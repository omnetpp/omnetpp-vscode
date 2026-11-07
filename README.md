# OMNeT++ Development Environment

Visual Studio Code extension and language server for the OMNeT++ **NED**, **MSG**, and
**INI** languages.

The extension bundles a full language server written in **pure TypeScript on tree-sitter
grammars** — it parses and analyzes your model with **no OMNeT++ installation required**:
the built-in NED types and the config-option registry are bundled. The same semantic
engine is also available as **command-line tools**: a linter, a documentation generator,
a language server for other LSP editors, and an **MCP server for AI agents**.

Available in the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=opensim.omnetpp-vscode)
and the [Open VSX Registry](https://open-vsx.org/extension/opensim/omnetpp-vscode).
Alternatively, [download the latest release](https://github.com/omnetpp/omnetpp-vscode/releases/latest).

> **Note:** the Marketplace and Open VSX listings can lag behind and may not have all the
> features described here (compare with [CHANGELOG.md](CHANGELOG.md)). In that case,
> install the `.vsix` from the latest release.

## Documentation

The **[User Guide](docs/USER_GUIDE.md)** describes every feature in the editor and in the
command-line tools, how to install the tools, and the MCP tool reference.

## Feature highlights

- **NED, MSG, INI** language support: syntax highlighting, folding, and outline for all
  three; formatting for NED and MSG; snippets for NED and INI.
- **Content assist**: context-aware completion of keywords, type names, inherited
  parameters and gates, INI keys and values, and documentation-comment tags.
- **Diagnostics** for all three languages — syntax errors, duplicate/unknown types,
  inheritance and value-type checks, and full INI config-option validation. Quick fixes
  repair common problems, and inline `suppress(...)` directives silence individual codes.
- **Navigation & refactoring**: go-to-definition, find-references, hover, rename, type
  hierarchy, and a workspace symbol search — all of it **cross-language**
  (NED ⇄ MSG ⇄ INI). `Alt+O` switches between a module's `.cc`, `.h` and `.ned` files.
- **INI parameter resolution**: `**.param = value` keys are resolved against the expanded
  module tree of the selected `network`, flagging dead keys and type conflicts.
- **Reverse-dependency tooling**: a "Used By" view, CodeLens reference counts, and
  "Show Impact" — *what breaks if I change this?*
- **Graphical NED preview**: a read-only rendering of the type under the cursor with the
  Eclipse IDE's visualization — icons, display strings, inherited submodules, IDE-identical
  auto-layout — with click-to-navigate, zoom, and SVG/PNG export.
- **Sequence Chart & Event Log** for `.elog` event logs (recorded with
  `record-eventlog=true`): a zoomable graphical chart of events, module axes, and message
  arrows at Eclipse-IDE feature parity, plus a virtual Event Log table panel — handles
  multi-gigabyte logs with bounded memory, live-follows a still-running simulation, and
  supports event filtering, bookmarks, and SVG export.
- **NED documentation**: "Generate NED Documentation" builds HTML (three styles),
  Markdown, or reStructuredText documentation with module figures and usage/inheritance
  diagrams. The same generator runs standalone as `opp_docgen`.
- **Activity-bar views**: Configurations, Module Hierarchy, Module Parameters, NED
  Inheritance, and Used By.
- **Command-line tools** — `opp_lint` (linter for CI, pre-commit hooks, and scripts),
  `opp_docgen` (documentation generator), `opp_ide_mcp` (MCP server), and `opp_lsp`
  (the language server, for other LSP editors such as Neovim or Helix). Install them
  with the **OMNeT++: Install Command-Line Tools** command, or with
  `npm install -g @omnetpp/opp-tools` (Node.js 18+). No OMNeT++ install needed.
- **MCP tools** — 23 read/refactor tools that let an AI agent query and safely refactor
  your model, served live from the editor and by `opp_ide_mcp`, plus 7 `elog_*` tools
  for reading event logs (`opp_ide_mcp` only).
- **AI agent setup** — **OMNeT++: Set Up AI Agents…** installs OMNeT++ skills, the MCP
  server, a post-edit lint hook, and (for Claude Code) the language server into Claude
  Code, Codex and Devin, describes the project in `AGENTS.md`, and recommends the clangd
  C++ extension. Copilot in VS Code gets the skills and the live MCP tools with no
  setup.

See the [User Guide](docs/USER_GUIDE.md) for the full list and usage details.

## Requirements

VS Code **1.101.0** or newer. No OMNeT++ installation is required; if you have one, point
`omnetpp.installDir` at it to use its icons in the graphical NED preview and in generated
documentation.

## Installing

Install from the Marketplace / Open VSX, or install a `.vsix` manually: in the VS Code
**Extensions** side panel, choose **Install from VSIX…** from the `…` menu.

## License

Free for noncommercial use (teaching, academic research, personal non-profit use), on the
same conditions of use as the OMNeT++ simulation kernel's Academic Public License. Commercial use
requires a valid commercial [OMNEST](https://omnest.com) license. See [LICENSE](LICENSE)
for the full terms. Third-party components are listed with their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
