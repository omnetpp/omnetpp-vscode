# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension + language server for the OMNeT++ **NED**, **MSG**, and **INI**
languages. The language server is pure TypeScript (NED/MSG on tree-sitter grammars, INI
on a hand-written port of the IDE's `InifileParser`) — it requires **no OMNeT++
installation** to parse and analyze files: the `ned.*` types are built in and INI
validation uses a bundled config-option snapshot. An OMNeT++ install
(`omnetpp.installDir` / `OMNETPP_ROOT`) is used **only as an icon source**
(`<installDir>/images`); it is never a NED source root. The NED preview panel reads only
the setting, not `OMNETPP_ROOT`.

## Architecture

Four Bun workspaces (`shared`, `server`, `client`, `mcp`), type-checked as six TypeScript
projects wired by project references (`client/webview/` and `client/worker/` are separate
tsc projects inside the `client` workspace):

- **`shared/`** — the host-agnostic semantic core: tree-sitter parser wrapper, AST/type
  model, and all analyzers for NED/MSG/INI (diagnostics, navigation, completion, rename,
  hierarchy, INI param resolution), plus the xref graph, C++ scanner, neddoc generator,
  match expressions and eventlog engine. **It must never import `vscode` or Node-specific
  APIs**, except `shared/src/node/` (`NodeFileSystem`, `NodeRandomAccessFile`, …), which
  is published only as the `@omnetpp/shared/node` subpath and imported explicitly by Node
  hosts. File access goes through the `FileSystem` interface in
  `shared/src/fs/fileSystem.ts`, which callers inject. The main surface is re-exported from
  `shared/src/index.ts`; curated subpaths (`/node`, `/protocol`, `/preview`, `/eventlog`,
  `/elog-protocol`, `/ui-protocol`, `/entry-proposals`, `/style-rules`, `/match`,
  `/elog-tools`) are listed in `shared/package.json` `exports`. Also hosts the **MCP tool layer** (`shared/src/mcp/tools.ts`):
  `OMNETPP_TOOLS` + `handleTool(name, args, ctx)`, pure functions over a `ToolContext`
  (the caches + a `FileSystem`), with **no MCP-SDK dependency** — the SDK glue lives only
  in the adapters below.
- **`server/`** — the LSP server (`server/src/server.ts`). Owns the LSP connection,
  the project index (`projectIndex.ts`), and injects the Node filesystem
  (`NodeFileSystem` from `@omnetpp/shared/node`) into `shared`. Translates LSP requests into
  `shared` calls. Bundled to `dist/server.js` and spawned as a child process. Also serves
  the `omnetpp/mcp/listTools` / `omnetpp/mcp/callTool` custom requests by running
  `handleTool` against its **live** index (so MCP results reflect unsaved buffers).
- **`client/`** — the thin VS Code extension (`client/src/extension.ts`). Starts the
  language client over IPC, registers the activity-bar tree views (`views.ts`) and the
  **graphical NED preview panel** (`nedPreviewPanel.ts`: follows the cursor via the
  `omnetpp/nedPreview` request, resolves icon ids to webview URIs using the Eclipse
  search order — project `images/` → `omnetpp.installDir/images` → bundled
  `dist/icons`), the Generate NED Documentation command (`docsCommand.ts`), the `Alt+O`
  C++/NED switch (`counterparts.ts`), the Install/Uninstall Command-Line Tools commands
  (`cliTools.ts`), and the eventlog editor/view (`client/src/eventlog/`). Bundled to
  `dist/extension.js` (the extension `main`). Also hosts a
  localhost Streamable-HTTP **MCP bridge** (`mcpBridge.ts`, token-guarded) registered via
  `lm.registerMcpServerDefinitionProvider`; it forwards tool calls to the live LSP index.
  The **preview webview app** lives separately in `client/webview/` (own tsconfig: DOM
  lib, no node/vscode types; bundled to `dist/webview/nedPreview.js` as a browser IIFE).
  It may import ONLY `@omnetpp/shared/preview` (a curated browser-safe subpath: the
  display-string instance model + `shared/src/graphics/` math ports — spring embedder,
  arrowcoords, X11 colors) plus type-only protocol imports, so the bundle never pulls in
  web-tree-sitter or Node APIs.
- **`mcp/`** — standalone disk-index tooling that runs without an editor. Three CLI
  artifacts, each bundled with a node shebang and listed as a `bin`: (a) a stdio MCP
  server (`mcp/src/server.ts` → `dist/opp_ide_mcp.js`) serving the same `OMNETPP_TOOLS`
  plus the `elog_*` tools, (b) the **CLI linter** (`mcp/src/lint.ts` →
  `dist/opp_lint.js`), and (c) the **documentation generator** (`mcp/src/neddoc.ts` →
  `dist/opp_neddoc.js`). All build their index from disk via `shared`
  (`indexBuilder.ts`) and find their assets (`wasm/`, `config/`, `icons/`,
  `neddoc-material/`) next to the script. The linter reuses the shared `lintFile`, the
  same per-file analysis the `get_diagnostics` MCP tool uses, suppression included.
  **The IDE does not use `lintFile`**: `server/src/features/diagnostics.ts`
  (`computeDiagnostics`) is a separate list that also follows INI `include`s and reports
  `unused-network`. All projects inherit `node16` module resolution from
  `tsconfig.base.json` (web-tree-sitter and the MCP SDK ship subpaths via `exports`
  maps); `client/` and `client/webview/` override it to `bundler`.
- **CLI distribution** (the source is not released): the npm package
  `@omnetpp/opp-tools` (manifest + README template in `mcp/npm/`, staged into
  `build/opp-tools/` by `scripts/pack-cli.mjs`), and the **Install Command-Line Tools**
  command (`client/src/cliTools.ts`), which writes marker-tagged shims into
  `~/.local/bin` / `%LOCALAPPDATA%\omnetpp\bin` that run the extension's `dist/` bundles
  on VS Code's runtime (`ELECTRON_RUN_AS_NODE=1`) and are rewritten on activation after
  an update.

The **eventlog subsystem** (Sequence Chart custom editor for `*.elog` + Event Log table
panel view) spans these workspaces: the engine in `shared/src/eventlog/` is a
host-agnostic TypeScript port of the OMNeT++ Java eventlog library (indexed random
access, bounded memory — built for multi-GB logs and live follow of a running
simulation). Each open `.elog` gets its own worker child process (`client/worker/` →
`dist/eventlogWorker.js`): JSON-RPC over stdio on the main thread, the synchronous
engine on a `node:worker_threads` thread with real mid-scan cancellation. The two
webview apps live under `client/webview/src/eventlog/` (browser IIFE bundles
`dist/webview/sequenceChart.js` / `dist/webview/eventLogTable.js`, protocol in
`shared/src/eventlog/uiProtocol.ts`). The `elog_*` MCP tools
(`shared/src/mcp/elogTools.ts`) are served by the standalone `dist/opp_ide_mcp.js` only,
not by the live LSP bridge.

Data flow: `client` reads `omnetpp.*` settings → passes them to `server` via LSP
`initializationOptions` → `server` builds the project index and answers requests using
`shared`. **UI is tree views + input boxes + webviews** (the NED preview panel, the
Sequence Chart editor, and the Event Log table; keep any new webview code under
`client/webview/` and browser-safe).

### Things that bite

- **Settings apply live, via push.** `extension.ts` seeds the server through
  `initializationOptions`, then a `workspace.onDidChangeConfiguration` listener forwards any
  `omnetpp.*` change as a `DidChangeConfigurationNotification`. The server's
  `onDidChangeConfiguration` re-reads `nedPath` / `installDir` and, if either changed, calls
  `scheduleReindex()`; it also applies `diagnostics.scope` and `codeLens.iniParams` — no
  window reload needed. `omnetpp.trace.server` is handled live by the `LanguageClient`
  itself. The `omnetpp.neddoc.*`, `omnetpp.eventlog.*` and `omnetpp.sequenceChart.*`
  settings are read in `client/` only and never sent to the server.
- **Two separate build passes, do not conflate them.** `tsc --build` type-checks and
  emits `.d.ts`/`out/` for project references (and feeds esbuild, which bundles from
  `shared/out`). `esbuild` produces the actual runtime bundles in `dist/`. Tests run via
  `bun:test` over the **TypeScript sources** (`shared/src/test` and the glue trees
  `server/src/test`, `client/webview/src/test`, `client/worker/src/test`), not the `tsc`
  output and not the esbuild bundle. `dist/` is never cleaned, so stale files end up in
  the `.vsix`; delete it before packaging a release.
- **Project model discovery**: NED source roots come from `.nedfolders` /
  `.nedexclusions` / `package.ned` (see `shared/src/project/projectModel.ts`), plus the
  `omnetpp.nedPath` setting — not just open workspace folders. The install dir is never
  a root.
- **The NED preview's icon set** is a bundled snapshot at `resources/icons/`
  (+ `index.json` with natural sizes), regenerated from an OMNeT++ source tree via
  `bun scripts/gen-icons.mjs <omnetpp-src-dir>`. Display-string semantics (parsing,
  fallback chains, defaults) live in `shared/src/ned/displayStringModel.ts` — a faithful
  port of the IDE's `DisplayString.java`; the scene DTO is built in
  `shared/src/ned/nedPreviewScene.ts` and rendered by `client/webview/`.
- **INI config-option validation** uses a bundled snapshot at
  `resources/config/opp-config-options.json`, regenerated from an OMNeT++ source tree
  via `bun scripts/gen-config-options.mjs <omnetpp-src-dir>`. The other snapshots:
  `resources/config/msg-builtin-types.json` (`gen-msg-builtins.mjs <omnetpp-src-dir>`),
  `resources/neddoc-material/` (`gen-neddoc-material-assets.mjs <omnetpp-src-dir>`), and
  `shared/src/eventlog/entries.ts` (`gen-eventlog-entries.mjs [<omnetpp-src-dir>]`).

## Commands

**The dev toolchain is `bun` only — no Node.js or npm required to install, build, test,
or package.** Because bun runs a tool's `#!/usr/bin/env node` bin via Node (not itself),
JS tools are invoked by file path so they run under bun: `compile`/`watch` run
`bun ./node_modules/typescript/bin/tsc`, `package`/`deploy` run
`bun ./node_modules/@vscode/vsce/vsce`, and the `.mjs` build scripts / `esbuild.mjs` are
run as `bun ./script.mjs`. `trustedDependencies` is intentionally empty so `bun install`
runs no dependency postinstall (they are all `node install.js`); esbuild's binary comes
from its `@esbuild/<platform>` package and the native `tree-sitter` binary is fetched on
demand by `scripts/build-wasm.mjs` (via `fetch`). vsce's prepublish hook is avoided by
naming the build step `prepackage` (not `vscode:prepublish`) and calling it from
`package`/`deploy`, so vsce never shells out to npm. **Node still runs the *shipped*
code** — the extension + LSP server run in VS Code's bundled Node extension host, so
esbuild keeps `platform: node`; and the `dist/opp_*.js` CLI bundles carry a
`#!/usr/bin/env node` shebang for end users running them standalone (Node 18+).

Tests use **Bun's test runner** (`bun:test`) over the TypeScript sources directly — no
compile-to-JS needed to run them. `bunfig.toml` pins the test `root` to `shared/src/test`,
so a bare `bun test` runs exactly that suite (and not the `shared/out/test/*.js` copies
that `tsc --build` also emits). Glue tests live in `server/src/test`,
`client/webview/src/test` and `client/worker/src/test` (excluded from their tsc builds
because they import `bun:test`); `bun run test` runs **all four** trees by passing
explicit `./`-prefixed paths, which override the bunfig root. It also
runs `tsc --build` first so type errors surface alongside test failures.

```bash
# First-time setup (grammars live in git submodules under subprojects/)
./refresh_submodules        # or: git submodule update --init --recursive
                            # (the tree-sitter submodules use SSH URLs)
bun install
bun run build:wasm          # compile NED/MSG tree-sitter grammars to WASM
                            # (needs emscripten `emcc` on PATH, or Docker; the native
                            #  tree-sitter binary is auto-downloaded if missing)

# Develop
bun run compile             # tsc --build (type-check all workspaces)
bun run watch               # tsc --build --watch
bun run dev:build           # copy:assets + esbuild bundle to dist/ (assumes a prior
                            #  `compile`; esbuild resolves @omnetpp/shared to shared/out)
bun run bundle:watch        # esbuild in watch mode

# Test (bun:test over the TS sources; bun run test also type-checks first)
bun run test                # compile + bun test over all four test trees
bun test ./shared/src/test/<name>.test.ts    # run a single test file (./ prefix
                                             #  needed outside the bunfig test root)
bun test -t "<name substr>"                  # run tests whose name matches (shared
                                             #  tree only; add ./paths for the others)

# Package / publish (prepackage chains compile + build:wasm + copy:assets + esbuild,
# so packaging works from a fresh checkout)
bun run package             # vsce package --no-dependencies -> .vsix
bun run package:cli         # -> build/omnetpp-opp-tools-<version>.tgz (npm package)
bun run deploy:cli          # bun publish @omnetpp/opp-tools
```

Press F5 in VS Code to launch the Extension Development Host (see `.vscode/launch.json`);
in debug mode the server listens on inspector port `6009` ("Attach to Server").

### Debugging / smoke scripts

`scripts/` holds standalone smoke/check scripts (e.g. `lsp-smoke.mjs`,
`workspace-diag-smoke.mjs` (asserts unopened workspace files still get diagnostics),
`semantic-check.mjs`, `ini-param-check.mjs`, `dump-tree.mjs`) useful for exercising the
parser/analyzers or an LSP feature outside VS Code. Run them with `bun scripts/<file>.mjs`
after `bun run compile` (the analyzer-only checks) or `bun run compile && bun run dev:build`
(everything that spawns a `dist/` bundle via `process.execPath`, i.e. bun).
For the MCP feature (after `bun run dev:build`):
`mcp-smoke.mjs <projectDir>` drives the standalone `dist/opp_ide_mcp.js` over MCP stdio;
`mcp-live-smoke.mjs <projectDir>` drives `dist/server.js` and exercises the
`omnetpp/mcp/*` live-index requests (incl. unsaved-buffer reflection);
`preview-smoke.mjs` checks the `omnetpp/nedPreview` scene request shape the same way.
`counterparts-smoke.mjs [<projectDir> <file>…]` checks the `omnetpp/counterparts` request (the
`Alt+O` .cc/.h/.ned switch) the same way, with the C++ files not open as LSP documents. Note: MCP stdio is
**newline-delimited JSON**, not LSP `Content-Length` framing. `lint-cli-smoke.mjs` drives
the bundled CLI linter (`dist/opp_lint.js`) over a throwaway project (diagnostics,
suppression, JSON shape, exit codes). For the eventlog feature (after `bun run dev:build`):
`elog-worker-smoke.mjs` drives the bundled worker (`dist/eventlogWorker.js`) end to end
over its JSON-RPC transport, `eventlog-ui-smoke.mjs` drives the client session layer
headlessly, and `eventlog-webview-smoke.mjs [<elog>]` loads the real
`dist/webview/sequenceChart.js` bundle under happy-dom with a recording canvas —
the only automated coverage of the webview's browser-only glue (DOM scaffold, init
handshake, render loop). `autocomplete-dropdown-smoke.mjs` covers
`common/autocompleteDropdown.ts`'s DOM/keyboard behavior the same way (happy-dom,
standalone script — needs no `dev:build`, imports the `.ts` source directly), most
notably the document-capture-phase keydown interception the Event Log Table's
Custom-filter content-assist popup relies on to pre-empt `toolbar.ts`'s own
commit-on-Enter listener. None of these can catch extension-host-only issues (e.g. the
`ELECTRON_RUN_AS_NODE` worker-spawn requirement in `workerClient.ts`); the manual F5
checklist is `docs/eventlog-manual-tests.md`.

## Conventions

- Keep `shared/` free of `vscode` and Node imports; inject capabilities (filesystem,
  etc.) through interfaces. New analysis logic belongs in `shared/`; only LSP glue belongs
  in `server/`, only VS Code UI in `client/`.
- New extension settings go under the `omnetpp.*` namespace in
  `package.json` (`contributes.configuration`) and should be threaded through
  `initializationOptions` if the server needs them.
- **Command-line tools must be named with the `opp_` prefix** (OMNeT++'s convention,
  e.g. `opp_msgc`, `opp_run`). This covers their `bin` command, their `dist/` bundle
  filename, and the program name shown in their `--help`/usage. A new tool also needs an
  entry in `mcp/npm/package.json` `bin` and in the `TOOLS` lists of
  `scripts/pack-cli.mjs` and `client/src/cliTools.ts`.
- A new analyzer must be wired into **both** `computeDiagnostics`
  (`server/src/features/diagnostics.ts`, the IDE) and `lintFile`
  (`shared/src/mcp/tools.ts`, CLI + MCP `get_diagnostics`); the lists are separate.
- Keep each new feature developed in a separate commit with a well written description.
