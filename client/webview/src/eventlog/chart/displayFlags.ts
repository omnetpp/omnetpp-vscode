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
 * `showAxisVectorData` gates the axis vector-data strips (`drawList.ts`'s `axisVectorStrip`
 * primitive, from `ViewportModel.axisVectorStrips`): when on, a module with a vector
 * attached shows its values as a colored step bar in place of its plain axis line.
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
  /**
   * ADDITIVE (not a Java flag): shows a small editable note box below the last axis for
   * every bookmark whose flag glyph is currently on screen, connected to it by a dotted
   * callout line -- see `chartMain.ts`'s note-layer refresh + `bookmarkNotesLayout.ts`'s
   * packing. Opt-in default (`false`) since it's an information-dense overlay, unlike
   * every other flag here which mirrors a Java default.
   */
  showBookmarkInfo: boolean;
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
  showBookmarkInfo: false,
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
  ['showAxisVectorData', 'Axis Vector Data'],
  ['showEmptyAxes', 'Empty Axes'],
  ['showHairlines', 'Hairlines'],
  ['showZeroSimulationTimeRegions', 'Zero Simulation Time Regions'],
  ['showTimeDifferences', 'Time Differences'],
  ['showPositionAndRange', 'Position and Range Info'],
  ['showAxisInfo', 'Axis Info'],
  ['showEventLogInfo', 'Event Log Info'],
  ['showBookmarkInfo', 'Bookmark Info'],
];

export function toggleFlag(flags: ChartDisplayFlags, key: keyof ChartDisplayFlags): ChartDisplayFlags {
  return { ...flags, [key]: !flags[key] };
}

// ---------------------------------------------------------------------------------
// Preset flag profiles (phase U8) — ports of SequenceChart.java's setShowAll()/
// setShowDefault()/setShowNetworkCommunication() (lines 425-492, read in full).
// Used by the Preset Configuration menu (`SequenceChartContributor.java:380-427`):
// Network Node / Network Interface -> network-communication profile; Full Detail ->
// everything on; Default -> the default profile; Empty -> everything off.
// ---------------------------------------------------------------------------------

/** Port of `setShowAll(value)`: every flag set to `value` (Java flips all ~26 `setShow*` setters). */
export function showAllFlags(value: boolean): ChartDisplayFlags {
  const flags = {} as Record<keyof ChartDisplayFlags, boolean>;
  for (const key of Object.keys(DEFAULT_DISPLAY_FLAGS) as (keyof ChartDisplayFlags)[]) flags[key] = value;
  return flags as ChartDisplayFlags;
}

/** Port of `setShowDefault()`: everything off, then Java's exact 16-flag true-list (`SequenceChart.java:456-475`). */
export function presetDefaultFlags(): ChartDisplayFlags {
  return {
    ...showAllFlags(false),
    showArrowHeads: true,
    showAxes: true,
    showAxisHeaders: true,
    showAxisLabels: true,
    showAxisVectorData: true,
    showComponentMethodCalls: true,
    showEventMarks: true,
    showEventNumbers: true,
    showHairlines: true,
    showMessageNames: true,
    showMessageSends: true,
    showMethodNames: true,
    showPositionAndRange: true,
    showSelfMessageSends: true,
    showTimeDifferences: true,
    showTransmissionDurations: true,
  };
}

/** Port of `setShowNetworkCommunication()`: everything off, then Java's exact 10-flag true-list (`SequenceChart.java:480-492`) — no event marks/numbers, no method calls, no self-messages: only the inter-module message traffic. */
export function presetNetworkCommunicationFlags(): ChartDisplayFlags {
  return {
    ...showAllFlags(false),
    showArrowHeads: true,
    showAxes: true,
    showAxisHeaders: true,
    showAxisLabels: true,
    showHairlines: true,
    showMessageNames: true,
    showMessageSends: true,
    showPositionAndRange: true,
    showTimeDifferences: true,
    showTransmissionDurations: true,
  };
}

/** Merges a (possibly partial/stale, e.g. from an older persisted blob) patch over the defaults — never lets a missing/renamed field crash the round trip. */
export function mergeDisplayFlags(patch: Partial<ChartDisplayFlags> | undefined | null): ChartDisplayFlags {
  return { ...DEFAULT_DISPLAY_FLAGS, ...(patch ?? {}) };
}
