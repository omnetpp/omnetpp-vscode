/**
 * FileReader — buffered, bidirectional, line-oriented reader over a
 * `RandomAccessFile`, with append/overwrite change detection.
 *
 * Ported from omnetpp-dev/src/common/filereader.{h,cc} (`omnetpp::common::FileReader`
 * / `FileReader::FileChange`), but only its *behavior* — forward/backward line
 * iteration, a bounded in-memory window over the file, the "an incomplete last
 * line is not returned" rule, and the tail-compare change-detection scheme.
 * The C++ implementation manages a single persistent buffer with raw pointer
 * arithmetic (`dataBegin`/`dataEnd`/`currentDataPointer`) so it can keep as much
 * previously-read data resident as possible; here we have true random access
 * (`RandomAccessFile.readAt`), so this is a fresh design that re-reads a
 * `[dataBeginOffset, dataEndOffset)` window on demand instead of memmove'ing a
 * fixed buffer. It reproduces the same externally observable behavior (see the
 * tests fuzzing this against a `String.split()` reference at several buffer
 * sizes), including throwing when a single line would not fit in one window
 * (a "line too long" condition).
 *
 * DEVIATION: the C++ class caps a line at `bufferSize/2` (`maxLineSize`, still
 * exposed here for API parity) because its buffer must hold two lines at once
 * for its pointer bookkeeping to work. That constraint doesn't apply to this
 * on-demand-reload design, so the effective cap enforced here is the full
 * `bufferSize` (strictly more permissive, never less) — see `scanForwardForNewline`
 * / `scanBackwardForNewline`.
 *
 * DEVIATION: `synchronize()` only drops the buffered window on OVERWRITTEN (the
 * C++ version unconditionally drops it on any change). On APPENDED, previously
 * read bytes are still correct — by definition of "appended" — so keeping them
 * avoids a wasted re-read; this matches the "live follow" design in the eventlog
 * port plan (APPENDED should be a cheap incremental step, not a full reset).
 *
 * File locking (`FileLock` in the C++) is not ported — cross-process advisory
 * locking has no bearing on a read-only, worker-thread-hosted analysis engine.
 */

import type { RandomAccessFile } from '../fs/randomAccess';
import { FileChange } from './enums';

const LF = 0x0a;
const CR = 0x0d;
const SAVED_TAIL_SIZE = 16 * 1024;

/**
 * Decodes bytes 1:1 to code points (ISO-8859-1/latin1), byte-exact and reversible.
 * Hand-rolled (rather than `new TextDecoder('latin1')`) to avoid depending on a
 * platform's encoding-label support and to keep this file free of Node-only APIs
 * (`Buffer`) — this needs to stay host-agnostic (see shared/src/fs/fileSystem.ts).
 */
