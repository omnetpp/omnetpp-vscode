# Rule: Moving Code Between Modules (Safe Refactoring)

This describes the step-by-step process we follow when moving a method (and its
dependencies) from one module to another, preserving behavior exactly.

## Principles

- **Small, testable steps.** Each step must compile and pass all fingerprint tests
  before proceeding.
- **Commit after every step.** If something goes wrong, we can revert to the last
  known-good state.
- **No behavior changes.** The refactoring must be purely mechanical — same inputs,
  same outputs, same side effects.
- **When in doubt, ASSERT.** Add runtime assertions to verify that independently
  computed values match.

## Steps

### 1. Flatten the method (if it uses virtual dispatch)

If the method is overridden in subclasses, first flatten it into the base class
using the process described in [flatten-virtual-methods.md](flatten-virtual-methods.md).

### 2. Move ONLY the call

- Make the method temporarily `public` in the source module.
- Have the destination module get a pointer to the source module.
- Call `sourceModule->method(pkt)` from the destination module.
- Remove the call from the source module.
- **Compile, test, commit.**

### 3. Mirror flags and ASSERT equality

- Add copies of all relevant flags/params to the destination module.
- Initialize them independently (same logic or same data source as the original).
- Add `ASSERT(myFlag == sourceModule->flag)` for each one.
- **Compile, test, commit.**
- If an ASSERT fires, it reveals a real discrepancy — fix the initialization
  logic and re-test. Do NOT suppress the ASSERT.

### 4. Copy the method body (and helpers)

- Copy all helper methods, data members, and types (structs, hash functions)
  to the destination module.
- Adapt the method to use the destination module's own members
  (e.g. replace `getNodeId()` with `nodeId_`, `isDualConnectivityEnabled()`
  with `dualConnectivityEnabled_`, etc.).
- Switch from calling `sourceModule->method()` to calling the local copy.
- **Compile, test, commit.**

### 5. Remove dead code from the source module

- Delete the now-unused method(s), helper methods, data members, types.
- Restore `protected`/`private` visibility on anything that was made `public`.
- Remove the cross-module pointer and includes.
- Remove the ASSERTs (they've served their purpose).
- **Compile, test, commit.**

### 6. Move NED parameters (if applicable)

- Add the parameters to the destination module's `.ned` file (same defaults).
- Update the destination module's C++ code to read from its own `par()`.
- Remove the parameters from the source module's `.ned` file.
- Remove the C++ code that read them from the source module.
- **Compile, test, commit.**

## Pitfalls to watch for

- **Initialization order:** When comparing flags between modules at init time,
  ensure the source module has already initialized before the destination module
  reads its values. Use a later init stage if needed.
- **Subclass-dependent flags:** (Example from Simu5G:) If a flag is set by the *subclass type*
  (e.g. `isNR_` set in `NrPdcpEnb::initialize()`), you cannot derive it from
  external properties alone (e.g. `binder_->isGNodeB()`). Instead, check the
  module's NED type name or use `dynamic_cast`.
- **INI overrides:** Module types can be overridden in `.ini` files
  (e.g. `*.masterEnb.cellularNic.pdcp.typename = "NrPdcpEnb"`), so the NIC type
  alone may not determine the PDCP type.
