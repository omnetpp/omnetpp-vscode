---
name: omnetpp-model-refactoring
description: >
  Behavior-preserving refactoring of OMNeT++/INET-style simulation models in small
  fingerprint-verified steps: the compile-test-commit gate, moving code between modules via
  mirrored flags and ASSERT-equality bridging, flattening virtual methods into a base class,
  and extracting new submodules. Use when refactoring simulation model C++/NED code, moving
  functionality between modules, or consolidating subclass variants. Verify every step with
  the project's fingerprint suite (see the project's fingerprint-testing skill).
---
# Refactoring simulation models

## Workflow

- SMALL STEPS: For larger refactorings, I prefer to have a sequence of SMALL,
  safe, straightforward, but compiling and testable changes (as git commits)
  that are easy to review. If changes are too big (e.g. multiple steps combined
  into one), they are difficult to review, and also to troubleshoot/debug if
  something breaks. (The user can squash commits manually later, but slicing up
  commits later is much harder and often impossible.)

- WHEN UNSURE, ASK! Stopping and letting the user clarify or give clearance
  is 100 times better than pushing through with potentially false assumptions.
  Pushing through without having complete understanding is a big NO-NO!

- Do not change anything in the code, or do actions that were not explicitly
  requested without getting confirmation from the user first.

- EXTREME CAUTION: When seeing anything suspicious (something that suggests that
  initial assumptions or the refactoring plan might not be completely right),
  STOP and REPORT this to the user. Pushing through is a big NO-NO!!!

- In accordance with the above: Always break large refactorings into small,
  independently testable steps. Commit after each step (run `git commit`, without
  asking for permission). After commit, compile and run the project's fingerprint suite (see the project's fingerprint-testing skill, e.g. inet-fingerprint-testing or simu5g-fingerprint-testing). If
  there are compile errors, fix all, then commit (!) and try again. Run
  fingerprint tests after each step, and only proceed if ALL fingerprints pass.
  If anything goes wrong, STOP immediately and do NOT push through!

## User Input

- I like to discuss technical decisions before they are committed to.

- If unforeseen difficulties arise during refactoring, do NOT go into a lengthy
  fight to try and "fix" the code. Rather, I prefer to get notified about the
  difficulties, and work out the solution together. WHY? Because the best course
  of action is VERY OFTEN to roll back everything, and either try with a
  different approach, or clean up/refactor bits and pieces in the code
  indendepdently before attempting the main refactoring again.

- I am NOT always right. I might mistype, be mistaken about details of the code,
  or misjudge. When in doubt, push back and let's discuss the best way forward.


## Templates/ideas for Typical Refactoring Operations

### Moving code into a separate, new submodule

- First, create an empty, do-nothing submodule, and update the fingerprints with
  that. (Only "tilx" fingerprints may change due to module IDs being shifted,
  but nothing else.) (See omnetpp-model-fingerprint-testing/ingredients.md for ingredient semantics.) Then, gradually port the code into the new submodule.
  E.g. first move just calls; then move just code but let it operate on data of the original submodule; then move relevant data fields.

### Flattening virtual methods

- See [flatten-virtual-methods.md](flatten-virtual-methods.md); for moving code between modules see [move-code.md](move-code.md).

## Git usage

Follow the staging and rename rules in dev-git-workflow, and the commit subject format in dev-commit-messages. For a multi-step refactoring, the group prefix is a very short name of the refactoring plus the step number, e.g. "RRC structuring step 1: rrc: refactor: ...".
