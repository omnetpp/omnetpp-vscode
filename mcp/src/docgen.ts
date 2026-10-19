// Standalone command-line NED documentation generator ("neddoc"). Builds a
// project index from disk (via @omnetpp/shared, no OMNeT++ install required)
// and generates browsable documentation for all NED/MSG types — the same
// feature the Eclipse-based IDE offers, with switchable output formats.
//
// The runtime artifact is dist/opp_docgen.js (produced by esbuild); the
// grammar wasm/, config/ and icons/ assets live next to it.
//
// Usage:  opp_docgen [options] [projectdir ...]
// Env:    OMNETPP_NED_PATH, OMNETPP_WASM_DIR, OMNETPP_CONFIG_DIR
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDiagramRenderer,
  embedsDiagramIcons,
  excludePatternRegex,
  generateNeddoc,
  defaultNeddocOptions,
  parseExternalDocsSpec,
  resolveInstallDir,
  type DocFormat,
  type GeneratedFile,
  type IncludeResolution,
  type NeddocOptions,
  type NeddocResult,
} from '@omnetpp/shared';
import { NeddocOutputTracker, createNodeIconProvider, loadExternalDocSets } from '@omnetpp/shared/node';
import { createDiskToolSetup, nedPathDirsFor } from './context.js';

/** Injected by esbuild from package.json. */
declare const __OPP_VERSION__: string;

interface CliOptions {
  projectDirs: string[];
  outputDir?: string;
  format: DocFormat;
  nedPath: string | undefined;
  title?: string;
  verbose: boolean;
  excludePatterns: string[];
  doxytagsPath?: string;
  doxyUrlPrefix?: string;
  customCssPath?: string;
  fragmentPaths: string[];
  externalDocs: Record<string, string>;
  toggles: Partial<NeddocOptions>;
}

const FORMATS: DocFormat[] = ['html', 'html-readthedocs', 'html-material', 'markdown', 'rst'];

const USAGE = `opp_docgen — generate documentation for OMNeT++ NED/MSG files

Usage:
  opp_docgen [options] [projectdir ...]

Arguments:
  projectdir          One or more project directories to document (scanned
                      recursively; .nedfolders/.nedexclusions are honored).
                      Defaults to the current directory.

Options:
  -o <dir>            Output directory (default: <projectdir>/doc/neddoc).
                      Files of the previous run that this one does not write
                      again are deleted (listed in its .neddoc-files); other
                      files are left alone.
  --format=<fmt>      Output format: html (default) | html-readthedocs |
                      html-material | markdown | rst.
  --ned-path=<dirs>   Extra NED source roots for cross-file resolution
                      (libraries), ';'-separated (or ':' outside Windows).
                      Indexed, not documented. Defaults to the
                      OMNETPP_NED_PATH environment variable, then to
                      "omnetpp.nedPath" in the first project's
                      .vscode/settings.json (relative to that project).
  --title=<text>      Documentation title (default: the project dir name).
  -x <pattern>        Exclude directories matching the glob-ish pattern
                      (* and ** supported); repeatable.
  --[no-]network-diagrams        Module figures on type pages (default: on).
  --[no-]usage-diagrams          Per-type usage diagrams (default: on).
  --[no-]inheritance-diagrams    Per-type inheritance diagrams (default: on).
  --[no-]full-usage-diagrams     Project-wide usage diagram (default: off).
  --[no-]full-inheritance-diagrams  Project-wide inheritance diagram (default: off).
  --[no-]message-definitions     Document MSG types (default: on).
  --[no-]source-snippets         Per-type source listings (default: on).
  --[no-]file-listings           A page per NED/MSG file with its types and
                                 source (default: on). Also accepted as
                                 --[no-]source-files (the Eclipse name).
  --[no-]automatic-hyperlinks    Link all known type names in comments; when
                                 off, only ~tilde references (default: on).
  --include-builtins             Document the built-in NED types too.
  --custom-css=<file>            Stylesheet replacing the generated style.css
                                 (the html* formats).
  --doxytags=<file>              Doxygen tag file for "C++ definition" links.
  --doxy-url-prefix=<url>        URL prefix for doxygen links.
  -f, --fragments=<file>         Doc fragments file (as in the Eclipse IDE): XML
                                 <docfragment> elements whose content is
                                 inserted at anchors of type, file, package
                                 and namespace pages; repeatable.
  -l, --external-docs=<list>     Documentation of dependencies generated
                                 separately: <package>=<url-or-path> items,
                                 comma- or space-separated; repeatable. A path
                                 is relative to the output directory (its
                                 nedtags.xml/msgtags.xml give the page names).
                                 Types of the longest matching package prefix
                                 link there; other dependency types are marked
                                 "not documented here".
  --verbose                      Print progress.
  -h, --help                     Show this help.
  --version                      Show the version.

Exit codes:
  0  documentation generated
  1  generated with warnings (unlinked dependency references do not count)
  2  usage or runtime error`;

