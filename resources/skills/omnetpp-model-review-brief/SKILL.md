---
name: omnetpp-model-review-brief
description: >
  Write a reviewer's brief for a pull request, topic branch or commit range of an
  OMNeT++-based model library (INET, Simu5G, ...): a fact sheet, with evidence, of
  what the change does to the model's architecture -- user-visible NED interface
  changes (types, parameters, defaults, gates, submodules, inheritance moves,
  module-path moves, signals/statistics; a bundled script cross-checks large NED diffs),
  shifts of responsibility between modules, changes to key data structures, and
  changes in how modules communicate (gates, method calls, signals, parameters,
  tags, shared registries). Use when asked to summarize, brief, or prepare the
  review of a PR, branch or commit range for a human reviewer, or to list what
  changed architecturally between two revisions. Not a bug hunt (use /code-review)
  and not release notes (use the release-notes skills).
---

# Reviewer's brief for a branch or PR

The reader is a human reviewer who knows the codebase. The brief tells them
WHAT CHANGED THAT MATTERS, with evidence, so they can decide where to read the
diff closely. It is a fact sheet, not a verdict: it reports, it does not
approve or reject, and it does not hunt for bugs. The one exception is
conflicts with the project's stated architecture rules: list them in their own
section, as facts with evidence.

Four questions drive the brief:

1. **External interface**: what changed that a user's ini file, NED file or
   result-analysis script can see? (Section A, mostly mechanical.)
2. **Responsibilities**: which module now does something it did not do, or
   stopped doing something, and where did that duty go? (Section B.)
3. **Key data structures**: which structures that carry the design changed
   shape, key, cardinality, owner or readers? (Section C.)
4. **Communication**: which module-to-module interactions appeared, vanished,
   or changed mechanism (call -> signal, parameter -> call, pull -> push)?
   (Section D.)

The report skeleton is in [TEMPLATE.md](TEMPLATE.md). Read it before writing.

## Ground rules

- **Read-only.** Never check out anything in the user's worktree, never
  commit, never comment on or otherwise write to the PR. Read revisions with
  `git show <rev>:<path>`, `git diff`, `git grep <rev>`, or a detached
  temporary worktree in the scratchpad (`git worktree add --detach <dir>
  <rev>`, removed afterwards). Fetching a PR head into a local ref is fine.
- **Net change, base to tip.** Describe how the tip differs from the base.
  Something added and then refined within the branch is ONE addition in its
  final form. Something added and then removed is not a change. Then map
  each net fact to the commit that introduced it (`git log -S`/`-G`,
  `git log -L`, `git blame <tip>`).
- **Cite commits by hash AND subject**, e.g. `a6707eb81 ("a UE attaches by
  requesting an RRC connection")`. Branches get rebased and bare hashes stop
  resolving.
- **Every fact carries evidence**: `file:line` at the tip (at the base for
  removed things) plus the introducing commit.
- **Mark every non-mechanical fact** as *verified* (you read the code on both
  sides) or *inferred* (from names, commit messages, partial reads). Never
  present an inference as a fact.
- **Commit messages are claims, not evidence.** Check them against the diff.
  A mismatch is itself a fact for the brief (section E).
- **Say "none found" explicitly**, and how you searched. Never drop an empty
  section silently: an empty section with a method note tells the reviewer
  something. A missing section tells them nothing.
- **Selective, except section A.** Sections B-D cover what is KEY, by the
  criteria below. Section A is exhaustive, because the script produces it.

## Step 0 -- fix the range

- Topic branch: `base = git merge-base <target> <tip>`, normally against the
  branch it will merge into.
- PR: `gh pr view <N> --json baseRefName,headRefOid,title,body,commits`
  (read-only), then `git fetch origin pull/<N>/head:refs/review/pr-<N>`.
- Commit range: as given. Check that base is an ancestor of tip
  (`git merge-base --is-ancestor`). If it is not, say so, and use the merge
  base.

