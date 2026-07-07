/**
 * zeroSimTimeRegions.ts (PURE) — port of `SequenceChart.java`'s
 * `drawZeroSimulationTimeRegions()` (`SequenceChart.java:3479-3530`, verified by reading
 * the source), computed WEBVIEW-SIDE from the already-fetched `TimelineEvent[]` rather
 * than a dedicated engine RPC (per this phase's brief: "zero-simtime regions may also
 * be computed webview-side from TimelineEvents with equal simtime but advancing tc").
 *
 * Java's rule (transcribed): a region is any tc SPAN where the simulation clock did not
 * advance --
 *  (a) an event whose own `tcBegin !== tcEnd` (its ENTRIES span multiple timeline
 *      coordinates within one event, e.g. `separateEventLogEntries` mode) draws a
 *      region over its own extent, and
 *  (b) two CONSECUTIVE events (by tc order, i.e. `getNextEvent()` order — this port
 *      approximates that with a tc-sort, since a `ViewportModel`'s `events` array is
 *      only "roughly" event-number order across timeline modes) with an EQUAL
 *      `simulationTime` string get a region spanning the gap between them.
 * (The two before/after-the-whole-simulation edge rectangles Java also draws — before
 * tc=0 and after the last event — are chart-viewport-clipping decoration this port
 * doesn't need: `drawList.ts` already clips regions against the visible content area.)
 *
 * Adjacent/overlapping raw spans are merged into the fewest possible bands (a
 * `regionBand` primitive per band, not per raw span) — cheap and keeps the render
 * output small for a dense log with many same-simtime events in a row.
 */

export interface TcRegion {
  tcBegin: number;
  tcEnd: number;
}

export interface ZeroSimTimeEventLike {
  tcBegin: number;
  tcEnd: number;
  simulationTime: string;
}

export function computeZeroSimTimeRegions(events: readonly ZeroSimTimeEventLike[]): TcRegion[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.tcBegin - b.tcBegin);
  const raw: TcRegion[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    if (event.tcBegin !== event.tcEnd) raw.push({ tcBegin: event.tcBegin, tcEnd: event.tcEnd });
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev.simulationTime === event.simulationTime && prev.tcEnd !== event.tcBegin) {
        raw.push({ tcBegin: Math.min(prev.tcEnd, event.tcBegin), tcEnd: Math.max(prev.tcEnd, event.tcBegin) });
      }
    }
  }
  if (raw.length === 0) return [];

  raw.sort((a, b) => a.tcBegin - b.tcBegin);
  const merged: TcRegion[] = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    const cur = raw[i];
    if (cur.tcBegin <= last.tcEnd) last.tcEnd = Math.max(last.tcEnd, cur.tcEnd);
    else merged.push({ ...cur });
  }
  return merged;
}
