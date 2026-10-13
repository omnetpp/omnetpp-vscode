# Change Log

## Unreleased

- **Doc fragments for NED documentation**: the Eclipse IDE's doc fragments file
  (`<docfragments>` XML) inserts extra content at fixed anchors of the type, package and
  namespace pages. Set it with `omnetpp.neddoc.fragmentsFile` or `opp_docgen -f <file>`
- **`--version` for the command-line tools**: `opp_lint`, `opp_docgen`, `opp_ide_mcp`
  and `opp_lsp` print their name and the package version (`opp_lint 1.0.0`)
- **`opp_lsp` command-line tool**: the extension's language server, for other LSP
  editors (Neovim, Helix, Emacs, …). It speaks LSP over stdio by default and takes
  library NED roots from `--ned-path` or `OMNETPP_NED_PATH`. Installed with the other
  command-line tools and by `@omnetpp/opp-tools`
- **"OMNeT++: Set Up AI Agents…"**: installs an OMNeT++ agent plugin (skills, a post-edit
  lint hook, and for Claude Code the language server) and the `opp_ide_mcp` MCP server
  into Claude Code, Codex and Devin through their own CLIs, writes a managed project
  section into `AGENTS.md`, and recommends the clangd C++ extension. Copilot in VS Code
  gets the OMNeT++ skills through the extension itself
- **OMNeT++ agent skills**: `omnetpp-tooling`, `omnetpp-modeling`,
  `omnetpp-model-development`, `omnetpp-coding-conventions`, `omnetpp-sim-debugging`,
  plus the optional `omnetpp-fingerprint-testing` and `omnetpp-model-refactoring`
- **`opp_lint --agent-hook`**: runs as an agent post-edit hook and reports the
  diagnostics of the edited NED/MSG/INI files back to the agent
- **`opp_ide_mcp` follows file changes**: before each tool call it re-reads the files
  that changed on disk, so an agent's edits show up without a server restart
- **Shared NED path**: the command-line tools read `omnetpp.nedPath` from the project's
  `.vscode/settings.json` when no `--ned-path` / `OMNETPP_NED_PATH` is given, and
  relative entries of the setting are resolved against the workspace folder

## 1.0.0

- **License change:** from 1.0.0 on, the extension and the command-line tools are licensed
  like the OMNeT++ / OMNEST simulation kernel — free for noncommercial use, commercial use
  with an OMNEST license (see `LICENSE`). Earlier versions remain under the MIT License
- **Sequence Chart and Event Log** for `.elog` eventlog files — a port of the Eclipse-based
  IDE's tools: a zoomable Sequence Chart custom editor (module axes, message arrows,
  timeline modes, axis vector data, rubber-band zoom) and a virtual Event Log table panel.
  Handles multi-gigabyte logs with bounded memory, live-follows a running simulation, and
  supports event filtering, cause/consequence tracing, bookmarks, and SVG export
