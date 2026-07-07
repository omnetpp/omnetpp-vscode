/**
 * Row DTO builder for the Event Log table (phase U2). Pure function: an `EventLogEntry`
 * (+ a small module/gate lookup context + the current display/name/type modes) in,
 * a `RenderedTableRow` (styled spans, per `elogProtocol.ts`) out. No engine-scanning, no
 * caching, no I/O -- callable from a plain unit test with a fake `TableRowRenderContext`.
 *
 * Porting source: `EventLogTableRowRenderer.java`
 * (omnetpp-dev/ui/org.omnetpp.eventlogtable/src/org/omnetpp/eventlogtable/widgets/
 * EventLogTableRowRenderer.java), specifically `getStyledText()`/`getDescriptiveStyledText()`/
 * `getRawStyledText()`/`getIndentation()`/the inner `Builder` class. `getSimulationTimeText()`
 * always takes the `true` branch in Java (`TimeUtils.secondsToTimeString`, a "TODO: make
 * this a parameter" that was never wired to anything else) -- ported as the sole
 * formatting, not as a toggle.
 *
 * Deliberate deviations from the Java source (all noted inline at the point they apply
 * too):
 *  - No icon/image column (`getImage()`) -- the Java row renderer draws a per-entry-type
 *    icon to the left of the "Details" text (`ImageFactory.EVENTLOG_IMAGE_DIR +
 *    className`); this port has no equivalent icon-resolution pipeline for eventlog
 *    entry types (unlike the NED preview's display-string icon search order) and the
 *    port plan's U2 scope list does not call for icons. Degradable gap, not a
 *    correctness bug -- every row still renders its full text.
 *  - No per-row selection-foreground flip (`Builder.selectedStyle()`) -- see
 *    `TableSpanStyle`'s doc comment in elogProtocol.ts for why that is pure
 *    presentation state the webview applies via CSS instead.
 *  - No bookmark-background painting (`drawCell()`'s `IMarker.BOOKMARK` scan) -- U2 has
 *    no bookmark model yet (that is U6, "4 Eclipse marker kinds"); the row DTO has
 *    nothing to say about it yet.
 *  - An entry type the Java `getDescriptiveStyledText()` switch does not handle at all
 *    (e.g. `GateDisplayStringChangedEntry`/`EncapsulatePacketEntry`/
 *    `DecapsulatePacketEntry`/`MessageDisplayStringChangedEntry` -- checked against the
 *    Java source: none of these appear in its `if`/`else if` chain, so a real Java
 *    table would throw `RuntimeException("Unknown eventlog entry")` if one were ever
 *    fed to it) throws `UnsupportedTableEntryError` here too (for test parity with the
 *    Java "unknown" case), but `renderTableRow()` catches it and falls back to RAW
 *    rendering for just that one row instead of propagating -- a defensive
 *    deviation (a single unusual log line should not break the whole table), reported
 *    per this phase's task list.
 */

import { BigDecimal } from './bigDecimal';
import type { EventLogEntry } from './eventLogEntry';
import { EventLogMessageEntry } from './eventLogEntry';
import type { GateDescriptionEntry, MessageDescriptionEntry, ModuleDescriptionEntry } from './entries';
import {
  BeginSendEntry,
  BubbleEntry,
  CancelEventEntry,
  CloneMessageEntry,
  ComponentMethodBeginEntry,
  ComponentMethodEndEntry,
  ConnectionCreatedEntry,
  ConnectionDeletedEntry,
  ConnectionDisplayStringChangedEntry,
  CreateMessageEntry,
  CustomChangedEntry,
  CustomCreatedEntry,
  CustomDeletedEntry,
  CustomEntry,
  CustomFoundEntry,
  DeleteMessageEntry,
  EndSendEntry,
  EventEntry,
  GateCreatedEntry,
  GateDeletedEntry,
  ModuleCreatedEntry,
  ModuleDeletedEntry,
  ModuleDisplayStringChangedEntry,
  SendDirectEntry,
  SendHopEntry,
  SimulationBeginEntry,
  SimulationEndEntry,
} from './entries';
import type { IEvent } from './ieventlog';
import type { RenderedTableRow, TableRenderModes, TableSpan, TableSpanStyle } from './elogProtocol';

export type { RenderedTableRow, TableRenderModes, TableSpan, TableSpanStyle };
export { DEFAULT_TABLE_RENDER_MODES } from './elogProtocol';

