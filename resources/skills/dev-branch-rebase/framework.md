# Generic Git Branch Rebase Procedure

Abstract framework for rebasing a `topic` branch onto a `main` branch (common ancestor `base`), producing a regression-free history. State is kept in a separate markdown file so the procedure can be resumed from disk alone if the AI conversation is lost.

The framework is domain-agnostic. It assumes a **regression-test infrastructure** whose results are compared against **recorded baselines**, and preferably a **test-impact map** that tells which tests a change can affect. A project layer (e.g. omnetpp-model-branch-rebase for simulation models) names the concrete test tools, the default test selection and the impact queries. Project-specific procedures are instances that fill in hooks: grouping heuristics, stage selection, integration mode, scope.

## How it operates (at a glance)

1. Partition `base..topic` into ordered **groups** of whole commits (human-approved).
2. For each group, pick an ordered list of **stages** — checkpoints on `main` between `base` and `main`'s HEAD — where the group will be incrementally rebased.
3. Walk every (group, stage) pair: branch off the previous safe point, apply the group's commits, build + run a **scoped regression test** (default test selection from the project layer).
4. **PASS** → promote the attempt to a canonical safe-point branch and continue silently. **FAIL/ERROR** → diagnose against four baselines (topic / base / main@Sj / previous safe point), author a new **fix commit** on a fresh attempt branch (never amend, never rewrite), re-run, ASK the human on success.
5. Every attempt — passing or failing — is preserved as a forensic git branch; no history is ever rewritten.
6. State (groups, stages, safe points, append-only progress log with per-fix `what failed / how it improved / why it's correct` entries) lives in a single markdown logbook so the rebase is resumable from disk alone if the AI conversation is lost.
7. When the last group reaches the last stage, assemble the **clean target** = topic commits in group order + fix commits, scaffolding stripped, validated against topic with the full (unscoped) regression test.

## Inputs

The instance must supply, before any rebase work starts:

- **`topic`** — branch name to rebase
- **`main`** — target branch name to rebase onto
- **`base`** — branch (or commit) name identifying the common ancestor of `topic` and `main`
- **tests** — which regression tests to run, in priority order; together with any scope hints the instance wants the framework to honour. The project layer supplies the defaults.

These inputs are recorded verbatim in the state file header.

## Conventions

- `base` — last common ancestor of `topic` and `main` (resolved from the input)
- `topic` — branch being rebased (`base..topic` = commits to carry forward)
- `main` — target branch (`base..main` = changes to rebase over)
- `target` — final clean branch: topic's effect on top of `main` HEAD, fix commits included, per-stage scaffolding stripped

## Phase 0 — Analysis

Before grouping, run a full upstream-gap and topic analysis:

- `git log` + `git diff --stat` for `base..main` and `base..topic`
- categorize topic commits (additive vs. modifying vs. baseline-update vs. fixup)
- file overlap between gap and topic
- test-impact queries (where the project has a test-impact map): commits → affected tests

Output: a **separate analysis file** at `ai-logs/executions/<date>_<rebase-name>.analysis.md`, containing SHAs of base/topic/main HEAD, upstream-gap summary, topic commit categorization, file overlap map, test-impact findings, and conflict prediction. The analysis file is the durable Phase 0 artefact; the state file references it but doesn't duplicate its contents.

## Phase 1 — Grouping

Partition `base..topic` into an ordered list of groups `G1, G2, …, Gn`.

- **Atomic unit**: whole commits. No splitting; no squashing of input commits.
- **Free reordering**: a group is an ordered list of topic commits drawn from anywhere in `base..topic`; groups are themselves ordered.
- **Total coverage**: every topic commit appears in exactly one group. Commits the AI proposes to drop are assigned to an explicit `dropped` group with logged rationale.
- **Authority**: AI proposes the initial grouping; human approves before any rebase work starts.
- **Mid-flight regrouping**: groups may be split or merged during the rebase. When that happens:
  - existing per-group branches are kept as historical fossils (no renames, no deletions)
  - new groups take fresh IDs (`G{n+1}`, `G{n+2}`, …); group IDs only grow
  - state file records `superseded-by` relationships

Goal of grouping: minimize the diagnosis surface per group so any regression introduced by a group is easy to attribute and fix.

Output: the approved grouping is written into the state file's **Groups** section (see Phase 5 file structure below). The state file is the durable Phase 1 artefact.

## Phase 2 — Stages per group

For each `Gi`, choose an ordered list of stages `[S0=base, S1, …, Sk=main HEAD]` — commits on `main` where `Gi` will be incrementally rebased.

