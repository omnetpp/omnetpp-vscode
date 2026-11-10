---
name: dev-design
description: >
  Design discipline for any software project: prototype code is never a
  template for production code, non-obvious design decisions are named and
  justified before code is written, and structures are changed rather than
  worked around. Use when designing a feature, writing an implementation plan,
  or implementing one, and always when prototype, spike or experiment code
  exists for the feature being implemented.
---

# Design before code

- **Prototype code is never a template.** Code written to answer a question
  (a measurement, an experiment, a proof of concept, a spike) answers only
  that question. Design the production implementation from scratch, as if
  the prototype did not exist: its shortcuts (minimal-change hooks, debug
  dumps, state bolted on beside existing structures) were chosen for a
  different goal. A plan that refers to a prototype states what the
  prototype showed, never "the prototype has most of this".
- **Name the design decisions before writing code.** For each non-obvious
  choice (data structure, ownership, where state lives, which hook point),
  know the alternatives and why this one wins. If you cannot say why, the
  design is not finished.
- **Fix the structure instead of working around it.** When new state or
  behavior does not fit an existing structure, consider changing the
  structure instead of working around it.
