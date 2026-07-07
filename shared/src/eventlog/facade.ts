/**
 * EventLogFacade — the common base of the two facades the UI consumes
 * (SequenceChartFacade, EventLogTableFacade). Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogFacade.java
 *
 * A facade wraps an `IEventLog` reference that can be swapped out later (`setEventLog()`,
 * used when the UI applies/removes a filter -- see `FilteredEventLog`, phase E5) and adds
 * derived queries the raw `IEventLog` interface doesn't need to carry itself.
 */

import { BigDecimal } from './bigDecimal';
import type { ModuleDescriptionEntry } from './entries';
import { EventLog } from './eventLog';
import { FilteredEventLog } from './filteredEventLog';
import type { FileChange } from './enums';
import type { IEvent, IEventLog } from './ieventlog';

/** Port of `EventLogFacade`. */
export class EventLogFacade {
  protected eventLog: IEventLog;

  constructor(eventLog: IEventLog) {
    this.eventLog = eventLog;
  }

  setEventLog(eventLog: IEventLog): void {
    this.eventLog = eventLog;
  }

  /**
   * Port of `synchronize()`. Deliberately empty: Java's comment explains why --
   * "we don't call synchronize on eventLog to avoid calling it multiple times from
   * multiple facades" (the host is expected to call `eventLog.synchronize()` itself,
   * once, before notifying each facade). Subclasses override this to react to the
   * change (see SequenceChartFacade/EventLogTableFacade).
   */
  synchronize(change: FileChange): void {
    void change;
  }

  getFirstEventNumber(): number {
    const event = this.eventLog.getFirstEvent();
    return event !== null ? event.getEventNumber() : -1;
  }

  getLastEventNumber(): number {
    const event = this.eventLog.getLastEvent();
    return event !== null ? event.getEventNumber() : -1;
  }

  getFirstSimulationTime(): BigDecimal {
    const event = this.eventLog.getFirstEvent();
    return event !== null ? event.getSimulationTime() : BigDecimal.MINUS_ONE;
  }

  getLastSimulationTime(): BigDecimal {
    const event = this.eventLog.getLastEvent();
    return event !== null ? event.getSimulationTime() : BigDecimal.MINUS_ONE;
  }

  /** Port of `ModuleDescriptionEntry_getModuleFullPath()` (Java's `ClassName_methodName` naming for a "method on a foreign type", kept verbatim -- Java has no extension methods). */
  ModuleDescriptionEntry_getModuleFullPath(moduleDescriptionEntry: ModuleDescriptionEntry | null): string {
    let fullPath = '';
    let current = moduleDescriptionEntry;
    while (current !== null) {
      fullPath = current.fullName + fullPath;
      current = this.eventLog.getEventLogEntryCache().getModuleDescriptionEntry(current.parentModuleId);
      if (current !== null) fullPath = '.' + fullPath;
    }
    return fullPath;
  }

  /** Port of `getNonFilteredEventForEventNumber()`: resolves an event number against the underlying (unfiltered) `EventLog`, unwrapping a `FilteredEventLog` if that's what this facade currently wraps. */
  getNonFilteredEventForEventNumber(eventNumber: number): IEvent | null {
    if (this.eventLog instanceof EventLog) return this.eventLog.getEventForEventNumber(eventNumber);
    else return (this.eventLog as FilteredEventLog).getEventLog().getEventForEventNumber(eventNumber);
  }
}
