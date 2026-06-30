# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension + language server for the OMNeT++ **NED**, **MSG**, and **INI**
languages. The language server is pure TypeScript built on tree-sitter grammars — it
requires **no OMNeT++ installation** to parse and analyze files. An OMNeT++ install
(`omnetpp.installDir` / `OMNETPP_ROOT`) only *enriches* features (bundled NED libraries,
live config-option registry).

## Architecture

Four workspaces (monorepo, managed by Bun's workspaces), wired together by TypeScript project references:

- **`shared/`** — the host-agnostic semantic core: tree-sitter parser wrapper, AST/type
  model, and all analyzers for NED/MSG/INI (diagnostics, navigation, completion, rename,
  hierarchy, INI param resolution). **It must never import `vscode` or Node-specific
  APIs.** File access goes through the `FileSystem` interface in
  `shared/src/fs/fileSystem.ts`, which callers inject. Public surface is re-exported from
  `shared/src/index.ts`. Also hosts the **MCP tool layer** (`shared/src/mcp/tools.ts`):
  `OMNETPP_TOOLS` + `handleTool(name, args, ctx)`, pure functions over a `ToolContext`
  (the caches + a `FileSystem`), with **no MCP-SDK dependency** — the SDK glue lives only
  in the adapters below.
- **`server/`** — the LSP server (`server/src/server.ts`). Owns the LSP connection,
  the project index (`projectIndex.ts`), and a concrete Node filesystem
  (`nodeFileSystem.ts`) that it injects into `shared`. Translates LSP requests into
  `shared` calls. Bundled to `dist/server.js` and spawned as a child process. Also serves
  the `omnetpp/mcp/listTools` / `omnetpp/mcp/callTool` custom requests by running
  `handleTool` against its **live** index (so MCP results reflect unsaved buffers).
- **`client/`** — the thin VS Code extension (`client/src/extension.ts`). Starts the
  language client over IPC, registers the activity-bar tree views (`views.ts`). Bundled
  to `dist/extension.js` (the extension `main`). Also hosts a localhost Streamable-HTTP
  **MCP bridge** (`mcpBridge.ts`, token-guarded) registered via
  `lm.registerMcpServerDefinitionProvider`; it forwards tool calls to the live LSP index.
- **`mcp/`** — standalone disk-index tooling that runs without an editor. Hosts (a) a
  stdio MCP server (`mcp/src/server.ts`, bundled to `dist/opp_ide_mcp.js`) serving the same
  `OMNETPP_TOOLS`, and (b) the **CLI linter** (`mcp/src/lint.ts`, bundled to
  `dist/opp_lint.js` with a node shebang + the `opp_lint` `bin`). Both build their
  index from disk via `shared` (`indexBuilder.ts`); the linter reuses the shared `lintFile`
  (the same per-file analysis the `get_diagnostics` tool and the IDE use, suppression
  included). Uses `node16` module resolution because the MCP SDK ships subpaths via a
  package.json `exports` map (the client uses `bundler` resolution for the same reason).

Data flow: `client` reads `omnetpp.*` settings → passes them to `server` via LSP
`initializationOptions` → `server` builds the project index and answers requests using
`shared`. **All UI is currently tree views + input boxes — there are no webviews.**

### Things that bite

- **Settings apply live, via push.** `extension.ts` seeds the server through
  `initializationOptions`, then a `workspace.onDidChangeConfiguration` listener forwards any
  `omnetpp.*` change as a `DidChangeConfigurationNotification`. The server's
  `onDidChangeConfiguration` re-reads `nedPath` / `installDir` and, if either changed, calls
  `scheduleReindex()` — no window reload needed. `omnetpp.trace.server` is handled live by
  the `LanguageClient` itself.
- **Two separate build passes, do not conflate them.** `tsc --build` type-checks and
  emits `.d.ts`/`out/` for project references and tests. `esbuild` produces the actual
  runtime bundles in `dist/`. Tests run against the `tsc` output (`shared/out/`), **not**
  the esbuild bundle.
- **Project model discovery**: NED source roots come from `.nedfolders` /
  `.nedexclusions` / `package.ned` (see `shared/src/project/projectModel.ts`), plus the
  `omnetpp.nedPath` setting and the install dir — not just open workspace folders.
- **INI config-option validation** uses a bundled snapshot at
  `resources/config/opp-config-options.json`, regenerated from an OMNeT++ source tree
  via `node scripts/gen-config-options.mjs <omnetpp-src-dir>`.

## Commands

**Package manager / task runner is `bun`** (not npm). `node` is still the JS runtime
for the build (esbuild) and the test runner. Note: run the package.json `test` script
with `bun run test`, **not** `bun test` — the latter invokes Bun's own (incompatible)
test runner instead of the node:test suite.

```bash
# First-time setup (grammars live in git submodules under subprojects/)
refresh_submodules          # or: git submodule update --init --recursive
bun install
bun run build:wasm          # compile NED/MSG tree-sitter grammars to WASM
                            # (needs emscripten `emcc` on PATH, or Docker)

# Develop
bun run compile             # tsc --build (type-check all workspaces)
bun run watch               # tsc --build --watch
bun run dev:build           # copy:assets + esbuild bundle to dist/
bun run bundle:watch        # esbuild in watch mode

# Test (must compile first; runner is node:test over the tsc output)
bun run test                # bun run compile && node --test "shared/out/test/**/*.test.js"
node --test shared/out/test/<name>.test.js   # run a single test file (after `bun run compile`)

# Package / publish
bun run package             # vsce package --no-dependencies -> .vsix
```

Press F5 in VS Code to launch the Extension Development Host (see `.vscode/launch.json`);
the server debug port is `6009`.

### Debugging / smoke scripts

`scripts/` holds standalone Node smoke/check scripts (e.g. `lsp-smoke.mjs`,
`workspace-diag-smoke.mjs` (asserts unopened workspace files still get diagnostics),
`semantic-check.mjs`, `ini-param-check.mjs`, `dump-tree.mjs`) useful for exercising the
parser/analyzers or an LSP feature outside VS Code. Run them with `node scripts/<file>.mjs`
after `bun run compile`. For the MCP feature (after `bun run dev:build`):
`mcp-smoke.mjs <projectDir>` drives the standalone `dist/opp_ide_mcp.js` over MCP stdio;
`mcp-live-smoke.mjs <projectDir>` drives `dist/server.js` and exercises the
`omnetpp/mcp/*` live-index requests (incl. unsaved-buffer reflection). Note: MCP stdio is
**newline-delimited JSON**, not LSP `Content-Length` framing. `lint-cli-smoke.mjs` drives
the bundled CLI linter (`dist/opp_lint.js`) over a throwaway project (diagnostics,
suppression, JSON shape, exit codes).

## Conventions

- Keep `shared/` free of `vscode` and Node imports; inject capabilities (filesystem,
  etc.) through interfaces. New analysis logic belongs in `shared/`; only LSP glue belongs
  in `server/`, only VS Code UI in `client/`.
- New extension settings go under the `omnetpp.*` namespace in
  `package.json` (`contributes.configuration`) and should be threaded through
  `initializationOptions` if the server needs them.
- **Command-line tools must be named with the `opp_` prefix** (OMNeT++'s convention,
  e.g. `opp_msgc`, `opp_run`). This covers their `bin` command, their `dist/` bundle
  filename, and the program name shown in their `--help`/usage.
- Keep each new feature developed in a separate commit with a well written description.
