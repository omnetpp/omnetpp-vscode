Visual Studio Code extension and language server for the OMNeT++ NED, MSG and INI languages.

The extension is available in the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=opensim.omnetpp-vscode) and the [Open VSX Registry](https://open-vsx.org/extension/opensim/omnetpp-vscode).

Alternatively, [Download latest release](https://github.com/omnetpp/omnetpp-vscode/releases/latest) or build locally.

## Features

The extension bundles a full **language server** (pure TypeScript, built on tree-sitter
grammars — no OMNeT++ installation required) that provides:

### NED files
- Syntax highlighting, brackets, comment toggling, code folding, document outline
- Diagnostics: syntax errors, duplicate names, unknown base/interface/submodule
  types, inheritance kind mismatches, and parameter default value type checks
- Go-to-definition, find-references and hover docs for types (across the workspace)
- Content assist for type names (after `extends`/`like`, submodule type, channel)
- Rename refactoring for types, updating every reference across the project

### MSG files
- Syntax highlighting, folding, document outline
- Diagnostics: syntax errors, duplicate names, conservative unknown-type checks
- Go-to-definition, hover and completion across imported message files

### INI files (omnetpp.ini)
- Syntax highlighting, folding, section outline
- Validation of configuration option keys and their value types (from a bundled
  snapshot of the OMNeT++ config registry)
- **Full parameter resolution**: `**.param = value` keys are resolved against the
  module tree of the selected `network` (expanding submodules, vectors, `like` and
  conditional submodules), flagging assignments to non-existent parameters and
  values whose type conflicts with the NED declaration
- Content assist for config options and reachable parameter paths; hover docs for
  config options

### Suppressing diagnostics

Any diagnostic can be silenced in-source with a `suppress(...)` directive that
names the diagnostic's code (shown in the Problems view / hover), placed either on
the line **before** the reported line or as a **trailing** comment on it:

- **NED & MSG** use a *private* comment `//#` (kept out of generated docs):

  ```ned
  //# suppress(duplicate)
  simple Host { ... }

  channel C extends ned.DatarateChannel { } //# suppress(unknown-type)
  ```

- **INI** uses a `###` comment:

  ```ini
  ### suppress(no-matching-param)
  **.unknownParam = 5

  *.host.x = 5   ### suppress(no-matching-param)
  ```

`suppress()` with no code silences every diagnostic on the target line;
`suppress(a, b)` silences several. A lightbulb **Quick Fix** on any diagnostic
inserts the matching directive for you. (One limitation: for MSG, a trailing
directive on a *type header* line isn't seen — put it on the line above instead.)

The project model honors `.nedfolders` / `.nedexclusions` / `package.ned`, falling
back to indexing workspace folders. Extra NED roots can be added via the
`omnetpp.nedPath` setting; an OMNeT++ install (`omnetpp.installDir` or the
`OMNETPP_ROOT` environment variable) is indexed as an additional source root.

## Command-line linter

The same analyzers are available outside the IDE as a standalone CLI, for CI,
pre-commit hooks, or scripts. It needs no OMNeT++ installation and honors the
inline `suppress(...)` directives described above.

```bash
omnetpp-lint [options] [path ...]            # paths default to the current dir

omnetpp-lint src/                            # lint a directory tree
omnetpp-lint Host.ned omnetpp.ini            # lint specific files
omnetpp-lint --format=json src/ > lint.json  # machine-readable output
omnetpp-lint --ned-path=/opt/inet/src src/   # add libraries for cross-file resolution
```

Options: `--ned-path=<dirs>` (extra source roots, indexed but not linted),
`--format=text|json`, `--severity=error|warning|info|hint` (minimum to report),
`--fail-on=error|warning|info|hint|never` (exit-code threshold, default `error`),
`--no-color`, `-h`. Exit code is `1` when diagnostics at or above `--fail-on` are
found, `0` otherwise, `2` on usage/runtime errors.

The runtime artifact is `dist/omnetpp-lint.js` (produced by `npm run dev:build`);
run it directly with `node dist/omnetpp-lint.js …`, or install the extension's
package to get the `omnetpp-lint` command on your `PATH`.

## Settings

- `omnetpp.nedPath` — extra NED source root directories (semicolon-separated)
- `omnetpp.installDir` — OMNeT++ installation root (also indexed for NED)
- `omnetpp.diagnostics.scope` — `workspace` (default; analyse every file) or `openFiles`
- `omnetpp.iniAnalysis.enabled` / `omnetpp.iniAnalysis.timeoutMs`
- `omnetpp.trace.server` — language-server trace level

## Requirements

VS Code version 1.92 or higher.

## Building locally

Node.js is required for building the extension locally (see https://nodejs.org).
Building the tree-sitter WASM grammars requires `emscripten` (emcc) or Docker.

- Clone this repo and run `refresh_submodules` to fetch the grammar submodules
- `npm install`
- `npm run build:wasm` — compile the NED/MSG grammars to WASM
- `npm run compile && npm test` — type-check and run the unit tests
- `npm run package` — produce the `.vsix`

The architecture is split into npm workspaces: `client/` (the VS Code language
client), `server/` (the LSP server), and `shared/` (the host-agnostic semantic
core: parsers, type model, analyzers). The config-option snapshot is regenerated
with `node scripts/gen-config-options.mjs <omnetpp-src-dir>`.

## Installing

In VSCode / Extensions side panel, select 'Install from VSIX...' from the ... menu.

## License

Free for noncommercial use (teaching, academic research, personal non-profit use), on the
same conditions of use as the OMNeT++ simulation kernel's Academic Public License. Commercial use
requires a valid commercial [OMNEST](https://omnest.com) license. See [LICENSE](LICENSE)
for the full terms.
