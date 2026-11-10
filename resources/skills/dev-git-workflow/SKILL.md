---
name: dev-git-workflow
description: >
  Git conventions and discipline for any software project: safe staging (never
  git add -A), checking what is committed, explaining the why of design choices
  in commit messages, green-at-every-commit for multi-step work, backup tags
  before history rewrites, incremental rebase tactics, intent-preserving conflict
  resolution, and integrating third-party PRs. Use for any commit, rebase,
  cherry-pick, branch reorganization, or PR-integration work. The commit
  subject format is in dev-commit-messages. For simulation-model projects,
  omnetpp-model-git-workflow adds to this skill.
---

# Git workflow

## Hard rules

- **NEVER perform destructive git operations** (reset, rebase, force push,
  history rewrites) without explicit user consent.
- **NEVER use `git add -A` or `git commit -a`** — repos contain unrelated
  untracked files. Stage with `git add -u` (tracked, changed files) plus
  `git add <file>` for files YOU created, then commit.
- **Check what you commit.** Run `git diff --cached --stat` immediately
  before every `git commit` and check that the file list matches the commit's
  intent (a test-only or docs-only commit touching `src/` is the smell). A
  green test suite proves nothing about what is committed: the build uses the
  working tree, not the index. Never claim "tree clean" without running
  `git status` at that moment.
- **Explain the why.** The commit message states the reason for every
  non-obvious design choice, and the main alternative it was chosen over.
  A choice you cannot justify in the message was never actually made: stop
  and redesign before committing. A typical miss is carrying a prototype's
  mechanism over without reconsidering it (see dev-design).
- **`git checkout <rev> -- <path>` also writes the INDEX.** Restoring the file
  afterwards with `cp` fixes only the working tree; the old version stays
  staged and the next commit silently reverts the file. For an A/B against an
  older version of a file, use `git show <rev>:<path> > <path>` instead.
- Disable pagers/editors in scripted use: `GIT_PAGER=cat`, `GIT_EDITOR=true`.
- Before any history rewrite, tag the original tip
  (`git tag <branch>-orig`) so the pre-rewrite state stays reachable.
- Use `git mv` for renames (preserves history); update `#include`s and header
  guards, and grep for references first.

## Green at every commit

For multi-step work (refactorings, ports, feature branches meant for review),
every commit must build cleanly, and the branch tip must pass the full test
suites. Commit after each completed step; don't batch. Any commit that
legitimately changes recorded test baselines updates them *in the same
commit* and explains the change in the message.

What to run where:
- **Every commit:** a build in the project's test build mode, and the tests
  the commit is about: a test commit's new tests fail without the fix they
  target, and the fix commit makes them pass.
- **The branch tip:** the full suites, locally or on CI. Intermediate
  commits do not get the full suites, except in projects whose suites take
  only minutes (below).
- **A commit whose point is a no-change claim** (`refactor:`, `cosmetics:`,
  `cleanup:` steps of a refactoring series): also run the regression tests
  that can see a difference, scoped to what the commit touches.
- **Projects whose full suites take only minutes** (Simu5G): run them at
  every commit; it is cheap and finds the first bad commit directly.
- **History rewrites** (cleanup, rebase) follow their own scoped per-commit
  procedures: dev-branch-cleanup, dev-branch-rebase.

Write subjects in the dev-commit-messages format from the start. While a
branch is still being reshaped, recheck them in a final message-only pass
when the history is otherwise final.

## Rebase tactics

- **Try the rebase before assuming conflicts** — even a large branch over a
  much-moved base rebases clean when the touched regions are disjoint.
- When a rebase hits many hard conflicts, do NOT fight through to the top of
  the base branch in one jump: perform multiple smaller rebases, each
  advancing over a few base commits, until reaching the top. When facing
  difficulties mid-rebase, STOP and recommend this to the user.
- Cherry-picking is weaker than rebase (it doesn't track file renames/moves).
  When a cherry-pick conflicts, try rebase instead — it may succeed without
  manual resolution.
- Conflict-resolution mindset: understand the INTENT of the original commit
  and re-apply that intent on the current code — preserve what the commit
  meant, not its exact text.
- For heavyweight jobs there are dedicated skills: dev-branch-cleanup
  (reshape a branch's history in place) and dev-branch-rebase
  (cross a large upstream gap in validated stages).

## Integrating third-party PRs

- Rebase the PR onto current master first.
- Evaluate every reviewer comment explicitly (valid bug / design critique /
  audit request) and fix the real ones as small, behavior-preserving commits.
  A fix commit may be folded into the contributor's commit if a squashed
  history is preferred.
- Add a targeted example or test for any code path that fired zero times in
  existing scenarios, and verify regression guards actually fail without the
  fix.
- Run the full relevant test suites before declaring the integration done.
