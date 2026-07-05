# OMNeT++ Development Environment

Visual Studio Code extension and language server for the OMNeT++ **NED**, **MSG**, and
**INI** languages.

The extension bundles a full language server written in **pure TypeScript on tree-sitter
grammars** — it parses and analyzes your model with **no OMNeT++ installation required**.
An OMNeT++ install only *enriches* features (bundled NED libraries, a live config-option
registry). The same semantic engine is also exposed as a **command-line linter** and an
**MCP server for AI agents**.

Available in the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=opensim.omnetpp-vscode)
and the [Open VSX Registry](https://open-vsx.org/extension/opensim/omnetpp-vscode).
Alternatively, [download the latest release](https://github.com/omnetpp/omnetpp-vscode/releases/latest)
or build it locally.

## Documentation

- **[User Guide](docs/USER_GUIDE.md)** — every feature in the IDE, the command-line
  linter, and the MCP agent layer: what it does, how to use it, and why it helps.
- **[Developer Guide](docs/DEVELOPMENT.md)** — building, testing, the architecture, and
  the project's conventions.

## Feature highlights

- **NED, MSG, INI** language support: syntax highlighting, folding, outline, and snippets.
- **Diagnostics** for all three languages — syntax errors, duplicate/unknown types,
  inheritance and value-type checks, and full INI config-option validation. Inline
  `suppress(...)` directives silence individual codes.
- **Navigation & refactoring**: go-to-definition, find-references, hover, rename, and a
  workspace symbol search — all of it **cross-language** (NED ⇄ MSG ⇄ INI).
- **INI parameter resolution**: `**.param = value` keys are resolved against the expanded
  module tree of the selected `network`, flagging dead keys and type conflicts.
- **Reverse-dependency tooling**: a "Used By" view, CodeLens reference counts, and
  "Show Impact" — *what breaks if I change this?*
- **Graphical NED preview**: a read-only rendering of the type under the cursor with the
  Eclipse IDE's visualization — icons, display strings, inherited submodules, IDE-identical
  auto-layout — with click-to-navigate, zoom, and SVG/PNG export.
- **Activity-bar views**: Configurations, Module Hierarchy, Module Parameters, NED
  Inheritance, and Used By.
- **`opp_lint`** — a standalone CLI for CI, pre-commit hooks, and scripts (no OMNeT++
  install needed).
- **MCP tools** — 22 read/refactor tools that let an AI agent query and safely refactor
  your model.

See the [User Guide](docs/USER_GUIDE.md) for the full list and usage details.

## Requirements

VS Code **1.101.0** or newer. No OMNeT++ installation is required; if you have one, point
`omnetpp.installDir` (or the `OMNETPP_ROOT` environment variable) at it to enable the
enriched features.

## Installing

Install from the Marketplace / Open VSX, or install a `.vsix` manually: in the VS Code
**Extensions** side panel, choose **Install from VSIX…** from the `…` menu.

## Building locally

See the [Developer Guide](docs/DEVELOPMENT.md). In short: [Bun](https://bun.sh) is the only
toolchain runtime (no Node.js/npm needed for development), then:

```bash
refresh_submodules     # fetch the tree-sitter grammar submodules
bun install
bun run build:wasm     # compile the NED/MSG grammars to WASM
bun run test           # type-check + run the unit tests
bun run package        # produce the .vsix
```

## License

Free for noncommercial use (teaching, academic research, personal non-profit use), on the
same conditions of use as the OMNeT++ simulation kernel's Academic Public License. Commercial use
requires a valid commercial [OMNEST](https://omnest.com) license. See [LICENSE](LICENSE)
for the full terms.
