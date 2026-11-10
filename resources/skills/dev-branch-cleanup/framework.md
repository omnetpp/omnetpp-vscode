# Generic Git Branch Cleanup Procedure

Abstract framework for **cleaning up** a `topic` branch: producing a *new* branch with a
clean, legible commit history whose **final state is byte-for-byte identical** to `topic`
(modulo explained baseline updates). The branch does not move — `base` stays fixed, there is no
upstream to absorb. The only thing that changes is the *shape of the history*: commits are
reordered, split, merged, and newly authored so that a reviewer can read the branch and
immediately tell **what preserves behavior, what is a bug fix, and what is an intended behavior
change**, validate each in isolation, and trust that nothing was smuggled in.

Cleanup recomposes the total diff freely — down to the hunk, and even sub-hunk, level — so
commits can be split, merged, reordered, and newly authored at will. The price of that freedom is
a central invariant, the **coverage ledger**, which proves the recomposition lost and invented
nothing.

The framework is domain-agnostic. It assumes a **regression-test infrastructure** whose results
are compared against **recorded baselines** (files committed in the repository), and preferably a
**test-impact map** that tells which tests a change can affect, so that per-commit tests can be
scoped. A project layer (e.g. omnetpp-model-branch-cleanup for simulation models) names the
concrete test tools, the baseline files, the default test selection, and how baselines are
re-recorded. State is kept in a separate markdown file so the procedure can be resumed from disk
alone if the AI conversation is lost.

## How it operates (at a glance)

1. Compute the **total diff** `base..topic` and read every commit. Semantically decompose the
   total diff into **behavior-preserving changes / bug fixes / intended behavior changes**
   (Phase 0 analysis file).
2. Partition the total diff into ordered **change groups** — independently-applicable slices of
   the diff, each with a single type and intent (human-approved). Groups may be merged or
   subdivided later as understanding improves.
3. Decide the **output-commit plan**: the linear sequence of clean commits the new branch will
   contain, their types, messages, order, and each one's **expected test effect** (regression
   results identical for behavior-preserving commits; results changed + baseline updated for
   fixes and unmarked commits).
4. Build the clean branch **forward**, one commit at a time, off `base`. After each commit,
   build + run the **scoped regression test** and update the **coverage ledger**
   (`remaining = git diff cleanHEAD topic`). The ledger drives to empty — monotonically, save for
   tracked **temporary detours** (scaffolding added now and removed later, net zero).
