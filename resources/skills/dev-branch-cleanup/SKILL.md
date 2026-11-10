---
name: dev-branch-cleanup
description: >
  Clean up a topic branch of any software project into a reviewable history, using the
  project's regression tests as the oracle: recompose the total diff into commits typed by
  the dev-commit-messages markers, validate each against the recorded baselines, and prove nothing
  was lost via a coverage ledger; or, for ordinary branches, an interactive per-patch
  procedure. Use when asked to clean up, reorganize, or validate a feature/topic branch.
  For rebasing onto a moved main branch use dev-branch-rebase. Simulation-model projects:
  omnetpp-model-branch-cleanup supplies the opp_repl test bindings.
---

# Branch cleanup

Two procedures, by rigor:

- [interactive-walkthrough.md](interactive-walkthrough.md) — the lighter, interactive
  per-patch procedure: cherry-pick each commit, run the regression tests scoped to the parts
  it affects, confirm each step with the user. Start here for ordinary branches.
- [framework.md](framework.md) — the full framework with free hunk-level recomposition,
  typed output commits (a behavior-preserving commit MUST leave the regression results
  identical; a fix or an unmarked commit may change them only with an in-commit baseline update
  and explanation), a coverage ledger
  proving the recomposition is lossless, and a resumable state file. Use for large or messy
  branches where commit boundaries must be redrawn.

Both assume a regression-test infrastructure with recorded baselines, preferably with a
test-impact map for scoping. A project layer names the concrete tools, baseline files and
defaults. The final state of the cleaned branch must be byte-identical to the original topic
branch (modulo explained baseline updates); the original branch is never rewritten.
