/**
 * labelProvider.ts (PURE) — port of `SequenceChartLabelProvider.java` (361 LOC, read
 * in full): the tooltip/label text builders for events, message dependencies, axes,
 * and method calls. Only the "formatted" (tooltip) branch is ported — the plain-text
 * branch (status-bar-style, `formatted=false`) is not needed by a webview (no SWT
 * status line equivalent).
 *
 * DEVIATIONS (documented):
 *  - Eclipse's `getDescriptiveText()` can stack MULTIPLE hit objects into one tooltip
 *    (e.g. an event AND an axis at the exact same pixel) by joining their individual
 *    blocks with `<br/>`. This port's `tooltip.ts` only ever asks for the SINGLE
 *    top-priority hit (`hitTest.ts`'s `pickPrimary()` — the same object a click would
 *    act on), so only one block is ever built at a time. Simpler, and consistent with
 *    every other "priority cascade" decision made in this phase.
 *  - `RenderDependency` (the protocol DTO, `elogProtocol.ts`) carries `messageName`/
 *    `messageClassName` but NOT the message id/tree id/encapsulation id fields Java's
 *    `MessageDescriptionEntry` exposes, and collapses Java's SENDS/REUSES/MIXED
 *    sub-kind of a *filtered* (aggregated) dependency into one `'filtered'` value with
 *    a single message name/class for the whole aggregate (not separate begin/end
 *    entries). Both are real, protocol-level fidelity gaps (fixing them would mean
 *    growing `elogProtocol.ts`/the engine's viewport-render path, out of this phase's
 *    scope) — `buildDependencyTooltip()` below omits the "(id = ...)" clause entirely
 *    and shows one generic "Derived message dependency" line for filtered deps instead
 *    of Java's begin→end two-message breakdown.
 *  - Simulation-time formatting (`TimeUtils.secondsToTimeString`, "1.5s"/"500ms"-style
 *    unit-scaled output) is reimplemented here as a pure decimal-STRING algorithm
 *    (digit-shifting through the same fixed unit ladder Java's `secondsToTimeString`
 *    uses) rather than importing `@omnetpp/shared`'s `BigDecimal`/`secondsToTimeString`
 *    (`shared/src/eventlog/tableRowRenderer.ts`) — those live behind the full
 *    `@omnetpp/shared/eventlog` barrel (the entire host-agnostic engine), and this
 *    webview bundle deliberately only ever imports the lean `elog-protocol`/
 *    `ui-protocol` subpaths (see `chartMain.ts`'s other imports) to keep the browser
 *    IIFE from bloating with engine code it doesn't run. Operating on the ORIGINAL
 *    decimal string (never round-tripped through a `number`) means this is actually
 *    exact-precision, not a lossy approximation like `coords.ts`/`ticks.ts`'s
 *    number-based interpolation.
 *  - The timeline-coordinate ("click on empty timeline") tooltip's simulation time
 *    comes from the caller's already-APPROXIMATE `tcToSimTimeApprox()` (a `number`),
 *    formatted via `ticks.ts`'s `formatTickLabel()` — consistent with every other
 *    "current pointer position" display already in this phase (status strip, ticks).
 */

import type { ElogModule, EventDetail, RenderDependency, RenderMethodCall, TimelineEvent } from '@omnetpp/shared/elog-protocol';
import { findModuleNode } from './axes';
import { formatTickTime } from './ticks';
import { formatSimulationTime, subtractDecimalStrings } from '../common/decimalTime';

export { formatSimulationTime, subtractDecimalStrings };

// ---------------------------------------------------------------------------------
// HTML text helpers
// ---------------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Port of `ANSI_CONTROL_SEQUENCE_REGEX` (strips ANSI CSI escape sequences from eventlog "-" message lines). */
const ANSI_CONTROL_SEQUENCE_REGEX = /\[[\d;]*[A-Za-z]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_CONTROL_SEQUENCE_REGEX, '');
}

// ---------------------------------------------------------------------------------
// module name/type text (getModuleText/getAxisText)
// ---------------------------------------------------------------------------------

