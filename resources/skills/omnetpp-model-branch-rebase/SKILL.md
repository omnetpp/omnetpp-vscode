---
name: omnetpp-model-branch-rebase
description: >
  Rebase a topic branch of an OMNeT++-based simulation project (INET, Simu5G, ...) onto a
  moved main branch, regression-free, using opp_repl tests: the opp_repl bindings for the
  dev-branch-rebase procedure (test selection, dependency-store scoping and stage hints,
  diagnosis queries, symptom phrasing). Use when asked to rebase a long-lived topic branch of
  a simulation project across a large upstream gap and opp_repl is available. For history
  cleanup without moving the base, use omnetpp-model-branch-cleanup.
---

# Branch rebase for simulation models (opp_repl)

Applies on top of dev-branch-rebase; read that first (its `framework.md`). This skill
supplies the simulation-model bindings for the places where the generic procedure says
"regression tests", "baselines" and "test-impact map".

## Test infrastructure

- **opp_repl** as the test infrastructure: fingerprint, statistical and chart tests. The
  instance sets the test type (fingerprint / statistical / chart / combination) and the
  affected scope; a single test invocation per attempt is run via opp_repl.
- **Default test selection**: `[fingerprint, statistical]`, with **run number 0 only** (other
  runs are ignored unless the instance explicitly opts in).
- **Test-impact map**: the opp_repl dependency store, which maps commits → NED packages →
  features → simulation configs. Tests are run only on the configs it flags as affected by the
  group's commits.
- Example instances of the framework: INET infrastructure cleanup, Simu5G upstream rebase.

## Framework bindings (framework.md)

- **Phase 0**: categorize topic commits as additive vs. modifying vs. fingerprint-update vs.
  fixup; run opp_repl dependency-store queries (commits → NED packages → features →
  simulation configs).
- **Phase 2**: stage selection uses opp_repl dependency-store hints (which main commits touch
  files the group touches).
- **Phase 5**: on FAIL, run opp_repl queries comparing `results_current` against the four
  baselines.
- **State file header**: the opp_repl test invocation.
- **Progress log phrasing** (fix sub-entries):
  - "What failed before" examples: `fingerprint hash mismatch on config X run 0`, `N rows
    DIFFERENT`;
  - "How it got better after" examples: `fingerprint IDENTICAL on the 7 affected configs vs
    main@Sj`, `the 954 new statistical rows are additive only, 0 conflicting values`;
  - "Why the fix is correct" example of a non-obvious invariant to state explicitly: "the
    inherited fields aren't used by NR RLC code".
