// A minimal, host-agnostic random-access (pread-style) file abstraction, used by
// the eventlog FileReader port (shared/src/eventlog/fileReader.ts). Deliberately
// synchronous: the eventlog engine runs on a dedicated worker thread (see the
// architecture notes in the eventlog port plan), so blocking syscalls there do
// not stall the extension host or the LSP server. The Node-backed implementation
// lives in shared/src/node/nodeRandomAccessFile.ts; other hosts (e.g. a browser
// worker with an OPFS-backed file) can provide their own implementation of
// RandomAccessFileProvider without shared/ ever importing Node or vscode APIs.

export interface RandomAccessFile {
  readonly path: string;

  /** Current file size in bytes. Performs a fresh stat() on every call. */
  getSize(): number;

  /** Current file modification time in epoch milliseconds. Performs a fresh stat() on every call. */
  getMtimeMs(): number;

  /**
   * Reads bytes starting at the given absolute file offset into `buffer`
   * (pread semantics: does not affect any other file position). Reads at
   * most `buffer.length` bytes. Returns the number of bytes actually read,
   * which is 0 at/past end of file.
   */
  readAt(buffer: Uint8Array, fileOffset: number): number;

  /** Releases the underlying OS file handle. Safe to call more than once. */
  close(): void;
}

export interface RandomAccessFileProvider {
  openRandomAccess(path: string): RandomAccessFile;
}
