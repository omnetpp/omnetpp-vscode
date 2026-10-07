---
name: omnetpp-sim-debugging
description: >
  Techniques for debugging OMNeT++/INET-family simulations: the vanishing-packet checklist
  (eventlog, crash-truncated logs), attaching gdb to the real binary, reproducing in Qtenv at
  a specific event, attributing log lines to modules, and diagnosing packet-content
  non-determinism with pcap diffing. Use when a simulation crashes, hangs, drops or "loses"
  packets, behaves non-deterministically, or when a test failure needs root-causing. For
  basic runtime-error flags see omnetpp-model-development.
---

# Debugging simulations

## The vanishing-packet checklist

Before theorizing about why a packet "disappeared":

1. Check whether the log/output file is **truncated mid-line** — truncation
   means the simulation CRASHED; the packet wasn't lost, the process died.
   When a test harness separates streams, the abort message is on **stderr**,
   not stdout — read the error stream first (a crash with only stdout in view
   looks like "the sim just stopped").
2. Record an eventlog (`--record-eventlog=true`) and look for the packet's
   DM (delete-message) entry — it names the module that deleted it.
3. Check for `sendDelayed()` / timer-driven sends before concluding a response
   was never generated — an analysis window cut too early misses delayed
   replies. Widen the window.
4. "Undisposed object" warnings are symptoms, not causes — an orphaned packet
   usually belongs to an event aborted by the real error.

## Crashes

- Attach gdb to the **real** simulation binary (the `*_dbg` executable in the
  working directory) with `--debug-on-error=true`. The `inet_dbg`-style
  wrapper scripts spawn a subprocess that gdb won't follow.
- To reproduce interactively: run the same working dir + ini under Qtenv
  (`<wrapper>_dbg -u Qtenv omnetpp.ini`) and run to the event number /
  simtime identified from the eventlog.

## Log attribution

- Default cmdenv log lines carry no module prefix. Re-run with
  `--cmdenv-log-prefix="@@[%C] "` and grep `^@@\[...\]` to attribute lines to
  their emitting module/class.

## Packet-content non-determinism

To root-cause a fingerprint or trace that differs run-to-run with the same
seed (INET-family projects):

1. Put a PcapRecorder on an involved node; run twice with the same seed;
   `cmp` the pcap files.
2. Dissect the first differing frame (`tshark -V` / `-x`). Giveaways:
   "Packet Length: 0" = a builder never set a length field; a garbage tail
   whose size equals a header-length constant = declared chunk length exceeds
   what the serializer writes, so it pads with uninitialized bytes.
3. Validate stability at FULL simulation time, not a short window — some bugs
   fire only on retransmission paths.
4. Rule out unordered-container iteration leaking into packet contents.

## General cautions

- A green fingerprint run only proves the *exercised* paths didn't change —
  before trusting "fingerprints unchanged" as proof that a config-wide change
  works, verify the change actually applies everywhere you think it does.
- Kernel-object lifecycle: deleting an object that a framework call already
  deletes (e.g. an interface-removal API that internally calls
  `deleteModule()`) is a use-after-free — check ownership before adding
  cleanup calls.
