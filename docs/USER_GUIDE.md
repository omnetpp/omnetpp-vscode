# User Guide

This guide describes every feature the OMNeT++ extension currently implements, across its
three surfaces:

1. [**In the IDE**](#1-in-the-ide) — language support, navigation, refactoring, diagnostics, and the activity-bar views.
2. [**On the command line**](#2-command-line-linter-opp_lint) — the standalone `opp_lint` linter.
3. [**For AI agents (MCP)**](#3-ai-agent-integration-mcp) — querying and refactoring your model from an AI assistant.

All three run the **same analyzers** built on tree-sitter, so a diagnostic you see in the
editor is the same one the CLI reports and an agent can fetch. **No OMNeT++ installation is
required** — an install only adds bundled NED libraries and a live config-option registry.

> **Tip — enrich features with your OMNeT++ install:** set `omnetpp.installDir` (or the
> `OMNETPP_ROOT` environment variable) to your OMNeT++ root. That directory is then indexed
> as an extra NED source root, giving you the bundled `ned.*` library types and a live
> config-option registry.

---

## 1. In the IDE

### Languages: NED, MSG, INI

The extension registers three languages — **OMNeT++ NED** (`.ned`), **OMNeT++ MSG**
(`.msg`), and **OMNeT++ INI** (`.ini`).

**Feature.** Syntax highlighting, bracket matching, comment toggling, code folding, and a
document outline (Outline view / breadcrumbs) for all three. Code **snippets** for common
NED type skeletons and INI sections.

**How to use it.** Open any `.ned`, `.msg`, or `.ini` file — the extension activates
automatically (it also activates as soon as a workspace contains a `.ned` file). Snippets
appear in completion; start typing a keyword such as `simple` or `[Config` and accept the
suggestion.

**Advantage.** A modern editing experience for OMNeT++ models with zero setup and without
needing the OMNeT++ IDE.

### Diagnostics (error checking)

**Feature.** Live problem reporting in the editor and the Problems panel:

- **NED** — syntax errors, duplicate names, unknown base/interface/submodule/channel
  types, inheritance-kind mismatches, and parameter default value type checks.
- **MSG** — syntax errors, duplicate names, conservative unknown-type checks.
- **INI** — configuration-option key and value-type validation (against a bundled snapshot
  of the OMNeT++ config registry), section-name validity, `extends=`/`network=` checks,
  global-option placement, iteration-variable (`${…}`) checks, and **full parameter
  resolution** (see below).
- **Cross-reference diagnostics** with **"did-you-mean" quick-fixes** that suggest the
  closest known type/parameter name when a reference doesn't resolve.

**How to use it.** Just edit — problems update as you type and are listed in the
**Problems** panel (`Ctrl+Shift+M`). By default the whole workspace is analyzed, so errors
in files you haven't opened still show up; switch with `omnetpp.diagnostics.scope`
(`workspace` vs `openFiles`).

**Advantage.** Catches modeling mistakes — typos in type names, broken inheritance,
mis-typed parameters, invalid config options — before you ever run a simulation.

### INI parameter resolution

**Feature.** `**.param = value` keys in `omnetpp.ini` are resolved against the **expanded
module tree** of the selected `network` — submodules, vectors, `like` and conditional
submodules are all expanded. The extension flags assignments to **non-existent
parameters** and values whose **type conflicts** with the NED declaration, and offers
go-to-definition / hover from an INI key straight to the NED parameter it assigns.

**How to use it.** Open an `omnetpp.ini`. Resolution uses the config's `network` (and its
`extends` chain). To resolve against a particular configuration interactively, set it as
the **active configuration** (see [Configurations](#configurations-view)).

**Advantage.** The single most error-prone part of an OMNeT++ setup — wiring parameters
through a deep module tree — becomes verifiable. Dead keys (that match nothing) and
type mismatches are caught immediately.

### Navigation & cross-references

**Feature.** Across the whole project, and **across languages** (NED ⇄ MSG ⇄ INI):

- **Go to Definition** (`F12`) and **Hover** for types, parameters (including inherited and
  submodule overrides), gate/submodule names in connections, `import` targets, INI
  `**.param` keys → the NED declaration, and NED `@class`/`@signal` backing classes → their
  MSG declarations.
- **Find All References** (`Shift+F12`) — symmetric and cross-language.
- **Workspace Symbol search** (`Ctrl+T`) — jump to any NED/MSG type by name.
- **Document Highlight** — every occurrence of the type under the cursor.
- **CodeLens** showing cross-reference counts above declarations.

**How to use it.** Standard VS Code gestures (`F12`, `Shift+F12`, `Ctrl+T`, hover). Hover
docs render documentation comments, with clickable `~Symbol` references.

**Advantage.** Navigate large model libraries (e.g. INET) the way you navigate code —
following types, parameters, and signals across NED and MSG boundaries.

### Refactoring & code actions

**Feature.**

- **Rename** (`F2`) — project-wide, cross-language safe rename of NED **types** and of
  **members** (parameters, gates, submodules), updating declarations, inherited overrides,
  and connection endpoints everywhere.
- **Content assist (completion)** — context-aware: top-level keywords; kind-filtered type
  names after `extends`/`like`/submodule/channel; inherited params and gates; INI config
  keys vs. parameter paths vs. typed values; and documentation-comment assist
  (`@author`/`@see`/… and HTML tags).
- **Quick Fixes / code actions** — "Organize imports" (NED: add missing, drop unused,
  sort), "Add missing parameter keys" (INI), "did-you-mean" reference fixes, and the
  **insert-suppress** fix (below).

**How to use it.** `F2` to rename; `Ctrl+Space` for completion; the lightbulb (`Ctrl+.`)
for quick fixes.

**Advantage.** Safe, mechanical edits that would otherwise be error-prone text search-and-
replace across many files.

### Suppressing diagnostics

**Feature.** Any diagnostic can be silenced in-source with a `suppress(...)` directive that
names the diagnostic's **code** (shown in the Problems view / hover), placed either on the
line **before** the reported line or as a **trailing** comment on it.

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

`suppress()` with no code silences every diagnostic on the target line; `suppress(a, b)`
silences several. A lightbulb **Quick Fix** on any diagnostic inserts the matching
directive as a **trailing comment on that line**.

> One MSG quirk: the grammar drops a trailing comment on a *type header* line, so a
> directive there can't be trailing — it must go on the line above. The Quick Fix knows
> this and, for MSG type-header diagnostics only, inserts the directive on the line above
> instead.

**How to use it.** Hover a diagnostic (or read the Problems view) to see its code, then add
the directive — or use the quick fix.

**Advantage.** Silence known-acceptable warnings precisely, per-line and per-code, without
turning off whole checks — and the directives are honored identically by the CLI linter.

### Activity-bar views

The extension contributes an **OMNeT++** container to the activity bar with five tree
views. Four of them (**Module Hierarchy**, **Module Parameters**, **NED Inheritance**,
**Used By**) *follow the editor cursor*: as you move the caret onto a NED/MSG type, the view
re-queries and its title updates to e.g. *"AODVRouter Inheritance"*. Each can be **pinned**
to freeze it on the current focus so it stops following the cursor; pins persist across
sessions. (When no NED editor is active but a configuration is active, these views fall
back to that config's network type.)

#### Configurations view

**Shows.** Every non-abstract `[Config …]`/`[General]` section in the workspace, grouped by
`.ini` file.

**Use.** It does *not* follow the cursor — it refreshes automatically as `.ini` files
change. Title-bar actions let you **Filter** / **Clear filter** the list, **Refresh**, and
**Clear** the active configuration. The key concept here is the **Active Configuration**:

- Set one via the inline **Set as Active Config** check on a config node, or
  **"Set as Active Configuration"** from the editor context menu while the cursor is inside
  a `[Config …]` section of an `.ini`.
- The active config is highlighted (green check), shown as a banner in the view title, and
  remembered across sessions.
- **Effect:** the **Module Parameters** view resolves every parameter value through that
  config's INI assignments, and the config's `network` becomes the default focus for the
  type/hierarchy views when no NED editor is active.

**Advantage.** One click pins "the run I'm working on", and the parameter views immediately
reflect the values that run will actually use.

#### Module Hierarchy view

**Shows.** The compound-module containment tree of the focused NED type — its submodules,
recursively (`~` marks `like` submodules). Clicking a node jumps to that submodule's
declaration.

**Use.** Follows the cursor; **Pin Module** to freeze it.

**Advantage.** Understand the structure of a network or compound module at a glance and
navigate into it.

#### Module Parameters view

**Shows.** The same containment tree, but each module expands to its **parameters with the
value actually in effect**, annotated by source:

- `(from config)` — the value comes from the active configuration's INI assignment,
- `(overridden)` — shadowed, not in effect (greyed out),
- `— UNASSIGNED` — no NED default and no config assignment,
- otherwise a NED-assigned value (tooltip shows where it was set).

**Use.** Follows the cursor; **Pin Module** to freeze the focus. Values depend on the
[active configuration](#configurations-view).

**Advantage.** See the *effective* parameterization of an entire network for a given
configuration — exactly what the simulation will run with — and spot unassigned or
overridden parameters.

#### NED Inheritance view

**Shows.** The inheritance spine of the focused NED/MSG type: its supertype chain (expanded)
and its subtypes (lazily loaded). Clicking a node jumps to that type.

**Use.** Follows the cursor; **Pin Type** to freeze it.

**Advantage.** Explore type hierarchies (including deep library hierarchies) without manual
search. The same data also backs VS Code's built-in **Type Hierarchy** view.

#### Used By view

**Shows.** The **reverse dependencies** of the symbol under the cursor, grouped by relation
("extended by", "instantiated by", "backing class for", …), from the cross-reference graph.
Each group shows a count; leaves jump to the using site.

**Use.** Follows the cursor; a title-bar **Pin** appears when there is a symbol to pin.

**Advantage.** Immediately answer *"who uses this type/message?"* before you change it.

### Graphical NED preview

**Feature.** A read-only graphical rendering of the NED type under the cursor — the same
visualization as the Eclipse-based IDE's graphical NED editor (types, not running
instances). Open it with the **preview button** in the editor title of any NED file, or
**"OMNeT++: Show NED Preview"** from the command palette. The panel opens beside the
editor and *follows the cursor*: moving the caret into another type (or file) re-renders.

**What is drawn.** Compound modules and networks show their full diagram: submodules
(icons, shapes, tints, status icons, ranges, queue markers, text labels — the complete
display-string tag set), connections (line styles, arrowheads, routing and bundling as in
the IDE), the background box/grid/image, and everything **inherited from base types**
(labelled in tooltips). Submodule vectors appear as a single `name[N]` box; connections
inside `for` loops / behind `if` conditions carry the IDE's `o` / `?` markers. Unresolved
`$param` display values use the IDE's placeholder visuals. Submodules without explicit
positions are laid out with the same seeded spring-embedder algorithm as the IDE/Qtenv.
Simple modules, channels, and interfaces show their icon "card". Unsaved edits render
immediately.

**Interactions.**
- **Click** a submodule or connection to reveal its declaration; **double-click** a
  submodule to open its type's NED file.
- **Hover** for tooltips (resolved type incl. `like` resolution, inheritance origin,
  gates/channel, `tt`/`bgtt` texts). **Drag** anywhere to pan the canvas.
- Toolbar: **zoom** in/out/1:1/fit buttons (also `Ctrl`+wheel), and a **type search box**
  on the right. While unpinned the box shows the currently previewed type as its hint
  text; type or pick a type name (with completion) to pin the preview on it.
- **Pin button** next to the search box: pressing it copies the shown type's fully
  qualified name into the box, pinning the preview (it stops following the cursor). The
  button then turns into a **clear** icon — pressing it empties the box and resumes
  cursor-following. The pin persists per workspace (also available in the panel title
  bar).
- **Right-click** context menu: **Re-layout** (new layout seed for unpinned submodules,
  like the IDE's re-layout action) and **Export as SVG/PNG**.

**Icons** are resolved like in the Eclipse IDE: a project's own `images/` folders first,
then `<omnetpp.installDir>/images`, then the bundled snapshot of the standard icon set —
so the preview works with zero OMNeT++ installation and still honors project-specific
icons.

### Impact analysis — "Show Impact (Reverse Dependencies)"

**Feature.** Computes the **transitive** set of types, configs, and files that depend
(directly or indirectly) on the symbol at the cursor — *what breaks if I change this?* This
is the full transitive closure, versus the single-hop grouping in the Used By view; each
result carries the relation it was reached by and its depth.

**How to use it.** Place the cursor on a NED/MSG type (or an INI network), open the
**Command Palette** (`Ctrl+Shift+P`) and run **"OMNeT++: Show Impact (Reverse
Dependencies)"**. Results appear in a navigable Quick Pick; pick one to jump to it.

**Advantage.** Assess the blast radius of a change before making it — invaluable when
refactoring shared library types.

### Settings

| Setting | Meaning |
| --- | --- |
| `omnetpp.nedPath` | Extra NED source-root directories (semicolon-separated), in addition to those discovered from `.nedfolders`/`package.ned`. |
| `omnetpp.installDir` | OMNeT++ installation root. When set (or auto-detected), enables enriched features (live config-option registry, bundled NED libraries). |
| `omnetpp.diagnostics.scope` | `workspace` (default — analyse every NED/MSG/INI file, so errors in unopened files stay visible) or `openFiles`. |
| `omnetpp.trace.server` | Language-server trace level (`off` / `messages` / `verbose`). |

> **Project model discovery.** NED source roots come from `.nedfolders` / `.nedexclusions`
> / `package.ned`, falling back to indexing workspace folders, plus `omnetpp.nedPath` and
> the install dir. Settings apply **live** — changing `nedPath`/`installDir` reindexes
> without a window reload.

---

## 2. Command-line linter (`opp_lint`)

**Feature.** The same analyzers, available outside the IDE as a standalone CLI — for CI,
pre-commit hooks, or scripts. It needs no OMNeT++ installation and honors the inline
`suppress(...)` directives described above.

**How to use it.**

```bash
opp_lint [options] [path ...]            # paths default to the current dir

opp_lint src/                            # lint a directory tree (recursive)
opp_lint Host.ned omnetpp.ini            # lint specific files
opp_lint --format=json src/ > lint.json  # machine-readable output
opp_lint --ned-path=/opt/inet/src src/   # add libraries for cross-file resolution
```

**Options.**

| Option | Meaning |
| --- | --- |
| `--ned-path=<dirs>` | Extra NED source roots (`;`- or `:`-separated) for cross-file resolution. Indexed but **not** linted. |
| `--format=text\|json` | Output format (default `text`). |
| `--severity=error\|warning\|info\|hint` | Minimum severity to report (default `hint` — report everything). |
| `--fail-on=error\|warning\|info\|hint\|never` | Exit non-zero if a diagnostic at this severity or worse is found (default `error`). |
| `--no-color` | Disable ANSI colors (also off when stdout is not a TTY). |
| `-h`, `--help` | Show help. |

**Exit codes.** `0` — no diagnostics at/above `--fail-on`; `1` — diagnostics found
at/above `--fail-on`; `2` — usage or runtime error.

**Getting the binary.** Installing the extension's package puts `opp_lint` on your `PATH`.
For a from-source build, the runtime artifact is `dist/opp_lint.js` (produced by
`bun run dev:build`); run it directly with `bun dist/opp_lint.js …` (or
`node dist/opp_lint.js …`).

**Advantage.** Enforce model correctness in CI and pre-commit hooks with the exact same
checks the IDE uses — no OMNeT++ install on the build agent, machine-readable JSON, and
precise exit-code control.

---

## 3. AI-agent integration (MCP)

The extension exposes its semantic model to AI agents through the **Model Context Protocol
(MCP)**, in two forms — a live in-editor bridge and a standalone server. Both serve the
**same 22 tools** over the OMNeT++ NED/MSG/INI model.

**Advantage.** An AI assistant can *query your actual model* (resolved types, parameters,
topology, cross-references, diagnostics) instead of guessing from raw text, and can compute
safe refactorings — making it far more reliable when working on OMNeT++ projects.

### A) Live in-editor bridge (recommended)

**Feature.** A localhost, token-guarded MCP server runs inside the extension and answers
against the **live index, including unsaved buffers**. It is registered with VS Code's MCP
layer as **"OMNeT++ NED/MSG/INI (live)"**.

**How to activate it.** Nothing to configure by hand — the extension injects the URL and a
per-session bearer token automatically. In your AI agent's MCP server list (e.g. Copilot
Chat agent mode), enable/allow the **"OMNeT++ NED/MSG/INI (live)"** server. (Requires a VS
Code version that provides the `registerMcpServerDefinitionProvider` MCP API; if it's
absent the rest of the extension still works, the bridge just isn't offered.)

**Advantage.** Tool results reflect exactly what you're editing right now, unsaved changes
included.

### B) Standalone stdio server (`opp_ide_mcp`)

**Feature.** The same tools served over MCP **stdio**, building the index from disk — for
agents/clients outside VS Code.

**How to activate it.** After `bun run dev:build`, point your MCP client at the bundled
server:

```bash
node dist/opp_ide_mcp.js [projectDir ...] [--ned-path=a;b]
```

It indexes the given project directories (default: current dir). Environment variables:
`OMNETPP_NED_PATH` (extra roots), `OMNETPP_WASM_DIR`, `OMNETPP_CONFIG_DIR`.

**Advantage.** Use the OMNeT++ tools from any MCP-capable client, in headless/CI contexts,
with no editor running.

### The tools

| Tool | What it answers |
| --- | --- |
| `list_ned_types` | List NED types, filterable by kind / package / name. |
| `get_ned_type` | Full detail for one NED type: merged params, gates, submodules, inheritance, docs, location. |
| `find_subtypes` | Types that extend/implement a NED type (direct or all). |
| `get_inheritance` | Ancestor chain, interfaces, and subtypes of a NED type. |
| `find_type_usages` | Project-wide reference sites of a NED type. |
| `get_connections` | Topology (connections) of a compound module/network. |
| `find_param_assignments` | Every INI key that assigns a given NED parameter (reverse of go-to-def). |
| `find_msg_usages` | Where a MSG type is used (NED `@class`/`@signal` sites + MSG subtypes). |
| `resolve_class` | Resolve a NED `@class`/`@signal` token to its MSG declaration. |
| `list_msg_types` | List MSG types, filterable by kind / namespace / name. |
| `get_msg_type` | Detail for one MSG type: base + fields (inherited + local). |
| `list_ini_configs` | `[Config …]` sections with extends chain, abstract flag, description, network. |
| `resolve_ini_params` | Effective parameter values for a config (with source: ini / NED default / unassigned). |
| `lookup_config_option` | Detail of one OMNeT++ config option (type, unit, default, scope, description). |
| `list_config_options` | List config options, filterable by scope / name. |
| `get_diagnostics` | Run the analyzer on a NED/MSG/INI file (suppression applied). |
| `rename_ned_type` | Project-wide type rename as a `WorkspaceEdit` (does not write files). |
| `rename_member` | Project-wide param/gate/submodule rename as a `WorkspaceEdit`. |
| `organize_imports` | Import edits for a NED file (`TextEdit[]`; does not write). |
| `impact_of` | Transitive reverse dependencies — *what breaks if I change this*. |
| `find_unused` | Heuristic dead-symbol report (unused networks, orphan MSG types). |
| `neighbors` | Raw cross-reference graph edges incident to a type (in/out/both, filterable by kind). |

> The refactoring tools (`rename_*`, `organize_imports`) return edits but **never write
> files**, so an agent can preview a change before applying it.
