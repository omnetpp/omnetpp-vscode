# Review brief: <branch or PR title>

<!--
Format rules for the whole brief (details in SKILL.md, step 7):
- No tables. Every item is a bullet: a paragraph that starts with a bold
  title, and the bold title is a full sentence that states the finding.
- The body is full English sentences: what it was before, what it is now,
  why it matters. No fragments joined by colons, semicolons or arrows.
- No arrows for "renamed", "changed to" or "calls"; write the verb.
- No "V"/"I" markers; write "I verified this ..." or "This is an inference
  from ...".
- Evidence in a closing sentence: "The declaration is at `<file:line>`;
  the change is in commit `<hash>` ("<subject>")." Every commit citation
  carries its subject, every time.
- Nested bullets only for a list inside an item; at most two levels.
-->

- **Range.** The base is `<hash>` ("<subject>"). The tip is `<hash>`
  ("<subject>"). The branch has <N> commits.
- **Stated goal.** <One or two sentences, from the PR description, the plan
  or the commit-group prefix.>
- **Weight.** <Where the changes are, in a sentence or two: how many files,
  how much of it is mechanical, which subsystems carry the design change.>
- **Written.** <Date>, from the tip named above. If the branch is rebased,
  check the hashes again.
- **Method.** <What was run and read: the script or a manual NED read, the
  C++ diff in full or by subsystem, how the ini files were summarized.>

## TL;DR

<5-10 numbered items, ranked by blast radius (see SKILL.md step 7). Each
starts with the section letter and a bold sentence that states the finding,
then one to three plain sentences.>

1. [A] **User configurations break without any error message.** <Old name>
   was renamed to <new name>. An ini line that still uses the old name
   matches nothing, and OMNeT++ does not report that.
2. [A] **A default value changed, so results change silently.** The default
   of `<Type>.<param>` changed from `<old>` to `<new>`.
3. [B] **Nobody does <duty> any more.** `<Module>` used to <duty>; after
   the change, no module does.
4. [D] **`<A>` now notifies `<B>` with a signal instead of calling it.**
   <What this changes, and the rule it conflicts with, see section D.>

## A. External interface (NED)

### Changes that break existing configurations

- **<Full sentence: e.g. "The UE parameter `servingNodeId` was renamed to
  `lteServingNodeId`.">** <Who inherits it. How the rename is confirmed:
  migrated ini lines, a guard, the commit message. What happens to a user
  whose ini still uses the old name.> I verified this. The declaration is
  at `<file:line>`; the change is in commit `<hash>` ("<subject>").

### Changes that silently change results

- **<Full sentence stating the change.>** <What it was before, what it is
  now, and why nothing reports it.> <I verified this / This is an inference
  from ...>. <Evidence sentence.>

### Additions

- **<Full sentence: e.g. "Rrc has a new parameter,
  `hasLteConnectionControl`.">** <One or two sentences.>

### How users migrate their configurations

- Replace `<old ini key or NED name>` with `<new>`.
- <One instruction per bullet, as an imperative sentence.>

### Changes of meaning that no declaration shows

- **<Full sentence: e.g. "`Rrc.connectionControl` now exists on base
  stations only.">** <What it meant before, what it means now, and where
  that shows (doc comment, default).> <Verified or inferred.>

### Other interfaces

- **<Full sentence about the C++ API for extenders, names built in C++,
  `.msg` files, result names.>** <Details, as sentences or a short nested
  list.>

## B. Responsibilities

- **<Full sentence: e.g. "BearerManagement now passes the node ids to the
  PDCP entities it creates.">** Before, <who did it and how>. Now, <who
  does it and how>. <Verified or inferred.> <Evidence sentence.>
- **<If a duty was dropped: "Nobody <does X> any more." -- say so
  plainly.>**
- **<Accumulation: "No module accumulated a duty from another layer or
  plane." or the module that did.>**
- **<"Several modules changed only internally.">** <Which ones, and that
  their duties did not change.>

## C. Key data structures

- **<Full sentence: e.g. "The Binder's address-to-node-id map was renamed,
  but its contents did not change.">** <Why it is key. Which modules write
  it and which read it, before and after.> <Verified or inferred.>
  <Evidence sentence.>
- **<"No key or cardinality changed." or the change, highlighted.>** <How
  this was searched.>

## D. Communication between modules

- **<Full sentence: e.g. "EventGenerator now asks the Binder for a UE's
  PHY.">** Before, <the old mechanism, in words>. Now, <the new mechanism>.
  <What flows.> <Verified or inferred.> <Evidence sentence.>

### Rule conflicts

<"I found no new conflict with the architecture rules of <skill>." and what
was checked, as bold-led bullets -- or one bullet per conflict, with the
rule, the interaction, and the evidence.>

## E. Other facts

- **<Full sentence for each fact: claims that do not match the code,
  baselines re-recorded, tests added or weakened, examples changed,
  missing documentation, unchecked areas.>** <Details.>

## Questions for the reviewer

1. **<Short topic.>** <The question, with the facts it rests on, in full
   sentences.>

## Coverage and method

- **NED.** <What was read or run, and the blind spots for this range.>
- **C++.** <What was read; which searches were made.>
- **ini files.** <How they were covered.>
- **Not examined.** <What was not checked.>
- **Subagents.** <Which sections, and which spot-checks were done.>