- **Adaptive selection**: pick stages so each per-stage rebase introduces no or minor regressions. Use test-impact hints (which main commits touch files `Gi` touches) plus AI judgement.
- **Subdivision**: if a chosen stage proves too coarse (intractable regressions), it can be split into smaller stages mid-flight. Tracked in the state file.
- **Bad main stages**: if `regression_test` fails on plain `main@Sj`, the AI may skip `Sj`, replace it with a nearby commit, or escalate to the human. Logged either way.

## Phase 3 — Test contract

A single test invocation per attempt. The test type is set by the instance and by the affected scope.

- **Build is folded into the test step**: build failure surfaces as a test ERROR (distinct from a FAIL but handled by the same loop).
- **Scope**: tests are run only where the test-impact map flags them as affected by the group's commits (no full-suite runs per stage), restricted further as the project layer specifies, unless the instance has explicitly opted out.
- **Result handling**: results are **ephemeral** — consumed during diagnosis to produce prose summaries in the state file, then discarded. The state file is the durable record of "what happened".

Diagnosis baselines available on FAIL:
- `results_topic` (intended behaviour)
- `results_base` (reference)
- `results_main@Sj` (control — main's behaviour at this stage)
- `results_current@stage-(j-1)` (previous safe point)

## Phase 4 — Integration mode (instance-specified)

Groups can interact in three documented ways; the instance picks one:

- **Parallel-end**: each group walks its stages on plain `main` independently; groups are integrated once, after all reach `Sk`.
- **Lockstep**: at each stage `Sj`, every group is rebased onto `Sj`, then combined and tested together. Continuous integration testing.
- **Serial**: G1 walks its stages on plain `main`, lands at `Sk`. G2 then walks its stages on top of G1's final state, and so on.

The instance documents which mode it uses and why.

## Phase 5 — The rebase loop

For each group `Gi` (in order), and each stage `Sj` (in order):

1. Branch off the previous safe point (`rebase/group-<i>/stage-<j-1>`, or the appropriate starting branch per the integration mode).
2. Apply `Gi`'s commits, resolving mechanical conflicts. Work lives on `rebase/group-<i>/attempt/<j>-<k>` (every attempt — passing or failing — is preserved as a forensic branch).
3. Run `regression_test` (build folded in).
4. **PASS** → promote that SHA to the canonical safe-point name `rebase/group-<i>/stage-<j>`, update state file, continue silently to the next stage.
5. **FAIL or ERROR**:
   - AI compares `results_current` against the four baselines.
   - AI writes a narrative diagnosis (root cause, why it diverges).
   - AI authors a **fix commit** — a new commit on the attempt branch (never amend an existing commit; never rewrite history).
   - Re-run on a fresh attempt branch (`attempt-<k+1>`).
   - On PASS, ASK human with a summary of the fix; promote to safe-point name on approval.
   - On persistent FAIL, **STOP and ASK**: candidate moves include stage subdivision, group split/merge, or human-led investigation.
   - **Logging contract**: before promoting (or ASKing), append the attempt's progress-log entry per the State file's section 7 format. Each fix authored in this attempt must be captured as its own sub-entry with the four labelled fields (`Fix commit`, `What failed before`, `How it got better after`, `Why the fix is correct`). The fix summary shown to the human at the ASK is a condensed read of those fields, not a separate artefact.

## Phase 6 — Human ASK seams

The framework runs autonomously on the happy path and pauses for human input at well-defined moments:

- Initial grouping proposal (Phase 1)
- Initial stage identification per group (Phase 2)
- Any applied fix, with the diagnosis + fix summary
- Group split / merge
- Stage subdivision
- Main-stage skip / replace
- Persistent failure that can't be auto-fixed
- Final delivery (Phase 7)

No ASK on clean PASS stage advances.

## Phase 7 — Finalization

When `Gn` reaches `Sk`:

1. Assemble the **clean target branch**: original topic commits (in group/applied order) plus the fix commits, **with all per-stage scaffolding stripped**. The historical per-stage branches survive untouched as audit trail.
2. Run the full (unscoped) `regression_test` on the clean target and on `topic`.
3. If results match — or every delta is explained in the state file — declare the rebase complete.
4. Produce a finalization section in the state file: every fix paired with the topic commit it adapted and the diagnosis that motivated it.

## Branches & safe points

- **Safe point** = any `rebase/group-<i>/stage-<j>` branch where `regression_test` passed. Every successful stage is a safe point.
- **Naming** (chosen so safe-point and attempt refs never share a path prefix — git forbids a ref being both a file and a directory):
  - `rebase/group-<i>/stage-<j>` — canonical safe-point branch (one per promoted safe point, pinned to a passing SHA)
  - `rebase/group-<i>/attempt/<j>-<k>` — forensic attempt branch (every attempt for stage `<j>`, attempt index `<k>`, preserved)
- **Branches only, no tags.** Branches are durable; their names are the authoritative reference to safe points.
- Historical branches from superseded groupings persist untouched.

## State file

- **Location**: `ai-logs/executions/<date>_<rebase-name>.md` (separate from `ai-logs/plans/`; one file per rebase).
- **Format**: single markdown file, curated head sections + append-only progress log.
- **Resumable cold**: must contain enough to continue the rebase even if the AI conversation is lost.
- **Timestamps**: every date or time written into the state file uses full ISO 8601 with seconds resolution (`YYYY-MM-DDThh:mm:ss`). The filename `<date>_<rebase-name>.md` keeps the date-only form for legibility; everything inside the file is full timestamp.

Required sections:

1. **Header** — SHAs of `base`, `topic`, `main` HEAD; instance / project info; integration mode; test invocation; relevant project paths; link to the Phase 0 analysis file.
2. **Groups** (Phase 1 output) — current group table: id, ordered commits, affected areas, intent, current stage, current branch. Superseded groups remain with `superseded-by` annotation.
3. **Stages per group** — ordered `Sj` list per `Gi` with one-line justification; subdivisions and skips logged inline.
4. **Progress report** — per current group and total: estimated completion percentage (e.g. stages-passed / total-stages, weighted by patch volume if useful), plus the most recent test invocation for that group (which tests were run, scope, PASS/FAIL/ERROR result, any explanatory note). Refreshed whenever a stage transitions or a group is regrouped.
5. **Latest regression-free branches** — one row per current group: the most recent `rebase/group-<i>/stage-<j>` branch on which `regression_test` passes (possibly only after fix commits applied at that stage). This is the curated "where each group stands right now" view; the safe-point set is the union across groups.
6. **Safe points** — full list of `rebase/group-<i>/stage-<j>` branches with their SHA and the (scoped) test status proving "no known regressions". Initialized at rebase start to the "all groups at stage-0" state (every group sitting at `base`, no rebase work yet applied — trivially regression-free); grows as groups advance through their stages.
7. **Progress log** (append-only) — one entry per attempted step:
   - timestamp (full ISO 8601 with date + hours:minutes:seconds, e.g. `2026-05-29T14:32:07`), group, transition `Sj-1 → Sj`, attempt index
   - test status (PASS / FAIL / ERROR)
   - on PASS without fixes: a single line is enough (branch SHA + scoped test summary).
   - on FAIL / ERROR: the failing tests/build errors and the diagnosis prose, followed by a **Fixes** sub-section. Record every fix commit applied during this attempt as its own sub-entry. Each sub-entry must contain — explicitly, in this order, with these labels — four fields:
     - **Fix commit**: SHA + one-line subject + the topic commit(s) it adapts (or "infrastructure / cross-cutting" if it doesn't pair to one).
     - **What failed before**: the precise symptom before the fix — exact compiler error / linker error / failing test names / baseline delta (with magnitude where applicable, e.g. "N rows DIFFERENT"). Quote the relevant snippet of the build/test output when it pins down the failure. Avoid vague phrasing like "build broke" or "tests failed". The project layer gives further examples.
     - **How it got better after**: the post-fix observation that proves the fix landed correctly — what the same build/test now reports (e.g. "release + debug build OK", "results IDENTICAL on the 7 affected tests vs main@Sj"). If something is still off but is now an *expected* divergence, say so and link to the explanation.
     - **Why the fix is correct**: the causal reasoning. Identify the upstream change on `main` (or in `topic`) that caused the regression, the API/data-flow contract the fix re-establishes, and why no other call site or behavioural path is broken by the fix. If the fix is a port to a renamed/relocated API, name both the old and new symbol; if it's a value/init-stage relocation, name the constraint that pins the new location. If correctness rests on a non-obvious invariant, state that invariant explicitly so a future reader can re-verify it.
   - A single attempt can carry multiple fix sub-entries; list them in the order they were applied. If a fix was folded into the cherry-pick (no separate commit), still write the sub-entry but record `Fix commit: folded into cherry-pick of <SHA>` and keep all four labelled fields.
   - These four fields are the durable record consumed at Phase 7 finalization (fix-to-topic-commit mapping); writing them at attempt time avoids a reconstruction pass at the end.
8. **Open issues / next step** — pending regressions, pending decisions, planned next move.
9. **Finalization** (written at Phase 7) — fix-to-topic-commit mapping, summary of every diagnosis.

Treat the file as a logbook: only the head sections are edited in place; the progress log is append-only.
