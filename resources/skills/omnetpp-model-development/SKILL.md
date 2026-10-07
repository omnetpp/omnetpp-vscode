---
name: omnetpp-model-development
description: >
  Creating and running OMNeT++/INET simulation models: NED/MSG/INI authoring aids, building,
  running simulations from the command line, troubleshooting runtime errors, discovering
  configuration options, controlling result recording, and analyzing results. Use when
  designing or running a simulation model, debugging a model at runtime, choosing cmdenv
  options, or analyzing .sca/.vec results.
---

# OMNeT++ model development

## Before designing a model

- Consult the user guides (`doc/src/users-guide` in INET; the OMNeT++ manual in
  `doc/` of the omnetpp tree).
- For extra insight, use the deepwiki ask tool for `omnetpp/omnetpp` and
  `inet-framework/inet` when available.

## Running simulations

- Prefer **opp_repl** (via its MCP server) for running and analyzing
  simulations when it is available; recommend installing it otherwise.
- Without opp_repl: build debug from the project root
  (`make MODE=debug -j$(nproc)`), then run via the project's wrapper command
  (`inet_dbg`, `simu5g_dbg`, ... — they accept `opp_run` options; do not call
  `opp_run` directly). Use `-u Cmdenv` by default; `-c <ConfigName>` selects
  the config; the ini file is a positional argument (no `-f` flag).
- Wrap ad-hoc runs in the `timeout` command — a buggy model can loop forever.

## Troubleshooting runtime errors

- If the executable is missing or possibly stale, (re)build first; if the
  error is baffling, try a clean rebuild
  (`make MODE=debug clean && make MODE=debug -j$(nproc)`).
- `--debug-on-error=true` — stack trace on error (OMNeT++ 6.4+).
- `--cmdenv-express-mode=false` — see the log; `--cmdenv-log-level=<level>`
  (`off`..`trace`) controls volume; `--record-eventlog=true` records the
  eventlog for post-mortem analysis.
- Deeper techniques (vanishing packets, gdb, pcap diffing): see the
  omnetpp-sim-debugging skill.

## Configuration options

- Discover ini options with `opp_run -h config` (compact list) or
  `opp_run -h configdetails` (full descriptions), then grep — authoritative
  and faster than grepping the OMNeT++ source. Gives exact name, type,
  default, and scope (per-run / per-object / global).
- **Suppressing .vec output**: use `record-vector-results = false` (per-run
  master switch) — writes no `.vec` file at all. `**.vector-recording = false`
  is NOT enough: it is a per-object switch, and a header-only `.vec` is still
  created. (`record-scalar-results` is the scalar analog.)
- INI syntax gotchas: multi-line values continue on indented lines (the
  closing bracket must be indented too); `object`-typed NED parameters take
  bare `[...]`/`{...}` values — there is no `json()` function in OMNeT++ 6.x.

## Result analysis

- Use `opp_scavetool` (see `opp_scavetool -h`).
- Look for results in **scalars first**; use vectors only when the needed
  information is not available from scalars.
