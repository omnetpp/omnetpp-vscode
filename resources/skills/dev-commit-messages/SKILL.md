---
name: dev-commit-messages
description: >
  Commit subject format for any software project: area prefix, change-type
  markers (fix:, refactor:, cosmetics:, cleanup:, docs:, test:,
  chore:/build:/ci:; no marker for intended behavior changes), what each
  marker claims, latent-bug fixes, the Fault/Fix body of fix commits (the
  symptom in user terms first, with a concrete example), and group prefixes
  for commit series. Use when writing or rewording commit messages,
  and when reviewing what commits claim.
---

# Commit messages

```
[<group>: ]<area>: [<marker>: ]<topic>
```

`<area>` is the module or subsystem the commit changes, named as the project
names it (`envir:`, `binder:`, `IPv6:`). Several areas are listed
comma-separated (`mac,phy:`). A commit that touches one KIND of thing across
the whole tree names that kind instead of listing directories
(`NED cosmetics: <topic>`).

## Markers

`fix:`, `refactor:`, `cosmetics:`, `cleanup:`, `docs:`, `test:`, `chore:`
(`test:` = the commit only adds or changes tests or test baselines;
`chore:` = build system, CI, developer tooling or repository housekeeping,
e.g. helper scripts, `.gitignore`, IDE project files, version bumps). For
build-system and CI changes, the more specific `build:` and `ci:` may be used
instead of `chore:`; they make the same claim. Pick the marker by what the
commit actually does, not by which files it touches. Variants such as
`refactoring:`, `fixes:`, `bugfix:`, `rename:` and `feature:` are drift; do
not use them, and do not copy them from older history as precedent.

`chore:`, `build:` and `ci:` are only for changes that cannot change the
software's behavior. A build or dependency change that CAN change it
(compiler or optimization flags, a dependency upgrade) gets no marker.

Every marker is a claim a reviewer can check: `refactor:`, `cosmetics:`,
`cleanup:`, `docs:`, `test:`, `chore:`, `build:` and `ci:` claim that the
behavior does not change; `fix:` claims a correction. NO marker means an
INTENDED change of behavior or interface: a feature, a deliberate behavior
change, a restructuring, a removal, a dependency upgrade. These are the
commits to read carefully, and the candidates for release notes. There is
deliberately no `feature:` marker:
the markers are useful because they are exhaustive, and an optional one would
make both `grep` and the absence of a marker meaningless. To flag an unmarked
commit whose effect matters, end the subject with `(behavior change)` or
`(baseline change: <what moved>)`.

A fix of a LATENT bug (one that no current input or configuration reaches) is
still `fix:`, never `refactor:`. `refactor:` is reserved for changes whose
behavior is identical in EVERY state, reachable or not; "nothing reaches the
difference" does not make a change a refactoring. A preparatory change that
removes a trap for the next commit is a fix, too. Say "latent" and
"regression results unchanged" in the body, in the "Fault (latent): ...
Fix: ..." form below.

So the markers separate the risk classes: `fix:` and unmarked commits are
where behavior (and thus regression baselines) may legitimately change;
`refactor:`, `cosmetics:`, `cleanup:`, `docs:`, `test:`, `chore:`, `build:`
and `ci:` commits must leave the regression results unchanged. They also
make each class of change mechanically greppable when assembling release
notes or auditing what moved between releases.

## Fix messages

The body of every `fix:` commit has this form:

```
Fault: <the symptom, as the person who hits it sees it>
<a concrete example: what they did, and what happened>

<optional: the technical cause>

Fix: <what changed, and why it was done this way>

Test: <the regression test that reproduces the fault>
```

The `Fault:` part describes the bug as the person who hits it sees it: they
do X, and Y happens. It comes FIRST. The technical cause may follow, but only
after it. From the first paragraph alone, a reader must be able to tell
whether they were affected, without reading any code. The subject names the
symptom, too, not the mechanism.

Who the user is depends on where the bug shows. It can be the person using a
UI (the IDE, Qtenv), the model developer whose code, NED or ini file stops
compiling or misbehaves, or the person running the build or a tool. X may be
code or configuration that they wrote.

The example is concrete and minimal. It names the action (a menu item, a
field, an API call, a config option, or a code snippet of a few lines). It
quotes the literal error message or wrong output, indented on its own line,
because users search the history for the error text they got. Take the
example from the regression test, or reproduce it. Never describe a symptom
that nobody observed. If the symptom depends on the environment (a library
version, the platform, the build mode), say which environment.

A latent bug has no user scenario. Write "Fault (latent): ..." to say what
would go wrong and under which conditions, and say "regression results
unchanged". Do not invent a scenario.

For a trivial fix (a typo in a message, a wrong label), the example alone can
be the `Fault:` part.

Leave out the `Test:` line only if an automated test is not practical, and
say why. A `test:` commit that adds the reproducing test before the fix opens
with the same user-terms description of the bug.

A fix is normally its OWN commit. When a fix exceptionally rides inside a
larger commit, the same Fault/Fix block goes into that commit's body, as
"Fault, exposed by <what exposed it>: ...". Deliberate exclusions from a
change's scope also belong in the message of the commit that defines the
change, so a reader cannot mistake them for omissions.

## Group prefix

A series of commits serving ONE goal that can be stated in one sentence (a
plan, a feature, a refactoring, a tree-wide sweep) gets a group prefix naming
that goal, so it reads as one block in `git log --oneline`. For a plan
executed on a topic branch, the name is the branch name without `topic/`;
otherwise a short name for the goal. The goal decides membership, not when or
where a commit was made: the tests written for the goal and the `fix:`
commits the work exposed or depends on belong to it; a commit made alongside
it for an unrelated reason does not.

## Older history

Older history of a project may not follow this format. It is not a
counter-example.
