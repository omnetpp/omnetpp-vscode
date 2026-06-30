# Change Log

## 0.0.4

- Ned: added 'parent' keyword

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

## 0.0.3

- Changed extension names to be more human-friendly

## 0.0.1

- Initial release
