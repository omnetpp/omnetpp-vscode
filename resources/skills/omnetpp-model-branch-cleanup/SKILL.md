---
name: omnetpp-model-branch-cleanup
description: >
  Clean up a topic branch of an OMNeT++-based simulation project (INET, Simu5G, ...) into a
  reviewable history using opp_repl-driven regression testing (fingerprint + statistical
  tests, dependency-scoped): the opp_repl bindings for the dev-branch-cleanup procedures
  (test selection, dependency-store scoping, baseline re-recording, validation messages).
  Use when asked to clean up, reorganize, or validate a feature/topic branch of a
  simulation project and opp_repl is available. For rebasing onto a moved main branch use
  omnetpp-model-branch-rebase; for the INET CLI-based playbook see inet-branch-cleanup.
---

# Branch cleanup for simulation models (opp_repl)

Applies on top of dev-branch-cleanup; read that first (its `framework.md` and
`interactive-walkthrough.md`). This skill supplies the simulation-model bindings for the
places where the generic procedures say "regression tests", "baselines" and "test-impact map".

## Test infrastructure

- **opp_repl**, preferably through its MCP server, for running simulations, querying the
  dependency store, and running tests.
- **Regression tests**: fingerprint, statistical and chart tests.
- **Baselines**: fingerprints in `fingerprint.json`; statistical baselines as `.sca` files in
  the statistics folder.
- **Test-impact map**: the dependency store (`dependency.json`), which maps changed files →
  NED packages → features → simulation configs. Changes in core/common code (directories not
  belonging to any feature) conservatively trigger testing of all configs.
- **Default test selection**: `[fingerprint, statistical]`, **run number 0 only** (other runs
  ignored unless the instance opts in). Scoping selects the simulation configs the dependency
  store flags as affected.
- The "regression results identical" oracle means: fingerprint IDENTICAL to the previous
  commit on every affected config. The source tree fully determines simulation behavior, which
  is why identical source ⇒ identical fingerprints.

## Re-recording baselines

- Fingerprint: `update_fingerprint_test_results(...)` (→ `FingerprintStore.update_fingerprint`,
  writing `fingerprint.json`; result codes `INSERT`/`UPDATE`/`KEEP`). Stage the resulting
  `fingerprint.json` delta into the commit.
- Statistical: `update_statistical_test_results(...)` (copies the current `.sca` into the
  baseline dir). Stage the `.sca` delta into the commit.
- The baseline/test-artifact files of the framework's acceptance criterion are
  `fingerprint.json`, `*.sca` and `dependency.json`.

## Framework bindings (framework.md)

- **Phase 0**: dependency-store queries (`dependency.json`): changed files → NED packages →
  features → simulation configs, to scope per-commit tests and predict which configs each group
  affects.
- **Phase 6**: the full suite is the full opp_repl suite (all flagged configs; run 0, or wider
  if the instance opted in).
- **State file header**: the opp_repl test invocation (types, run 0, scope rule) and the
  baseline-store paths (`fingerprint.json`, `.sca` dir, `dependency.json`).
- **Progress log phrasing**:
  - behavior-preserving commit oracle line: `fingerprint IDENTICAL vs prev on configs {…} —
    behavior-preserving confirmed`;
  - "What changed" examples: `fingerprint hash changed on config X run 0`;
    `+954 statistical rows, additive only, 0 conflicting values`;
  - "Why it's acceptable": the change is confined to the dependency-store-predicted configs;
    unrelated configs stayed IDENTICAL;
  - "Baseline update" example: `update_fingerprint_test_results` → `fingerprint.json` entries
    for X,Y, codes UPDATE/INSERT; or `update_statistical_test_results` → `.sca` files copied.

## Walkthrough bindings (interactive-walkthrough.md)

Inputs and prerequisites: a **`.opp` file** defining the simulation project (e.g. INET), the
baseline branch, the feature branch (e.g. `topic/infrastructure`); **opp_repl**; an
**omnetpp version** compatible with both the baseline and the feature branch.

- **1.1 Separate baseline stores**: copy the original `.opp` file and modify the test store
  paths:
  - `fingerprint_store="tests/fingerprint/<feature>-clean.json"`
  - `statistics_folder="tests/statistical/<feature>-clean"`

  ```python
  clean_project = SimulationProject(...)  # load from the modified .opp file
  ```
- **1.2 Build**: build the simulation project in debug mode (opp_repl's run and update
  functions default to debug, and testing is debug-only: see "Build and test in debug
  mode only" in omnetpp-model-development).
- **1.3 Test-impact map**: run all simulations on the baseline to build the dependency
  database:
  ```python
  update_simulation_task_dependencies(simulation_project=clean_project)
  ```
- **1.4 Baseline results**: run all simulations on the baseline to populate the separate
  stores:
  ```python
  update_fingerprint_test_results(simulation_project=clean_project)
  update_statistical_test_results(simulation_project=clean_project)
  ```
- **3.3 Commit message**: name the affected modules/protocols.
- **3.5 Scoped tests**:
  ```python
  run_fingerprint_tests(simulation_project=clean_project, affected_by_modification_filter="<commit>")
  run_statistical_tests(simulation_project=clean_project, affected_by_modification_filter="<commit>")
  ```
  `affected_by_modification_filter` uses the dependency store to test only the simulation
  configs affected by the modified files.
- **3.6 Rolling results forward** (explainable FAIL):
  ```python
  update_fingerprint_test_results(simulation_project=clean_project, affected_by_modification_filter="<commit>")
  update_statistical_test_results(simulation_project=clean_project, affected_by_modification_filter="<commit>")
  ```
- **3.7 Validation in the commit message**: the "summary of the test results" is the `repr()`
  of the fingerprint test results and of the statistical test results. Example explanation
  for an explained FAIL: event reordering due to synchronous send replacing async at the same
  simulation time.
- **4 Final validation**: `run_fingerprint_tests(simulation_project=clean_project)` and
  `run_statistical_tests(simulation_project=clean_project)` over all configs.
