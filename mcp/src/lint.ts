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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_URI,
  DiagnosticSeverity,
  editedFiles,
  lintFile,
} from '@omnetpp/shared';
import { createDiskToolSetup, nedPathDirsFor } from './context.js';

/** Injected by esbuild from package.json. */
declare const __OPP_VERSION__: string;

interface Options {
  paths: string[];
  nedPath: string | undefined;
  format: 'text' | 'json';
  /** Report diagnostics whose severity is at least this severe (1=error … 4=hint). */
  minSeverity: DiagnosticSeverity;
  /** Exit non-zero when a diagnostic at least this severe is found; null = never fail. */
  failOn: DiagnosticSeverity | null;
  color: boolean;
  /** Read an agent post-edit hook's JSON from stdin and lint only the edited files. */
  agentHook: boolean;
  severityGiven: boolean;
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
                      ';'-separated (or ':' outside Windows). These are indexed
                      but not linted. Defaults to the OMNETPP_NED_PATH
                      environment variable, then to "omnetpp.nedPath" in
                      ./.vscode/settings.json (relative to the current directory).
  --format=<fmt>      Output format: text (default) or json.
  --severity=<level>  Minimum severity to report: error | warning | info | hint
                      (default: hint — report everything).
  --fail-on=<level>   Exit non-zero if a diagnostic at this severity or worse is
                      found: error (default) | warning | info | hint | never.
  --no-color          Disable ANSI colors (also off when stdout is not a TTY).
  --agent-hook        Run as an AI agent post-edit hook (Claude Code, Codex,
                      Devin): read the hook JSON from stdin, lint only the
                      edited .ned/.msg/.ini files against the project at the
                      hook's cwd, and report to stderr with exit code 2 when
                      there are diagnostics (default --severity=warning).
                      Path arguments are ignored.
  -h, --help          Show this help.
  --version           Show the version.

Exit codes:
  0  no diagnostics at or above the --fail-on level
  1  diagnostics found at or above the --fail-on level
  2  usage or runtime error; with --agent-hook: diagnostics found`;

function fail(msg: string): never {
  process.stderr.write(`opp_lint: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    paths: [],
    nedPath: process.env.OMNETPP_NED_PATH,
    format: 'text',
    minSeverity: DiagnosticSeverity.Hint,
    failOn: DiagnosticSeverity.Error,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    agentHook: false,
    severityGiven: false,
  };
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--version') {
      process.stdout.write(`opp_lint ${__OPP_VERSION__}\n`);
      process.exit(0);
    } else if (a === '--no-color') {
      opts.color = false;
    } else if (a === '--agent-hook') {
      opts.agentHook = true;
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
      opts.severityGiven = true;
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
  if (opts.agentHook) return runAgentHook(opts);

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

  // Index the targeted dirs plus the parents of any explicit files (for cross-file
  // resolution), plus the library roots from --ned-path. A missing grammar wasm is
  // fatal for the linter.
  const indexRoots = unique([...dirArgs, ...fileArgs.map((f) => dirname(f))]);

  // Which indexed files are lint targets: explicit files, or anything under a dir arg.
  const explicitFiles = new Set(fileArgs);
  const underDir = (p: string) => dirArgs.some((d) => p === d || p.startsWith(d + sep));
  const { results, counts } = await lintTargets(
    indexRoots,
    nedPathDirsFor(opts.nedPath, process.cwd()),
    (p) => explicitFiles.has(p) || underDir(p),
    opts.minSeverity,
  );

  const total = counts[1] + counts[2] + counts[3] + counts[4];
  if (opts.format === 'json') {
    emitJson(results, counts);
  } else {
    process.stdout.write(formatText(results, counts, total, opts.color, process.cwd()));
  }

  // Exit code.
  if (opts.failOn === null) process.exit(0);
  let worst = 5;
  for (const r of results) for (const d of r.diagnostics) worst = Math.min(worst, d.severity);
  process.exit(worst <= opts.failOn ? 1 : 0);
}

const HOOK_EXTENSIONS = ['.ned', '.msg', '.ini'];

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Post-edit hook mode. The agent waits for this on every edit of any file, so it
 * returns before loading the grammars when no NED/MSG/INI file was edited. Exit 2
 * with the report on stderr is the hook contract that shows the text to the model.
 */
async function runAgentHook(opts: Options): Promise<void> {
  let input: { cwd?: unknown } = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0);
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const files = unique(editedFiles(input).map((p) => resolve(cwd, p))).filter(
    (p) => HOOK_EXTENSIONS.some((ext) => p.endsWith(ext)) && existsSync(p),
  );
  if (!files.length) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const isInside = (f: string) => {
    const rel = relative(projectDir, f);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  };
  const outside = files.filter((f) => !isInside(f)).map((f) => dirname(f));
  const targets = new Set(files);
  const { results, counts } = await lintTargets(
    unique([projectDir, ...outside]),
    nedPathDirsFor(opts.nedPath, projectDir),
    (p) => targets.has(p),
    opts.severityGiven ? opts.minSeverity : DiagnosticSeverity.Warning,
  );
  const total = counts[1] + counts[2] + counts[3] + counts[4];
  if (total === 0) process.exit(0);
  process.stderr.write(`opp_lint: problems in the edited file(s):\n${formatText(results, counts, total, false, projectDir)}`);
  process.exit(2);
}

/** Index `indexRoots` (+ the NED path) and lint the indexed files that `isTarget` selects. */
async function lintTargets(
  indexRoots: string[],
  nedPathDirs: string[],
  isTarget: (path: string) => boolean,
  minSeverity: DiagnosticSeverity,
): Promise<{ results: FileResult[]; counts: Record<number, number> }> {
  const { ctx, index } = await createDiskToolSetup(indexRoots, nedPathDirs, fail);

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
    .filter((t) => isTarget(t.path))
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
      .filter((d) => d.severity <= minSeverity)
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
  return { results, counts };
}

function formatText(
  results: FileResult[],
  counts: Record<number, number>,
  total: number,
  color: boolean,
  baseDir: string,
): string {
  const out: string[] = [];
  for (const r of results) {
    const rel = relative(baseDir, r.path) || r.path;
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
  return out.join('\n') + '\n';
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