/** Thrown for an entry type the Java descriptive renderer's `if`/`else if` chain does not cover -- see this file's header. Caught by `renderTableRow()`. */
export class UnsupportedTableEntryError extends Error {
  constructor(className: string) {
    super(`renderTableRow: unknown eventlog entry for descriptive rendering: ${className}`);
    this.name = 'UnsupportedTableEntryError';
  }
}

/**
 * The module/gate lookup surface `renderTableRow()` needs beyond the entry itself --
 * satisfied engine-side by `EventLogEntryCache` (`IEventLog.getEventLogEntryCache()`)
 * plus `EventLogFacade.ModuleDescriptionEntry_getModuleFullPath()` and
 * `IEventLog.getEventForEventNumber()` (see `client/worker/src/engineSession.ts`'s
 * caller). Kept as a narrow structural interface (not the full `IEventLog`) so this
 * module stays testable with a plain object literal.
 */
export interface TableRowRenderContext {
  getModuleDescriptionEntry(moduleId: number): ModuleDescriptionEntry | null;
  getGateDescriptionEntry(moduleId: number, gateId: number): GateDescriptionEntry | null;
  getModuleFullPath(moduleDescriptionEntry: ModuleDescriptionEntry | null): string;
  /** Port of the fragment of `EventLogInput`/`IEventLog` `findBeginSendEntry()` needs -- resolving a previous event by number to search its entries. */
  getEventForEventNumber(eventNumber: number): IEvent | null;
}

const ANSI_CONTROL_SEQUENCE_REGEX = /\[[\d;]*[A-HJKSTfimnsu]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_CONTROL_SEQUENCE_REGEX, '');
}

// ---------------------------------------------------------------------------------
// getSimulationTimeText() -- port of org.omnetpp.common.util.TimeUtils.secondsToTimeString()
// ---------------------------------------------------------------------------------

function truncateToBigInt(value: BigDecimal): bigint {
  const scale = value.getScale();
  const unscaled = value.getUnscaledValue();
  // `value` is always >= 0 here (secondsToTimeString() negates upfront), so bigint
  // division (which truncates toward zero) matches Java's `BigDecimal.longValue()`.
  return scale >= 0 ? unscaled * 10n ** BigInt(scale) : unscaled / 10n ** BigInt(-scale);
}

/** Port of `TimeUtils.secondsToTimeString(BigDecimal)`. */
export function secondsToTimeString(time: BigDecimal): string {
  let negative = false;
  if (time.less(BigDecimal.ZERO)) {
    negative = true;
    time = time.negate();
  }
  let out = '';
  for (const unit of ['s ', 'ms ', 'us ', 'ns ', 'ps ', 'fs ', 'as ']) {
    const intPart = truncateToBigInt(time);
    if (intPart > 0n) out += `${intPart}${unit}`;
    // time = (time - intPart).movePointRight(3)
    const remainder = time.subtract(BigDecimal.fromUnscaled(intPart, 0));
    time = BigDecimal.fromUnscaled(remainder.getUnscaledValue(), remainder.getScale() + 3);
  }
  if (out.length === 0) out = '0s';
  return (negative ? '-' : '') + out.trim();
}

// ---------------------------------------------------------------------------------
// Builder -- port of EventLogTableRowRenderer.Builder (minus the selected-style flip
// and the isSelected constructor flag; see this file's header).
// ---------------------------------------------------------------------------------

class Builder {
  readonly spans: TableSpan[] = [];

  constructor(
    private readonly ctx: TableRowRenderContext,
    private readonly modes: TableRenderModes,
    private readonly contextEvent: IEvent,
  ) {}

  append(text: string, style: TableSpanStyle): this {
    this.spans.push({ text: text.replace(/\n/g, '\\n'), style });
    return this;
  }

  constant(text: string): this {
    return this.append(text, 'const');
  }

  constantBold(text: string): this {
    return this.append(text, 'constBold');
  }

  data(value: string): this {
    return this.append(value, 'data');
  }

  raw(value: string): this {
    return this.append(stripAnsi(value), 'raw');
  }

  bubble(text: string): this {
    return this.append(text, 'bubble');
  }

  eventLogMessage(text: string): this {
    return this.append(stripAnsi(text), 'msg');
  }

