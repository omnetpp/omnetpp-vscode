# Developer Guide

This document is for people **hacking on the OMNeT++ VS Code extension itself** —
building it, running the tests, understanding the architecture, and following the
project's conventions. If you only want to *use* the extension, see the
[User Guide](USER_GUIDE.md).

## What this project is

A VS Code extension plus language server for the OMNeT++ **NED**, **MSG**, and **INI**
languages. The language server is **pure TypeScript** — NED and MSG are parsed with
tree-sitter grammars, INI with a hand-written port of the IDE's `InifileParser` — and it
needs **no OMNeT++ installation** to parse and analyze files: the `ned.*` types are
built in, and INI validation uses a bundled config-option snapshot. An OMNeT++
install (`omnetpp.installDir` / `OMNETPP_ROOT`) is used only as an icon source
(`<installDir>/images`).

The same semantic core also powers three non-editor surfaces: a standalone
**command-line linter** (`opp_lint`), a **documentation generator** (`opp_docgen`), and an
**MCP server** for AI agents (`opp_ide_mcp`). The language server itself also ships as a
command-line tool, `opp_lsp`, for other LSP editors. The CLI linter and the MCP `get_diagnostics`
tool share `lintFile`. The IDE runs the same `shared` analyzers through
`server/src/features/diagnostics.ts`, plus a few checks that need the live index (unused
networks, INI `include` resolution, and include-merged INI parameter checks), so CLI/MCP
output can differ slightly from the Problems view.

## Toolchain: Bun only