export interface LabelProviderContext {
  moduleTree: ElogModule | null;
}

interface ModuleClause {
  typeName: string;
  fullPath: string;
}

function moduleClause(moduleId: number, ctx: LabelProviderContext): ModuleClause {
  const node = findModuleNode(moduleId, ctx.moduleTree);
  return { typeName: node?.nedTypeName ?? '?', fullPath: node?.fullName ?? `Module #${moduleId}` };
}

export function buildAxisTooltip(moduleId: number, ctx: LabelProviderContext): string {
  const mod = moduleClause(moduleId, ctx);
  return `<b>Axis</b> (${mod.typeName}) <b>${mod.fullPath}</b> (id = ${moduleId})`;
}

// ---------------------------------------------------------------------------------
// event (getEventText + the single-event message-line dump)
// ---------------------------------------------------------------------------------

export interface EventTooltipOptions {
  /** The `RenderDependency` whose `consequenceEventNumber` is this event, if resolvable from the currently-loaded viewport model (the "causing message" clause). `null`/omitted if not found (e.g. the cause dependency's cause side fell outside the fetched window). */
  causeDependency?: RenderDependency | null;
  /** `elog/getEventDetail`'s result for this event, if the caller fetched it (the message-line dump below the header). `null`/omitted skips that section entirely (no extra round trip forced). */
  detail?: EventDetail | null;
}

