# Interactive Branch Cleanup Guide

Step-by-step procedure for cleaning up a feature branch, producing a validated, rebased branch
with a clear commit history. The project layer (e.g. omnetpp-model-branch-cleanup for simulation
models) supplies the concrete commands for each step that involves the tests.

## Inputs

- The **project** and its regression-test setup
- A **baseline branch** name (e.g. `master`)
- A **feature branch** name with N commits to clean up

## Prerequisites

- A regression-test infrastructure with recorded baselines, preferably with a test-impact map
  that can scope a test run to the parts a commit changes
- A toolchain that can build both the baseline and the feature branch

## Phase 1: Preparation

### 1.1 Use separate baseline stores for the clean branch

Point the clean branch's tests at a separate copy of the baseline stores, to avoid merge
conflicts with the regular stores when rebasing later.

### 1.2 Check out and build the baseline branch

```bash
git checkout <baseline>
```

Build the project.

### 1.3 Build the test-impact map

If the test infrastructure supports it, run the tests on the baseline once to build the map
from changed files to affected tests.

### 1.4 Record the baseline test results

Run the tests on the baseline to populate the separate baseline stores. These serve as the
reference for validating each patch.

### 1.5 Create a clean branch

```bash
git checkout -b <feature>-clean
```

## Phase 2: Branch Review

Before processing individual patches, review the entire feature branch to understand the full scope of changes:

1. Read through all commits (`git log <baseline>..<feature>`)
2. Review the overall diff (`git diff <baseline>..<feature>`)
3. Categorize commits by area/purpose
4. Identify dependencies between commits
5. Plan the ordering: which commits to cherry-pick as-is, which to split, merge, or reorder
6. Document the plan (e.g. in the project-specific plan file)

This upfront review is essential for out-of-order cherry-picking and merging related commits.

## Phase 3: Per-Patch Processing

This is an **interactive** process. Each step requires user confirmation before proceeding.

For each patch (cherry-picked, split, merged, or reordered as determined in Phase 2):

### 3.1 Propose the next step ⏸️ ASK USER

Before touching any code, present to the user:
- **Which commit(s)** from the feature branch will be processed next
- **What the commit does**: summarize the diff, the intent, and the affected areas
- **How it will be applied**: cherry-pick as-is, split, merge with other commits, or reorder
- **Why this ordering**: explain dependencies or rationale for processing it now
- **Expected test outcome**: whether results should be identical or are expected to diverge

**Wait for user confirmation before proceeding.**

### 3.2 Apply the patch

```bash
git cherry-pick <commit>
```

Or apply manually if splitting/merging.

### 3.3 Rewrite the commit message

Make it accurate, detailed, and self-contained:
- Describe *what* the patch does and *why*
- Name affected components
- Note expected behavioral changes (if any)

### 3.4 Build

Ensure compilation succeeds. If the build fails:

1. Search other commits on the feature branch for fixes (e.g. later commits that add missing includes, fix typos, or resolve compilation errors introduced by this patch)
2. **⏸️ ASK USER**: explain the build error, identify the fix (with the source commit if found), and ask for explicit permission before making any new code changes
3. If approved, apply the minimal fix and note it in the commit message

### 3.5 Run tests (scoped to the affected parts)

Run the regression tests, scoped with the test-impact map to the tests the commit's changes
can affect.

### 3.6 Evaluate results

- **PASS**: proceed to commit
- **FAIL but explainable**: roll the baselines forward (re-record the affected tests) and
  include the updated stores in the commit. Document the explanation in the commit message.
- **RUNTIME ERROR**: search other commits on the feature branch for fixes (e.g. missing initializations, wrong parameters). **⏸️ ASK USER**: explain the error, identify the fix (with the source commit if found), and ask for explicit permission before making any new code changes
- **FAIL and unexplainable**: STOP — investigate before proceeding

### 3.7 Amend commit

Include validation result in the commit message. If test results were rolled forward, include the updated store files in the commit.

#### Commit message format (PASS)

```
<clear summary line>

<detailed description>

Validation:
  <summary of the test results>
```

#### Commit message format (explained FAIL)

```
<clear summary line>

<detailed description>

Validation:
  <summary of the test results>

  Explanation: <why the differences are expected>
```

### 3.8 Present the result ⏸️ ASK USER

After the commit is created, present to the user:
- **What was done**: summary of the applied patch and any modifications made
- **Commit message**: the full proposed commit message
- **Test results**: pass/fail summary
- **Updated stores**: if test results were rolled forward, note which files changed
- **Next step preview**: briefly mention what comes next

**Wait for user confirmation before continuing to the next patch.**

## Phase 4: Final Validation

After all patches are applied:

1. **Full test run**: run all regression tests, unscoped
2. **Summary report**: list of all patches with their verification status (pass / explained-fail)

## Notes

- Patches touching shared code that the test-impact map cannot attribute to a narrower part
  conservatively trigger all tests
- The separate store files can be merged back into the standard stores after the branch is finalized
