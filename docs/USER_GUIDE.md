# User Guide

This guide describes every feature of the OMNeT++ extension for VS Code and of its
command-line tools:

1. [**Editor GUI (VS Code)**](#1-editor-gui-vs-code) — language support, diagnostics,
   navigation, refactoring, the activity-bar views, the graphical NED preview, the
   Sequence Chart and Event Log, documentation generation, and the in-editor bridge for
   AI agents.
2. [**Command-line tools**](#2-command-line-tools) — how to install them, and the
   `opp_lint` linter, the `opp_neddoc` documentation generator, and the `opp_ide_mcp`
   MCP server for AI agents.
3. [**MCP tool reference**](#3-mcp-tool-reference) — the tools that AI agents can call.

The editor and the command-line tools run the **same analyzers**, built on tree-sitter.
The editor additionally reports the `unused-network` hint and follows INI `include`
directives; the CLI linter and the MCP `get_diagnostics` tool analyze each INI file on
its own. **No OMNeT++ installation is required**: the built-in `ned.*` types and the
config-option registry are bundled.

> **Tip — use the icons of your OMNeT++ install:** set `omnetpp.installDir` (or the
> `OMNETPP_ROOT` environment variable) to your OMNeT++ root. Icons from
> `<installDir>/images` are then used in display-string icon completion, in the graphical
> NED preview, and in generated documentation.

---

## 1. Editor GUI (VS Code)

### Installing the extension

Install **OMNeT++ Development Environment** from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=opensim.omnetpp-vscode)
or the [Open VSX Registry](https://open-vsx.org/extension/opensim/omnetpp-vscode), or
install a `.vsix` file: in the **Extensions** view, choose **Install from VSIX…** from the
`…` menu. It needs VS Code **1.101.0** or newer.

### Languages: NED, MSG, INI

The extension registers three languages — **OMNeT++ NED** (`.ned`), **OMNeT++ MSG**
(`.msg`), and **OMNeT++ INI** (`.ini`).

**Feature.** Syntax highlighting, bracket matching, comment toggling, code folding, and a
document outline (Outline view / breadcrumbs) for all three. **Format Document**
re-indents NED and MSG files by brace depth. Code **snippets** for common NED type
skeletons and INI sections.

**How to use it.** Open any `.ned`, `.msg`, or `.ini` file — the extension activates
automatically (it also activates as soon as a workspace contains a `.ned` file). Snippets
appear in completion; start typing a keyword such as `simple` or `[Config` and accept the
suggestion. Format with `Shift+Alt+F`.

**Advantage.** A modern editing experience for OMNeT++ models with zero setup and without
needing the OMNeT++ IDE.

### Diagnostics (error checking)

**Feature.** Live problem reporting in the editor and the Problems panel:

- **NED** — syntax errors, duplicate names, unknown base/interface/submodule/channel
  types, kind mismatches (`not-an-interface`, `not-a-module`, `not-a-channel`),
  connection gate checks (unknown gate, index on a scalar gate, wrong direction),
  ambiguous type names, parameter value type checks, a `missing-cpp-class` warning when
  no C++ class is registered for a simple module, and an `unused-network` hint.
- **MSG** — syntax errors, duplicate names, conservative unknown-type checks.
- **INI** — configuration-option key and value-type validation (against a bundled snapshot
  of the OMNeT++ config registry), section-name validity, unknown configs, duplicate keys,
  `extends=`/`network=` checks, global-option placement, iteration-variable (`${…}`)
  checks, and **full parameter resolution** (see below) — including shadowed and
  redundant assignments (a value equal to the NED default), unit mismatches and invalid
  `@enum` values. `include` directives are followed: sections and parameter assignments
  from included files participate in resolution (so `extends=` a base config in another
  file resolves, and inherited `network=`/typenames are seen), a missing included file is
  flagged, and **`Ctrl`/`Cmd`-clicking an `include` path opens that file**.
- **Type names written as strings** (see Navigation) are warned about when they name no
  known type (`unknown-typename`) or no type implementing the slot's `like` interface
  (`typename-interface-mismatch`). Arguments of `firstAvailable(...)` are not checked.
- **"Did-you-mean" quick fixes** for an unresolved INI `network=` or `extends=` value
  offer the closest network or section names.

**How to use it.** Just edit — problems update as you type and are listed in the
**Problems** panel (`Ctrl+Shift+M`). By default the whole workspace is analyzed, so errors
in files you haven't opened still show up; switch with `omnetpp.diagnostics.scope`
(`workspace` vs `openFiles`). The index also re-checks itself against disk after git
operations (checkout, reset, stash) and when the window regains focus.

**Advantage.** Catches modeling mistakes — typos in type names, broken inheritance,
mis-typed parameters, invalid config options — before you ever run a simulation.

### INI parameter resolution

**Feature.** `**.param = value` keys in `omnetpp.ini` are resolved against the **expanded
module tree** of the selected `network` — submodules, vectors, `like` and conditional
submodules are all expanded. The extension flags assignments to **non-existent
parameters** and values whose **type conflicts** with the NED declaration, and offers
go-to-definition / hover from an INI key straight to the NED parameter it assigns.

**How to use it.** Open an `omnetpp.ini`. Resolution uses the config's `network` (and its
`extends` chain). A config may `extends=` **several** base configs; their precedence is
resolved with **C3 linearization** — the same algorithm the OMNeT++ kernel uses — so
first-match-wins lookup is correct even for diamond inheritance. To resolve against a
particular configuration interactively, set it as the **active configuration** (see
[Configurations](#configurations-view)); its network is also used for lines in
`[General]`.

**Advantage.** The single most error-prone part of an OMNeT++ setup — wiring parameters
through a deep module tree — becomes verifiable. Dead keys (that match nothing) and
type mismatches are caught immediately.

### Navigation & cross-references

**Feature.** Across the whole project, and **across languages** (NED ⇄ MSG ⇄ INI ⇄ C++):

- **Go to Definition** (`F12`) and **Hover** for types, parameters (including inherited and
  submodule overrides), gate/submodule names in connections, `import` targets, INI
  `**.param` keys → the NED declaration, INI module-path segments → the module's NED
  type, `extends=` → the section, `network=` → the network, and NED `@class`/`@signal`
  backing classes → their MSG declarations. Hover on an INI config-option key shows the
  option's documentation.
- **C++ links** — `F12` on a simple module or channel type name, or on a `@class` token,
  jumps to the C++ class registered with `Define_Module`/`Define_Channel`; hover on
  `@class` shows where it is registered.
- **Type names written as strings** — `<"X">`, `<default("X")>` (submodules and channels),
  NED `[path.]typename = "X"` and INI `**.typename = "X"` — support Go to Definition, Hover,
  Find All References and Rename. A simple name resolves like OMNeT++ does: among the types
  that implement the slot's `like` interface; if the slot is unknown, every type with that
  name is offered. Rename changes only the last segment of a qualified name.
- **Find All References** (`Shift+F12`) — symmetric and cross-language. For a NED
  parameter, gate or submodule it also lists the C++ `par()`/`gate()`/`getSubmodule()`
  calls that name it with a string literal.
- **Workspace Symbol search** (`Ctrl+T`) — jump to any NED/MSG type or INI configuration
  by name.
- **Document Highlight** — every occurrence of the type under the cursor (NED files).
- **CodeLens** above declarations — NED: references, subtypes, configs using a network,
  "C++ implementation by …", and per-member C++ access counts; MSG: NED usages and
  subtypes; INI: the number of module parameters an assignment line matches (toggle with
  `omnetpp.codeLens.iniParams`).
- **Switch Between C++ and NED File** (`Alt+O`) — steps through the files of a module in
  the order `.cc` → `.h` → `.ned` → `.cc`, skipping the ones that do not exist. The files
  are paired the way OMNeT++ pairs them (`@class`, `@namespace`, `Define_Module`, and the
  class inherited from a base type), so differently named files are found too. Without a
  match, the file with the same base name in the same folder is used. In a NED file with
  several modules, the module at the cursor decides. When the next step has several
  candidates (e.g. one C++ class used by several NED types), the one named like the current
  file wins; without such a file, a picker opens.

**How to use it.** Standard VS Code gestures (`F12`, `Shift+F12`, `Ctrl+T`, hover). Hover
docs render documentation comments, with clickable `~Symbol` references. `Alt+O` works in
NED and C/C++ editors. The C/C++ and clangd extensions bind `Alt+O` to their own
header/source switch; if theirs wins, add this to your `keybindings.json`:

```json
{ "key": "alt+o", "command": "omnetpp.switchCounterpart",
  "when": "editorTextFocus && (editorLangId == 'cpp' || editorLangId == 'c' || editorLangId == 'OMNeT++ NED')" }
```

**Advantage.** Navigate large model libraries (e.g. INET) the way you navigate code —
following types, parameters, and signals across NED, MSG and C++ boundaries.

### Refactoring & code actions

**Feature.**

- **Rename** (`F2`) — project-wide, cross-language safe rename of NED **types** and of
  **members** (parameters, gates, submodules), updating declarations, inherited overrides,
  connection endpoints, INI `network=`/`typename` values and parameter keys everywhere;
  and of MSG **types**, including MSG `extends` and field types and NED
  `@class`/`@signal` references.
- **Content assist (completion)** — context-aware: top-level keywords and IDE-style type
  and topology templates; kind-filtered type names after `extends`/`like`/submodule/
  channel; inherited params and gates; display-string tags and values inside
  `@display("…")`, with icon previews for icon names; `@figure` keys and values; MSG
  completion; INI config keys vs. parameter paths vs. typed values; and
  documentation-comment assist (`@author`/`@see`/… and HTML tags).
- **Source actions** — **Organize Imports** (NED: add missing, drop unused, sort; also
  `Shift+Alt+O`) and **Add Missing Parameter Keys** (INI: adds `path = ` lines for the
  network's parameters that have no NED default and no assignment).
- **Quick fixes** — the INI did-you-mean fixes and the **insert-suppress** fix (below).

**How to use it.** `F2` to rename; `Ctrl+Space` for completion; right-click →
**Source Action…** for the source actions; the lightbulb (`Ctrl+.`) for quick fixes.

**Advantage.** Safe, mechanical edits that would otherwise be error-prone text search-and-
replace across many files.

### Suppressing diagnostics

**Feature.** Any diagnostic can be silenced in-source with a `suppress(...)` directive that
names the diagnostic's **code** (shown in the Problems view / hover), placed either before
the reported line (on the nearest preceding line that is not blank and not just a
comment) or as a **trailing** comment on it.

- **NED & MSG** use a *private* comment `//#` (kept out of generated docs):

  ```ned
  //# suppress(duplicate)
  simple Host { ... }

  network Net {
      submodules:
          probe: ExternalProbe;   //# suppress(unknown-type)
  }
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
**Used By**) *follow the editor cursor*: as you move the caret onto a NED type (Used By:
also NED members, MSG types and INI sections), the view re-queries and its title updates
to e.g. *"AODVRouter Inheritance"*. Each can be **pinned** to freeze it on the current
focus so it stops following the cursor; pins persist across sessions. When the active
editor is not a NED file and a configuration is active, Module Hierarchy, Module
Parameters and NED Inheritance show that configuration's network.

#### Configurations view

**Shows.** Every non-abstract `[Config …]` section in the workspace, grouped by `.ini`
file. Only `.ini` files inside the workspace's NED folders are listed (see *Project model
discovery* below).

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

**Shows.** The inheritance spine of the focused NED type: its supertype chain (expanded)
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
instances). Open it with the **preview button** in the editor title of any NED file,
**"OMNeT++: Show Graphical Preview"** from the command palette, or the same item in the
NED editor's right-click menu. The panel opens beside the editor and *follows the
cursor*: moving the caret into another type (or file) re-renders.

**What is drawn.** Compound modules and networks show their full diagram: submodules
(icons, shapes, tints, status icons, ranges, queue markers, text labels — the complete
display-string tag set), connections (line styles, arrowheads, routing and bundling as in
the IDE), the background box/grid/image, and everything **inherited from base types**
(labelled in tooltips). Submodule vectors appear as a single `name[N]` box; connections
inside `for` loops / behind `if` conditions carry the IDE's `⦀` / `?` markers. Unresolved
`$param` display values use the IDE's placeholder visuals. Submodules without explicit
positions are laid out with the same seeded spring-embedder algorithm as the IDE/Qtenv.
Simple modules, channels, and interfaces show their icon "card". Unsaved edits render
immediately.

**Interactions.**
- **Click** a submodule or connection to reveal its declaration; **double-click** a
  submodule to open its type's NED file. **`Ctrl`/`Cmd`-click** a submodule drills into
  it — pinning the preview on that submodule's resolved type (as if following a link).
  The same drill-in is available as a **Show** item in the right-click menu of such a
  submodule.
- **Hover** for tooltips (resolved type incl. `like` resolution, inheritance origin,
  gates/channel, `tt`/`bgtt` texts). **Drag** anywhere to pan the canvas.
- **Back / Forward**: each type you deliberately pin (drill-in, the search box, the pin
  button) is recorded in a history you can step through — the **←/→ toolbar buttons**, the
  **mouse back/forward buttons**, or `Alt+Left`/`Alt+Right` (macOS: `Ctrl+-` /
  `Ctrl+Shift+-`) while the preview is focused, mirroring VS Code's normal navigation.
  Drilling in while following the cursor also records the module you drilled *from*, so
  **Back** returns to it (this pins the preview; unpin to resume cursor-following). The
  history holds only real pinned NED types; cursor-following and clearing the pin are not
  entries.
- Toolbar: **zoom** in/out/1:1/fit buttons (also `Ctrl`+wheel), and a **type search box**
  on the right. While unpinned the box shows the currently previewed type as its hint
  text; type or pick a type name (with completion) to pin the preview on it.
- **Pin button** next to the search box: pressing it copies the shown type's fully
  qualified name into the box, pinning the preview (it stops following the cursor). The
  button then turns into a **clear** icon — pressing it empties the box and resumes
  cursor-following. The pin persists per workspace.
- **Right-click** context menu: **Re-layout** (new layout seed for unpinned submodules,
  like the IDE's re-layout action) and **Export as SVG/PNG**.

**Icons** are resolved like in the Eclipse IDE: the `images/` folder at the root of each
workspace folder first, then `<omnetpp.installDir>/images`, then the bundled snapshot of
the standard icon set — so the preview works with zero OMNeT++ installation and still
honors project-specific icons.

### Impact analysis — "Show Impact (Reverse Dependencies)"

**Feature.** Computes the **transitive** set of types, configs, and files that depend
(directly or indirectly) on the symbol at the cursor — *what breaks if I change this?* This
is the full transitive closure, versus the single-hop grouping in the Used By view; each
result carries the relation it was reached by and its depth.

**How to use it.** Place the cursor on a NED/MSG type, a NED parameter, gate or
submodule, or an INI section or network, open the **Command Palette** (`Ctrl+Shift+P`)
and run **"OMNeT++: Show Impact (Reverse Dependencies)"**. Results appear in a navigable
Quick Pick; pick one to jump to it.

**Advantage.** Assess the blast radius of a change before making it — invaluable when
refactoring shared library types.

### Sequence Chart and Event Log (`.elog`)

**Feature.** Two linked viewers for OMNeT++ **event log** files (`.elog`), which record a
run's events, message sends, module creations, method calls and log lines. The
**Sequence Chart** draws the run as a timeline over module axes; the **Event Log table**
lists the same log line by line. Both run on a TypeScript port of the OMNeT++ IDE's
eventlog engine — no OMNeT++ installation needed. The engine is indexed and uses bounded
memory, so multi-gigabyte logs open quickly and a log that is still growing can be
followed live.

**Recording an event log.** Set `record-eventlog = true` in `omnetpp.ini` (or pass
`--record-eventlog=true` on the command line). By default the file goes to
`results/<config>-<itervars>#<repetition>.elog` (option `eventlog-file`). To keep files
small, limit recording to simulation-time intervals with `eventlog-recording-intervals`
(e.g. `..10.2, 22.2..100`), or to some modules with
`**.module-eventlog-recording = false` (or a narrower path pattern).

**How to use it.** Open any `.elog` file: it opens in the **OMNeT++ Sequence Chart**
editor (the default editor for `*.elog`). The bottom panel gets an **OMNeT++ Event Log**
container with a **Table** view; **OMNeT++: Show Event Log Table** (also an icon in the
chart's editor title bar) brings it into view.

- **Following the editor.** The table follows the active chart editor. **Pin to This
  Event Log** (the pin icon in the table's title bar, or **Pin** in its context menu)
  keeps it on one file; **Unpin** makes it follow the active editor again.
- **Selection sync.** Clicking an event in the chart selects it in the table and scrolls
  it into view. Clicking a row selects the event in the chart; press `Enter` or
  double-click the row to also center the chart on it. **Select in Event Log Table** in
  the chart's event menu does the reverse.

**Advantage.** Explore the causality and timing of a simulation run directly in VS Code,
even for very large or still-running logs.

#### Sequence Chart

**Navigation.**

- **Pan and scroll.** Drag to pan. The wheel scrolls the axes vertically; `Shift`+wheel
  pans horizontally.
- **Zoom.** `Ctrl`/`Cmd`+wheel zooms around the mouse cursor. `Ctrl`/`Cmd`+drag draws a
  rubber band; on release the chart zooms to that time range.
- **Toolbar.** **Go to start**, **Go to end**, **Zoom out**, **Zoom in**, **Zoom to
  fit**, **Default zoom**, **Follow end**, **Refresh**, **Filter Event Log…**, **Select
  Modules…**, **Increase/Decrease Spacing**, the **Preset Configuration**, **Axis Ordering
  Mode** and **Timeline Mode** dropdowns, and **Show/Hide…**.
- **Selection.** Click to select an event, arrow, axis or position; click again to
  clear. `Ctrl`/`Cmd`+click adds to or removes from the selection.
- **Double-click** an arrow to zoom to that message, or an axis to open the module one
  level deeper (`Ctrl`/`Cmd`+double-click opens all levels).
- **Hover.** After about half a second a tooltip describes everything under the cursor,
  and the hovered object is outlined. A dashed hairline and a ruler label show the
  simulation time under the mouse.
- **Context menu**, with one section per object under the cursor:
  - **Event:** Select, Center, Select in Event Log Table, Toggle Bookmark, Filter
    Causes/Consequences….
  - **Message arrow:** Go to Cause Event, Go to Consequence Event, Zoom to Message,
    Toggle Bookmark, Filter Message….
  - **Method call:** Toggle Bookmark.
  - **Axis:** Center, Toggle Bookmark, Go to NED Declaration, attach/detach vector, and
    the module open/expand/collapse actions.
  - **Toggle Bookmark at Position** for the clicked point in time.

  Below them are the global items: **Zoom**, **Go to**, **Find**, **Refresh**, **Release
  Memory**, **Copy Image to Clipboard**, **Export to SVG...**.

Keys (click the chart first so it has focus; on macOS `Cmd` works wherever `Ctrl` is
listed):

| Key | Action |
| --- | --- |
| `Home` / `End` | First / last event (`End` also turns on follow-end) |
| `Left` / `Right` | Previous / next event |
| `Ctrl+Left` / `Ctrl+Right` | Cause event / first consequence event |
| `Shift+Left` / `Shift+Right` | Previous / next event on the same module |
| `Up` / `Down`, `PgUp` / `PgDn` | Scroll by one axis / one page |
| `+` (or `=`) / `-` / `*` | Zoom in / zoom out / default zoom |
| `Tab` | Toggle time differences between the selected events |
| `Delete` (or `Backspace`) | Hide the selected events (adds them to the filter's excluded event numbers) |
| `Ctrl+D` | Toggle a bookmark on the selection |
| `F5` | Refresh |
| `Esc` | Close the filter panel if it is open, otherwise clear the selection |

**What is drawn.** Events are red marks on the module axes, with event numbers. Message
sends are blue arrows between axes; self-messages are half-ellipses on their own axis.
Message reuses are green dotted arrows, method calls orange dashed vertical arrows, and
dependencies through filtered-out events teal dashed arrows with a marker. Transmission
durations show as a band along the arrow, and regions where simulation time does not
advance are shaded.

**Axes.**

- **Choosing modules.** **Select Modules…** opens a tri-state module tree. Axis labels
  carry `+`/`−` glyphs to expand or collapse a compound module; the axis menu has Open
  Compound Module, Open Parent Module, Expand Axis Module (Recursively), Collapse Axis
  Module (Submodules) and Remove Axis Module.
- **Presets.** **Network Node**, **Network Interface**, **Full Detail**, **Default**,
  **Empty**. The first two read the `@networkNode` / `@networkInterface` NED properties;
  without a NED index they fall back to Full Detail and say so.
- **Ordering.** **Module Id**, **Module Path**, **Minimize Crossings**, or **Manual…** (a
  reorder dialog).
- **Spacing.** **Balanced Axes**, **Dense Axes**, **Increase/Decrease Spacing**.
- **Axis vector data.** **Attach Vector to Axis...** picks a `.vec` file, a run (if there
  are several) and a vector — the axis module's own vectors first — and draws its values
  as a bar strip below the axis. A run ID that differs from the event log's asks for
  confirmation. **Detach Vector from Axis** and **Zoom to Value** are then available. The
  attachment is remembered per file.

**Display options.**

- **Timeline Mode:** **Simulation Time** (**Linear** in the context menu), **Event
  Number**, **Step**, **Nonlinear**. **Custom nonlinear...** (context menu only) opens
  two sliders that update the chart live; Cancel restores the previous layout.
- **Show/Hide** (toolbar and context menu) toggles about two dozen elements, e.g. event
  marks and numbers, the initialization event, each arrow kind, arrow heads,
  message/method names, transmission durations, axes, axis labels and headers, axis
  vector data, empty axes, hairlines, zero-simulation-time regions, time differences,
  and the Position and Range / Axis / Event Log / **Bookmark Info** boxes.
- **Configure Style...** (context menu): pattern-to-color rules for axes, axis headers,
  events, self events, message sends and method calls. The first matching rule wins. A
  color can be a name, a hex value, a `light`/`dark` keyword or a comma-separated list,
  with a color picker. Rules apply immediately and are saved in
  `omnetpp.sequenceChart.styleRules`.
- **Time Accuracy** (context menu): rounds every displayed time to full precision or to
  s / ms / µs / ns / ps / fs. Remembered per file.
- **Label size:** the `omnetpp.sequenceChart.fontSize` setting.

#### Event Log table

**Feature.** A virtual table over the whole file with **Event #**, **Time** and
**Details** columns (the first two are resizable), and a status strip with the file, the
event range and count, the simulation-time range, and **Filter: active** when a filter
is applied. The scrollbar uses approximate positions, so you can jump anywhere in a
huge file.

- **Toolbar.** **Refresh**; **Filter Event Log…** (opens the chart's filter panel); and
  the modes:
  - **Line Filter:** **All lines**, **Events + sends + messages**, **Events +
    messages**, **Events only**, or **Custom…**, which shows a match-expression box with
    content assist (entry-type codes such as `BS`, `ES`, `MC`, their attribute names,
    `AND`/`OR`, and the module and message names seen in the file).
  - **Module Name Mode:** Smart name / Full name / Full path.
  - **Type Mode:** C++ type / NED type.
  - **Display Mode:** Descriptive / Raw.
- **Context menu.** Go to Event Cause, Go to Message Arrival, Go to Message Origin, Go to
  Message Reuse, Go to Previous/Next Event, Go to Previous/Next Module Event, Toggle
  Bookmark, Go to NED Declaration, Copy, Find Text..., Filter Event Log..., the four mode
  submenus, Pin/Unpin, Refresh.
- **Keys.** `Up`/`Down` move (`Shift` extends the selection, `Ctrl` moves without
  selecting). `Ctrl+Up`/`Ctrl+Down`: cause / message arrival. `Alt+Up`/`Alt+Down`:
  previous / next event. `Shift+Up`/`Shift+Down`: previous / next event of the same
  module. `PgUp`/`PgDn`/`Home`/`End`; `Left`/`Right` scroll horizontally. `Ctrl+A`
  selects all, `Ctrl+Space` toggles the focused row, `Ctrl+C` copies. `Ctrl+F` opens a
  find bar (`Enter` searches forward, `Shift+Enter` backward). `F5` refreshes; `Enter` or
  double-click centers the chart on the event.

#### Filtering, Go to, Find

- **Filter panel.** A collapsible side panel in the chart, opened from the toolbar, the
  editor title bar, **OMNeT++: Filter Event Log...**, or the table (which opens the chart
  editor if needed). Its sections:
  - **Collection limits:** depth, count and time.
  - **Range filter:** by event numbers and by simulation time.
  - **Event filter:** excluded event numbers.
  - **Module filter:** by expression, NED type, module tree, or class name.
  - **Message filter:** by expression, class name, name, ID, tree ID, encapsulation ID,
    or encapsulation tree ID.
  - **Cause/consequence filter:** the traced event, causes and/or consequences, following
    reuse and self-message dependencies, and event-number and simulation-time limits.

  **Filter Causes/Consequences...** and **Filter Message...** in the chart menu fill in
  the panel. **Apply** shows progress and can be canceled; **Remove Filter** clears the
  filter. The filter is saved per file and applied again when you reopen the file.
- **Go to.** **Go to Event...** (`Ctrl+G` / `Cmd+G`) and **Go to Simulation Time...**
  (`Ctrl+Shift+G` / `Cmd+Shift+G`). A simulation time is a number with an optional unit
  (`s`, `ms`, `us`, `ns`, `ps`, `min`, `h`, `d`); a leading `+`/`-` makes it relative.
- **Find.** **Find in Event Log...** searches the log text (case-sensitive and backward
  options) in the chart or in the table's find bar, whichever has focus. **Find Next in
  Event Log** is `Ctrl+Alt+K` / `Cmd+Alt+K`.

These shortcuts work while the chart editor or the table has focus.

#### Bookmarks

You can bookmark an **event**, a **message arrow**, a **method call**, an **axis**, or a
bare **position in time**.

- **Toggle Bookmark** (`Ctrl+D` / `Cmd+D` in the chart, or the context menu in either
  view) asks for a name; toggling the same object again removes the bookmark.
- **Show Bookmarks...** (`Ctrl+Shift+B` / `Cmd+Shift+B` in these views) lists them in a
  Quick Pick and jumps to the one you pick.
- **Bookmark Info** (Show/Hide) shows a note box for each visible bookmark below the
  axes. Double-click a box, or use **Edit Bookmark...**, to rename it, edit its Markdown
  notes, or **Remove** it.
- Bookmarks are kept per file across reloads. After the log is rewritten, a bookmark that
  points past its last event is shown as stale.

#### Export, refresh, memory

- **Export to SVG...** exports the range between two selected events, the visible area,
  or the whole log, with extra space at both ends (it asks to confirm above 50,000 px).
- **Copy Image to Clipboard** copies the visible chart as PNG, and offers to save a PNG
  file if the clipboard is blocked.
- **Refresh Event Log** (`F5` in either view) re-reads the file.
- **Release Memory** empties the engine's event cache and reports the cache size before
  and after.
- **OMNeT++: Reset Event Log View State** clears the saved chart and table state and the
  filter of the active file (bookmarks are kept). Use it if a view stays broken after
  reopening the file.

#### Large files and live runs

- **One worker per file.** Each open `.elog` gets its own worker process, shared by its
  chart and table. A crashed worker restarts automatically and reopens the file.
- **Bounded memory.** The engine reads through an index instead of parsing the whole
  file, and caches a limited number of parsed events
  (`omnetpp.eventlog.maxEngineMemoryMB`). Long operations — applying a trace filter, a
  find across the file — can be canceled; if one fails, an overlay shows the details and
  a **Refresh** button.
- **Live follow.** The worker detects growth through file-system events, with polling as
  a fallback (`omnetpp.eventlog.pollIntervalMs`), and both views update without a manual
  refresh. **Follow end** (toolbar, or `End`) keeps the newest events in view; any manual
  scroll stops it. A file opened for the first time starts in follow mode
  (`omnetpp.eventlog.followEndOnAppend`). If a new run overwrites the file, both views
  reset and the filter is applied again.
- Worker problems are logged to the **OMNeT++ Event Log Diagnostics** output channel.

#### Eventlog settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `omnetpp.sequenceChart.defaultTimelineMode` | `SIMULATION_TIME` | Initial timeline mode for a file with no remembered mode (`SIMULATION_TIME`, `EVENT_NUMBER`, `STEP`, `NONLINEAR`). |
| `omnetpp.sequenceChart.fontSize` | `0` | Chart label size in px; `0` keeps the built-in 12 px. |
| `omnetpp.sequenceChart.styleRules` | `{}` | Color rules, edited through **Configure Style...**. |
| `omnetpp.eventlog.followEndOnAppend` | `true` | A file opened for the first time starts following the end of the log. |
| `omnetpp.eventlog.maxEngineMemoryMB` | `0` | Rough memory budget for the event cache (about 2 KB per event); `0` means the built-in default of about 50,000 events. Applies the next time the file is opened. |
| `omnetpp.eventlog.pollIntervalMs` | `3000` | Fallback poll interval for detecting file changes; `0` disables polling. Applies the next time the file is opened. |

The view settings are read when a chart or table opens; views that are already open do
not pick up changes.

**For AI agents.** The standalone `opp_ide_mcp` server (not the in-editor bridge) offers
`elog_*` tools that query the same engine — see [Eventlog tools](#eventlog-tools).

#### Differences from the Eclipse IDE

- **Filtering** uses a side panel that stays open instead of the modal Filter dialog;
  **Remove Filter** replaces **Show All**.
- **Change Font...** is replaced by the `omnetpp.sequenceChart.fontSize` setting.
- **Pinning.** Each `.elog` is its own editor tab, so only the table can be pinned.
- **Self Test** and **Show In** do not exist.
- **Go to Simulation Time** accepts a number with a unit and an optional `+`/`-`, but no
  arithmetic expressions.
- **Find Next** is `Ctrl+Alt+K`, because `Ctrl+K` is a VS Code chord prefix; Find Text has
  no default shortcut in the chart.
- **Wheel zoom** zooms around the mouse cursor, not the view center.
- **Custom nonlinear...** and **Configure Style...** are only in the context menu.
- **Bookmarks** are stored by VS Code, not as Eclipse markers.
- **Additions:** Go to NED Declaration, Select in Event Log Table, `Ctrl+D` bookmarks,
  bookmark notes, the Show Bookmarks Quick Pick, stale-bookmark marking, and follow end.

### NED documentation

**Feature.** **"OMNeT++: Generate NED Documentation"** documents the NED and MSG types of
the workspace folder (the first one, in a multi-root workspace): one page per type with
its documentation comment, parameters, gates, module figure, usage and inheritance
diagrams, and source listing. Output formats: **HTML** (a static site with navigation and
search), **HTML (Read the Docs)**, **HTML (Material)** (the Eclipse IDE's neddoc look),
**Markdown**, and **reStructuredText** (Sphinx-ready). The same generator runs on the
command line as [`opp_neddoc`](#opp_neddoc--documentation-generator).

**How to use it.** Run the command from the Command Palette and pick a format (the
`omnetpp.neddoc.format` setting preselects one). A progress notification shows the
steps and can be canceled. When it is done, **Open** shows the documentation in your
browser, and **Reveal in Explorer** shows the output folder (`omnetpp.neddoc.outputDirectory`,
default `doc/neddoc`; existing files are overwritten, but the folder is not cleaned
first). The other `omnetpp.neddoc.*` settings (see [Settings](#settings)) select the
diagrams and sections, the title, excluded folders, a custom stylesheet, and links to
Doxygen-generated C++ documentation.

**Advantage.** Browsable, linked model documentation straight from the doc comments —
without the OMNeT++ IDE.

#### Linking to the documentation of dependencies

Types from other NED source roots (`omnetpp.nedPath`, `--ned-path`) are indexed but not
documented. References to them can link to the documentation of those dependencies that
was generated separately — for example a model framework that builds on INET links to the
INET documentation.

Map NED package prefixes to the location of their documentation:

- **VS Code:** the `omnetpp.neddoc.externalDocs` setting, e.g.
  `{ "inet": "https://inet.omnetpp.org/doc/neddoc" }`.
- **`opp_neddoc`:** `-l inet=https://inet.omnetpp.org/doc/neddoc` (the Eclipse IDE's
  syntax: `<package>=<location>` items, comma- or space-separated; repeatable).

The location is a URL, or a path relative to the output directory (e.g. `../inet`). For a
path, the generator reads the `nedtags.xml` / `msgtags.xml` that a documentation run
writes there (`msgtags.xml` only when MSG types are documented) and uses the exact page
names from them; without tag files it falls back to the Eclipse page naming. For a URL,
it assumes the Eclipse page naming (`<qualified name>.html` for NED types). The longest
matching prefix wins, so `inet.showcases` can point somewhere other than `inet`.

References to dependency types are marked in the HTML output (↗, with a "from inet"
tooltip). A type whose dependency is not mapped — or that the dependency's tag file does
not list — is shown as "not documented here" instead of as a broken link. Each run
reports one line per such dependency: in the CLI as a warning that does not change the
exit code, in VS Code in the **OMNeT++ Language Server** output.

### AI agents: the live MCP bridge

**Feature.** A localhost, token-guarded MCP (Model Context Protocol) server runs inside
the extension and answers against the **live index, including unsaved buffers**. It is
registered with VS Code's MCP layer as **"OMNeT++ NED/MSG/INI (live)"** and serves the 23
[NED/MSG/INI tools](#nedmsgini-tools). (The `elog_*` eventlog tools are served only by
the standalone [`opp_ide_mcp`](#opp_ide_mcp--mcp-server-for-ai-agents).)

**How to activate it.** Nothing to configure by hand — the extension injects the URL and a
per-session bearer token automatically. In your AI agent's MCP server list (e.g. Copilot
Chat agent mode), enable/allow the **"OMNeT++ NED/MSG/INI (live)"** server. (Requires a VS
Code version that provides the `registerMcpServerDefinitionProvider` MCP API; if it's
absent the rest of the extension still works, the bridge just isn't offered.)

**Advantage.** An AI assistant can *query your actual model* (resolved types, parameters,
topology, cross-references, diagnostics) instead of guessing from raw text, and tool
results reflect exactly what you're editing right now, unsaved changes included.

### Installing the command-line tools from VS Code

**"OMNeT++: Install Command-Line Tools"** puts `opp_lint`, `opp_neddoc` and
`opp_ide_mcp` on your `PATH` without a separate download — see
[Installation](#installation).

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `omnetpp.nedPath` | `""` | Extra NED source-root directories (`;`-separated), in addition to those discovered from `.nedfolders`/`package.ned`. Indexed for cross-file resolution. |
| `omnetpp.installDir` | `""` | OMNeT++ installation root. Only its `images/` folder is used, as an icon source. When empty, the `OMNETPP_ROOT` (or `__omnetpp_root_dir`) environment variable is used. |
| `omnetpp.diagnostics.scope` | `workspace` | `workspace` analyzes every NED/MSG/INI file, so errors in unopened files stay visible; `openFiles` analyzes open editors only. |
| `omnetpp.codeLens.iniParams` | `true` | Show the "N module parameters" CodeLens on INI assignment lines. |
| `omnetpp.trace.server` | `off` | Language-server trace level (`off` / `messages` / `verbose`). |
| `omnetpp.neddoc.format` | `html` | Default output format of **Generate NED Documentation** (`html`, `html-readthedocs`, `html-material`, `markdown`, `rst`). |
| `omnetpp.neddoc.outputDirectory` | `doc/neddoc` | Output folder, relative to the workspace folder. |
| `omnetpp.neddoc.title` | `""` | Documentation title; empty means the workspace folder name. |
| `omnetpp.neddoc.excludeDirs` | `[]` | Folders to leave out, as workspace-relative patterns (`*` and `**` supported). |
| `omnetpp.neddoc.networkDiagrams` | `true` | Module figure on type pages. |
| `omnetpp.neddoc.usageDiagrams` | `true` | Per-type usage diagrams. |
| `omnetpp.neddoc.inheritanceDiagrams` | `true` | Per-type inheritance diagrams. |
| `omnetpp.neddoc.fullUsageDiagram` | `false` | Project-wide usage diagram pages (can get large). |
| `omnetpp.neddoc.fullInheritanceDiagram` | `false` | Project-wide inheritance diagram pages (can get large). |
| `omnetpp.neddoc.messageDefinitions` | `true` | Document MSG types too. |
| `omnetpp.neddoc.sourceListings` | `true` | Include the NED/MSG source of each type. |
| `omnetpp.neddoc.automaticHyperlinks` | `true` | Link every known type name in doc comments; when off, only `~Name` references are linked. |
| `omnetpp.neddoc.includeBuiltins` | `false` | Also document the built-in NED types. |
| `omnetpp.neddoc.customCss` | `""` | Stylesheet that replaces the generated `style.css` (HTML formats). |
| `omnetpp.neddoc.doxytagsFile` | `""` | Doxygen tag file; when set, simple-module and message pages link to the C++ documentation. |
| `omnetpp.neddoc.doxyUrlPrefix` | `""` | URL or path prefix for the Doxygen links. |
| `omnetpp.neddoc.externalDocs` | `{}` | Documentation of dependencies, by NED package prefix (see above). |

The Sequence Chart and Event Log settings are listed in
[Eventlog settings](#eventlog-settings).

> **Project model discovery.** NED source roots come from `.nedfolders` / `.nedexclusions`
> / `package.ned`, falling back to indexing workspace folders, plus `omnetpp.nedPath`.
> Settings apply **live** — changing `nedPath`/`installDir` reindexes without a window
> reload. `.ini` files count only inside a NED folder (under a source root, not in an
> excluded package): copies elsewhere, e.g. in documentation, are ignored even when opened
> in an editor.

---

## 2. Command-line tools

Three tools bring the extension's analyzers to the command line — for CI, pre-commit
hooks, scripts, and AI clients outside VS Code. None of them needs an OMNeT++
installation.

| Command | Purpose |
| --- | --- |
| [`opp_lint`](#opp_lint--linter) | Lint NED, MSG, and INI files. |
| [`opp_neddoc`](#opp_neddoc--documentation-generator) | Generate documentation from NED and MSG files. |
| [`opp_ide_mcp`](#opp_ide_mcp--mcp-server-for-ai-agents) | MCP stdio server for AI agents (NED/MSG/INI model and eventlogs). |

### Installation

Choose one of the two ways. Both install all three tools.

**From VS Code** (no Node.js needed). Run **"OMNeT++: Install Command-Line Tools"** from
the Command Palette. It writes one small launcher per tool into `~/.local/bin` (Linux,
macOS) or `%LOCALAPPDATA%\omnetpp\bin` (Windows). The launchers run the tools shipped
with the extension on VS Code's own runtime, and the extension updates them when it or
VS Code is updated. If the folder is not on your `PATH` yet, the command says so and
offers to copy its path: add it to `PATH` and open a new terminal.

- The command asks before it overwrites a file of the same name that it did not create
  (for example one from the npm package).
- If a launcher reports that VS Code or the extension was updated or removed, run the
  command again (or open an OMNeT++ project in VS Code, which refreshes the launchers).
- **"OMNeT++: Uninstall Command-Line Tools"** removes the launchers.
- In a remote window (SSH, WSL, containers) the launchers are installed on the remote
  machine.

**From npm** (needs Node.js 18 or newer). Use this on machines without VS Code, such as
CI agents:

```bash
npm install -g @omnetpp/opp-tools
```

**Common options.** All three tools take `--ned-path=<dirs>` — extra NED source roots
(libraries such as INET) that are indexed for cross-file resolution but not linted or
documented, separated by `;` or `:`. Its default is the `OMNETPP_NED_PATH` environment
variable. Quote the value in a shell if it contains `;`. Run any tool with `-h` /
`--help` for its full usage.

### `opp_lint` — linter

**Feature.** The same analyzers, available outside the IDE as a standalone CLI — for CI,
pre-commit hooks, or scripts. It honors the inline `suppress(...)` directives described
above. Unlike the editor, it analyzes each INI file on its own (no `include` following)
and does not report the `unused-network` hint.

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
| `--ned-path=<dirs>` | Extra NED source roots (`;`- or `:`-separated) for cross-file resolution. Indexed but **not** linted. Default: `OMNETPP_NED_PATH`. |
| `--format=text\|json` | Output format (default `text`). |
| `--severity=error\|warning\|info\|hint` | Minimum severity to report (default `hint` — report everything). |
| `--fail-on=error\|warning\|info\|hint\|never` | Exit non-zero if a diagnostic at this severity or worse is found (default `error`). |
| `--no-color` | Disable ANSI colors (also off when stdout is not a TTY, or when `NO_COLOR` is set). |
| `-h`, `--help` | Show help. |

**Exit codes.** `0` — no diagnostics at/above `--fail-on`; `1` — diagnostics found
at/above `--fail-on`; `2` — usage or runtime error.

**Advantage.** Enforce model correctness in CI and pre-commit hooks with the same checks
the IDE uses — no OMNeT++ install on the build agent, machine-readable JSON, and precise
exit-code control.

### `opp_neddoc` — documentation generator

**Feature.** The documentation generator of
[Generate NED Documentation](#ned-documentation), for scripts and CI. It documents the
NED and MSG types of the given project directories, honoring `.nedfolders` and
`.nedexclusions`.

**How to use it.**

```bash
opp_neddoc [options] [projectdir ...]    # defaults to the current dir

opp_neddoc .                                       # HTML into ./doc/neddoc
opp_neddoc -o public/doc --format=markdown .       # Markdown into public/doc
opp_neddoc --ned-path=../inet/src \
           -l inet=https://inet.omnetpp.org/doc/neddoc .   # link to the INET docs
```

**Options.**

| Option | Meaning |
| --- | --- |
| `-o <dir>` | Output directory (default `<projectdir>/doc/neddoc`). Existing files are overwritten, but the directory is not cleaned first. |
| `--format=<fmt>` | `html` (default), `html-readthedocs`, `html-material`, `markdown`, or `rst`. |
| `--ned-path=<dirs>` | Extra NED source roots; indexed, not documented. |
| `--title=<text>` | Documentation title (default: the project directory name). |
| `-x <pattern>` | Exclude directories matching the pattern (`*` and `**` supported); repeatable. |
| `--[no-]network-diagrams` | Module figures on type pages (default on). |
| `--[no-]usage-diagrams` | Per-type usage diagrams (default on). |
| `--[no-]inheritance-diagrams` | Per-type inheritance diagrams (default on). |
| `--[no-]full-usage-diagrams` | Project-wide usage diagram (default off). |
| `--[no-]full-inheritance-diagrams` | Project-wide inheritance diagram (default off). |
| `--[no-]message-definitions` | Document MSG types (default on). |
| `--[no-]source-snippets` | Per-type source listings (default on). |
| `--[no-]automatic-hyperlinks` | Link all known type names in comments; when off, only `~` references (default on). |
| `--include-builtins` | Document the built-in NED types too. |
| `--custom-css=<file>` | Stylesheet that replaces the generated `style.css` (HTML formats). |
| `--doxytags=<file>` | Doxygen tag file for "C++ definition" links. |
| `--doxy-url-prefix=<url>` | URL prefix for the Doxygen links. |
| `-l`, `--external-docs=<list>` | Documentation of dependencies, as `<package>=<url-or-path>` items (see [Linking to the documentation of dependencies](#linking-to-the-documentation-of-dependencies)). |
| `--verbose` | Print progress. |
| `-h`, `--help` | Show help. |

Icons for the module figures come from the `images/` folders of the project directories,
then `$OMNETPP_ROOT/images`, then the bundled icon set.

**Exit codes.** `0` — documentation generated; `1` — generated with warnings (unlinked
dependency references do not count); `2` — usage or runtime error.

### `opp_ide_mcp` — MCP server for AI agents

**Feature.** The [NED/MSG/INI tools](#nedmsgini-tools) and the
[eventlog tools](#eventlog-tools) served over MCP **stdio** (newline-delimited JSON-RPC),
with an index built from disk — for AI clients outside VS Code and for headless use.
Inside VS Code, prefer the [live bridge](#ai-agents-the-live-mcp-bridge), which also
sees unsaved edits.

**How to use it.** Register it as a stdio MCP server in your AI client; it is not meant
to be run interactively (logs go to stderr). For example:

```json
{ "command": "opp_ide_mcp", "args": ["/path/to/project", "--ned-path=/path/to/inet/src"] }
```

It indexes the given project directories (default: the current directory) at startup.
The eventlog tools open `.elog` files by path on demand.

**Advantage.** Use the OMNeT++ model tools from any MCP-capable client, in headless/CI
contexts, with no editor running.

---

## 3. MCP tool reference

The refactoring tools (`rename_*`, `organize_imports`) return edits but **never write
files**, so an agent can preview a change before applying it.

### NED/MSG/INI tools

Served by both the [live bridge](#ai-agents-the-live-mcp-bridge) and
[`opp_ide_mcp`](#opp_ide_mcp--mcp-server-for-ai-agents).

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
| `find_member_accesses` | C++ implementation class of a NED type, and where each param/gate/submodule is accessed in C++ via a literal `par()`/`gate()`/`getSubmodule()` (a hint, not proof: dynamic accesses are not seen). |

### Eventlog tools

Served only by [`opp_ide_mcp`](#opp_ide_mcp--mcp-server-for-ai-agents). Each tool takes
the path of an `.elog` file.

| Tool | What it answers |
| --- | --- |
| `elog_info` | Summary of an `.elog` file: run id, versions, first/last event and simulation time, approximate event count, module count. |
| `elog_get_module_tree` | The module hierarchy recorded in the eventlog (depth and node count capped). |
| `elog_get_event` | Full detail of one event (by event number or simulation time): its entries, the message it processes, its cause and consequences. |
| `elog_get_events` | Compact summaries for a contiguous range of events. |
| `elog_find_text` | The first log line (forward or backward) that contains a given text. |
| `elog_trace` | The transitive cause/consequence chain of one event (capped). |
| `elog_filter_summary` | Applies an event/module/message/trace filter and reports the match count, first/last match, and a sample. |
