// Standalone command-line linter for OMNeT++ NED/MSG/INI files. Builds a project
// index from disk (via @omnetpp/shared, no OMNeT++ install required) and runs the
// same analyzers the IDE uses, printing diagnostics for CI / pre-commit / scripts.
// Inline `//# suppress(...)` / `### suppress(...)` directives are honored.
//
// The runtime artifact is dist/opp_lint.js (produced by esbuild); the grammar
// wasm/ and config/ assets live next to it, as for the LSP and MCP bundles.
//
// Usage:  opp_lint [options] [path ...]
// Env:    OMNETPP_NED_PATH, OMNETPP_WASM_DIR, OMNETPP_CONFIG_DIR
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUILTIN_URI,
  DiagnosticSeverity,
  ParserService,
  ToolContext,
  lintFile,
} from '@omnetpp/shared';
import { NodeFileSystem } from './nodeFileSystem.js';
import { buildDiskIndex } from './indexBuilder.js';

interface Options {
  paths: string[];
  nedPath: string;
  format: 'text' | 'json';
  /** Report diagnostics whose severity is at least this severe (1=error … 4=hint). */
  minSeverity: DiagnosticSeverity;
  /** Exit non-zero when a diagnostic at least this severe is found; null = never fail. */
  failOn: DiagnosticSeverity | null;
  color: boolean;
}

const SEVERITY_BY_NAME: Record<string, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  warn: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: 'error',
  [DiagnosticSeverity.Warning]: 'warning',
  [DiagnosticSeverity.Information]: 'info',
  [DiagnosticSeverity.Hint]: 'hint',
};

const USAGE = `opp_lint — lint OMNeT++ NED/MSG/INI files

Usage:
  opp_lint [options] [path ...]

Arguments:
  path                One or more files or directories to lint. Directories are
                      scanned recursively. Defaults to the current directory.

Options:
  --ned-path=<dirs>   Extra NED source roots for cross-file resolution (libraries),
                      ';'- or ':'-separated. These are indexed but not linted.
  --format=<fmt>      Output format: text (default) or json.
  --severity=<level>  Minimum severity to report: error | warning | info | hint
                      (default: hint — report everything).
  --fail-on=<level>   Exit non-zero if a diagnostic at this severity or worse is
                      found: error (default) | warning | info | hint | never.
  --no-color          Disable ANSI colors (also off when stdout is not a TTY).
  -h, --help          Show this help.

Exit codes:
  0  no diagnostics at or above the --fail-on level
  1  diagnostics found at or above the --fail-on level
  2  usage or runtime error`;

