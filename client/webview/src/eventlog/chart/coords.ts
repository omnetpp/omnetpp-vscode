/**
 * coords.ts (PURE) — tc<->pixel mapping and an approximate, client-side
 * simtime<->tc interpolation used for synchronous per-frame needs (gutter tick
 * labels, status-strip readout, hover position) that cannot afford an
 * `elog/sc/mapCoords` round trip on every mouse move / paint.
 *
 * Port intent:
 *  - tc<->pixel: `SequenceChart.java`'s `getViewportCoordinateForTimelineCoordinate`/
 *    `getTimelineCoordinateForViewportCoordinate` (`x = round((t - leftTc) *
 *    pixelsPerTc)`), generalized to plain (unrounded) doubles here — canvas 2D drawing
 *    doesn't need integer pixels the way SWT does, and keeping it unrounded avoids
 *    compounding error on the inverse.
 *  - simtime<->tc: `SequenceChartFacade.getSimulationTimeForTimelineCoordinate()`/
 *    `getTimelineCoordinateForSimulationTime()` (see sequenceChartFacade.ts):
 *    piecewise-LINEAR interpolation between the two `TimelineEvent` samples
 *    (tcBegin/tcEnd, simulationTime) that bracket the query — exact in
 *    `SIMULATION_TIME` mode (tc is an affine function of simtime there, so any two
 *    samples define the whole line exactly), an APPROXIMATION in `EVENT_NUMBER`/
 *    `STEP`/`NONLINEAR` modes (same as the engine's own facade — its doc comment
 *    literally says "IMPORTANT NOTE: this is just an approximation" for those
 *    branches too, so this port isn't introducing new imprecision, just doing the
 *    same interpolation client-side instead of engine-side).
 *
 * DEVIATION from the engine facade (documented, deliberate): the engine interpolates
 * using exact `BigDecimal` simulation times; this module receives simulation times
 * already as `number` (the caller parses the protocol's decimal strings once when
 * building the sample table) since it must run synchronously without a worker round
 * trip. This loses precision only in the same way `Number(bigDecimalString)` always
 * does (>~15-17 significant decimal digits) — never observed in practice for real
 * `.elog` simulation times, and irrelevant for a *display* value (the authoritative
 * value for anything exact, e.g. "go to this simtime", still goes through
 * `elog/sc/mapCoords`/`elog/gotoSimTime`, never through this module).
 *
 * Extrapolation beyond the fetched sample window (edge case the engine facade
 * doesn't need to handle, since it can always compute one more event on demand):
 * linear-extrapolates using the slope of the two nearest samples at that edge, so a
 * tick label drawn just outside the currently-cached viewport window doesn't jump
 * discontinuously as the user pans slightly further than the last fetch. Falls back
 * to a flat (non-extrapolated) value if fewer than two samples exist at that edge.
 */

import type { ViewportState } from './viewportState';

// ---------------------------------------------------------------------------------
// tc <-> pixel
// ---------------------------------------------------------------------------------

/** Maps a timeline coordinate to a CSS-px x offset WITHIN THE CONTENT AREA (i.e. NOT yet offset by GUTTER_LEFT_WIDTH — callers add that when actually drawing). */
export function tcToPixel(tc: number, v: Pick<ViewportState, 'leftTc' | 'pixelsPerTc'>): number {
  return (tc - v.leftTc) * v.pixelsPerTc;
}

/** Inverse of `tcToPixel`. */
export function pixelToTc(px: number, v: Pick<ViewportState, 'leftTc' | 'pixelsPerTc'>): number {
  return px / v.pixelsPerTc + v.leftTc;
}

/**
 * Clamps a coordinate into a range every browser's Canvas 2D backend can rasterize
 * reliably (port plan: "clipX-style clamping for huge virtual widths" — dense logs
 * with a fine zoom level and a huge event-number/tc span can otherwise overflow
 * typical single-precision-float canvas backends well before `Number.MAX_SAFE_INTEGER`).
 * Chosen bound (±8,388,608 = 2^23) is the largest integer a float32 can represent
 * exactly, a conservative, widely-cited safe ceiling for canvas coordinates.
 */
const CANVAS_COORDINATE_LIMIT = 8_388_608;
export function clipCoordinate(px: number): number {
  if (Number.isNaN(px)) return 0;
  return Math.min(CANVAS_COORDINATE_LIMIT, Math.max(-CANVAS_COORDINATE_LIMIT, px));
}