  module(moduleIdOrEntry: number | ModuleDescriptionEntry | null, nameMode?: TableRenderModes['nameMode']): this {
    const entry = typeof moduleIdOrEntry === 'number' ? this.ctx.getModuleDescriptionEntry(moduleIdOrEntry) : moduleIdOrEntry;
    const mode = nameMode ?? this.modes.nameMode;
    this.constant('module ');
    if (entry !== null) {
      const typeName = this.modes.typeMode === 'NED' ? entry.nedTypeName : entry.moduleClassName;
      this.append(`(${typeName}) `, 'type');
      switch (mode) {
        case 'SMART_NAME':
          if (this.contextEvent.getModuleId() === entry.moduleId) this.moduleFullName(entry);
          else this.moduleFullPath(entry);
          break;
        case 'FULL_NAME':
          this.moduleFullName(entry);
          break;
        case 'FULL_PATH':
          this.moduleFullPath(entry);
          break;
      }
    } else this.append('<unknown>', 'name');
    return this;
  }

  moduleFullPath(entry: ModuleDescriptionEntry): this {
    return this.append(this.ctx.getModuleFullPath(entry), 'name');
  }

  moduleFullName(entry: ModuleDescriptionEntry): this {
    return this.append(entry.fullName, 'name');
  }

  gate(moduleIdOrEntry: number | GateDescriptionEntry | null, gateId?: number): this {
    const entry = typeof moduleIdOrEntry === 'number' ? this.ctx.getGateDescriptionEntry(moduleIdOrEntry, gateId!) : moduleIdOrEntry;
    this.constant('gate ');
    if (entry !== null) this.append(entry.name + (entry.index !== -1 ? `[${entry.index}]` : ''), 'name');
    else this.append('<unknown>', 'name');
    return this;
  }

  connection(sourceModuleId: number, sourceGateId: number, destModuleId = -1, destGateId = -1): this {
    this.constant('connection from ');
    const source = this.ctx.getModuleDescriptionEntry(sourceModuleId);
    if (source !== null) {
      this.module(source);
      this.constant(' ');
      this.gate(sourceModuleId, sourceGateId);
    }
    const dest = this.ctx.getModuleDescriptionEntry(destModuleId);
    if (dest !== null) {
      this.constant(' to ');
      this.module(dest);
      this.constant(' ');
      this.gate(destModuleId, destGateId);
    }
    return this;
  }

  message(entry: MessageDescriptionEntry | null): this {
    this.constant('message ');
    if (entry !== null) {
      this.append(`(${entry.messageClassName}) `, 'type');
      this.append(entry.messageName, 'name');
    } else this.append('<unknown>', 'name');
    return this;
  }

  messageArrivalTime(endSendEntry: EndSendEntry): this {
    const arrivalTime = endSendEntry.arrivalTime;
    const eventSimulationTime = endSendEntry.getEvent()!.getSimulationTime();
    this.data(secondsToTimeString(arrivalTime));
    this.constant(', now + ');
    this.data(secondsToTimeString(arrivalTime.subtract(eventSimulationTime)));
    return this;
  }
}

// ---------------------------------------------------------------------------------
// getIndentation()
// ---------------------------------------------------------------------------------

function computeIndentUnits(entry: EventLogEntry): number {
  let indent = entry.getLevel();
  if (!(entry instanceof EventEntry)) indent += 1;
  if (entry instanceof SendHopEntry || entry instanceof SendDirectEntry) indent += 1;
  return indent;
}

// ---------------------------------------------------------------------------------
// getRawStyledText()
// ---------------------------------------------------------------------------------

function renderRaw(entry: EventLogEntry): TableSpan[] {
  const spans: TableSpan[] = [];
  const push = (text: string, style: TableSpanStyle): void => {
    spans.push({ text: text.replace(/\n/g, '\\n'), style });
  };
  if (!(entry instanceof EventLogMessageEntry)) push(`${entry.getAsString() ?? ''} `, 'constBold');
  for (const name of entry.getAttributeNames()) {
    push(`${name} `, 'const');
    const value = entry.getAsString(name);
    if (value === null || value === '') push('"" ', 'raw');
    else push(stripAnsi(value) + ' ', 'raw');
  }
  return spans;
}

// ---------------------------------------------------------------------------------
// getDescriptiveStyledText() -- the big per-entry-type switch
// ---------------------------------------------------------------------------------

function findBeginSendEntry(ctx: TableRowRenderContext, previousEventNumber: number, messageId: number): BeginSendEntry | null {
  if (previousEventNumber === -1) return null;
  const event = ctx.getEventForEventNumber(previousEventNumber);
  if (event === null) return null;
  const index = event.findBeginSendEntryIndex(messageId);
  if (index === -1) return null;
  return event.getEventLogEntry(index) as BeginSendEntry;
}