function fail(msg: string): never {
  process.stderr.write(`opp_lint: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    paths: [],
    nedPath: process.env.OMNETPP_NED_PATH ?? '',
    format: 'text',
    minSeverity: DiagnosticSeverity.Hint,
    failOn: DiagnosticSeverity.Error,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--no-color') {
      opts.color = false;
    } else if (a.startsWith('--ned-path=')) {
      opts.nedPath = a.slice('--ned-path='.length);
    } else if (a.startsWith('--format=')) {
      const f = a.slice('--format='.length);
      if (f !== 'text' && f !== 'json') fail(`invalid --format: ${f} (expected text|json)`);
      opts.format = f;
    } else if (a.startsWith('--severity=')) {
      const s = SEVERITY_BY_NAME[a.slice('--severity='.length).toLowerCase()];
      if (s === undefined) fail(`invalid --severity (expected error|warning|info|hint)`);
      opts.minSeverity = s;
    } else if (a.startsWith('--fail-on=')) {
      const v = a.slice('--fail-on='.length).toLowerCase();
      if (v === 'never') opts.failOn = null;
      else {
        const s = SEVERITY_BY_NAME[v];
        if (s === undefined) fail(`invalid --fail-on (expected error|warning|info|hint|never)`);
        opts.failOn = s;
      }
    } else if (a.startsWith('-')) {
      fail(`unknown option: ${a}`);
    } else {
      opts.paths.push(a);
    }
  }
  return opts;
}

const COLORS = { red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
function paint(color: boolean, code: string, s: string): string {
  return color ? `${code}${s}${COLORS.reset}` : s;
}
function severityColor(sev: DiagnosticSeverity): string {
  if (sev === DiagnosticSeverity.Error) return COLORS.red;
  if (sev === DiagnosticSeverity.Warning) return COLORS.yellow;
  return COLORS.cyan;
}

interface FileResult {
  path: string;
  uri: string;
  diagnostics: { line: number; character: number; severity: DiagnosticSeverity; message: string; code?: string }[];
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Classify positionals into files vs directories.
  const positionals = opts.paths.map((p) => resolve(p));
  const fileArgs: string[] = [];
  const dirArgs: string[] = [];
  for (const p of positionals) {
    let st;
    try {
      st = statSync(p);
    } catch {
      fail(`no such file or directory: ${p}`);
    }
    if (st.isDirectory()) dirArgs.push(p);
    else fileArgs.push(p);
  }
  if (positionals.length === 0) dirArgs.push(process.cwd());

  const wasmDir = process.env.OMNETPP_WASM_DIR || join(__dirname, 'wasm');
  const configDir = process.env.OMNETPP_CONFIG_DIR || join(__dirname, 'config');
  if (!existsSync(join(wasmDir, 'tree-sitter-ned.wasm'))) {
    fail(`grammar wasm not found in ${wasmDir}. Run "npm run dev:build" or set OMNETPP_WASM_DIR.`);
  }

  const parsers = await ParserService.create({
    runtimeWasmDir: wasmDir,
    nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
    msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
  });

  const nedPathDirs = opts.nedPath
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));

  // Index the targeted dirs plus the parents of any explicit files (for cross-file
  // resolution), plus the library roots from --ned-path.
  const indexRoots = unique([...dirArgs, ...fileArgs.map((f) => dirname(f))]);
  const fs = new NodeFileSystem();
  const index = await buildDiskIndex(fs, parsers, configDir, indexRoots, nedPathDirs);

  const ctx: ToolContext = {
    nedCache: index.nedCache,
    msgCache: index.msgCache,
    configRegistry: index.configRegistry,
    db: index.db,
    iniCache: index.iniCache,
    fs,
    parsers,
    toUri: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : pathToFileURL(resolve(p)).toString()),
    toPath: (u) => (u.startsWith('file:') ? fileURLToPath(u) : u),
  };

  // Which indexed files are lint targets: explicit files, or anything under a dir arg.
  const explicitFiles = new Set(fileArgs);
  const underDir = (p: string) => dirArgs.some((d) => p === d || p.startsWith(d + sep));
  const targetUris: string[] = [];
  for (const f of index.nedCache.allFiles()) targetUris.push(f.uri);
  for (const f of index.msgCache.allFiles()) targetUris.push(f.uri);
  for (const { uri } of index.iniCache.allDocs()) targetUris.push(uri);

  const targets = unique(targetUris)
    .filter((uri) => uri !== BUILTIN_URI)
    .map((uri) => {
      try {
        return { uri, path: fileURLToPath(uri) };
      } catch {
        return undefined;
      }
    })
    .filter((t): t is { uri: string; path: string } => !!t)
    .filter((t) => explicitFiles.has(t.path) || underDir(t.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  // Run the analyzers and collect (severity-filtered) results.
  const results: FileResult[] = [];
  const counts: Record<number, number> = {
    [DiagnosticSeverity.Error]: 0,
    [DiagnosticSeverity.Warning]: 0,
    [DiagnosticSeverity.Information]: 0,
    [DiagnosticSeverity.Hint]: 0,
  };
  for (const t of targets) {
    const { diagnostics } = await lintFile(t.uri, ctx);
    const kept = (diagnostics as any[])
      .filter((d) => d.severity <= opts.minSeverity)
      .map((d) => ({
        line: d.range.start.line,
        character: d.range.start.character,
        severity: d.severity as DiagnosticSeverity,
        message: d.message as string,
        code: d.code as string | undefined,
      }))
      .sort((a, b) => a.line - b.line || a.character - b.character);
    for (const d of kept) counts[d.severity]++;
    if (kept.length) results.push({ path: t.path, uri: t.uri, diagnostics: kept });
  }

  const total = counts[1] + counts[2] + counts[3] + counts[4];
  if (opts.format === 'json') {
    emitJson(results, counts);
  } else {
    emitText(results, counts, total, opts.color);
  }

  // Exit code.
  if (opts.failOn === null) process.exit(0);
  let worst = 5;
  for (const r of results) for (const d of r.diagnostics) worst = Math.min(worst, d.severity);
  process.exit(worst <= opts.failOn ? 1 : 0);
}

function emitText(
  results: FileResult[],
  counts: Record<number, number>,
  total: number,
  color: boolean,
): void {
  const cwd = process.cwd();
  const out: string[] = [];
  for (const r of results) {
    const rel = relative(cwd, r.path) || r.path;
    out.push(paint(color, COLORS.bold, rel));
    for (const d of r.diagnostics) {
      const loc = `${d.line + 1}:${d.character + 1}`.padEnd(7);
      const sev = SEVERITY_LABEL[d.severity].padEnd(7);
      const code = d.code ? paint(color, COLORS.dim, `  ${d.code}`) : '';
      out.push(`  ${paint(color, COLORS.dim, loc)} ${paint(color, severityColor(d.severity), sev)} ${d.message}${code}`);
    }
    out.push('');
  }
  if (total === 0) {
    out.push(paint(color, COLORS.dim, 'No problems found.'));
  } else {
    const parts: string[] = [];
    if (counts[1]) parts.push(`${counts[1]} error${counts[1] === 1 ? '' : 's'}`);
    if (counts[2]) parts.push(`${counts[2]} warning${counts[2] === 1 ? '' : 's'}`);
    if (counts[3]) parts.push(`${counts[3]} info`);
    if (counts[4]) parts.push(`${counts[4]} hint${counts[4] === 1 ? '' : 's'}`);
    const mark = counts[1] ? paint(color, COLORS.red, '✖') : paint(color, COLORS.yellow, '⚠');
    out.push(`${mark} ${total} problem${total === 1 ? '' : 's'} (${parts.join(', ')}) in ${results.length} file${results.length === 1 ? '' : 's'}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

function emitJson(results: FileResult[], counts: Record<number, number>): void {
  const payload = {
    summary: {
      errors: counts[1],
      warnings: counts[2],
      infos: counts[3],
      hints: counts[4],
      problems: counts[1] + counts[2] + counts[3] + counts[4],
      files: results.length,
    },
    // line/column are 1-based for human/tool consumption
    files: results.map((r) => ({
      path: r.path,
      uri: r.uri,
      diagnostics: r.diagnostics.map((d) => ({
        line: d.line + 1,
        column: d.character + 1,
        severity: SEVERITY_LABEL[d.severity],
        code: d.code,
        message: d.message,
      })),
    })),
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`opp_lint: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
