---
name: omnetpp-model-fingerprint-testing
description: >
  Run, triage, and re-record OMNeT++ simulation fingerprint tests: what fingerprints are,
  ingredient semantics (tplx, tilx, ~tNl, ~tND, ~tNlb, sz, tyf), how to interpret which
  ingredient moved and why, and the discipline for accepting fingerprint changes. Use when
  fingerprint tests fail or drift, when re-recording fingerprint baselines, when choosing
  ingredients for a new test, or when planning a refactoring that must keep fingerprints
  stable. Generic knowledge only — the exact runner command and flags for each project are
  in that project's skill (e.g. inet-fingerprint-testing, simu5g-fingerprint-testing).
---

# Fingerprint testing (generic)

A fingerprint is a 32-bit hash accumulated over a simulation run from selected
"ingredients" (simulation time, module paths, packet lengths, packet bytes, ...).
Fingerprint tests run each simulation for a configured time limit and compare
the computed fingerprints against recorded baselines stored in CSV files
(entries look like `ce26-3758/tplx;5d56-5fa2/~tNl` — hash/ingredients pairs).
They are the primary regression harness for model refactoring: a behavior-preserving
change must leave fingerprints byte-identical; a behavior-changing commit must
explain exactly which fingerprints moved and why.

Reference files (read as needed):
- [ingredients.md](ingredients.md) — ingredient letters and the standard combinations.
- [interpreting-drift.md](interpreting-drift.md) — mapping a moved ingredient to its cause.

## Workflow

1. **Purge stale result artifacts first.** The runner leaves `*.UPDATED`,
   `*.ERROR`, `*.FAILED` files next to the baseline CSVs. A leftover from an
   earlier run (or another commit) makes a deterministic simulation look
   non-deterministic and sends you chasing ghosts. Delete them before running,
   and trust only the current run's log output — never a leftover file.
2. **Run the suite** with the project's runner (see the project skill) in
   **debug mode** (see "Build and test in debug mode only" in
   omnetpp-model-development: never release, except to reproduce a CI
   release-only failure), saving
   the output to a log file. Do not edit NED or ini files in that tree while
   it runs: each row reads them when it starts, while the C++ library was
   fixed at launch, so later rows run new NED against the old library ("Class
   not found", "Unknown parameter" errors that look like a broken baseline).
   Edit only `.cc`/`.h` files there, or work in another worktree.
3. **Read the summary line** at the end of the log: `OK`,
   `FAILED (failures=N)`, or `FAILED (errors=M, ...)`.
   - **errors** = simulations that crashed or hit a runtime error. NEVER
     acceptable; there is a bug to fix.
   - **failures** = fingerprint mismatches. Acceptable only when each mismatch
     is an expected consequence of the change.
4. **Triage errors first.** Search the log for the error lines (they carry the
   simulation directory, command line, and message); re-run the failing
   simulation manually if you need a stack trace. Do NOT re-record baselines
   while any error is present.
5. **Explain every failure per-ingredient.** For each mismatching simulation,
   identify which ingredient(s) moved and tie each one to the code change using
   [interpreting-drift.md](interpreting-drift.md). An ingredient move you
   cannot explain is a red flag: investigate, don't re-record. Also check the
   baseline isn't stale on the base branch: run the same test on a clean
   checkout WITHOUT your change — if it computes the same "drifted" value, the
   baseline was already outdated and is not your regression.
6. **Re-record.** The runner writes a `<name>.csv.UPDATED` file next to the
   baseline; once every change is verified and justified, copy it over the
   baseline CSV. A follow-up run of the affected simulations must PASS. If
   determinism is in doubt, run twice and compare.
7. **Commit with per-ingredient justification.** The commit message states,
   for each moved ingredient, why it moved (e.g. "~tNl unchanged — only tplx
   moved (rescheduled internal timer), packets on the wire identical").

## Discipline

- **Unrelated baselines stay byte-identical.** When changing a shared area,
  hold the invariant that fingerprints of unrelated simulations do not move at
  all; if they do, the change is not as local as you thought — redesign it
  rather than re-record (see interpreting-drift.md for techniques).
- **One fingerprint type per step.** Break refactorings into steps that each
  move only one kind of ingredient (e.g. `tplx` or `tilx`, not both) so every
  re-record has a single clear cause.
- **Never update baselines without consent** when working as an agent: propose
  the re-record with its justification and let the user approve.
- **After accepting**, a full-suite re-run is not required; spot-check a few of
  the affected simulations with the runner's filter option.
- **Graphical fingerprints (`tyf`) are often unreliable** (display-string noise);
  projects commonly exclude them and enforce only behavioral ingredients.
