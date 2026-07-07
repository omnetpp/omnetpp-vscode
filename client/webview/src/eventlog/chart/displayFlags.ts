/**
 * displayFlags.ts (PURE) — the ~25 Show/Hide toggles Java keeps as private booleans
 * on `SequenceChart` (`SequenceChart.java:192-216`, verified by reading the source —
 * field list + default values transcribed 1:1 below). `drawList.ts` reads this object
 * to gate primitive emission; `chartContextMenu.ts` builds the "Show/Hide" submenu from
 * `TOGGLE_ORDER`; `chartMain.ts` owns the live `ChartDisplayFlags` value and persists it
 * (port plan: "Show/Hide state ... persisted per-file via stateChanged like table
 * modes" — see `sequenceChartEditor.ts`'s per-uri `workspaceState` blob, mirroring
 * `eventLogTableView.ts`'s `TABLE_STATE_KEY` pattern).
 *
 * `showAxisVectorData` is kept in the shape (state round-trips it, so restoring an
 * older/newer persisted blob never drops an unrelated field) but has NO toggle in
 * `TOGGLE_ORDER` and NO rendering effect — the `.vec` axis-data strips themselves are
 * out of scope for this whole port (per the port plan's decision record), so there is
 * nothing for this flag to gate; it stays present only so a hand-written blob shaped
 * like Java's real persisted state doesn't fail to round-trip.
 */

export interface ChartDisplayFlags {
  showArrowHeads: boolean;
  showAxes: boolean;
  showAxisHeaders: boolean;
  /**
   * Port of Java's `drawAxisInfo()` (a small hover-tracked "which axis is the mouse
   * over" readout). STUB (documented, unlike `showAxisVectorData`'s permanent
   * out-of-scope): the toggle exists, is wired into the Show/Hide menu, and persists
   * like every other flag, but `chartMain.ts` has no hovered-axis tracking to feed it
   * text yet (no protocol/state gap — just not wired up this phase), so it currently
   * renders nothing regardless of value. A future phase can wire it by computing an
   * `infoPanelText`-shaped hover string in `chartMain.ts`'s mousemove handler.
   */
  showAxisInfo: boolean;
  showAxisLabels: boolean;
  /** See this file's header — no UI toggle, no rendering effect (deliberately out of scope). */
  showAxisVectorData: boolean;
  showComponentMethodCalls: boolean;
  showEmptyAxes: boolean;
  showEventLogInfo: boolean;
  showEventMarks: boolean;
  showEventNumbers: boolean;
  showHairlines: boolean;
  showInitializationEvent: boolean;
  showMessageNames: boolean;
  showMessageReuses: boolean;
  showMessageSends: boolean;
  showMethodNames: boolean;
  showMixedMessageDependencies: boolean;
  showMixedSelfMessageDependencies: boolean;
  showPositionAndRange: boolean;
  showSelfMessageReuses: boolean;
  showSelfMessageSends: boolean;
  showTimeDifferences: boolean;
  showTransmissionDurations: boolean;
  showZeroSimulationTimeRegions: boolean;
}

/** Java's own field initializers, transcribed verbatim (`SequenceChart.java:192-216`). */
export const DEFAULT_DISPLAY_FLAGS: ChartDisplayFlags = {
  showArrowHeads: true,
  showAxes: true,
  showAxisHeaders: true,
  showAxisInfo: true,
  showAxisLabels: true,
  showAxisVectorData: true,
  showComponentMethodCalls: true,
  showEmptyAxes: false,
  showEventLogInfo: false,
  showEventMarks: true,
  showEventNumbers: true,
  showHairlines: true,
  showInitializationEvent: false,
  showMessageNames: true,
  showMessageReuses: false,
  showMessageSends: true,
  showMethodNames: true,
  showMixedMessageDependencies: true,
  showMixedSelfMessageDependencies: true,
  showPositionAndRange: true,
  showSelfMessageReuses: false,
  showSelfMessageSends: true,
  showTimeDifferences: true,
  showTransmissionDurations: true,
  showZeroSimulationTimeRegions: true,
};

/** `(key, menu label)` pairs, in the order the Show/Hide submenu lists them — `showAxisVectorData` deliberately absent (see header). */
export const TOGGLE_ORDER: [keyof ChartDisplayFlags, string][] = [
  ['showEventMarks', 'Event Marks'],
  ['showEventNumbers', 'Event Numbers'],
  ['showInitializationEvent', 'Initialization Event'],
  ['showMessageSends', 'Message Send Arrows'],
  ['showMessageReuses', 'Message Reuse Arrows'],
  ['showSelfMessageSends', 'Self-Message Send Arrows'],
  ['showSelfMessageReuses', 'Self-Message Reuse Arrows'],
  ['showMixedMessageDependencies', 'Mixed Filtered Dependencies'],
  ['showMixedSelfMessageDependencies', 'Mixed Filtered Self-Dependencies'],
  ['showArrowHeads', 'Arrow Heads'],
  ['showMessageNames', 'Message Names'],
  ['showTransmissionDurations', 'Transmission Durations'],
  ['showComponentMethodCalls', 'Method Call Arrows'],
  ['showMethodNames', 'Method Names'],
  ['showAxes', 'Axes'],
  ['showAxisLabels', 'Axis Labels'],
  ['showAxisHeaders', 'Axis Headers'],
  ['showEmptyAxes', 'Empty Axes'],
  ['showHairlines', 'Hairlines'],
  ['showZeroSimulationTimeRegions', 'Zero Simulation Time Regions'],
  ['showTimeDifferences', 'Time Differences'],
  ['showPositionAndRange', 'Position and Range Info'],
  ['showAxisInfo', 'Axis Info'],
  ['showEventLogInfo', 'Event Log Info'],
];

export function toggleFlag(flags: ChartDisplayFlags, key: keyof ChartDisplayFlags): ChartDisplayFlags {
  return { ...flags, [key]: !flags[key] };
}

/** Merges a (possibly partial/stale, e.g. from an older persisted blob) patch over the defaults — never lets a missing/renamed field crash the round trip. */
export function mergeDisplayFlags(patch: Partial<ChartDisplayFlags> | undefined | null): ChartDisplayFlags {
  return { ...DEFAULT_DISPLAY_FLAGS, ...(patch ?? {}) };
}
