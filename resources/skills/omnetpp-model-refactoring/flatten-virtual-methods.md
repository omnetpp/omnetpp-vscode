# Rule: Flattening Virtual Methods into a Base Class

This describes the step-by-step process for replacing a virtual method with
subclass overrides by a single implementation in the base class that uses
boolean flags to distinguish the variants.

## When to use

- A virtual method is overridden in several subclasses with mostly similar logic.
- You want to consolidate the logic into one place (e.g. before moving it
  to another module, or simply to reduce code duplication).

## Principles

- **Small, testable steps.** Each step must compile and pass all tests.
- **Commit after every step.**
- **No behavior changes.** Same inputs, same outputs, same side effects.
- **One method at a time.** If the method calls other virtual methods that
  also need flattening, flatten the callees first (bottom-up).

## Steps

### 1. Add boolean flags to the base class

- Identify what distinguishes each subclass override (e.g. "is NR", "has D2D").
- Add `bool` members to the base class (e.g. `isNR_`, `hasD2DSupport_`).
- Set them in each subclass's `initialize()`.
- **Compile, test, commit.**

### 2. Mechanically merge overrides into the base class

- Copy each subclass override into the base class method, guarded by
  `if`/`else` on the boolean flags. Keep the code as close to the original
  as possible — do NOT simplify yet.
- Remove `virtual` and `override` from subclass declarations.
- **Compile, test, commit.**

### 3. Factor out common code

- Identify code that is identical (or nearly identical) across branches.
- Pull it out of the `if`/`else` into the shared path.
- **Compile, test, commit.**

### 4. Simplify and compress

- Merge remaining branches where possible.
- Replace `dynamic_cast` checks with flag checks.
- Remove dead code, redundant variables, duplicate assignments.
- **Compile, test, commit** after each simplification pass.

### 5. Remove empty subclass overrides

- Delete the override declarations from subclass headers.
- Delete the override implementations from subclass `.cc` files.
- Change the base class method from `virtual` to non-virtual (if no longer
  overridden anywhere).
- **Compile, test, commit.**

## Pitfalls to watch for

- **Subtle behavioral differences between overrides:** Diff each subclass
  override carefully. Watch for differences in: logging text, variable names
  used as source IDs, calls that look the same but resolve to different
  virtual methods, side effects that only some overrides have.
- **Order of operations:** When merging, preserve the exact order of
  assignments and side effects from each original override.
- **Dead code in the original:** Some overrides may contain dead code
  (e.g. a variable is computed but never used). Preserve it during flattening
  to keep fingerprints stable; clean it up in a separate step.
- **Helper methods that are also virtual:** If the method being flattened
  calls other virtual methods (e.g. `getNextHopNodeId()`), flatten those
  first, otherwise the flattened method will still dispatch virtually.