function renderDescriptive(entry: EventLogEntry, contextEvent: IEvent, ctx: TableRowRenderContext, modes: TableRenderModes): TableSpan[] {
  const b = new Builder(ctx, modes, contextEvent);
  const eventNumber = contextEvent.getEventNumber();

  if (entry instanceof EventEntry) {
    if (eventNumber === 0) {
      b.constant('Initializing ').module(1);
    } else {
      const fingerprints = contextEvent.getEventEntry().fingerprints;
      if (fingerprints !== null) b.data(`${fingerprints} `);
      const cause = contextEvent.getCause();

      b.constant('Event in ').module(contextEvent.getModuleId(), 'FULL_PATH');

      const beginSendEntry = cause !== null ? cause.getBeginMessageDescriptionEntry() : null;
      if (beginSendEntry !== null) {
        b.constant(' on arrival of ');
        if (contextEvent.isSelfMessageProcessingEvent()) b.constant('self ');
        b.message(beginSendEntry);
        if (!contextEvent.isSelfMessageProcessingEvent()) b.constant(' from ').module(beginSendEntry.getContextModuleId());
        const causeEvent = cause!.getCauseEvent();
        if (causeEvent !== null && causeEvent.getModuleId() !== beginSendEntry.getContextModuleId()) b.constant(' called from ').module(causeEvent.getModuleId());
      }
    }
    return b.spans;
  }

  if (entry instanceof EventLogMessageEntry) {
    b.eventLogMessage(entry.text ?? '');
  } else if (entry instanceof BubbleEntry) {
    b.constant('Bubble');
    if (contextEvent.getModuleId() !== entry.moduleId) b.constant(' in ').module(entry.moduleId);
    b.constant(': ').bubble(entry.text);
  } else if (entry instanceof ComponentMethodBeginEntry) {
    b.constant('Begin calling ');
    if (!entry.methodName) b.constant('method');
    else b.data(entry.methodName);
    b.constant(' in ').module(entry.targetComponentId);
    if (contextEvent.getModuleId() !== entry.getContextModuleId()) b.constant(' from ').module(entry.sourceComponentId);
  } else if (entry instanceof ComponentMethodEndEntry) {
    b.constant('End calling module');
  } else if (entry instanceof ModuleCreatedEntry) {
    b.constant('Creating ').module(entry);
    if (entry.parentModuleId !== -1) b.constant(' under ').module(entry.parentModuleId);
    b.constant(' started');
  } else if (entry instanceof ModuleDeletedEntry) {
    b.constant('Deleting ').module(entry.moduleId);
  } else if (entry instanceof GateCreatedEntry) {
    b.constant('Creating ').gate(entry).constant(' in ').module(entry.moduleId);
  } else if (entry instanceof GateDeletedEntry) {
    b.constant('Deleting ').gate(entry.moduleId, entry.gateId).constant(' in ').module(entry.moduleId);
  } else if (entry instanceof ConnectionCreatedEntry) {
    b.constant('Creating ').connection(entry.sourceModuleId, entry.sourceGateId, entry.destModuleId, entry.destGateId);
  } else if (entry instanceof ConnectionDeletedEntry) {
    b.constant('Deleting ').connection(entry.sourceModuleId, entry.sourceGateId);
  } else if (entry instanceof ConnectionDisplayStringChangedEntry) {
    b.constant('Display string changed for ').connection(entry.sourceModuleId, entry.sourceGateId).constant(' to ').data(entry.displayString);
  } else if (entry instanceof ModuleDisplayStringChangedEntry) {
    b.constant('Display string changed');
    if (contextEvent.getModuleId() !== entry.moduleId) b.constant(' for ').module(entry.moduleId);
    b.constant(' to ').data(entry.displayString);
  } else if (entry instanceof CancelEventEntry) {
    b.constant('Cancelling self ');
    let beginSendEntry = findBeginSendEntry(ctx, entry.previousEventNumber, entry.messageId);
    if (beginSendEntry === null) beginSendEntry = findBeginSendEntry(ctx, contextEvent.getEventEntry().causeEventNumber, entry.messageId);
    b.message(beginSendEntry);
  } else if (entry instanceof BeginSendEntry) {
    const isSelfMessage = contextEvent.isSelfMessage(entry);
    b.constant(isSelfMessage ? 'Scheduling self ' : 'Sending ');
    b.message(entry);
    b.constant(isSelfMessage ? ' for ' : ' arriving at ');
    const endSendEntry = contextEvent.getEndSendEntry(entry);
    // Literal port of an apparent upstream oddity (Java never actually uses
    // `endSendEntry`'s value here, only its null-ness) -- see this file's header.
    if (endSendEntry === null) b.data('<unknown>');
    else b.constant(' kind = ');
    b.data(String(entry.messageKind));
    if (entry.messageClassName !== 'cMessage') b.constant(' length = ').data(String(entry.messageLength));
  } else if (entry instanceof EndSendEntry) {
    b.constant('Arrival at ').messageArrivalTime(entry);
  } else if (entry instanceof SendHopEntry) {
    b.constant('Sending through ').module(entry.senderModuleId).constant(' ').gate(entry.senderModuleId, entry.senderGateId);
    if (!entry.transmissionDelay.equals(BigDecimal.ZERO)) b.constant(' transmission delay = ').data(secondsToTimeString(entry.transmissionDelay));
    if (!entry.propagationDelay.equals(BigDecimal.ZERO)) b.constant(' propagation delay = ').data(secondsToTimeString(entry.propagationDelay));
  } else if (entry instanceof SendDirectEntry) {
    b.constant('Sending direct message ');
    if (contextEvent.getModuleId() !== entry.getContextModuleId()) b.constant('from ').module(entry.senderModuleId);
    b.constant(' to ')
      .module(entry.destModuleId)
      .constant(' ')
      .gate(entry.destModuleId, entry.destGateId)
      .constant(' with transmission delay ')
      .data(secondsToTimeString(entry.transmissionDelay))
      .constant(' and propagation delay ')
      .data(secondsToTimeString(entry.propagationDelay));
  } else if (entry instanceof CreateMessageEntry) {
    b.constant('Creating ').message(entry);
  } else if (entry instanceof CloneMessageEntry) {
    b.constant('Cloning ').message(entry);
  } else if (entry instanceof DeleteMessageEntry) {
    b.constant('Deleting ').message(entry);
  } else if (entry instanceof SimulationBeginEntry) {
    b.constant('Simulation started with runId ').data(entry.runId);
  } else if (entry instanceof SimulationEndEntry) {
    b.constant(entry.isError ? 'Simulation aborted with error code ' : 'Simulation finished with result code ')
      .data(String(entry.resultCode))
      .constant(' : ')
      .data(entry.message);
  } else if (entry instanceof CustomCreatedEntry) {
    b.constant('Custom created entry: ').constant('type = ').data(entry.type).constant(', key = ').data(String(entry.key)).constant(', content = ').data(entry.content);
  } else if (entry instanceof CustomDeletedEntry) {
    b.constant('Custom deleted entry: ').constant('type = ').data(entry.type).constant(', key = ').data(String(entry.key));
  } else if (entry instanceof CustomChangedEntry) {
    b.constant('Custom changed entry, ').constant('type = ').data(entry.type).constant(', key = ').data(String(entry.key)).constant(', content = ').data(entry.content);
  } else if (entry instanceof CustomFoundEntry) {
    b.constant('Custom found entry: ').constant('type = ').data(entry.type).constant(', key = ').data(String(entry.key)).constant(', content = ').data(entry.content);
  } else if (entry instanceof CustomEntry) {
    b.constant('Custom entry: ').constant('type = ').data(entry.type).constant(', key = ').data(String(entry.key)).constant(', content = ').data(entry.content);
  } else {
    throw new UnsupportedTableEntryError(entry.getClassName());
  }

  return b.spans;
}

