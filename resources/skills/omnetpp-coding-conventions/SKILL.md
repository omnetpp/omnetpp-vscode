---
name: omnetpp-coding-conventions
description: >
  C++ and MSG/NED coding conventions for OMNeT++-based simulation models: explicit error
  handling (assert/throw over silent guards), cRuntimeError/ASSERT/check_and_cast usage,
  msg-file pitfalls, and the expectation to criticize suspect code proactively. Use when
  writing or reviewing model C++ code, msg files, or NED in any OMNeT++-family project;
  project skills may add stricter local rules.
---

# Coding conventions for simulation models

## Error handling

- **EXPLICIT ERRORS PREFERRED.** On an unexpected condition, report an error
  (assert or throw) rather than silently sidestep it with a guard or early
  return. If a pointer argument is unexpectedly nullptr, throw or assert — do
  not wrap the code in `if (p != nullptr)`.
- **ASSERT vs exception**: assertions verify the program's own assumptions;
  exceptions report invalid input or state.
- Prefer `cRuntimeError` (sprintf-like argument list) and include the relevant
  values in the message. The module path and type are added automatically from
  context, so the enclosing class name is usually unnecessary.
- Use OMNeT++'s `ASSERT()` instead of `assert()`.
- Use `check_and_cast<T*>()` instead of `dynamic_cast<T*>()` (it throws with a
  useful message instead of returning nullptr). Use plain `dynamic_cast` only
  when a null result is a legitimate, handled case.
- Never add static variables unless explicitly requested.

## MSG / NED pitfalls

- In msg-file generated code, a `namespace` directive applies only from the
  point where it occurs — NOT to the whole file.
- A simple module without `@class` is not a do-nothing dummy: NED looks for a
  C++ class with the same name as the NED type (modulo namespace) and errors
  if it doesn't exist.
- MSG `struct`s cannot have dynamic array fields — any record with a
  variable-length array must be a `class`. Struct fields are public members
  (`x.field`), class fields use getters (`x.getField()`). Embed hand-written
  value types with `@existingClass @opaque @toString(.str())`.

## Text hygiene

- No em-dashes or fancy Unicode in code or comments — plain ASCII (`-`, `->`,
  `:)`).

## Be critical

- Raise criticism proactively, without being asked: misnamed
  functions/variables, suspicious (potentially buggy) fragments, functionality
  that plainly doesn't belong in the class it sits in.
- For protocol models: report code that visibly does not conform to the
  standard (RFC, IEEE, 3GPP, ...). Do not assume the existing code is correct.
