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

## Build and test in debug mode only

- **Build, run and test debug only** (`make MODE=debug`, the `*_dbg`
  wrappers, the debug mode of every test runner). Release builds compile
  every `ASSERT` out, so a release run can pass while violating invariants,
  and further checks are debug-only too (INET's signal validator, the
  chunk-length-vs-serializer check). A debug run can also be debugged
  directly (gdb, Qtenv).
- **Do not build or test release locally.** CI runs the suites in both
  modes against the same baselines, so a debug/release divergence (side
  effects inside `ASSERT(...)`, uninitialized variables, `NDEBUG` paths) still
  fails there; running both modes locally doubles build and test time for
  little gain.
- **Never run a release wrapper or runner mode** (`inet`, `simu5g`,
  `fingerprinttest -s`, a release lib in `LD_LIBRARY_PATH`): with release
  no longer built, the release library on disk is stale, and a run against it
  silently tests old code.
- **Exceptions**, both explicit and temporary: reproducing a failure that CI
  reports in release mode only, and performance measurement or profiling.
  Build release for that purpose, and do not count a release run as testing
  otherwise.

## Checking layouts visually (headless Qtenv)

To check a network or compound-module layout without a display, render Qtenv
under Xvfb and take screenshots (needs `xvfb-run`, ImageMagick `import`,
`xdotool`). Script, with `V` = a scratch directory and `CLICK="x y"` the
screen coordinates of the node to open:

```
cd <simulation dir>
<wrapper>_dbg -u Qtenv -c <Config> -r 0 omnetpp.ini \
  --output-scalar-file=$V/x.sca --output-vector-file=$V/x.vec > $V/q.log 2>&1 &
P=$!; sleep 15; import -window root $V/net.png
xdotool mousemove $CLICK; xdotool click --repeat 2 --delay 80 1; sleep 3
xdotool key ctrl+minus   # repeat if the node opens zoomed in
import -window root $V/node.png; kill $P
```

Run it as `timeout 120 xvfb-run -a -s "-screen 0 2700x1700x24" bash script.sh`.
Two passes: first screenshot the network to find the node icon (an image
viewer may show it scaled -- convert back to screen coordinates), then
double-click into it.

Traps: use a real example config -- a test network that merely `extends` a
node type usually dies in `initialize()` (missing infrastructure modules) and
Qtenv then shows nothing. Qtenv rewrites the directory's `.qtenvrc` (tracked
in some directories): back it up and restore it. Unassigned parameters pop up
a dialog that blocks the run; assign them in the ini.

## Troubleshooting runtime errors

- If the executable is missing or possibly stale, (re)build first; if the
  error is baffling, try a clean rebuild
  (`make MODE=debug clean && make MODE=debug -j$(nproc)`).
- `--debug-on-error=true` — stack trace on error (OMNeT++ 6.4+).
- `--cmdenv-express-mode=false` — see the log; `--cmdenv-log-level=<level>`
  (`off`..`trace`) controls volume; `--record-eventlog=true` records the
  eventlog for post-mortem analysis.
- Deeper techniques (vanishing packets, gdb, pcap diffing): see the
  omnetpp-model-debugging skill.

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