// ---------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------

/**
 * Builds one table row's rendered DTO. `entry.getEvent()` must be non-null (true for
 * every `EventLogEntry` `EventLogTableFacade` ever hands out -- see that file's header).
 * A descriptive-mode entry type the Java renderer doesn't cover falls back to RAW for
 * just this row instead of throwing -- see this file's header.
 */
export function renderTableRow(entry: EventLogEntry, ctx: TableRowRenderContext, modes: TableRenderModes): RenderedTableRow {
  const event = entry.getEvent();
  if (event === null) throw new Error('renderTableRow: entry does not belong to an event');
  const isEventLogEntry = entry instanceof EventEntry;

  const eventNumberSpan: TableSpan = { text: `#${event.getEventNumber()}`, style: isEventLogEntry ? 'eventNo' : 'faint' };
  const simTimeSpan: TableSpan = { text: secondsToTimeString(event.getSimulationTime()), style: isEventLogEntry ? 'simtime' : 'faint' };

  let detailSpans: TableSpan[];
  if (modes.displayMode === 'RAW') detailSpans = renderRaw(entry);
  else {
    try {
      detailSpans = renderDescriptive(entry, event, ctx, modes);
    } catch (err) {
      if (!(err instanceof UnsupportedTableEntryError)) throw err;
      detailSpans = renderRaw(entry);
    }
  }

  return { indentUnits: computeIndentUnits(entry), eventNumberSpan, simTimeSpan, detailSpans };
}