- **7 `elog_*` MCP tools** for reading eventlog files (standalone `opp_ide_mcp` server)
- **Command-line tools for everyone**: "OMNeT++: Install Command-Line Tools" puts
  `opp_lint`, `opp_docgen` and `opp_ide_mcp` on the `PATH` (launchers that run on VS
  Code's own runtime, refreshed on updates), and the npm package `@omnetpp/opp-tools`
  installs them without VS Code (Node.js 18+). `opp_ide_mcp` is now a command with
  `--help`, like the other two
- **NED documentation generation** — "Generate NED Documentation" command and the
  standalone `opp_docgen` CLI: HTML (classic, Read the Docs, and Material styles),
  Markdown, or reStructuredText output with module figures, usage/inheritance diagrams,
  Doxygen tag-file links to C++ docs, and links to separately generated documentation
  of dependencies; configurable via `omnetpp.neddoc.*` settings
- **Switch between corresponding `.cc`/`.h`/`.ned` files** (`Alt+O`)
- **`find_member_accesses` MCP tool** — where NED parameters, gates, and submodules are
  accessed from C++ (23 NED/MSG/INI tools in total)
- NED type-name strings (e.g. `typename = "..."`) take part in navigation, references,
  rename, and diagnostics; INI `typename` values resolve against the slot's `like`
  interface
- INI `include` directives are merged and navigable; configs with several `extends=`
  bases use C3 linearization
- `.ini` files are considered only inside NED folders
- The graphical NED preview now finds icons via `OMNETPP_ROOT` when `omnetpp.installDir`
  is not set, like the rest of the extension and `opp_docgen`
- NED preview: back/forward history, toolbar with a type search box, Ctrl/Cmd-click
  drill-down into submodule types, drag scrolling, `g` (layout group) display-string tag,
  and richer connection tooltips

## 0.4.0

- **Graphical NED preview** — a read-only rendering of the NED type under the cursor,
  matching the Eclipse-based IDE's graphical editor: full display-string tag support
  (icons with tinting and size variants, shapes, ranges, background box/grid/image,
  connection styles/routing/bundling), inherited submodules and connections, `$param`
  placeholder visuals, and the IDE's seeded spring-embedder auto-layout. Opens beside the
  editor (preview button on NED files), follows the cursor, and can be pinned.
  Click-to-navigate, hover tooltips, zoom/fit/re-layout, SVG/PNG export. Icons resolve
  from project `images/` folders, the OMNeT++ install, or a bundled snapshot — no
  OMNeT++ installation required.

## 0.3.0

- **Cross-reference graph** spanning NED ⇄ MSG ⇄ INI: a single semantic database that
  powers reverse queries (who references a type, what a config runs, which INI keys assign
  a parameter)
- **Impact analysis** — "Show Impact (Reverse Dependencies)": the transitive set of types,
  configs, and files that break if you change a given type
- **"Used By" reverse-dependency tree view** (pinnable), showing what depends on the
  selected type
- **Cross-language Find All References, safe rename, and a workspace symbol provider**
  (`Ctrl+T`) that span NED and MSG
- **CodeLens with cross-reference counts** and cross-reference diagnostics with
  "did-you-mean" quick-fixes
- **MCP server for AI agents** — 22 read/refactor tools over the semantic model, available
  both as a standalone stdio server (`opp_ide_mcp`) and as a live in-editor bridge that
  reflects unsaved buffers
- **Standalone command-line linter** (`opp_lint`) — the same analyzers for CI, pre-commit
  hooks, and scripts, with text/JSON output and configurable exit codes
- **Inline diagnostic-suppression directives** (`//# suppress(code)` for NED/MSG,
  `### suppress(code)` for INI) with a lightbulb quick-fix
- **Workspace-wide diagnostics**: problems in files that aren't open in an editor still
  appear in the Problems view (configurable via `omnetpp.diagnostics.scope`)
- Build/test/package toolchain migrated to **Bun only** (no Node.js or npm required for
  development)

## 0.2.0

- Added a full language server (pure TypeScript on tree-sitter, no OMNeT++ install required)
- NED: diagnostics (syntax, duplicates, unknown/inheritance/type checks, value type checks),
  go-to-definition, find-references, hover, completion, and project-wide rename
- MSG: diagnostics, go-to-definition, hover and completion across imports
- INI: config-option validation and full parameter resolution against the network module
  tree, with config/parameter completion and hover
- Project model via `.nedfolders`/`package.ned`; `omnetpp.*` settings; INI language support
- Navigation of types in `import` statements (go-to-definition, references, hover, rename)
- Go-to-definition/hover for NED parameter references (incl. inherited and submodule
  overrides), and for submodule/gate names in connections
- Go-to-definition/hover from INI `**.param` keys to the resolved NED parameter declaration
- Document highlight of type occurrences
- Code actions: "Organize imports" (NED) and "Add missing parameter keys" (INI)
- Context-aware content assist that offers only meaningful items per cursor context
  (top-level keywords, kind-filtered types after extends/like/submodule/connection,
  inherited params/gates, INI config keys vs parameter paths vs typed values)
- Expanded INI diagnostics toward IDE parity: section-name validity, `extends=`
  placement/targets, `network=` type checks (no-such-type/not-a-module/not-a-network),
  global-only option placement, parameter unit/`@enum` checks, and a "same as NED
  default" info hint
- INI iteration variables (`${...}`): undefined-reference, redefinition and cross-section
  redeclaration diagnostics, predefined-variable awareness, plus variable completion and hover
- NED member refactoring: rename and find-references for parameters, gates and submodules
  (declarations, inherited overrides and connection endpoints)
- NED type hierarchy (super-/subtypes) via the editor's Type Hierarchy view
- Documentation-comment content assist (`@author`/`@see`/… and HTML tags) for NED and MSG
- Code snippets for common NED type skeletons and INI sections
- Three OMNeT++ tree views: Module Hierarchy, Module Parameters and NED Inheritance

## 0.0.4

- Ned: added 'parent' keyword

## 0.0.3

- Changed extension names to be more human-friendly

## 0.0.1

- Initial release
