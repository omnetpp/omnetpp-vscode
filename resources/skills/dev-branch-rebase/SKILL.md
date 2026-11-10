---
name: dev-branch-rebase
description: >
  Rebase a topic branch of any software project onto a moved main branch, regression-free:
  partition commits into groups, walk them across intermediate stages of main, validate each
  (group, stage) with scoped regression tests, preserve every attempt as a forensic branch,
  and keep resumable state in a logbook. Use when asked to rebase a long-lived topic branch
  across a large upstream gap. For history cleanup without moving the base, use
  dev-branch-cleanup. Simulation-model projects: omnetpp-model-branch-rebase supplies the
  opp_repl test bindings.
---

# Branch rebase

The full procedure is in [framework.md](framework.md): groups-times-stages incremental
rebase with safe points, four-baseline failure diagnosis, a never-rewrite/fix-commit-only
policy, and a state file that makes the process resumable from disk alone.

Related: dev-branch-cleanup (reshaping history in place, base fixed), and the simpler
conflict tactics in dev-git-workflow (incremental multi-step rebase, intent-preserving
conflict resolution).
