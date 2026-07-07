/**
 * Test-only helpers for phase E4's EventLog/EventLogIndex suite: synthesizes .elog
 * text (plain event streams, duplicate-simulation-time runs, and chunked I/S streams
 * with real, self-consistent file-offset bookkeeping) plus a byte-counting
 * RandomAccessFile wrapper used by the parse-policy test (item 7 of the phase's test
 * plan: "assert via a counting RandomAccessFile wrapper that bytes-read << file size").
 */

import type { RandomAccessFile } from '../../fs/randomAccess';

/** Small deterministic PRNG (mulberry32), same one used by sortedMap.test.ts, so fuzz tests here are repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthesizedEventLog {
  text: string;
  eventCount: number;
  /** simulation time (as its exact printed string) of every event, indexed by event number. */
  simTimes: string[];
}

/**
 * Builds a plain (no I/S chunks) .elog text: a "SB" header, `eventCount` events
 * (`# 0`..`# eventCount-1`), and an "SE" trailer. All events share module id 1 (a
 * single "MC" line on event #0 creates it, matching a minimal real eventlog).
 */
export function synthesizeEventLog(options: { eventCount: number; simTimeForEvent?: (i: number) => string; fillerBytesPerEvent?: number }): SynthesizedEventLog {
  const simTimeForEvent = options.simTimeForEvent ?? ((i: number) => String(i));
  const filler = options.fillerBytesPerEvent ?? 0;
  const lines: string[] = ['SB ov 1536 ev 2 rid Test-0', ''];
  const simTimes: string[] = [];
  for (let i = 0; i < options.eventCount; i++) {
    const simTime = simTimeForEvent(i);
    simTimes.push(simTime);
    lines.push(`E # ${i} t ${simTime} m 1 ce -1 msg -1`);
    if (i === 0) lines.push('MC id 1 c C t T n root cm 1');
    if (filler > 0) lines.push('- ' + 'x'.repeat(filler));
    lines.push('');
  }
  lines.push('SE e 0 c 9 m "done"');
  return { text: lines.join('\n') + '\n', eventCount: options.eventCount, simTimes };
}

/**
 * Builds a .elog text like `synthesizeEventLog()` but additionally interleaves real
 * "S" (full snapshot) and "I" (incremental index) chunks, with `f`/`i`/`s` file-offset
 * fields computed to be exactly self-consistent (this file is never "truncated" at
 * write time, so `EventLogIndex`'s file-offset-shift arithmetic in
 * `parseIndicesAndSnapshots()` always resolves with delta 0) -- following the wire
 * syntax in shared/src/test/eventlog/chunks.test.ts's hand-written fixture, generalized
 * to run over many events. A snapshot is emitted every `snapshotEvery` events; an index
 * (referencing the nearest preceding snapshot and index) is emitted every `indexEvery`
 * events in between. The single module ("root", id 1) is created on event #0 and never
 * deleted, so every snapshot/index's "RF #0" reference resolves for the whole file.
 */
export function synthesizeChunkedEventLog(options: { eventCount: number; simTimeForEvent?: (i: number) => string; snapshotEvery?: number; indexEvery?: number; fillerBytesPerEvent?: number }): SynthesizedEventLog {
  const simTimeForEvent = options.simTimeForEvent ?? ((i: number) => String(i));
  const snapshotEvery = options.snapshotEvery ?? 20;
  const indexEvery = options.indexEvery ?? 5;
  const filler = options.fillerBytesPerEvent ?? 0;
  const simTimes: string[] = [];

  let text = '';
  let offset = 0;
  const append = (line: string): void => {
    text += line + '\n';
    offset += line.length + 1; // fixture content is pure ASCII: char length === byte length
  };

  append('SB ov 1536 ev 2 rid Test-0');
  append('');

  append(`E # 0 t ${simTimeForEvent(0)} m 1 ce -1 msg -1`);
  simTimes.push(simTimeForEvent(0));
  append('MC id 1 c C t T n root cm 1');
  if (filler > 0) append('- ' + 'x'.repeat(filler));
  append('');

  let previousIndexFileOffset = -1;
  let previousSnapshotFileOffset = -1;
  const emitSnapshot = (eventNumber: number): void => {
    const snapshotOffset = offset;
    append(`S f ${snapshotOffset} # ${eventNumber} t ${simTimeForEvent(eventNumber)}`);
    append('RF # 0 b 1 e 1');
    append('');
    previousSnapshotFileOffset = snapshotOffset;
  };
  const emitIndex = (eventNumber: number): void => {
    const indexOffset = offset;
    append(`I f ${indexOffset} i ${previousIndexFileOffset} s ${previousSnapshotFileOffset} # ${eventNumber} t ${simTimeForEvent(eventNumber)}`);
    append('');
    previousIndexFileOffset = indexOffset;
  };

  emitSnapshot(0);

  for (let i = 1; i < options.eventCount; i++) {
    const simTime = simTimeForEvent(i);
    simTimes.push(simTime);
    append(`E # ${i} t ${simTime} m 1 ce -1 msg -1`);
    if (filler > 0) append('- ' + 'x'.repeat(filler));
    append('');
    if (i % snapshotEvery === 0) emitSnapshot(i);
    else if (i % indexEvery === 0) emitIndex(i);
  }
  append('SE e 0 c 9 m "done"');
  return { text, eventCount: options.eventCount, simTimes };
}

