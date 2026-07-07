// Public surface of the '@omnetpp/shared/eventlog' subpath (see shared/package.json
// "exports"). This is the foundation layer of the OMNeT++ eventlog library port
// (phase E1): exact-precision simulation time, line tokenization, a TreeMap
// replacement, and a buffered bidirectional file reader with change detection.
// Host-agnostic: no vscode or Node imports (the RandomAccessFile it reads through
// is injected by the caller — see shared/src/fs/randomAccess.ts and
// shared/src/node/nodeRandomAccessFile.ts for the Node-backed implementation).

export { BigDecimal, type BigDecimalSpecial } from './bigDecimal';
export { LineTokenizer, tokenizeLine } from './lineTokenizer';
export { SortedMap, type Comparator, type SortedMapEntry } from './sortedMap';
export { MatchKind, TimelineMode, EventLogTableFilterMode, EventNumberKind, FileChange } from './enums';
export { FileReader, FileChangedError, type Line } from './fileReader';
