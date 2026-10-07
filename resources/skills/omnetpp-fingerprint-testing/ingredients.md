# Fingerprint ingredients

A baseline CSV entry stores one or more `hash/ingredients` pairs separated by
semicolons, e.g. `ce26-3758/tplx;5d56-5fa2/~tNl;2251-2948/sz`. Each ingredient
letter selects what gets hashed. See also the Testing chapter of the OMNeT++
manual.

## Ingredients recognized by the OMNeT++ kernel

- "e": event number
- "t": simulation time
- "n": message (event) full name
- "c": message (event) class name
- "k": message kind
- "l": message (packet) bit length
- "o": message control info class name
- "g": message control info (uses parsimPack())
- "d": message data (legacy, DO NOT USE) (uses parsimPack())
- "b": message contents (uses parsimPack())
- "i": module id
- "m": module full name (name with index)
- "p": module full path (hierarchical name)
- "a": module class name
- "r": random numbers drawn
- "s": scalar results (just the data, without name or module path)
- "z": statistic results: histogram, statistical summary (data only)
- "v": vector results (data only); no effect if vector recording is disabled
- "y": display strings of all modules (on refreshDisplay())
- "f": essential properties (geometry) of canvas figures (on refreshDisplay())
- "x": extra data provided by modules
- "0": clean hasher

`y` and `f` only produce data under Cmdenv's "fake GUI" mode (the runner
enables it automatically for fingerprints that need it).

## Ingredients added by INET (inet::FingerprintCalculator)

Available in INET and INET-based projects (e.g. Simu5G); active when the
fingerprint uses the INET calculator (the `~` filter implies it).

- "~" NETWORK_COMMUNICATION_FILTER: excludes intra-node communication; only
  packet arrivals crossing between network nodes count.
- "U" PACKET_UPDATE_FILTER: excludes packet update arrival events (e.g.
  transmission truncations).
- "N" NETWORK_NODE_PATH: adds full paths of the sender and arrival network
  nodes for packet arrival events.
- "I" NETWORK_INTERFACE_PATH: adds full paths of the sender and arrival
  network interfaces.
- "D" PACKET_DATA: includes raw packet data bytes in the fingerprint. Requires
  every chunk in the packet to have a serializer, and the runner enables
  computed checksums/CRCs/FCS automatically (serialization needs them).

## Standard combinations and their sensitivity

- **tplx** — simulation time, module path, packet length, extra data: ALL
  events, including internal self-messages/timers. The most sensitive
  behavioral fingerprint: any scheduling or init-ordering change moves it.
  Includes module *paths*, so it is sensitive to module renames but NOT to
  adding/deleting event-less modules, module relocation, or submodule-order
  changes. NED package or directory renames do NOT move it — it keys off
  module instance names, not NED file/package paths.
- **tilx** — like tplx but module *ID* instead of path: insensitive to renames,
  sensitive to structural changes (adding/deleting/relocating modules, and
  connections with channel objects — channels occupy IDs too; note that adding
  `@display` to a plain connection creates a channel object and shifts IDs).
  tplx and tilx are complementary; validate renames with tilx.
- **~tNl** — network-level traffic without contents: which packets cross
  between nodes, when, and their lengths. Insensitive to anything inside a
  node; the go-to fingerprint for validating intra-node restructuring. Does
  NOT require serializers (nothing is serialized).
- **~tND** — network-level traffic including packet data. Like ~tNl but
  stricter and costlier: works via packet serialization, so every chunk needs
  a serializer, and checksum/CRC/FCS modes are forced to "computed". It is
  checksum-VALUE-independent, though: switching a protocol's checksumMode
  does not move it.
- **~tNlb** — network traffic plus `b` (parsimPack of message contents).
  CAUTION: `b` is NOT the on-wire representation. parsimPack includes the
  cMessage object NAME and internal fields such as tag contents — so renaming
  a message via setName(), or anything that renumbers `Protocol` ids, moves
  ~tNlb while ~tNl/~tND/tplx stay put. Plain ~tNl does not capture names.
- **sz** — scalar + histogram/summary results (values only, no names/paths).
  Sensitive to adding/removing statistics and to result-recording ORDER (e.g.
  module-order changes), not just values.
- **tyf** — graphical fingerprint: display strings + canvas figure geometry,
  under fake-GUI. Useful for visualization code; noisy/unreliable in practice
  and commonly excluded from enforcement.