export function buildEventTooltip(event: Pick<TimelineEvent, 'eventNumber' | 'simulationTime' | 'moduleId'>, ctx: LabelProviderContext, options: EventTooltipOptions = {}): string {
  const mod = moduleClause(event.moduleId, ctx);
  let result = `<b>Event</b> #<b>${event.eventNumber}</b> at t = <b>${formatSimulationTime(event.simulationTime)}</b> in module (${mod.typeName}) <b>${mod.fullPath}</b> (id = ${event.moduleId})`;

  const dep = options.causeDependency;
  if (dep?.messageName) result += ` message (${dep.messageClassName ?? '?'}) <b>${dep.messageName}</b>`;

  const detail = options.detail;
  if (detail) {
    let count = 0;
    for (const entry of detail.entries) {
      if (entry.text === null) continue;
      // NOTE: no style="..." attributes anywhere in webview HTML -- the webview CSP's
      // style-src-attr blocks them (only the nonce'd <style> sheet and CSSOM
      // assignments are allowed); .elog-tooltip-msg lives in webviewHtml.ts.
      result += `<br/><span class="elog-tooltip-msg"> - ${escapeHtml(stripAnsi(entry.text))}</span>`;
      count++;
      if (count === 100) {
        result += '<br/><br/>Content stripped after 100 lines. See Eventlog Table for more details.';
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------
// message dependency (getMessageDependencyText)
// ---------------------------------------------------------------------------------

export function buildDependencyTooltip(dep: RenderDependency): string {
  const name = dep.messageName ?? '(unknown)';
  const cls = dep.messageClassName ?? '?';
  const nameClause = `(${cls}) <b>${name}</b>`;

  const result =
    dep.kind === 'filtered'
      ? // see this file's header: protocol fidelity gap, one generic line instead of Java's SENDS/REUSES/MIXED + begin/end breakdown
        `<b>Derived </b>message dependency ${nameClause}`
      : `<b>${dep.kind === 'reuse' ? 'Reusing' : 'Sending'} </b>${nameClause}`;

  let out = `${result} (#${dep.causeEventNumber} -&gt; #${dep.consequenceEventNumber})`;
  if (dep.causeSimulationTime !== null && dep.consequenceSimulationTime !== null) {
    out += ` dt = ${formatSimulationTime(subtractDecimalStrings(dep.consequenceSimulationTime, dep.causeSimulationTime))}`;
  }
  return out;
}

/** Short label for a dependency (context-menu submenu titles) -- port of `getMessageDependencyLabel()`: just the message name(s), no class/kind/id. */
export function buildDependencyLabel(dep: RenderDependency): string {
  return dep.messageName ?? '(unknown message)';
}

// ---------------------------------------------------------------------------------
// method call (getComponentMethodCallText)
// ---------------------------------------------------------------------------------

export function buildMethodCallTooltip(call: RenderMethodCall, ctx: LabelProviderContext): string {
  const source = moduleClause(call.sourceModuleId, ctx);
  const target = moduleClause(call.targetModuleId, ctx);
  return `<b>Calling ${call.methodName}</b> from module (${source.typeName}) <b>${source.fullPath}</b> to module (${target.typeName}) <b>${target.fullPath}</b>`;
}

// ---------------------------------------------------------------------------------
// timeline coordinate ("Double" -- click on empty timeline)
// ---------------------------------------------------------------------------------

export function buildTimestampTooltip(simTime: number | null, beforeEventNumber: number | null, afterEventNumber: number | null): string {
  let result = `<b>At</b> t = <b>${simTime !== null ? formatTickTime(simTime) : '?'}</b>`;
  if (beforeEventNumber !== null) result += `, just after event #${beforeEventNumber}`;
  if (afterEventNumber !== null) result += `, just before event #${afterEventNumber}`;
  return result;
}

/** Port of `getEventLabel()` -- `"#<n>"`. */
export function formatEventLabel(eventNumber: number): string {
  return `#${eventNumber}`;
}

// ---------------------------------------------------------------------------------
// neighbor lookup for the timestamp tooltip (client-side, currently-loaded events only
// -- see this file's header)
// ---------------------------------------------------------------------------------

/** Nearest events (by `tcBegin`) at-or-before / at-or-after `tc`, excluding an exact match at `tc` itself (mirrors Java's "if event's simtime differs from the clicked position's" check, approximated here via tc rather than simtime -- see header). `events` need not be sorted. */
export function findNeighborEvents(tc: number, events: Pick<TimelineEvent, 'eventNumber' | 'tcBegin'>[]): { before: number | null; after: number | null } {
  let before: { eventNumber: number; tcBegin: number } | null = null;
  let after: { eventNumber: number; tcBegin: number } | null = null;
  for (const e of events) {
    if (e.tcBegin < tc && (before === null || e.tcBegin > before.tcBegin)) before = e;
    if (e.tcBegin > tc && (after === null || e.tcBegin < after.tcBegin)) after = e;
  }
  return { before: before?.eventNumber ?? null, after: after?.eventNumber ?? null };
}

// ---------------------------------------------------------------------------------
// single dispatch entry point -- tooltip.ts resolves a HitObject into one of these
// variants (looking up TimelineEvent/RenderDependency/RenderMethodCall/EventDetail
// from the currently-loaded viewport model / an on-demand getEventDetail call) and
// calls buildTooltipHtml() once.
// ---------------------------------------------------------------------------------

export type ResolvedHit =
  | { kind: 'event'; event: Pick<TimelineEvent, 'eventNumber' | 'simulationTime' | 'moduleId'>; causeDependency: RenderDependency | null; detail: EventDetail | null }
  | { kind: 'dependency'; dependency: RenderDependency }
  | { kind: 'methodCall'; call: RenderMethodCall }
  | { kind: 'axis'; moduleId: number }
  | { kind: 'timestamp'; simTime: number | null; beforeEventNumber: number | null; afterEventNumber: number | null };

export function buildTooltipHtml(hit: ResolvedHit, ctx: LabelProviderContext): string {
  switch (hit.kind) {
    case 'event':
      return buildEventTooltip(hit.event, ctx, { causeDependency: hit.causeDependency, detail: hit.detail });
    case 'dependency':
      return buildDependencyTooltip(hit.dependency);
    case 'methodCall':
      return buildMethodCallTooltip(hit.call, ctx);
    case 'axis':
      return buildAxisTooltip(hit.moduleId, ctx);
    case 'timestamp':
      return buildTimestampTooltip(hit.simTime, hit.beforeEventNumber, hit.afterEventNumber);
  }
}