Record base and tip (hash + subject) and the commit count in the header.

## Step 1 -- orient

- `git log --reverse --format='%h %s' base..tip`: the commit list, in order.
- `git diff --stat=200 --dirstat=files,3 base tip`: where the weight is.
- The stated goal: the PR description, the plan document, or the
  commit-group prefix. One sentence in the brief header. Later sections
  compare what the branch DOES with this stated goal; a difference goes into
  section E.
- Change-type markers in commit subjects (dev-commit-messages: `fix:`,
  `refactor:`, ...) are claims; note them and check them in section E.
  Older history may lack them.

## Step 2 -- section A: external interface (NED)

When the NED diff is small (`git diff --stat base tip -- '*.ned'` shows a
handful of files), read the changed NED files at both revisions directly.
That is enough. Two effects are easy to miss when you read a diff file by
file, so check them explicitly:

- **Inheritance**: a change in a base type (a parameter or submodule added,
  removed, or moved down into subclasses) changes every subtype. List the
  subtypes (`git grep -n 'extends <Type>' <tip> -- '*.ned'`).
- **Module paths**: a submodule moved into a new compound or renamed changes
  the ini keys of everything under it, in every network that contains it.

For larger NED diffs, or as a cross-check, run the bundled script, which
does both of these mechanically:

```
python3 <this-skill-dir>/ned_interface_diff.py <base> <tip> \
    --repo <repo> --external <dependency NED roots...> > <scratch>/ned-diff.md
```