5. The test is the **oracle for the commit's claimed type**:
   - a behavior-preserving commit (*refactor*, *cosmetics*, *cleanup*, *docs*, *test*, *chore*/
     *build*/*ci*) MUST leave the regression results **IDENTICAL** to the previous commit — if it doesn't, the label is
     wrong or behavior leaked in; STOP and investigate;
   - a *fix* or an *unmarked* commit MAY change the results, but only in an **explained** way,
     with the **baseline updated inside that same commit** so it stays green.
6. Every validated commit is a **safe point**. Progress (plan, ledger, per-commit log with
   `what changed / why the result changed / why it's acceptable / baseline update` entries for
   every behavior change) lives in a single markdown logbook so cleanup is resumable from disk
   alone if the AI conversation is lost.
7. When the ledger reaches **empty**, finalize: prove tree-equality against `topic`, run the
   **full (unscoped)** test suite, and confirm the clean branch is green end to end.

## Inputs

The instance must supply, before any cleanup work starts:

- **`topic`** — branch to clean up (its final tree is the pinned target / oracle).
- **`base`** — branch or commit identifying the starting point (`base..topic` = the material to
  recompose). The clean branch is built starting from this exact commit; it never moves.
- **tests** — which regression tests to run as the per-commit regression test, in priority
  order, plus any scope hints. The project layer supplies the defaults. The same suite, run
  **unscoped**, is the Phase 6 acceptance test.

These inputs are recorded verbatim in the state file header.

## Conventions

- `base` — fixed starting commit; the clean branch is built on top of it.
- `topic` — branch being cleaned; **never modified**. Its final tree is the target/oracle.
- `clean` — the new branch under construction (`cleanup/<name>`): the legible history whose
  final tree must equal `topic`'s.
- **output commit** — one commit on `clean`. Each has a declared **type** and a single clear
  intent. The types are the markers of dev-commit-messages: the behavior-preserving `refactor` |
  `cosmetics` | `cleanup` | `docs` | `test` (`test` also covers baseline-only commits) |
  `chore` (or the more specific `build` / `ci`), `fix`,
  and *unmarked* for an intended change of behavior or interface (a feature, a deliberate
  behavior change, a removal). The type becomes the commit's subject marker.
- **change group** — an independently-applicable slice of the total diff (a set of files, hunks,
  or hand-authored edits) that feeds one or more output commits. The atomic unit is the hunk **by
  default, but not the floor**: a hunk that mixes types (a refactor and a behavior change in
  adjacent lines) is split **sub-hunk**, down to individual lines or characters where necessary. Splitting,
  merging, and reordering are the whole point.
- **temporary detour** — content deliberately added in one commit and removed in a later one
  (`+delta … −delta`), netting to **zero** across the branch. A detour is scaffolding present in
  neither `base` nor `topic`; it exists only to keep intermediate commits building/passing when
  reordering alone can't (a shim, a stub, a forward declaration, a retained old code path). It is
  *not* part of the total diff, so it must be tracked and must close before finalization.
- **coverage ledger** — the live accounting that every part of the total diff is assigned to
  exactly one output commit and nothing is *permanently* invented. Operationally: `remaining =
  git diff cleanHEAD topic`. Starts equal to the total diff and ends empty. It shrinks
  monotonically **except across an open detour**: adding a detour's scaffold makes `remaining`
  temporarily *grow* (the scaffold is something `topic` lacks, so the diff now carries its
  eventual removal), and closing the detour shrinks it back. A tracked detour is the only
  legitimate reason for the ledger to move *away* from empty.

## Core invariant & acceptance criterion

Cleanup is **correct** iff, at the end:

1. **Source tree identical** — `git diff topic clean` is empty over all non-baseline files. This
   is the hard, mechanical guarantee that the recomposition neither lost nor invented any code.
   It is *checkable at every step* as the coverage ledger's `remaining` diff.
2. **Baselines correct & explained** — baseline/test-artifact files (the recorded baselines and
   any test-impact data; the project layer names them) on `clean` either match `topic` exactly
   **or** differ only by being *correctly updated to reflect the branch's actual behavior*, with
   every such difference explained in the state file. In the ideal case where `topic` already
   maintained its baselines, there is **no difference at all** and criterion 1 covers everything.
3. **Every commit green (relaxed)** — every output commit **builds** and **passes** the scoped
   test. Relaxation is permitted for individual commits that are genuinely too difficult to make
   green in isolation (e.g. a mid-series refactor that only type-checks once the next commit
   lands), but only with an explicit, logged justification. Prefer to **never break the build**;
   a red *test* with a logged reason is tolerable, a red *build* almost never is.

Why the baseline carve-out is honest: the source tree fully determines the tested behavior, so
identical source ⇒ identical behavior. Baseline files are *test artifacts describing* that
behavior. If `topic` left them stale (tests red on `topic`), `clean` will additionally correct
them — a legitimate, explained divergence in the test-artifact files only, never in source.

## Phase 0 — Analysis

Before partitioning, understand the whole change:

- `git log --stat` and `git diff --stat` for `base..topic`; read the full `base..topic` diff.
- Categorize **the total diff**, not just the commits: which portions preserve behavior
  (refactors such as renames/moves/extractions, cosmetics, cleanup, docs, tests, chores), which are bug
  fixes, which are intended behavior changes (features, deliberate behavior changes, removals).
  The same source commit often mixes all three — that mixing is exactly what cleanup untangles,
  so categorize at the **hunk** level.
- Map each category to files/areas and approximate hunk locations. Note **dependencies** between
  changes (a behavior change that builds on a refactor; a fix to code a refactor moves).
- Test-impact queries (where the project has a test-impact map): changed files → affected
  tests, to scope per-commit tests and predict which tests each group affects.
- Record the **base/topic HEAD SHAs** and the **total-diff size** (files, +/- lines) as the
  ledger's starting magnitude.

Output: a **separate analysis file** at `ai-logs/executions/<date>_<cleanup-name>.analysis.md`
containing the SHAs, the hunk-level categorization, the dependency map, the test-impact findings,
and a first-cut grouping proposal. The analysis file is the durable Phase 0 artefact; the state
file references it rather than duplicating it.

## Phase 1 — Decomposition into change groups

Partition the total diff into an ordered list of change groups `G1, G2, …, Gn`.

- **Atomic unit**: the hunk **by default, but not the floor** — a hunk that mixes types is split
  sub-hunk, down to single lines or characters where a refactor and a behavior change share a
  line.
- **Single type per group**: each group has exactly one type (see Conventions). If a region of the
  diff resists a single label, split it until each piece has one.
- **Independence**: prefer groups that can be applied in isolation. Where the diff has dependent
  changes in the same region (a refactor later modified by a behavior change), the group boundary may
  require **hand-authored intermediate states** — file contents matching neither `base` nor
  `topic` — staged as separate commits. Where no clean order keeps every commit green, a
  **temporary detour** (scaffold added now, removed by a later commit; net zero) is the escape
  hatch. Either way the coverage ledger keeps it honest: whatever intermediate states or detours
  are authored, the *final* tree must still equal `topic` and every detour must close.
- **Total coverage**: every hunk of the total diff belongs to exactly one group. Nothing is
  dropped (there is nothing to drop — the final tree is pinned); nothing is duplicated.
- **Authority**: AI proposes the grouping; **human approves** before build work starts.
- **Mid-flight regrouping**: groups may be split or merged as understanding improves. When that
  happens, new groups take fresh IDs (`G{n+1}, …`; IDs only grow), and the state file records
  `superseded-by` relationships. There are no per-group git branches to fossilize; the fossil
  record is the state file's group table plus the `clean` branch's own history.

Goal of grouping: **minimize the reasoning surface per commit** so a reviewer can validate each
output commit on its own and attribute any surprise to a single, well-labelled change.

## Phase 2 — Output-commit plan & ordering

Map groups onto the linear sequence of output commits the `clean` branch will contain. A group
may become one commit, several commits, or be merged with others into one — the mapping is the
AI's proposal, human-approved.

**Default ordering** (override per instance with logged rationale):

1. **Behavior-preserving first** — `refactor` (renames, moves, extractions), `cosmetics`
   (formatting, comment changes), `cleanup`, `docs`, `test`, `chore`/`build`/`ci`. These keep the
   regression results **identical** and form a stable base the rest builds on. Putting them first lets a reviewer clear them quickly (the test *proves* they're
   inert) and concentrate attention on the smaller, meaningful commits.
2. **Bug fixes next** — each isolated, each with a description of the bug and its symptom.
   Result changes here are the fix's intended effect: explained and baselined in-commit.
3. **Intended behavior changes last** (unmarked) — each a cohesive commit or short series,
   built on already-refactored code. Result changes explained and baselined in-commit.
4. **Baseline-only commits** (`test`) — avoid them; prefer folding each baseline update into the commit
   that causes the behavior change (so every commit is independently green and the baseline
   delta is part of that change's reviewable story). A standalone baseline commit is a last
   resort, logged.

When changes are genuinely independent across subsystems, a **per-subsystem cluster**
(behavior-preserving → fix → behavior change within one subsystem, then the next) can read more
clearly than a global sweep in that order. Use judgment; when the clearer ordering is ambiguous, ASK.

Record the plan in the state file: the ordered commit list, each with type, message subject,
feeding group(s), and **expected test effect** (`results IDENTICAL` vs `results CHANGE —
baseline update expected on tests X, Y`).

## Phase 3 — Test contract

One test invocation per output commit, with build folded in.

- **Build folded into the test step**: a build failure surfaces as a test ERROR (distinct from a
  FAIL, same loop).
- **Scope**: run only the tests the test-impact map flags as affected by the commit's changes,
  restricted further as the project layer specifies (unless the instance opted out).
- **The test is the type oracle** — this is the cleanup-specific use of testing:
  - **behavior-preserving commit** → regression results **must be IDENTICAL** to the previous
    commit on every affected test. A mismatch means the change is not actually
    behavior-preserving: either a real behavior change leaked in (mislabelled — re-classify and
    re-plan) or there's an accidental bug (fix it). **STOP and investigate; do not paper over
    with a baseline update.**
  - **fix or unmarked commit** → regression results **may change**. The change must be (a)
    intended and explained, (b) confined to the tests the test-impact map predicted, and (c)
    reconciled by **updating the baseline inside the same commit**.
- **Baseline updates**: re-record the affected baselines with the project's tool (the project
  layer gives the mechanics), and stage the resulting baseline delta into the commit. The
  baseline delta becoming part of the commit is a feature, not a nuisance: it makes the behavior
  change auditable and keeps every commit green.
- **Result handling**: results are **ephemeral** — consumed to write the state file's prose, then
  discarded. The state file is the durable record of what happened.

Diagnosis baselines available when a commit misbehaves:
- `results_topic` (the intended final behavior),
- `results_base` (the starting reference),
- `results_clean@prev` (the previous output commit — the immediate control for "did *this* commit
  change behavior?").

## Phase 4 — The build loop

Build `clean` forward from `base`, one output commit at a time. For each planned commit `Ck`:

1. **Author the commit's content.** Pick the cheapest mechanism that produces exactly the group's
   slice:
   - *file-disjoint group* → `git checkout topic -- <files>` to pull the final version of files
     this group wholly owns, then commit;
   - *sub-file group* → apply a curated subset of hunks (`git apply` of a hand-trimmed patch, or
     interactive `git checkout -p` / `git add -p` against `topic`), then commit;
   - *dependent region* → hand-author the intermediate file state, then commit;
   - *can't stay green by ordering alone* → open a **temporary detour**: add a scaffold (record it
     as an open detour), commit, and schedule the matching removal commit later in the plan.
2. **Build + run the scoped test** (Phase 3).
3. **Check the type oracle**: behavior-preserving ⇒ expect results IDENTICAL; fix or unmarked ⇒
   expect the predicted change. On a surprise, STOP (do not advance the ledger).
4. **Reconcile baselines** for fix and unmarked commits (re-record the affected baselines, `git add`
   them, `--amend` into `Ck` so the commit is self-consistently green).
5. **Update the coverage ledger**: recompute `remaining = git diff cleanHEAD topic`. Confirm it
   moved by exactly this commit's intended effect — *shrank* by the group's slice for an ordinary
   commit, *grew* by the scaffold for a detour-opening commit, *shrank back* for a detour-closing
   commit — and that no *unintended* file changed. Record any newly-opened or now-closed detour.
   The ledger plus the open-detour list is the live, resumable-cold progress signal — another
   agent can reconstruct "what's left" from this diff, the open detours, and the plan.
6. **PASS** → the commit is a **safe point**; append a progress-log entry; continue silently.
7. **FAIL / ERROR / oracle-surprise** →
   - Diagnose against the Phase 3 baselines; write narrative root-cause prose.
   - **Build/test red because of ordering** (a commit references something a later group
     introduces) → reorder the plan, merge the two groups, or — when neither is clean — open a
     **temporary detour** (a bridging scaffold removed by a later commit, net zero). Log the
     regrouping or the detour (IDs only grow; detours stay tracked until closed).
   - **Behavior-preserving commit changed the results** → re-classify (it was secretly a fix or
     a behavior change) or fix the
     accidental bug. Re-plan the affected commits. **ASK** the human with the finding.
   - **Genuinely too hard to make this single commit green** → first try reordering or a temporary
     detour to keep it green; only if both are worse than the disease, fall back to the relaxed
     rule: log the explicit justification, keep the build green if at all possible, and carry the
     test expectation forward to the commit that resolves it.
   - On any non-trivial ambiguity, **STOP and ASK**.

Rework discipline: prefer append-only forward progress; each validated commit is a safe point. If
re-partitioning forces rewriting an already-built commit, snapshot the current tip as a fossil
(`cleanup/<name>/checkpoint-<ISO8601>`) **before** any reset/`rebase -i`, then rebuild forward.
`topic` is never touched; it remains the oracle throughout.

## Phase 5 — Human ASK seams

Runs autonomously on the happy path; pauses for human input at:

- Initial grouping proposal (Phase 1) and initial output-commit plan / ordering (Phase 2).
- Any commit where a behavior-preserving commit changed the regression results (mislabel vs.
  accidental bug).
- Any behavior change whose acceptability is not obvious (is this result delta *intended*?).
- Group split/merge or output-commit reordering that changes the approved plan.
- A commit that must be left test-red under the relaxed rule.
- Any decision that is difficult or ambiguous to make.
- Final delivery (Phase 6).

No ASK on a clean PASS that matches the planned expectation.

## Phase 6 — Finalization

When the coverage ledger reaches **empty**:

1. **Prove tree-equality**: `git diff topic clean` is empty over non-baseline files **and the
   open-detours list is empty**. Any residual delta is a partition bug or an unclosed detour (its
   scaffold lives on `clean` but not `topic`) — resolve it before declaring done. List any
   baseline-file differences from `topic` with their per-commit explanations (ideally none).
2. **Full (unscoped) test**: run the full regression suite (as the project layer defines it) on
   `clean`. Confirm green end to end. Spot-check a few commits in the middle of the history to
   confirm they too build and pass (the per-commit safe points should already guarantee this;
   verify a sample).
3. **Confirm the story reads**: the commit list, top to bottom, separates behavior-preserving
   commits from fixes from intended behavior changes, each message states intent, and each behavior change carries its baseline delta.
4. Write the **Finalization** section: the final ordered commit list with types, the
   tree-equality proof, the full-suite result, and the mapping of every behavior-changing commit
   to its `why-changed / why-acceptable / baseline-update` explanation.

## Branches & safe points

- `cleanup/<name>` — the `clean` branch under construction. Advances one validated commit at a
  time; every validated commit is a safe point.
- `cleanup/<name>/checkpoint-<ISO8601>` — fossil snapshot taken before any rework that would
  rewrite already-built commits. Preserved, never deleted.
- `topic` — never modified; the oracle. `base` — never modified; the start point.
- **Branches only, no tags.** Branch names are the authoritative reference to safe points. IDs
  (group IDs, checkpoint timestamps) only grow; nothing is renamed or deleted.

## State file

- **Location**: `ai-logs/executions/<date>_<cleanup-name>.md` (one file per cleanup; separate
  from `ai-logs/plans/`).
- **Format**: single markdown file, curated head sections + append-only progress log.
- **Resumable cold**: must contain enough — together with the `clean` branch and `git diff
  cleanHEAD topic` — to continue even if the AI conversation is lost.
- **Timestamps**: every date/time inside the file is full ISO 8601 with seconds
  (`YYYY-MM-DDThh:mm:ss`); the filename keeps the date-only form for legibility.

Required sections:

1. **Header** — SHAs of `base` and `topic`; instance/project info; the test invocation (tests,
   scope rule); baseline-store paths (the recorded baselines and the test-impact data); the
   `clean` branch name; link to the Phase 0 analysis file.
2. **Total-diff analysis** — the Phase 0 hunk-level categorization (behavior-preserving / fixes /
   intended behavior changes) mapped to files/areas, with the dependency map between changes and the test-impact
   findings. Summarized here; full detail in the analysis file.
3. **Change groups** (Phase 1) — table: id, type, intent, source material (files + hunk refs),
   independence/dependency notes, target output commit(s). Superseded groups remain with
   `superseded-by` annotation.
4. **Output-commit plan** (Phase 2) — the ordered commit list: position, type, message subject,
   feeding group(s), and **expected test effect** (`results IDENTICAL` vs `CHANGES on X,Y +
   baseline update`). Edited in place as the plan evolves.
5. **Coverage ledger** — the live "what's left" view: total-diff magnitude (files, +/- lines);
   applied-so-far; `remaining = git diff cleanHEAD topic` magnitude; a per-file checklist marking
   each as fully-assigned / partially-assigned / untouched; and an **open-detours** list — every
   temporary scaffold added but not yet removed, with the commit that opened it and the planned
   commit that will close it. The single source of truth for progress; refreshed after every
   commit. Completion requires `remaining` empty **and** zero open detours.
6. **Progress & safe points** — the `clean` branch's validated commits (SHA, subject, type, test
   status), the latest safe point, and a % complete (e.g. `1 − remaining/total` by line volume).
7. **Progress log** (append-only) — one entry per output commit built (or per rework attempt):
   - timestamp (full ISO 8601), output commit position + planned type, the commit SHA + subject.
   - diff material absorbed (which groups/hunks), and the post-commit ledger delta.
   - build result; scoped test result (PASS / FAIL / ERROR); affected tests.
   - **for a behavior-preserving commit**: one line confirming the oracle —
     `results IDENTICAL vs prev on {…} — behavior-preserving confirmed`.
   - **for a fix or unmarked commit (behavior change)**: a sub-entry with these four labelled fields,
     in this order:
     - **What changed**: the code change and the test delta it produced — exact tests and the
       nature of the result change (the project layer gives examples of precise phrasing).
       Avoid vague phrasing.
     - **Why the result changed**: the causal mechanism — what in the code makes the tested
       behavior different, tied to the specific lines this commit introduces.
     - **Why it's acceptable**: why this new behavior is correct/intended (it's the bug fix's
       point; it's the intended change's output), and why nothing *else* should have moved (the change
       is confined to the predicted tests; unrelated tests stayed IDENTICAL).
     - **Baseline update**: which baseline entries were re-recorded and how, and confirmation
       they are staged into this same commit.
   - **for a detour-opening / detour-closing commit**: the detour id, the scaffold added or
     removed, why ordering couldn't avoid it, and the ledger's expected transient growth/shrink.
     An open detour stays listed in §5 until its closing commit lands.
   - **for a relaxed (left-red) commit**: the explicit justification and which later commit is
     expected to turn it green.
8. **Open issues / next step** — pending ambiguities, pending ASKs, planned next commit.
9. **Finalization** (Phase 6) — final ordered commit list with types; confirmation that **zero
   temporary detours remain open**; the `git diff topic clean` tree-equality proof (and any
   explained baseline-file differences); the full-suite test result; the complete behavior-change
   → explanation → baseline-update mapping.

Treat the file as a logbook: only the head sections (1–6, 8) are edited in place; the progress
log (7) is append-only; Finalization (9) is written once at the end.