function decodeLatin1(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  if (bytes.length <= CHUNK_SIZE) return String.fromCharCode(...bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  return out;
}

export interface Line {
  /** Line content, with a trailing `\r` (if any) stripped. Never includes the `\n`. */
  text: string;
  /** Absolute byte offset of the first character of the line. */
  startOffset: number;
  /** Absolute byte offset just past the line's trailing `\n` (i.e. the start of the next line). */
  endOffset: number;
}

/** Port of `FileChangedError` (filereader.h) — thrown by FileReader when a buffer refill notices the file changed. */
export class FileChangedError extends Error {
  constructor(
    public readonly change: FileChange,
    message: string,
  ) {
    super(message);
    this.name = 'FileChangedError';
  }
}

export class FileReader {
  readonly maxLineSize: number;

  private buffer: Uint8Array;
  private dataBeginOffset = 0;
  private dataEndOffset = 0;
  private currentOffset = 0;

  private lastFileSize = 0;
  private lastMtimeMs = 0;
  private savedTail = new Uint8Array(0);
  private numReadBytes = 0;

  constructor(
    private readonly raf: RandomAccessFile,
    private readonly bufferSize: number = 256 * 1024,
  ) {
    if (bufferSize < 2) throw new Error('FileReader: bufferSize must be at least 2');
    this.maxLineSize = Math.floor(bufferSize / 2);
    this.buffer = new Uint8Array(bufferSize);
    this.captureFileState();
  }

  // ---- Position / size --------------------------------------------------------------

  getCurrentOffset(): number {
    return this.currentOffset;
  }

  /** Returns the file size as of the last synchronize() (NOT a fresh stat — see getFileChange()). */
  getFileSize(): number {
    return this.lastFileSize;
  }

  /**
   * Port of the C++/Java `FileReader.getNumReadBytes()` -- cumulative count of bytes
   * actually pulled from the underlying `RandomAccessFile` (i.e. buffer window
   * (re)loads via `forceLoad()`), not bytes handed back through `getNextLine()`/
   * `getPreviousLine()` (which mostly come from the already-resident window). Used by
   * `EventLog.parseBegin()`/`parseEnd()` (eventLog.ts) to budget how much of a huge
   * file to eagerly parse at open time -- the same byte-budget role `numReadBytes` plays
   * in `EventLog.java`.
   */
  getNumReadBytes(): number {
    return this.numReadBytes;
  }

  seekTo(offset: number): void {
    if (offset < 0 || offset > this.lastFileSize) throw new Error(`FileReader: invalid offset ${offset}`);
    this.currentOffset = offset;
  }

  close(): void {
    this.raf.close();
  }

  // ---- Line iteration ----------------------------------------------------------------

  /**
   * Returns the next line starting at or after the current position, and advances the
   * position past it. If the current position is not itself at a line boundary (e.g.
   * right after a seekTo() into the middle of a line), the remainder of that partial
   * line is discarded and the line *after* it is returned instead (matches
   * `FileReader::getNextLineBufferPointer`). Returns null (without moving the position)
   * when the next line is not terminated by `\n` yet (an "incomplete last line").
   */
  getNextLine(): Line | null {
    let start = this.currentOffset;
    if (start >= this.lastFileSize) return null;

    if (!this.isLineStart(start)) {
      const skipNlIdx = this.scanForwardForNewline(start);
      if (skipNlIdx < 0) return null;
      start = skipNlIdx + 1;
      this.currentOffset = start;
      if (start >= this.lastFileSize) return null;
    }

    const nlIdx = this.scanForwardForNewline(start);
    if (nlIdx < 0) return null;
    const endOffset = nlIdx + 1;
    const text = this.decodeRangeEndingAtNewline(start, nlIdx);
    this.currentOffset = endOffset;
    return { text, startOffset: start, endOffset };
  }

  /**
   * Returns the line immediately before the current position, and moves the position to
   * its start. Symmetric to getNextLine(): if the current position is mid-line, that
   * partial line is discarded first and the complete line before it is returned. Returns
   * null (position moved to offset 0) once the beginning of the file is reached.
   */
  getPreviousLine(): Line | null {
    let end = this.currentOffset;
    if (end <= 0) return null;

    if (!this.isLineStart(end)) {
      end = this.startOfLineContaining(end);
      this.currentOffset = end;
      if (end === 0) return null;
    }

    const start = this.startOfPreviousLine(end);
    this.currentOffset = start;
    const text = this.decodeRangeEndingAtNewline(start, end - 1);
    return { text, startOffset: start, endOffset: end };
  }

  // ---- Change detection ---------------------------------------------------------------

  /**
   * Compares the file's current state against what was recorded at the last
   * synchronize(). A change is an APPEND if the size grew and the bytes at the
   * previously-known end of file (the saved tail) are unchanged; anything else
   * (shrunk, or same/greater size but the tail differs) is an OVERWRITE.
   */
  getFileChange(): FileChange {
    const size = this.raf.getSize();
    const mtimeMs = this.raf.getMtimeMs();
    if (size === this.lastFileSize && mtimeMs === this.lastMtimeMs) return FileChange.UNCHANGED;
    if (size < this.lastFileSize) return FileChange.OVERWRITTEN;

    const tailLen = this.savedTail.length;
    const current = new Uint8Array(tailLen);
    const tailStart = this.lastFileSize - tailLen;
    let total = 0;
    while (total < tailLen) {
      const n = this.raf.readAt(current.subarray(total), tailStart + total);
      if (n <= 0) break;
      total += n;
    }
    if (total === tailLen && bytesEqual(current, this.savedTail))
      return size === this.lastFileSize ? FileChange.UNCHANGED : FileChange.APPENDED;
    return FileChange.OVERWRITTEN;
  }

  /** Adopts a detected FileChange: refreshes the cached size/mtime/tail, dropping the buffered window on OVERWRITTEN. */
  synchronize(change: FileChange): void {
    this.captureFileState();
    if (change === FileChange.OVERWRITTEN) {
      this.dataBeginOffset = 0;
      this.dataEndOffset = 0;
      if (this.currentOffset > this.lastFileSize) this.currentOffset = this.lastFileSize;
    }
  }

  private captureFileState(): void {
    this.lastFileSize = this.raf.getSize();
    this.lastMtimeMs = this.raf.getMtimeMs();
    const tailLen = Math.min(SAVED_TAIL_SIZE, this.lastFileSize);
    const tail = new Uint8Array(tailLen);
    const tailStart = this.lastFileSize - tailLen;
    let total = 0;
    while (total < tailLen) {
      const n = this.raf.readAt(tail.subarray(total), tailStart + total);
      if (n <= 0) break;
      total += n;
    }
    this.savedTail = total === tailLen ? tail : tail.subarray(0, total);
  }

  private checkFileForChanges(): void {
    const change = this.getFileChange();
    if (change !== FileChange.UNCHANGED) {
      const what = change === FileChange.APPENDED ? 'appended' : 'overwritten';
      throw new FileChangedError(change, `File changed: '${this.raf.path}' has been ${what}`);
    }
  }

  // ---- Buffer window management --------------------------------------------------------

  /** Loads exactly `[begin, end)` (clamped to the last-known file size) into the buffer, checking for changes first. */
  private forceLoad(begin: number, end: number): void {
    this.checkFileForChanges();
    const size = this.lastFileSize;
    begin = Math.max(0, Math.min(begin, size));
    end = Math.max(begin, Math.min(end, size));
    const len = end - begin;
    let total = 0;
    while (total < len) {
      const n = this.raf.readAt(this.buffer.subarray(total, len), begin + total);
      if (n <= 0) break;
      total += n;
    }
    this.dataBeginOffset = begin;
    this.dataEndOffset = begin + total;
    this.numReadBytes += total;
  }

  /** Ensures the window covers `[neededBegin, neededEnd)`, reloading (recentered around the need) only if it doesn't already. */
  private ensureCoverage(neededBegin: number, neededEnd: number): void {
    neededBegin = Math.max(0, neededBegin);
    neededEnd = Math.min(this.lastFileSize, Math.max(neededBegin, neededEnd));
    if (this.dataBeginOffset <= neededBegin && neededEnd <= this.dataEndOffset) return;
    const halfSlack = Math.floor(this.bufferSize / 2);
    let begin = Math.max(0, neededBegin - halfSlack);
    let end = Math.min(this.lastFileSize, begin + this.bufferSize);
    if (end < neededEnd) {
      end = neededEnd;
      begin = Math.max(0, end - this.bufferSize);
    }
    this.forceLoad(begin, end);
  }

  private isLineStart(offset: number): boolean {
    if (offset === 0) return true;
    this.ensureCoverage(offset - 1, offset);
    return this.buffer[offset - 1 - this.dataBeginOffset] === LF;
  }

  /** Scans forward from `start` (inclusive) for the next `\n`. Returns its absolute offset, or -1 if EOF is reached first. */
  private scanForwardForNewline(start: number): number {
    this.ensureCoverage(start, Math.min(this.lastFileSize, start + 1));
    for (let attempt = 0; ; attempt++) {
      const relStart = Math.max(0, start - this.dataBeginOffset);
      const relEnd = this.dataEndOffset - this.dataBeginOffset;
      for (let i = relStart; i < relEnd; i++) {
        if (this.buffer[i] === LF) return this.dataBeginOffset + i;
      }
      if (this.dataEndOffset >= this.lastFileSize) return -1;
      if (attempt >= 1) throw new Error(`FileReader: line too long (over ${this.bufferSize} bytes), in '${this.raf.path}'`);
      this.forceLoad(start, Math.min(this.lastFileSize, start + this.bufferSize));
    }
  }

  /** Scans backward, strictly before `end`, for the nearest `\n`. Returns its absolute offset, or -1 if offset 0 is reached first. */
  private scanBackwardForNewline(end: number): number {
    this.ensureCoverage(Math.max(0, end - 1), end);
    for (let attempt = 0; ; attempt++) {
      const winBegin = this.dataBeginOffset;
      const relEnd = Math.min(end, this.dataEndOffset) - winBegin;
      let found = -1;
      for (let i = relEnd - 1; i >= 0; i--) {
        if (this.buffer[i] === LF) {
          found = i;
          break;
        }
      }
      if (found >= 0) return winBegin + found;
      if (winBegin === 0) return -1;
      if (attempt >= 1) throw new Error(`FileReader: line too long (over ${this.bufferSize} bytes), in '${this.raf.path}'`);
      this.forceLoad(Math.max(0, end - this.bufferSize), end);
    }
  }

  /** Returns the start offset of the (possibly partial) line that contains `offset` (searches strictly before `offset`). */
  private startOfLineContaining(offset: number): number {
    const nlIdx = this.scanBackwardForNewline(offset);
    return nlIdx < 0 ? 0 : nlIdx + 1;
  }

  /**
   * Given a confirmed line-start `lineStart` (0, or `buffer[lineStart-1] === '\n'`),
   * returns the start offset of the line immediately before it. Searches strictly
   * before `lineStart - 1`, so it does not re-match `lineStart`'s own trailing `\n`
   * as if it were a separator (that would make no backward progress at all).
   */
  private startOfPreviousLine(lineStart: number): number {
    const nlIdx = this.scanBackwardForNewline(lineStart - 1);
    return nlIdx < 0 ? 0 : nlIdx + 1;
  }

  /** Decodes `[startAbs, lfAbs)` as latin1 text, stripping a trailing `\r` right before the `\n` at `lfAbs`, if present. */
  private decodeRangeEndingAtNewline(startAbs: number, lfAbs: number): string {
    this.ensureCoverage(startAbs, lfAbs);
    const startRel = startAbs - this.dataBeginOffset;
    let endRel = lfAbs - this.dataBeginOffset;
    if (endRel > startRel && this.buffer[endRel - 1] === CR) endRel--;
    return decodeLatin1(this.buffer.subarray(startRel, endRel));
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