`--external` lists the NED source roots of the libraries the project
builds on (for an INET-based project: INET's `src`). They are used only to
resolve base types and are not diffed. The script needs `opp_nedtool` on
`PATH`. It reads `.nedfolders`/`.nedexclusions` at each revision. It takes
about a second on a project of 300 NED files.

What it reports, per NED type, with inheritance flattened:

- types added, removed, moved to another package, and rename candidates
  (same kind, at least 60% member overlap, matched one to one);
- base type and implemented interfaces;
- parameters: added (flagged when there is no default, so every config must
  now set it), removed, rename candidates (same type and value), type,
  effective value, `default()` vs FIXED (`=`, which ini files can no longer
  override), unit, `volatile`, `@mutable`, and the type in the inheritance
  chain that declares or assigns the parameter ("now DECLARED in X (was Y)"
  is a move up or down the inheritance tree);
- deep (pattern) assignments, gates, submodules (type, `like` expression,
  condition, vector size, declaring type, assignments in the submodule body),
  `@class`, `@signal`, `@statistic`, own connections;
- parameter and type doc-comment changes (a change of MEANING often shows
  only there);
- module-tree path changes: each compound type's submodule tree is expanded,
  and paths that moved (one level deeper into a new compound, renamed, gone,
  new, retyped) are reported in the type that introduces the change. They
  are not repeated in every network that contains it. These are the ini
  keys that move.

A subtype that only inherits changes is listed once under "Types affected
only through inheritance".

Then do the judgment work that neither the script nor a plain diff read does:

1. **Classify each item for a user upgrading from base:** *breaks existing
   configs* (removed or renamed parameter, type, submodule or gate; a path
   move; a new parameter without default; FIXED where it was a default; a
   type or unit change), *silently changes results* (a default or effective
   value changed; a statistic's source or record mode changed), or
   *additive*. The interface is everything an ini file, a user's NED file or
   an analysis script can name: type names with packages, parameters,
   module paths, gate names, signal and statistic names.
2. **Confirm the rename candidates.** Look for `git diff -M` file renames,
   the commit message, ini files migrated in the same range (`git diff
   base tip -- '*.ini'`: a rewritten key is the strongest evidence and gives
   the old -> new key), and compatibility guards for old names. Mark each
   rename as confirmed or candidate.
3. **Build the migration list:** for everything in the *breaks* class, one
   instruction per bullet, e.g. "Replace `<old key>` with `<new key>`."
4. **Check the C++ side of each parameter change.** Is a removed parameter
   still read (`git grep -n 'par("<name>")' <tip>`)? Is a new `par()` read
   without a NED declaration? Both are runtime errors.
5. **Check the names that C++ code builds or looks up as strings.** NED
   does not declare them, so neither the script nor a NED diff shows them.
   They are still part of the interface:
   - **Names C++ creates**: dynamically created modules (`create("<name>",
     ...)`, `createScheduleInit`). Their names are ini keys and module paths
     in result files. Signals registered by string (`registerSignal("...")`):
     listeners and `@statistic` sources depend on them. Also check WHICH
     signal a module emits in which case: the declared set can stay the same
     while the conditions change. Results recorded outside `@statistic`
     (`recordScalar`, `cOutVector::setName`).
   - **Names C++ looks up**: `getSubmodule("...")`, `findSubmodule("...")`,
     `getModuleByPath("...")`, relative paths in string literals,
     `hasPar("...")`, `gate("...")`. After a NED rename, a lookup that still
     uses the old name either throws (`getSubmodule`) or silently returns
     "not found" (`findSubmodule`, `hasPar`), and the behavior changes with
     no error.

   Method:
   - **Changed string literals** (the main check): list the identifier-like
     literals on the changed lines, without log and error text:

     ```
     git diff -U0 base tip -- '*.cc' '*.h' | grep -E '^[-+][^-+]' \
       | grep -v -E 'EV|cRuntimeError|throw|//' \
       | grep -o -E '"[A-Za-z][A-Za-z0-9_.^-]*"' | sort | uniq -c | sort -rn
     ```

     The list is short. Trace each literal that names a module, a signal, a
     parameter or a name prefix to its use. Do not grep only for the calls:
     a name is often built on another line than the `create()` or `emit()`
     that uses it (e.g. a `"lteRlc-"` prefix chosen in one line, passed to
     `create()` three lines later).
   - **Stale old names**: for each NED name that was renamed or removed,
     look for string literals at the tip that still use the old name
     (`git grep -n '"<old>"' tip -- '*.cc' '*.h'`, plus paths that contain
     it). A literal that is still correct for another node kind (e.g. a base
     station keeps the old name) is fine; say so in the coverage note.
6. **Read the flagged doc-comment changes.** Report the ones where the
   meaning of an unchanged declaration changed.
7. **State the script's blind spots for this range** in the coverage note:
   - `like` submodules whose type comes from a non-literal expression are
     not expanded;
   - the external libraries are not diffed;
   - if the range also upgrades a dependency, inherited changes from it are
     invisible, because the script resolves both revisions against the one
     `--external` root;
   - NED-level only: names built or looked up in C++ are covered by item 5;
     `.ini`, XML config schemas, `.msg` files and C++ registration
     (`Define_Module`) by sections C and E.

Secondary external surfaces, to mention when touched: the C++ API for users
who subclass (public or virtual methods removed or changed in module
classes), `.msg` packet and tag fields used by user applications, the formats
of XML or other configuration files, and result names (vectors and scalars
recorded outside `@statistic`).

## Step 3 -- section B: responsibilities

A responsibility is a duty a module carries out: it owns state X, decides Y,
handles message kind or gate Z, runs timer T, emits signal S, answers
method M. For each module whose code or NED changed beyond cosmetics, write a
before/after "duty card" from:

- the NED doc comment (base vs tip);
- the message dispatch: `handleMessage` / `handleUpperPacket` / ... --
  which kinds, gates and self-messages it handles;
- self-message timers it owns;
- public methods, especially `Enter_Method` entry points (called from other
  modules);
- state members it owns, signals it emits or subscribes to, and the
  initialization stages it uses.

Find code that moved between modules with `git diff --color-moved=zebra
--color-moved-ws=allow-indentation-change base tip`, file renames with
`git diff -M`, and pairs of removed and added functions with similar bodies.

Report only modules whose SET of duties changed. The kinds of change, and
how a finding of each kind reads in the brief:

- **transferred**: "Y now <does the duty>, which X used to do."
- **gained**: "X now <does the duty>." Say whether it is new behavior or
  accumulated from elsewhere.
- **dropped**: "X no longer <does the duty>." Say who does it now. If
  nobody does, say that plainly: a dropped duty without a new owner is the
  most important kind of finding here.
- **split**, **merged**, **new module**, **removed module**: say it the
  same way, as a sentence.

Flag accumulation: a module that gains a duty from a different layer, plane
or domain than its existing ones. Signs: new dependencies on unrelated
modules, a new group of state members, a doc comment that needs "and also".
Restructuring inside one module with no duty change gets one line ("internal
restructuring of X; duties unchanged").

## Step 4 -- section C: key data structures

A structure is KEY if at least one holds:

- it crosses a module boundary: a packet, chunk, tag or control-info class
  (`.msg`), a struct in a method signature between modules, or a signal
  payload;
- it is a shared registry or table in an infrastructure or singleton module;
- it is the primary state of a module: the table or map its logic revolves
  around;
- it is serialized: a wire format, a serializer, or a chunk length (which
  changes simulated results).

Local helpers, loop variables and private caches are not key.

Report per key structure:

- fields added, removed, renamed or retyped;
- **key and cardinality changes** -- a map keyed by UE becoming keyed by
  (UE, session), one entry per node becoming one per bearer. Highlight
  these: they are semantic changes even when no field changed;
- ownership and lifetime: who creates it, who deletes it, raw pointer vs
  value vs smart pointer;
- the set of writers and the set of readers, before and after;
- new or removed enum values (`switch` completeness);
- serialized size changes.

Method: `git diff base tip -- '*.msg'`; in `.h` diffs, member declarations,
container types (`std::map<`, `std::vector<`, `std::unordered_map<`) and
key types; `git grep` for the writers and readers of each changed member at
both revisions.

## Step 5 -- section D: communication between modules

Mechanisms and their grep markers:

- **Packet or message through gates**: `send(`, `gate(`, NED connections
- **Direct send**: `sendDirect(`
- **Method call through a module reference**: `check_and_cast<`,
  `getModuleByPath`, `ModuleRefByPar`, `getParentModule()->`, `Enter_Method`
- **Signal (notification)**: `emit(`, `subscribe(`, `registerSignal`,
  `receiveSignal`
- **Static configuration by NED parameter**: NED assignments, `par(` on the
  module's own parameters
- **Cross-module parameter read**: `->par(` on another module
- **Runtime configuration write**: `par(...).parse(`, `setValue` on another
  module
- **Packet tags or control info**: `addTag`, `getTag`, `findTag`,
  `removeTag`, `setControlInfo`
- **Shared registry (A writes, B reads)**: infrastructure-module setters and
  getters
- **Initialization-order dependency**: `initialize(int stage)`, `INITSTAGE_*`
- **Global or static state**: `static` members, globals

For the modules touched by the range, build the interaction edge list
(from, to, mechanism, what flows) at base and at tip. Report:

- new edges and removed edges;
- **mechanism changes**, written as a sentence: "A now notifies B with
  signal S instead of calling B's method M", "A now gets X from a setter
  call instead of a NED parameter", "A now calls B instead of sending it a
  packet";
- **direction changes**: pull became push, or the other way round;
- new coupling to infrastructure modules.

Then check every new or changed edge against the rules: the generic ones in
`omnetpp-model-coding-conventions`, and the project's red lines from its
entry-point skill (e.g. `simu5g-dev`). Typical generic conflicts:

- a signal used as a request: the emitting side reads, after `emit()`
  returns, a result that a listener left;
- a method called from another module without `Enter_Method`;
- another module's parameter read with `par()`;
- configuration pushed with `par().parse()` into an already built module;
- a read that depends on initialization order without a stage that
  guarantees the order.

List these in "Rule conflicts", each as a fact with evidence. Do not bury
them in the other lists.

## Step 6 -- section E: other facts for the reviewer

Keep each item short; include only what applies:

- **Claims vs reality**: a commit whose marker or message claims "no
  behavior change" (`refactor:`, `cosmetics:`, ...) but changes the NED
  interface, a default, or test baselines; a fix commit that also adds
  features; a stated goal that the branch does not reach, or goes beyond.
- **Behavior evidence**: fingerprint or statistical baselines re-recorded
  (which ones, in which commit, with what stated reason); re-records without
  a stated reason.
- **Tests**: added, removed, disabled, or made more lenient.
- **Examples and configs**: ini or NED examples changed, added or removed.
- **Documentation**: user-visible changes from section A that no doc or
  release-notes text covers. List them; do not edit release notes.
- **Unchecked areas**: source trees that no test suite exercises (e.g. an
  emulation tree) but that the range touches.

## Step 7 -- write the brief

Fill in [TEMPLATE.md](TEMPLATE.md). The brief is read in its Markdown source
by a human. Write it as prose that reads well there:

- **No tables.** Tables, especially wide ones, are unreadable in the source.
  Write each item as a bullet: a paragraph that starts with a bold title.
- **The bold title is a full sentence that states the finding**, e.g.
  "**The UE's MAC submodule was renamed from `cellularNic.mac` to
  `cellularNic.lteMac`.**" -- not a label such as "**UE submodule rename.**"
  or "**ConnectionControlEnb -> UE.**".
- **The body is full English sentences.** Say what it was before, what it
  is now, and why it matters to the reader. Never collapse a table row into
  a run of fragments separated by colons, semicolons and arrows.
- **No arrows for "renamed", "changed to", "became" or "calls".** Write the
  verb: "X was renamed to Y", "the default changed from A to B", "A now
  calls B instead of emitting a signal". Arrows are acceptable only in
  quoted code.
- **No shorthand markers.** Write "I verified this by reading both
  versions" or "This is an inference from the commit message", not "V" or
  "I". Do not invent abbreviations; say "base station", not "BS", unless the
  codebase itself uses the abbreviation as a name.
- **Evidence goes in its own closing sentence**: "The declaration is at
  `<file:line>`; the change is in commit `<hash>` ("<subject>")."
- **Every commit citation carries its subject**, also the second and later
  times. An abbreviated subject ("...the UE's LTE-leg submodules have the
  lte prefix") is fine; a bare hash is not.
- **Name things the way a user names them**: the module type, the
  submodule path, the parameter name -- then the C++ detail if it matters.

The TL;DR comes first: 5-10 bullets
that fit on one screen, ranked by blast radius:

1. breaks existing user configurations or NED;
2. silently changes results (defaults, effective values, cardinality of key
   state, serialized sizes);
3. dropped duties with no new owner, and rule conflicts;
4. transfers of responsibility and changes of communication mechanism;
5. everything else.

End with "Questions for the reviewer": what the brief could not decide, and
places where the reader's judgment is needed ("who handles X after this
change?"). Give no recommendations unless asked.

Write the brief to the location the project skill names (default: the
scratchpad). In chat, give the TL;DR and the path.

## Scale and delegation

- Small range (under ~30 changed files): do everything inline.
- Larger: always run the script yourself, because it is cheap. Delegate the
  evidence gathering for sections C and D (grep-and-list work) to
  cheaper-model subagents, one per subsystem. Each returns structured lists
  with `file:line` at both revisions. Do sections B and E and the synthesis
  yourself. Spot-check at least three items from each subagent report
  against the code before you use it; record the spot-checks in the
  coverage note.
- For a range with very many commits, read the commit list first and group
  the commits by goal before you read the code. The brief is organized by
  section, not by commit.
