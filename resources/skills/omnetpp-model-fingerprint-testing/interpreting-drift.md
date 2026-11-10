# Interpreting fingerprint drift

Given a failing simulation, the runner log shows which ingredient combinations
mismatched. Read the *pattern* of moved vs. unmoved ingredients — it usually
identifies the cause class before you look at any code.

## Reading the pattern

- **tplx moved, ~tNl/~tND identical** → internal event scheduling changed
  (rescheduled timer, init-stage/lifecycle reordering, extra self-message);
  observable network traffic is unchanged. Typically benign — but say so
  explicitly in the re-record justification.
- **~tNl moved** → the traffic itself changed: packets added/removed/retimed
  or lengths changed. Never benign by default; explain which packets and why.
- **~tND moved, ~tNl identical** → same packets, same lengths, different
  contents (a header field value changed, serialization changed).
- **~tNlb moved, everything else identical** → parsimPack-visible metadata
  changed, not wire behavior: a message rename (setName), a tag field, or a
  `Protocol` id shift. In INET-family projects, inserting a new `Protocol`
  into the registry renumbers ids of later-defined protocols and silently
  moves ~tNlb for every example whose frames carry a
  PacketProtocolTag with a renumbered protocol (e.g. PPP-framed examples) —
  a legitimate deterministic re-record, not a regression. If ~tNlb moves for
  no apparent reason, suspect a registry insertion and bisect.
- **sz moved** → statistics were added/removed, values changed, or the result
  recording ORDER changed (module reordering does this).
- **sz moved, values identical, only their order differs** → often a signal
  ID shift. Per-module result recording follows the global signal-ID order,
  and IDs of `static simsignal_t X = registerSignal(...)` are assigned in
  static-initialization (= link) order across translation units. Moving such
  statics into another file -- or a new file statically registering an
  already-used name -- reorders IDs and moves `sz` on every config that
  records those statistics, while tplx/tilx/~tNl stay identical. Put the
  signals where they belong, but make the move a SEPARATE step, so its
  sz-only drift can be verified (compare the `.sca` values of both builds as
  sets) and re-recorded on its own. Diagnose with a single-config `.sca`
  diff, not by reading code.
- **tyf moved** → display-string/figure noise; usually excluded from
  enforcement.
- **Different value on every run (non-deterministic)** → uninitialized data in
  the hash. Classic cause for ~tND: a chunk whose declared length exceeds what
  the serializer writes, so the serializer pads with uninitialized bytes.
  Diagnose with a pcap recorder: run twice with the same seed, compare the
  files, dissect the first differing frame ("Packet Length: 0" and
  garbage tails whose size equals a header-length constant are giveaways).
  Validate stability at FULL simulation time — some bugs only fire on
  retransmission. Also rule out unordered-container iteration leaking into
  packet contents. And before concluding non-determinism at all, make sure
  you are not reading a stale `*.UPDATED` file from an earlier run.

## Cause → ingredient map (for writing justifications)

| Change | Expected movement |
|---|---|
| Header field value changed | ~tND (and ~tNlb) but NOT ~tNl |
| Extra / removed / retimed control packets | ~tNl + ~tND (+ tplx) |
| Init-stage or lifecycle change in a module | tplx across ALL sims that bring the module up; traffic ingredients stay |
| Message object renamed (setName) | ~tNlb only |
| Protocol registry insertion | ~tNlb of affected framings only |
| Serialization refactor | ~tND only |
| Module added/deleted (event-less) | tplx unmoved; tilx moves; deleting a submodule from every node also moves ~tNlb (module/event id renumbering reorders simultaneous events) |
| NED package/dir rename | nothing moves |
| Statistics recording change | sz only |
| Unordered→deterministic iteration | fixes run-to-run drift; one final re-record |

If a change you believe is behavior-preserving moves anything: stop and
investigate. Do not re-record your way to green — that converts a regression
into a new baseline.

## Techniques for keeping fingerprints still

- **Inert-shim deletion.** To delete a module type wired into many nodes,
  first empty it into a do-nothing shim while keeping it wired — fingerprints
  must stay byte-identical, proving the removed code was behavior-free. Delete
  the shim (the structural change) in a separate commit with its own
  re-record. This separates "code removal is safe" from "structure changed".
- **Feature-off-by-default integration.** New protocol modules enter node
  types behind a default-off switch or a `like`-interface slot; prove
  inertness by byte-identical fingerprints of the whole suite.
- **Scale, don't reorder.** When adjusting values that feed ordered
  algorithms (costs, priorities), preserving relative ORDER can keep
  downstream fingerprints identical even though values changed.
- **Don't trust "fingerprints unchanged" as full-coverage proof.** A no-op
  fingerprint run only proves the exercised paths didn't change. If a
  config-wide change moves nothing, first verify the change is actually being
  applied everywhere you think (a config bug can mean it applies to one
  instance only) before celebrating.
