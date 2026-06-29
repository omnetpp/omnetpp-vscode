# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension + language server for the OMNeT++ **NED**, **MSG**, and **INI**
languages. The language server is pure TypeScript built on tree-sitter grammars — it
requires **no OMNeT++ installation** to parse and analyze files. An OMNeT++ install
(`omnetpp.installDir` / `OMNETPP_ROOT`) only *enriches* features (bundled NED libraries,
live config-option registry).

## Architecture

Three npm workspaces (monorepo), wired together by TypeScript project references:

- **`shared/`** — the host-agnostic semantic core: tree-sitter parser wrapper, AST/type
  model, and all analyzers for NED/MSG/INI (diagnostics, navigation, completion, rename,
  hierarchy, INI param resolution). **It must never import `vscode` or Node-specific
  APIs.** File access goes through the `FileSystem` interface in
  `shared/src/fs/fileSystem.ts`, which callers inject. Public surface is re-exported from
  `shared/src/index.ts`.
- **`server/`** — the LSP server (`server/src/server.ts`). Owns the LSP connection,
  the project index (`projectIndex.ts`), and a concrete Node filesystem
  (`nodeFileSystem.ts`) that it injects into `shared`. Translates LSP requests into
  `shared` calls. Bundled to `dist/server.js` and spawned as a child process.
- **`client/`** — the thin VS Code extension (`client/src/extension.ts`). Starts the
  language client over IPC, registers the activity-bar tree views (`views.ts`). Bundled
  to `dist/extension.js` (the extension `main`).

Data flow: `client` reads `omnetpp.*` settings → passes them to `server` via LSP
`initializationOptions` → `server` builds the project index and answers requests using
`shared`. **All UI is currently tree views + input boxes — there are no webviews.**

### Things that bite

- **Settings are read once at activation** (`extension.ts` → `initializationOptions`).
  Changing `omnetpp.nedPath` / `omnetpp.installDir` requires a window reload to take
  effect; there is no live `didChangeConfiguration` handling.
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

```bash
# First-time setup (grammars live in git submodules under subprojects/)
refresh_submodules          # or: git submodule update --init --recursive
npm install
npm run build:wasm          # compile NED/MSG tree-sitter grammars to WASM
                            # (needs emscripten `emcc` on PATH, or Docker)

# Develop
npm run compile             # tsc --build (type-check all workspaces)
npm run watch               # tsc --build --watch
npm run dev:build           # copy:assets + esbuild bundle to dist/
npm run bundle:watch        # esbuild in watch mode

# Test (must compile first; runner is node:test over the tsc output)
npm test                    # npm run compile && node --test "shared/out/test/**/*.test.js"
node --test shared/out/test/<name>.test.js   # run a single test file (after `npm run compile`)

# Package / publish
npm run package             # vsce package -> .vsix
```

Press F5 in VS Code to launch the Extension Development Host (see `.vscode/launch.json`);
the server debug port is `6009`.

### Debugging / smoke scripts

`scripts/` holds standalone Node smoke/check scripts (e.g. `lsp-smoke.mjs`,
`semantic-check.mjs`, `ini-param-check.mjs`, `dump-tree.mjs`) useful for exercising the
parser/analyzers or an LSP feature outside VS Code. Run them with `node scripts/<file>.mjs`
after `npm run compile`.

## Conventions

- Keep `shared/` free of `vscode` and Node imports; inject capabilities (filesystem,
  etc.) through interfaces. New analysis logic belongs in `shared/`; only LSP glue belongs
  in `server/`, only VS Code UI in `client/`.
- New extension settings go under the `omnetpp.*` namespace in
  `package.json` (`contributes.configuration`) and should be threaded through
  `initializationOptions` if the server needs them.
