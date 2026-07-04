# Developer Guide

This document is for people **hacking on the OMNeT++ VS Code extension itself** —
building it, running the tests, understanding the architecture, and following the
project's conventions. If you only want to *use* the extension, see the
[User Guide](USER_GUIDE.md).

## What this project is

A VS Code extension plus language server for the OMNeT++ **NED**, **MSG**, and **INI**
languages. The language server is **pure TypeScript built on tree-sitter grammars** — it
needs **no OMNeT++ installation** to parse and analyze files. An OMNeT++ install only
*enriches* features (bundled NED libraries, a live config-option registry).

The same semantic core also powers two non-editor surfaces: a standalone **command-line
linter** (`opp_lint`) and an **MCP server** for AI agents. All three (IDE, CLI, MCP) run
the identical analyzers, so a diagnostic reported in one is reported in all.

## Toolchain: Bun only

**The dev toolchain is [Bun](https://bun.sh) only — no Node.js or npm is required** to
install, build, test, or package. Node still runs the *shipped* code (the extension and
language server execute in VS Code's bundled Node extension host, and `dist/opp_lint.js`
carries a `#!/usr/bin/env node` shebang for end users), but you do not need it on your
development machine.

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

The tree-sitter grammars live in **git submodules** under `subprojects/`.

```bash
refresh_submodules            # or: git submodule update --init --recursive
bun install
bun run build:wasm            # compile the NED/MSG tree-sitter grammars to WASM
```

`build:wasm` needs Emscripten (`emcc`) on your `PATH`, or Docker; the native
`tree-sitter` binary is auto-downloaded if missing.

## Commands

```bash
# Develop
bun run compile        # tsc --build: type-check all workspaces, emit .d.ts + out/
bun run watch          # tsc --build --watch
bun run dev:build      # copy:assets + esbuild bundle to dist/ (runtime artifacts;
                       #   assumes a prior `compile` — esbuild pulls shared from shared/out)
bun run bundle:watch   # esbuild in watch mode

# Test (bun:test over the TypeScript sources; shared + server test trees)
bun run test           # compile (type-check) THEN bun test ./shared/src/test ./server/src/test
bun test ./shared/src/test ./server/src/test   # tests only, no type-check
bun test ./shared/src/test/<name>.test.ts      # a single test file (./ prefix needed
                                               #   outside the bunfig test root)
bun test -t "<name substr>"                    # tests whose name matches

# Package / publish (prepackage chains compile + build:wasm + copy:assets + esbuild,
# so both work from a fresh checkout)
bun run package        # -> omnetpp-vscode-<version>.vsix
bun run deploy         # vsce publish
```

Press **F5** in VS Code to launch the Extension Development Host (see
`.vscode/launch.json`); the server attaches for debugging on port `6009`.

### Two build passes — do not conflate them

- **`tsc --build`** type-checks and emits `.d.ts` / `out/` for the TypeScript project
  references (and feeds esbuild, which bundles from `shared/out`).
- **`esbuild`** (`esbuild.mjs`) produces the actual runtime bundles in `dist/`:
  `extension.js`, `server.js`, `opp_ide_mcp.js`, and `opp_lint.js`.

Tests run via **`bun:test` over the TypeScript sources** (`shared/src/test`) — not the
`tsc` output and not the esbuild bundle. `bunfig.toml` pins the test `root` to
`shared/src/test`, so a bare `bun test` runs exactly that suite (and not the
`shared/out/test/*.js` copies that `tsc --build` also emits).

## Architecture

Four workspaces (a monorepo managed by Bun's workspaces), wired together by TypeScript
project references:

### `shared/` — the semantic core

The host-agnostic engine: tree-sitter parser wrapper, the AST/type model, and all
analyzers for NED/MSG/INI (diagnostics, navigation, completion, rename, hierarchy, INI
parameter resolution, and the cross-reference graph).

- **It must never import `vscode` or Node-specific APIs.** File access goes through the
  `FileSystem` interface in `shared/src/fs/fileSystem.ts`, which callers inject.
- The public surface is re-exported from `shared/src/index.ts`.
- It also hosts the **MCP tool layer** (`shared/src/mcp/tools.ts`): `OMNETPP_TOOLS` plus
  `handleTool(name, args, ctx)`, pure functions over a `ToolContext` (the caches + a
  `FileSystem`), with **no MCP-SDK dependency**. The SDK glue lives only in the adapters.

### `server/` — the LSP server

`server/src/server.ts` owns the LSP connection, the project index
(`projectIndex.ts`), and a concrete Node filesystem (`nodeFileSystem.ts`) that it injects
into `shared`. It translates LSP requests into `shared` calls. Bundled to `dist/server.js`
and spawned as a child process by the client. It also serves the `omnetpp/mcp/listTools` /
`omnetpp/mcp/callTool` custom requests by running `handleTool` against its **live** index
(so MCP results reflect unsaved editor buffers).

### `client/` — the VS Code extension

`client/src/extension.ts` is the thin VS Code glue: it starts the language client over
IPC and registers the activity-bar tree views (`views.ts`). Bundled to `dist/extension.js`
(the extension `main`). It also hosts a localhost Streamable-HTTP **MCP bridge**
(`mcpBridge.ts`, token-guarded) registered via `lm.registerMcpServerDefinitionProvider`,
which forwards tool calls to the live LSP index.

### `mcp/` — standalone disk-index tooling (runs without an editor)

Two artifacts that build their index from disk via `shared` (`indexBuilder.ts`):

- **stdio MCP server** — `mcp/src/server.ts`, bundled to `dist/opp_ide_mcp.js`, serving
  the same `OMNETPP_TOOLS`.
- **CLI linter** — `mcp/src/lint.ts`, bundled to `dist/opp_lint.js` (node shebang + the
  `opp_lint` `bin`). It reuses the shared `lintFile` — the same per-file analysis the
  `get_diagnostics` tool and the IDE use, suppression included.

`mcp/` uses `node16` module resolution because the MCP SDK ships subpaths via a
`package.json` `exports` map (the client uses `bundler` resolution for the same reason).

### Data flow

`client` reads `omnetpp.*` settings → passes them to `server` via LSP
`initializationOptions` → `server` builds the project index and answers requests using
`shared`. **All UI is currently tree views + input boxes — there are no webviews.**

## Conventions (patterns to follow)

- **Keep `shared/` free of `vscode` and Node imports.** Inject capabilities (filesystem,
  etc.) through interfaces. New analysis logic belongs in `shared/`; only LSP glue belongs
  in `server/`, only VS Code UI in `client/`.
- **New settings** go under the `omnetpp.*` namespace in `package.json`
  (`contributes.configuration`) and should be threaded through `initializationOptions` if
  the server needs them. Settings apply **live**: a `workspace.onDidChangeConfiguration`
  listener forwards `omnetpp.*` changes to the server, which re-reads `nedPath` /
  `installDir` and reindexes if either changed — no window reload.
- **Command-line tools must be named with the `opp_` prefix** (OMNeT++'s convention, e.g.
  `opp_msgc`, `opp_run`). This covers the `bin` command, the `dist/` bundle filename, and
  the program name shown in `--help`/usage.
- **Develop each feature in a separate commit** with a well-written description.
- **A new analyzer or tool should be reachable from all three surfaces.** Because IDE,
  CLI, and MCP share `lintFile` / the tool layer, adding analysis in `shared/` generally
  surfaces everywhere for free; prefer that over duplicating logic per host.

### Things that bite

- **Project-model discovery is not just open folders.** NED source roots come from
  `.nedfolders` / `.nedexclusions` / `package.ned` (see
  `shared/src/project/projectModel.ts`), plus the `omnetpp.nedPath` setting and the
  install dir.
- **INI config-option validation** uses a bundled snapshot at
  `resources/config/opp-config-options.json`, regenerated from an OMNeT++ source tree with
  `bun scripts/gen-config-options.mjs <omnetpp-src-dir>`. The MSG built-in types snapshot is
  regenerated with `bun scripts/gen-msg-builtins.mjs`.
- **MCP stdio is newline-delimited JSON**, not LSP `Content-Length` framing — keep the two
  transports straight when writing smoke scripts.

## Debugging / smoke scripts

`scripts/` holds standalone smoke/check scripts useful for exercising the parser,
analyzers, or an LSP/MCP feature outside VS Code. Run them with `bun scripts/<file>.mjs`
after `bun run compile` (they spawn the bundled servers via `process.execPath`, i.e. bun);
for the MCP/lint scripts run `bun run dev:build` first.

| Script | What it drives |
| --- | --- |
| `lsp-smoke.mjs`, `lsp-ini-smoke.mjs`, `lsp-project-smoke.mjs`, `lsp-modhier-smoke.mjs` | LSP features over `dist/server.js` |
| `workspace-diag-smoke.mjs` | asserts unopened workspace files still get diagnostics |
| `semantic-check.mjs`, `ini-param-check.mjs`, `ini-struct-check.mjs`, `modhier-check.mjs` | analyzers directly |
| `dump-tree.mjs` | dumps a tree-sitter parse tree |
| `mcp-smoke.mjs <projectDir>` | the standalone `dist/opp_ide_mcp.js` over MCP stdio |
| `mcp-live-smoke.mjs <projectDir>` | the `omnetpp/mcp/*` live-index requests on `dist/server.js` (incl. unsaved-buffer reflection) |
| `lint-cli-smoke.mjs` | the bundled CLI linter (`dist/opp_lint.js`) — diagnostics, suppression, JSON shape, exit codes |

## Releasing

GitHub Actions in `.github/workflows/` (`publish.yml`, `release.yml`) handle publishing.
Bump `version` in `package.json`, add a `CHANGELOG.md` entry, then package with
`bun run package` (or let CI run `bun run deploy`).