function fail(msg: string): never {
  process.stderr.write(`opp_docgen: ${msg}\n`);
  process.exit(2);
}

const BOOL_TOGGLES: Record<string, keyof NeddocOptions> = {
  'network-diagrams': 'typeDiagrams',
  'usage-diagrams': 'usageDiagrams',
  'inheritance-diagrams': 'inheritanceDiagrams',
  'full-usage-diagrams': 'fullUsageDiagrams',
  'full-inheritance-diagrams': 'fullInheritanceDiagrams',
  'message-definitions': 'messageDefinitions',
  'source-snippets': 'sourceSnippets',
  'file-listings': 'fileListings',
  'source-files': 'fileListings',
  'automatic-hyperlinks': 'automaticHyperlinks',
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    projectDirs: [],
    format: 'html',
    nedPath: process.env.OMNETPP_NED_PATH,
    verbose: false,
    excludePatterns: [],
    fragmentPaths: [],
    externalDocs: {},
    toggles: {},
  };
  const addExternalDocs = (spec: string) => {
    try {
      Object.assign(opts.externalDocs, parseExternalDocsSpec(spec));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--version') {
      process.stdout.write(`opp_docgen ${__OPP_VERSION__}\n`);
      process.exit(0);
    } else if (a === '-o') {
      const v = argv[++i];
      if (!v) fail('-o requires a directory argument');
      opts.outputDir = resolve(v);
    } else if (a === '-x') {
      const v = argv[++i];
      if (!v) fail('-x requires a pattern argument');
      opts.excludePatterns.push(...v.split(/[,\s]+/).filter(Boolean));
    } else if (a === '-l') {
      const v = argv[++i];
      if (!v) fail('-l requires a <package>=<url-or-path> list argument');
      addExternalDocs(v);
    } else if (a === '-f') {
      const v = argv[++i];
      if (!v) fail('-f requires a file argument');
      opts.fragmentPaths.push(v);
    } else if (a.startsWith('--fragments=')) {
      opts.fragmentPaths.push(a.slice('--fragments='.length));
    } else if (a.startsWith('--external-docs=')) {
      addExternalDocs(a.slice('--external-docs='.length));
    } else if (a.startsWith('--format=')) {
      const f = a.slice('--format='.length) as DocFormat;
      if (!FORMATS.includes(f)) fail(`invalid --format: ${f} (expected ${FORMATS.join('|')})`);
      opts.format = f;
    } else if (a.startsWith('--ned-path=')) {
      opts.nedPath = a.slice('--ned-path='.length);
    } else if (a.startsWith('--title=')) {
      opts.title = a.slice('--title='.length);
    } else if (a.startsWith('--custom-css=')) {
      opts.customCssPath = resolve(a.slice('--custom-css='.length));
    } else if (a.startsWith('--doxytags=')) {
      opts.doxytagsPath = resolve(a.slice('--doxytags='.length));
    } else if (a.startsWith('--doxy-url-prefix=')) {
      opts.doxyUrlPrefix = a.slice('--doxy-url-prefix='.length);
    } else if (a === '--include-builtins') {
      opts.toggles.includeBuiltins = true;
    } else if (a === '--verbose') {
      opts.verbose = true;
    } else if (/^--(no-)?[a-z-]+$/.test(a)) {
      const m = /^--(no-)?([a-z-]+)$/.exec(a)!;
      const key = BOOL_TOGGLES[m[2]];
      if (!key) fail(`unknown option: ${a}`);
      (opts.toggles as Record<string, unknown>)[key] = !m[1];
    } else if (a.startsWith('-')) {
      fail(`unknown option: ${a}`);
    } else {
      opts.projectDirs.push(resolve(a));
    }
  }
  if (opts.projectDirs.length === 0) opts.projectDirs.push(process.cwd());
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  for (const dir of opts.projectDirs) {
    let st;
    try {
      st = statSync(dir);
    } catch {
      fail(`no such directory: ${dir}`);
    }
    if (!st.isDirectory()) fail(`not a directory: ${dir}`);
  }
  const outputDir = opts.outputDir ?? join(opts.projectDirs[0], 'doc', 'neddoc');

  const log = (msg: string) => {
    if (opts.verbose) process.stderr.write(`opp_docgen: ${msg}\n`);
  };

  log(`indexing ${opts.projectDirs.join(', ')} ...`);
  const { index } = await createDiskToolSetup(opts.projectDirs, nedPathDirsFor(opts.nedPath, opts.projectDirs[0]), fail);

  const excludes = opts.excludePatterns.map(excludePatternRegex);
  const projectRelative = (path: string): string | undefined => {
    for (const dir of opts.projectDirs) {
      if (path === dir || path.startsWith(dir + sep)) return relative(dir, path).split(sep).join('/');
    }
    return undefined;
  };
  const isTargetUri = (uri: string): boolean => {
    if (!uri.startsWith('file:')) return false;
    const rel = projectRelative(fileURLToPath(uri));
    if (rel === undefined) return false; // library file from --ned-path
    return !excludes.some((re) => re.test(rel));
  };

  const includeResolver = (fileRef: string, fromId: string | undefined): IncludeResolution | undefined => {
    try {
      const fromPath = fromId?.startsWith('file:') ? fileURLToPath(fromId) : fromId;
      const target = resolve(fromPath ? dirname(fromPath) : opts.projectDirs[0], fileRef);
      return { id: target, content: readFileSync(target, 'utf8') };
    } catch {
      return undefined;
    }
  };

  const optionOverrides: Partial<NeddocOptions> = {
    ...opts.toggles,
    format: opts.format,
    excludePatterns: opts.excludePatterns,
    includeResolver,
    projectTitle: opts.title ?? opts.projectDirs[0].split(sep).filter(Boolean).pop(),
    externalDocs: loadExternalDocSets(opts.externalDocs, outputDir),
  };
  if (opts.doxytagsPath) {
    let xml = '';
    try {
      xml = readFileSync(opts.doxytagsPath, 'utf8');
    } catch (e) {
      fail(`cannot read doxytags file: ${opts.doxytagsPath}`);
    }
    optionOverrides.doxytags = { xml, urlPrefix: opts.doxyUrlPrefix ?? '' };
  }
  if (opts.customCssPath) {
    try {
      optionOverrides.customCss = readFileSync(opts.customCssPath, 'utf8');
    } catch {
      fail(`cannot read custom CSS file: ${opts.customCssPath}`);
    }
  }
  if (opts.fragmentPaths.length > 0) {
    optionOverrides.docFragments = opts.fragmentPaths.map((path) => {
      try {
        return { source: path, xml: readFileSync(resolve(path), 'utf8') };
      } catch {
        fail(`cannot read doc fragments file: ${path}`);
      }
    });
  }
  if (opts.format === 'html-material') {
    // the vendored Eclipse template snapshot ships next to the bundle
    const assetDir = process.env.OMNETPP_NEDDOC_MATERIAL_DIR || join(__dirname, 'neddoc-material');
    if (!existsSync(join(assetDir, 'page.tmpl')))
      fail(`material template assets not found in ${assetDir} (run "bun run dev:build" or set OMNETPP_NEDDOC_MATERIAL_DIR)`);
    const materialAssets: Record<string, string | Uint8Array> = {};
    for (const f of readdirSync(assetDir)) materialAssets[f] = readFileSync(join(assetDir, f));
    optionOverrides.materialAssets = materialAssets;
  }

  let files = 0;
  mkdirSync(outputDir, { recursive: true });
  const output = new NeddocOutputTracker(outputDir);
  const emit = (file: GeneratedFile): void => {
    const target = join(outputDir, ...file.relativePath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    output.record(file.relativePath);
    files++;
  };

  // icon search roots: project images/ dirs, <OMNETPP_ROOT>/images, the bundled
  // snapshot next to the CLI bundle (Eclipse order). Referenced icons are
  // copied once into <out>/icons/ and SVGs point at them relatively (SVG
  // files live in images/, or at the root in the material layout); formats
  // that show SVGs as <img> embed them instead (embedsDiagramIcons).
  const installDir = resolveInstallDir(undefined, process.env);
  const iconDirs = [
    ...opts.projectDirs.map((d) => join(d, 'images')).filter(existsSync),
    ...(installDir ? [join(installDir, 'images')] : []),
    process.env.OMNETPP_ICONS_DIR || join(__dirname, 'icons'),
  ];
  let bundledIndex: Record<string, [number, number]> | undefined;
  try {
    bundledIndex = (JSON.parse(readFileSync(join(iconDirs[iconDirs.length - 1], 'index.json'), 'utf8')) as {
      icons: Record<string, [number, number]>;
    }).icons;
  } catch {
    /* no bundled index: sizes come from image headers */
  }
  const iconHrefPrefix = opts.format === 'html-material' ? 'icons/' : '../icons/';
  const icons = createNodeIconProvider({
    iconDirs,
    bundledIndex,
    emit: embedsDiagramIcons(opts.format)
      ? 'embed'
      : (absPath, relName) => {
          emit({ relativePath: `icons/${relName}`, content: readFileSync(absPath) });
          return iconHrefPrefix + relName;
        },
  });
  const renderDiagram = createDiagramRenderer({ nedCache: index.nedCache, icons });

  let lastStep = '';
  // live progress line when stderr is a TTY (verbose mode keeps plain lines)
  const statusLine = process.stderr.isTTY === true && !opts.verbose;
  let lastStatus = '';
  let statusWidth = 0;
  let result: NeddocResult | undefined;
  try {
    result = await generateNeddoc(
      {
        nedCache: index.nedCache,
        msgCache: index.msgCache,
        isTargetUri,
        displayPath: (uri) => (uri.startsWith('file:') ? (projectRelative(fileURLToPath(uri)) ?? uri) : uri),
      },
      optionOverrides,
      emit,
      {
        report: (step, done, total, percent) => {
          if (statusLine) {
            // self-updating status line on a TTY (throttled to visible changes)
            const line = `[${String(Math.floor(percent)).padStart(3)}%] ${step} (${done}/${total})`;
            if (line !== lastStatus) {
              lastStatus = line;
              process.stderr.write(`\r${line.padEnd(statusWidth)}`);
              statusWidth = Math.max(statusWidth, line.length);
            }
          } else if (opts.verbose && step !== lastStep) {
            lastStep = step;
            log(step.toLowerCase());
          }
        },
      },
      renderDiagram,
    );
  } finally {
    const removed = output.finish(result !== undefined);
    if (removed.length > 0) log(`removed ${removed.length} file(s) of the previous run`);
  }
  if (statusLine) process.stderr.write(`\r${' '.repeat(statusWidth)}\r`);

  for (const w of result.warnings) process.stderr.write(`opp_docgen: warning: ${w}\n`);
  for (const w of result.externalWarnings) process.stderr.write(`opp_docgen: warning: ${w}\n`);
  const entry = opts.format === 'markdown' ? 'index.md' : opts.format === 'rst' ? 'index.rst' : 'index.html';
  process.stdout.write(
    `Generated ${result.pages} page(s), ${result.diagrams} diagram(s), ${files} file(s) into ${outputDir}\n` +
      `Entry point: ${join(outputDir, entry)}\n`,
  );
  process.exit(result.warnings.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`opp_docgen: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