export interface SynthesizedEventLogSteps {
  /**
   * `cumulativeText[k]` is the full `.elog` text (SB header + events `#0..#(k-1)`, no
   * `SE` trailer -- a still-running simulation hasn't written one yet) for every `k`
   * from `0` to `eventCount`. Deliberately built with the exact same per-event line
   * shape as `synthesizeEventLog()` (single-event-per-`E`-line, `MC` only on event
   * #0), so any `cumulativeText[k]` is a byte-for-byte-valid prefix of every
   * `cumulativeText[m]` with `m > k` -- i.e. `cumulativeText[m].slice(cumulativeText[k]
   * .length)` is exactly the bytes a live-growing eventlog file would have had
   * appended to it between having `k` and `m` events. Phase E9's live-follow tests
   * use this to simulate a real append (`fs.appendFileSync`) without needing an
   * actual running simulation process.
   */
  cumulativeText: string[];
  simTimes: string[];
}

/** Like `synthesizeEventLog()`, but returns every prefix instead of only the final text -- see `SynthesizedEventLogSteps`'s doc comment. */
export function synthesizeEventLogSteps(options: { eventCount: number; simTimeForEvent?: (i: number) => string; fillerBytesPerEvent?: number }): SynthesizedEventLogSteps {
  const simTimeForEvent = options.simTimeForEvent ?? ((i: number) => String(i));
  const filler = options.fillerBytesPerEvent ?? 0;
  let text = 'SB ov 1536 ev 2 rid Test-0\n\n';
  const cumulativeText: string[] = [text];
  const simTimes: string[] = [];
  for (let i = 0; i < options.eventCount; i++) {
    const simTime = simTimeForEvent(i);
    simTimes.push(simTime);
    text += `E # ${i} t ${simTime} m 1 ce -1 msg -1\n`;
    if (i === 0) text += 'MC id 1 c C t T n root cm 1\n';
    if (filler > 0) text += '- ' + 'x'.repeat(filler) + '\n';
    text += '\n';
    cumulativeText.push(text);
  }
  return { cumulativeText, simTimes };
}

/** Non-decreasing simulation-time generator with runs of duplicate values, e.g.
 * `runLengths=[10,5,3]` yields ten events at t=0, five at t=1, three at t=2, and (if
 * `eventCount` exceeds the sum) continues incrementing by 1 per subsequent event. */
export function makeDuplicateRunSimTime(runLengths: number[]): (i: number) => string {
  const boundaries: number[] = [];
  let cumulative = 0;
  for (const len of runLengths) {
    cumulative += len;
    boundaries.push(cumulative);
  }
  return (i: number): string => {
    for (let t = 0; t < boundaries.length; t++) if (i < boundaries[t]) return String(t);
    const lastBoundary = boundaries.length > 0 ? boundaries[boundaries.length - 1] : 0;
    const lastT = boundaries.length > 0 ? boundaries.length - 1 : 0;
    return String(lastT + (i - lastBoundary) + 1);
  };
}

/** Byte-counting `RandomAccessFile` wrapper (test item 7: verifying a "large file" open reads only a small fraction of the file). */
export class CountingRandomAccessFile implements RandomAccessFile {
  totalBytesRead = 0;
  readCount = 0;

  constructor(private readonly inner: RandomAccessFile) {}

  get path(): string {
    return this.inner.path;
  }
  getSize(): number {
    return this.inner.getSize();
  }
  getMtimeMs(): number {
    return this.inner.getMtimeMs();
  }
  readAt(buffer: Uint8Array, fileOffset: number): number {
    const n = this.inner.readAt(buffer, fileOffset);
    this.totalBytesRead += n;
    this.readCount++;
    return n;
  }
  close(): void {
    this.inner.close();
  }
}