// ---------------------------------------------------------------------------------
// simtime <-> tc (approximate, piecewise-linear interpolation)
// ---------------------------------------------------------------------------------

/** One (tc, simTime) sample point for the interpolation table. */
export interface TcSimSample {
  tc: number;
  simTime: number;
}

/** Anything with the fields needed to build a sample table — `TimelineEvent` satisfies this; kept generic so tests can hand-build samples without the full protocol type. `tcEnd` optional (defaults to `tcBegin` = a zero-width point). */
export interface TcSimSource {
  tcBegin: number;
  tcEnd?: number;
  simulationTime: string;
}

/**
 * Builds a sample table from a `TimelineEvent[]` (or hand-built `TcSimSource[]`),
 * sorted ascending by `tc` (defensive — the engine already emits events in ascending
 * tc order within a viewport, but interpolation requires it and callers may merge
 * several fetched windows). Duplicate `tc` values (possible: several
 * `isSelfMessageProcessingEvent`/zero-duration events at the same instant) are kept
 * as-is (not deduped) — `interpolate()` below explicitly handles a zero-width
 * bracket instead of requiring unique x values, matching the engine facade's own
 * `if (delta === 0)` branches.
 */
export function buildSampleTable(events: TcSimSource[]): TcSimSample[] {
  const samples: TcSimSample[] = [];
  for (const e of events) {
    const simTime = Number(e.simulationTime);
    // A pill-shaped event spans [tcBegin, tcEnd] all at the SAME simulation time (its
    // internal log entries have no simtime advance). Emit BOTH ends so the piecewise-linear
    // interpolation stays FLAT across the pill instead of ramping toward the next event --
    // otherwise the mouse-time hairline "counts up" while sweeping a zero-simtime pill.
    samples.push({ tc: e.tcBegin, simTime });
    if (e.tcEnd !== undefined && e.tcEnd !== e.tcBegin) samples.push({ tc: e.tcEnd, simTime });
  }
  samples.sort((a, b) => a.tc - b.tc);
  return samples;
}

/**
 * Generic monotonic (in `x`) piecewise-linear interpolation with edge extrapolation,
 * shared by both interpolation directions below (`samples` must be sorted ascending
 * by `x`; `y` need not be monotonic across ties in `x`, but normally is).
 * `preferUpper` picks which sample wins when the query lands exactly on a zero-width
 * bracket (two samples with the same `x`) — matches the engine facade's `upperLimit`
 * out-parameter convention.
 */
function interpolate(x: number, samples: { x: number; y: number }[], preferUpper: boolean): number | null {
  const n = samples.length;
  if (n === 0) return null;
  if (n === 1) return samples[0].y;

  if (x <= samples[0].x) {
    // extrapolate below using the first two samples' slope
    const [a, b] = samples;
    if (b.x === a.x) return a.y;
    return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  if (x >= samples[n - 1].x) {
    const a = samples[n - 2];
    const b = samples[n - 1];
    if (b.x === a.x) return b.y;
    return b.y + ((b.y - a.y) * (x - b.x)) / (b.x - a.x);
  }

  // binary search for the bracket [lo, lo+1] with samples[lo].x <= x <= samples[lo+1].x
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (b.x === a.x) return preferUpper ? b.y : a.y;
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

/** Approximate simulation time at timeline coordinate `tc` — see this file's header. `null` iff `samples` is empty. */
export function tcToSimTimeApprox(tc: number, samples: TcSimSample[], upperLimit = false): number | null {
  const asXY = samples.map((s) => ({ x: s.tc, y: s.simTime }));
  return interpolate(tc, asXY, upperLimit);
}

/**
 * Approximate timeline coordinate at simulation time `simTime`. Builds an
 * ascending-by-simTime view of the same table (simTime is not guaranteed unique
 * across events in EVENT_NUMBER/STEP/NONLINEAR modes -- several events can share one
 * simulation time; `upperLimit` picks the later/earlier tc among ties, same
 * convention as `tcToSimTimeApprox`). `null` iff `samples` is empty.
 */
export function simTimeToTcApprox(simTime: number, samples: TcSimSample[], upperLimit = false): number | null {
  const bySimTime = samples.map((s) => ({ x: s.simTime, y: s.tc })).sort((a, b) => a.x - b.x);
  return interpolate(simTime, bySimTime, upperLimit);
}