**The dev toolchain is [Bun](https://bun.sh) only — no Node.js or npm is required** to
install, build, test, or package. Node still runs the *shipped* code (the extension and
language server execute in VS Code's bundled Node extension host, and the `opp_*` CLI
bundles carry a `#!/usr/bin/env node` shebang for end users), but you do not need it on
your development machine.

A few consequences worth knowing, because they bite if you forget them:

- Bun runs a tool's `#!/usr/bin/env node` bin under **Node**, not under Bun. To keep
  everything on Bun, JS tools are invoked **by file path**: `compile`/`watch` run
  `bun ./node_modules/typescript/bin/tsc`, `package`/`deploy` run
  `bun ./node_modules/@vscode/vsce/vsce`, and the `.mjs` build scripts run as
  `bun ./script.mjs`.
- `trustedDependencies` in `package.json` is **intentionally empty**. Dependency
  postinstall scripts (esbuild, tree-sitter-cli, `@vscode/vsce-sign`) are all
  `node install.js`, which would pull in Node during `bun install`. esbuild's binary
  ships via its `@esbuild/<platform>` package, the native tree-sitter binary is fetched
  on demand by `scripts/build-wasm.mjs` (via `fetch`), and signing is unused. Keeping
  this empty lets `bun install` run with no Node.
- vsce's `vscode:prepublish` hook would shell out to npm, so the build step is named
  **`prepackage`** instead and called explicitly from `package`/`deploy`.

## First-time setup

The NED/MSG tree-sitter grammars and the NED/MSG TextMate grammars (symlinked from
`syntaxes/`) live in **git submodules** under `subprojects/`.

```bash
./refresh_submodules          # or: git submodule update --init --recursive
bun install
bun run build:wasm            # compile the NED/MSG tree-sitter grammars to WASM
```

`build:wasm` needs Emscripten (`emcc`) on your `PATH`, or Docker; the native
`tree-sitter` binary is auto-downloaded if missing.

## Commands

```bash
# Develop
bun run compile        # tsc --build: type-check all projects, emit .d.ts + out/
bun run watch          # tsc --build --watch
bun run dev:build      # clean dist/, copy:assets + esbuild bundle (runtime artifacts;
                       #   assumes a prior `compile` — esbuild pulls shared from shared/out)
bun run bundle:watch   # esbuild in watch mode

# Test (bun:test over the TypeScript sources; shared, server, webview and worker trees)
bun run test           # compile (type-check) THEN bun test ./shared/src/test ./server/src/test
                       #   ./client/webview/src/test ./client/worker/src/test
bun test ./shared/src/test/<name>.test.ts      # a single test file (./ prefix needed
                                               #   outside the bunfig test root)
bun test -t "<name substr>"                    # tests whose name matches (shared/src/test
                                               #   only; add ./paths for the other trees)

# Package / publish (prepackage chains compile + build:wasm + clean:dist + copy:assets + esbuild
# --production, so both work from a fresh checkout once the submodules are initialized
# and emcc/Docker is available)
bun run package        # -> omnetpp-vscode-<version>.vsix
bun run deploy         # vsce publish (VS Code Marketplace)
bun run package:cli    # -> build/omnetpp-opp-tools-<version>.tgz (npm package, see below)
bun run deploy:cli     # bun publish @omnetpp/opp-tools (needs an npm login)
```

Press **F5** in VS Code ("Launch Extension", which runs `bun: dev:build` first) to start
the Extension Development Host. In debug mode the server listens on inspector port
`6009`; use "Attach to Server" or the "Extension + Server" compound
(`.vscode/launch.json`) to debug it.

### Two build passes — do not conflate them

- **`tsc --build`** type-checks and emits `.d.ts` / `out/` for the TypeScript project
  references (and feeds esbuild, which bundles from `shared/out`).
- **`esbuild`** (`esbuild.mjs`) produces the actual runtime bundles in `dist/`:
  `extension.js`, `opp_lsp.js`, `opp_ide_mcp.js`, `opp_lint.js`, `opp_docgen.js`,
  `eventlogWorker.js` (Node/CJS), and the browser IIFEs `webview/nedPreview.js`,
  `webview/sequenceChart.js`, `webview/eventLogTable.js`. `copy:assets` adds
  `dist/wasm/`, `dist/config/`, `dist/icons/`, `dist/webview/codicons/` and
  `dist/neddoc-material/`.

Tests run via **`bun:test` over the TypeScript sources** — not the `tsc` output and not
the esbuild bundle. The main suite is `shared/src/test`; the glue-code trees
`server/src/test`, `client/webview/src/test` and `client/worker/src/test` are excluded
from their tsc builds because they import `bun:test`. `bunfig.toml` pins the test `root`
to `shared/src/test`, so a bare `bun test` runs exactly that suite (and not the
`shared/out/test/*.js` copies that `tsc --build` also emits).

## Architecture

Four Bun workspaces (`shared`, `server`, `client`, `mcp`), type-checked as six TypeScript
projects wired by project references (`client/webview/` and `client/worker/` are separate
tsc projects inside the `client` workspace).

### `shared/` — the semantic core

The host-agnostic engine: the tree-sitter parser wrapper, the AST/type model, and all
analyzers for NED/MSG/INI (diagnostics, navigation, completion, rename, hierarchy, INI
parameter resolution). It also holds the cross-reference graph (`xref/`), a lightweight
C++ scanner for `Define_Module`/class cross-references (`cpp/`), formatting, folding and
workspace symbols (`features/`), inline `suppress(...)` directives
(`diagnostics/suppress.ts`), the NED preview scene and display-string model (`ned/`,
`graphics/`), the NED documentation generator (`neddoc/`), the OMNeT++ match-expression
language (`match/`), and the eventlog engine (`eventlog/`).

- **The core must never import `vscode` or Node-specific APIs.** File access goes through
  the `FileSystem` interface in `shared/src/fs/fileSystem.ts`, which callers inject. The
  only exception is `shared/src/node/` (`NodeFileSystem`, `NodeRandomAccessFile`, …),
  published as the separate `@omnetpp/shared/node` subpath. It is never re-exported from
  the core barrel; Node hosts (server, mcp, worker) import it explicitly.
- The main public surface is re-exported from `shared/src/index.ts`. Curated subpaths in
  `shared/package.json` `exports` serve hosts that must not pull in the whole barrel:
  `/node`, `/protocol`, `/preview`, `/eventlog`, `/elog-protocol`, `/ui-protocol`,
  `/entry-proposals`, `/style-rules`, `/match`, `/elog-tools`.
- It also hosts the **MCP tool layer** (`shared/src/mcp/tools.ts`): `OMNETPP_TOOLS` plus
  `handleTool(name, args, ctx)`, pure functions over a `ToolContext` (the caches + a
  `FileSystem`), with **no MCP-SDK dependency**. The SDK glue lives only in the adapters.
  The `elog_*` tools live in `shared/src/mcp/elogTools.ts`.

### `server/` — the LSP server

`server/src/server.ts` owns the LSP connection and the project index (`projectIndex.ts`),
and injects the Node filesystem (`NodeFileSystem` from `@omnetpp/shared/node`) into
`shared`. It translates LSP requests into `shared` calls. Bundled to `dist/opp_lsp.js`
(with a node shebang), which the client spawns as a child process over IPC, and which
also ships as the `opp_lsp` command-line tool for other LSP editors.
`server/src/commandLine.ts` handles its command line before the connection is created:
`--help`, `--version`, `--ned-path=<dirs>` (else `OMNETPP_NED_PATH`, used when the editor sends no
`nedPath`), and `--stdio` when no transport flag is given. The server never writes to
stdout, because stdout carries the LSP stream. It also serves the `omnetpp/mcp/listTools` /
`omnetpp/mcp/callTool` custom requests by running `handleTool` against its **live** index
(so MCP results reflect unsaved editor buffers).

### `client/` — the VS Code extension

`client/src/extension.ts` is the thin VS Code glue. It starts the language client over
IPC and registers the activity-bar tree views (`views.ts`), the graphical NED preview
panel (`nedPreviewPanel.ts`), the Generate NED Documentation command (`docsCommand.ts`),
the `Alt+O` C++/NED switch (`counterparts.ts`), the Install/Uninstall Command-Line Tools
commands (`cliTools.ts`), the Sequence Chart editor and Event Log table view
(`client/src/eventlog/`), and git/focus-triggered index revalidation. Bundled to
`dist/extension.js` (the extension `main`). It also hosts a localhost Streamable-HTTP
**MCP bridge** (`mcpBridge.ts`: 127.0.0.1, ephemeral port, per-session Bearer token);
`extension.ts` registers it via `lm.registerMcpServerDefinitionProvider`, and it forwards
tool calls to the live LSP index.

### `mcp/` — standalone disk-index tooling (runs without an editor)

Three artifacts that build their index from disk via `shared` (`indexBuilder.ts`), each
bundled with a node shebang and listed as a `bin`:

- **stdio MCP server** — `mcp/src/server.ts` → `dist/opp_ide_mcp.js`, serving the same
  `OMNETPP_TOOLS` plus the `elog_*` eventlog tools (only this server offers them; the
  live LSP bridge does not).
- **CLI linter** — `mcp/src/lint.ts` → `dist/opp_lint.js`. It reuses the shared
  `lintFile`, the same per-file analysis the `get_diagnostics` MCP tool uses, suppression
  included.
- **CLI documentation generator** — `mcp/src/docgen.ts` → `dist/opp_docgen.js`. It runs
  the shared `generateNeddoc` with `--format=html|html-readthedocs|html-material|markdown|rst`.

All three find their assets (`wasm/`, `config/`, and for `opp_docgen` also `icons/` and
`neddoc-material/`) next to the script, overridable with `OMNETPP_WASM_DIR`,
`OMNETPP_CONFIG_DIR`, `OMNETPP_ICONS_DIR` and `OMNETPP_NEDDOC_MATERIAL_DIR`.

All projects inherit `node16` module resolution from `tsconfig.base.json`, because
web-tree-sitter and the MCP SDK expose subpaths through `package.json` `exports` maps;
`client/` and `client/webview/` override it to `bundler`.

### Distributing the command-line tools

The source is not released, so end users get the `opp_*` tools in one of two ways:

- **npm package `@omnetpp/opp-tools`.** The manifest and README template live in
  `mcp/npm/`. `scripts/pack-cli.mjs` stages the package from an already-built `dist/`
  into `build/opp-tools/` — the four bundles, only the asset folders they load, the
  template, and `LICENSE` — with the version taken from the root `package.json`, then runs
  `bun pm pack` (or `bun publish` with `--publish`). Use `bun run package:cli` /
  `bun run deploy:cli`. Requires Node ≥ 18 at the user's end (the esbuild target).
- **"OMNeT++: Install Command-Line Tools"** (`client/src/cliTools.ts`). It writes one
  shim per tool into `~/.local/bin` (Linux, macOS) or `%LOCALAPPDATA%\omnetpp\bin`
  (Windows, `.cmd`). A shim runs the bundle in the installed extension's `dist/` with VS
  Code's own runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so no Node is
  needed. Both paths change on updates, so the install is kept in `globalState` and the
  shims are rewritten on activation when either moved. Shims carry a marker line; the
  refresh and the uninstall command only touch marked files.

### Graphical NED preview

`client/src/nedPreviewPanel.ts` hosts a webview that follows the cursor via the
`omnetpp/nedPreview` request. The server builds the scene DTO in
`shared/src/ned/nedPreviewScene.ts`. Display-string semantics (parsing, fallback chains,
defaults) live in `shared/src/ned/displayStringModel.ts`, a faithful port of the IDE's
`DisplayString.java`. Icon ids resolve in the Eclipse search order: project `images/` →
`omnetpp.installDir/images` → bundled `dist/icons`. The webview app
(`client/webview/src/main.ts` → `dist/webview/nedPreview.js`, a browser IIFE) has its own
tsconfig (DOM lib, no node/vscode types). It may import only `@omnetpp/shared/preview`
plus type-only protocol imports, so the bundle never pulls in web-tree-sitter or Node
APIs.

### Eventlog: Sequence Chart and Event Log table

`shared/src/eventlog/` is a host-agnostic TypeScript port of the OMNeT++ Java eventlog
library: indexed random access with bounded memory, built for multi-GB logs and live
follow of a running simulation. Each open `.elog` gets its own worker child process
(`client/worker/` → `dist/eventlogWorker.js`): JSON-RPC (`Content-Length` framing) over
stdio on the main thread, and the synchronous engine on a `node:worker_threads` thread
with real mid-scan cancellation. `client/src/eventlog/` registers the
`omnetpp.sequenceChart` custom editor for `*.elog` and the `omnetppEventLogTable` webview
view. Their apps live in `client/webview/src/eventlog/` (`dist/webview/sequenceChart.js`,
`dist/webview/eventLogTable.js`) and follow the protocol in
`shared/src/eventlog/uiProtocol.ts`. `shared/src/eventlog/entries.ts` is generated from
the committed `resources/eventlog/eventlogentries.txt`. The manual F5 checklist is
[eventlog-manual-tests.md](eventlog-manual-tests.md); the Eclipse parity audit is
[eventlog-parity.md](eventlog-parity.md). Worker spawning in the real extension host
needs `ELECTRON_RUN_AS_NODE` (`workerClient.ts`), which no headless script can cover.

### NED documentation generator (neddoc)

`shared/src/neddoc/` extracts a `DocModel` and renders it with format-specific renderers
(html, html-readthedocs, html-material, markdown, rst). Output goes through an `emit`
callback, so `shared/` stays filesystem-free. It has two hosts: the `opp_docgen` CLI
(`mcp/src/docgen.ts`, disk index) and the **OMNeT++: Generate NED Documentation** command
(`client/src/docsCommand.ts`, configured by the `omnetpp.neddoc.*` settings), which calls
the `omnetpp/generateDocs` request (`server/src/docsRequests.ts`) against the live index
with `omnetpp/generateDocsProgress` notifications.

### C++/NED counterpart switch (`Alt+O`)

`omnetpp.switchCounterpart` (`client/src/counterparts.ts`) steps through the
`.cc` → `.h` → `.ned` ring of the current module via the `omnetpp/counterparts` request.
Pairing is semantic (`@class`, `@namespace`, `Define_Module`, and the implementation
class inherited from a base type; `shared/src/xref/counterparts.ts`,
`counterpartRing.ts`) and is answered from the server's on-disk C++ index
(`shared/src/cpp/cppScanner.ts`), so the C++ files need not be open. When the index
cannot fill a ring member, it falls back to the same-basename sibling file.

### Data flow

`client` reads `omnetpp.*` settings → passes them to `server` via LSP
`initializationOptions` → `server` builds the project index and answers requests using
`shared`. The UI is tree views, input boxes and quick picks, plus three webviews: the NED
preview panel, the Sequence Chart custom editor, and the Event Log table view.

## Conventions (patterns to follow)

- **Keep `shared/` free of `vscode` and Node imports** (except `shared/src/node/`).
  Inject capabilities (filesystem, etc.) through interfaces. New analysis logic belongs in
  `shared/`; only LSP glue belongs in `server/`, only VS Code UI in `client/`.
- **New webview code** goes under `client/webview/` and must stay browser-safe.
- **New settings** go under the `omnetpp.*` namespace in `package.json`
  (`contributes.configuration`) and should be threaded through `initializationOptions` if
  the server needs them. Settings apply **live**: a `workspace.onDidChangeConfiguration`
  listener forwards `omnetpp.*` changes to the server, which re-reads `nedPath` /
  `installDir` (reindex if changed), `diagnostics.scope` (publish or clear workspace
  diagnostics) and `codeLens.iniParams` (refresh lenses) — no window reload. Settings only
  the client uses (`omnetpp.neddoc.*`, `omnetpp.eventlog.*`, `omnetpp.sequenceChart.*`)
  are read in `client/` and not sent to the server.
- **Command-line tools must be named with the `opp_` prefix** (OMNeT++'s convention, e.g.
  `opp_msgc`, `opp_run`). This covers the `bin` command, the `dist/` bundle filename, and
  the program name shown in `--help`/usage. A new tool also needs an entry in the npm
  manifest (`mcp/npm/package.json`), in `TOOLS` of `scripts/pack-cli.mjs` and of
  `client/src/cliTools.ts`.
- **Develop each feature in a separate commit** with a well-written description.
- **A new analyzer should be reachable from all surfaces.** Put it in `shared/`, then wire
  it into both `server/src/features/diagnostics.ts` (`computeDiagnostics`, the IDE) and
  `lintFile` in `shared/src/mcp/tools.ts` (CLI + MCP `get_diagnostics`). The two lists are
  maintained separately.

### Things that bite

- **Project-model discovery is not just open folders.** NED source roots come from
  `.nedfolders` / `.nedexclusions` / `package.ned` (see
  `shared/src/project/projectModel.ts`), plus the `omnetpp.nedPath` setting. The install
  dir is never a NED source root.
- **Diagnostics cover unopened files and self-heal.** With `omnetpp.diagnostics.scope` =
  `workspace` (the default), the server publishes diagnostics for every indexed file
  (`server/src/workspaceDiagnostics.ts`). Git HEAD changes and window refocus send
  `omnetpp/revalidate`, so the index reconciles against disk after a `git checkout` that
  the file watcher missed.
- **Bundled snapshots** are regenerated from an OMNeT++ source tree:

  | Snapshot | Regenerate with |
  | --- | --- |
  | `resources/config/opp-config-options.json` (INI config-option validation) | `bun scripts/gen-config-options.mjs <omnetpp-src-dir>` |
  | `resources/config/msg-builtin-types.json` (from `sim_std.msg`) | `bun scripts/gen-msg-builtins.mjs <omnetpp-src-dir>` |
  | `resources/icons/` (+ `index.json` with natural sizes) | `bun scripts/gen-icons.mjs <omnetpp-src-dir>` |
  | `resources/neddoc-material/` (html-material template) | `bun scripts/gen-neddoc-material-assets.mjs <omnetpp-src-dir>` |
  | `shared/src/eventlog/entries.ts` (from `resources/eventlog/eventlogentries.txt`) | `bun scripts/gen-eventlog-entries.mjs [<omnetpp-src-dir>]` |

- **`dist/` is rebuilt from scratch.** `dev:build` and `prepackage` delete it first
  (`clean:dist`, in `prepackage` only after `compile` and `build:wasm` succeeded), so files
  that a build no longer produces cannot end up in the `.vsix` or the npm package.
  `bundle` and `bundle:watch` alone do not clean.
- **Third-party notices.** `THIRD_PARTY_NOTICES.md` (shipped in the `.vsix` and the npm
  package) is generated by `bun ./scripts/gen-third-party-notices.mjs` after
  `bun run compile`. It finds the npm packages that really end up in a bundle by
  re-running the `esbuild.mjs` targets with a metafile; assets copied without esbuild are
  listed by hand in its `COPIED_ASSETS`, which must follow `scripts/copy-assets.mjs`.
  `prepackage` runs it with `--check` and fails if the file is out of date — regenerate
  and commit it after a dependency change.
- **Transports differ.** MCP stdio is **newline-delimited JSON**; LSP and the eventlog
  worker use `Content-Length` framing. Keep them straight when writing smoke scripts.

## Debugging / smoke scripts

`scripts/` holds standalone smoke/check scripts for exercising the parser, analyzers, or
an LSP/MCP/CLI feature outside VS Code. Run them with `bun scripts/<file>.mjs`. Scripts
that drive a bundle (`dist/opp_*.js`, `dist/eventlogWorker.js`,
`dist/webview/*`) need `bun run compile && bun run dev:build` first and spawn the bundle
via `process.execPath`, i.e. bun. The analyzer-only check scripts load `shared/out`
directly and need only `bun run compile` (and built WASM).

| Script | What it drives |
| --- | --- |
| `lsp-smoke.mjs`, `lsp-ini-smoke.mjs <projDir> <iniPath>`, `lsp-project-smoke.mjs <projectDir>`, `lsp-modhier-smoke.mjs <projDir> <nedFile>` | LSP features over `dist/opp_lsp.js` |
| `lsp-cli-smoke.mjs` | `dist/opp_lsp.js` started like a non-VS Code editor does: no transport flag, `--help`, and the `--ned-path` / `OMNETPP_NED_PATH` / `initializationOptions` order |
| `ini-nav-smoke.mjs` | INI param-line hover/definition/references/CodeLens over `dist/opp_lsp.js` |
| `workspace-diag-smoke.mjs` | asserts unopened workspace files still get diagnostics |
| `workspace-suppress-smoke.mjs` | inline `suppress(...)` is honored for never-opened workspace files |
| `revalidate-smoke.mjs` | `omnetpp/revalidate` reconciles the index after a real `git checkout` |
| `preview-smoke.mjs [projectDir]` | the `omnetpp/nedPreview` scene request shape |
| `counterparts-smoke.mjs [<projectDir> <file>…]` | the `omnetpp/counterparts` (`Alt+O`) request, with the C++ files not open |
| `mcp-smoke.mjs <projectDir>` | the standalone `dist/opp_ide_mcp.js` over MCP stdio |
| `mcp-live-smoke.mjs <projectDir>` | the `omnetpp/mcp/*` live-index requests on `dist/opp_lsp.js` (incl. unsaved-buffer reflection) |
| `lint-cli-smoke.mjs` | the bundled CLI linter (`dist/opp_lint.js`) — diagnostics, suppression, JSON shape, exit codes |
| `docgen-cli-smoke.mjs` | the bundled `dist/opp_docgen.js` — pages, links, options, exit codes |
| `neddoc-live-smoke.mjs` | the `omnetpp/generateDocs` request on the live index (incl. unsaved buffer, progress) |
| `elog-worker-smoke.mjs` | the bundled `dist/eventlogWorker.js` over its JSON-RPC transport, incl. mid-scan cancellation |
| `eventlog-ui-smoke.mjs` | the client eventlog session layer, headless, against the real worker |
| `eventlog-webview-smoke.mjs [<elog>]` | the real `dist/webview/sequenceChart.js` under happy-dom with a recording canvas |
| `autocomplete-dropdown-smoke.mjs` | `autocompleteDropdown.ts` DOM/keyboard behavior under happy-dom (imports the `.ts` source; no `dev:build` needed) |
| `semantic-check.mjs <projectDir>`, `ini-param-check.mjs`, `ini-struct-check.mjs`, `modhier-check.mjs` | analyzers directly, to gauge false positives on real code |
| `smoke-test.mjs [corpusDir]` | parses every `.ned`/`.msg` in a corpus and reports ERROR/MISSING nodes |
| `dump-tree.mjs` | dumps a tree-sitter parse tree |

## Releasing

GitHub Actions in `.github/workflows/`:

- `ci.yml` — every push/PR: `build:wasm`, compile, unit tests, `dev:build`,
  `lint-cli-smoke.mjs`, `lsp-smoke.mjs` and `lsp-cli-smoke.mjs`.
- `release.yml` — on a pushed `X.Y.Z` tag (no `v` prefix): builds the `.vsix` and the
  npm package (`omnetpp-opp-tools-X.Y.Z.tgz`) and creates the GitHub release with both
  attached, its notes taken from the `## X.Y.Z` section of `CHANGELOG.md`. It fails early
  if the tag differs from the `package.json` version or the section is missing. It
  publishes nothing.
- `publish.yml` — started by hand (**Actions → Publish → Run workflow**) with the tag of
  an existing release: downloads that release's files and publishes them, unchanged, to
  Open VSX, the VS Code Marketplace and npm. Each registry is a checkbox, so a publish
  that failed on one of them can be repeated for that one alone (a registry never takes
  the same version twice). The only secret is `NPM_TOKEN`: both extension registries use
  trusted publishing (`ovsx publish --trusted-publishing`, `vsce publish --oidc`), which
  exchanges the job's GitHub OIDC token for a short-lived publishing token. For that, the
  `opensim` Open VSX namespace has a trusted publisher
  (<https://open-vsx.org/user-settings/trusted-publishers>) and the `opensim` Marketplace
  publisher a policy (publisher page → **Trusted Publishing**), both for repository
  `omnetpp/omnetpp-vscode`, workflow `publish.yml` and no environment.

To release: bump `version` in `package.json`, add a `## X.Y.Z` section to `CHANGELOG.md`,
commit, and push the tag `X.Y.Z`. Check the GitHub release, then run `publish.yml` for
that tag.
