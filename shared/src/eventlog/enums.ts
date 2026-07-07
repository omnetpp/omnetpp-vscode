/**
 * Small enum/constant types shared across the eventlog port. Ported 1:1 (names
 * and member order) from the Java sources under
 * omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/:
 *   MatchKind.java, TimelineMode.java, EventLogTableFilterMode.java,
 *   EventNumberKind.java
 * plus the FileChange notion from omnetpp-dev/src/common/filereader.h
 * (`FileReader::FileChange`).
 */

/**
 * Port of org.omnetpp.eventlog.MatchKind. Used by EventLogIndex search
 * functions to describe how an inexact match should be resolved.
 */
export enum MatchKind {
  /** returns not null if exactly one event was found */
  EXACT = 'EXACT',
  /** if multiple matches were found it returns the first one or the previous if there are no matches at all */
  FIRST_OR_PREVIOUS = 'FIRST_OR_PREVIOUS',
  /** if multiple matches were found it returns the first one or the next if there are no matches at all */
  FIRST_OR_NEXT = 'FIRST_OR_NEXT',
  /** as per FIRST_OR_PREVIOUS but the opposite */
  LAST_OR_NEXT = 'LAST_OR_NEXT',
  /** as per FIRST_OR_NEXT but the opposite */
  LAST_OR_PREVIOUS = 'LAST_OR_PREVIOUS',
}

/**
 * Port of org.omnetpp.eventlog.TimelineMode.
 *
 * Simulation time and event number based means proportional to distance
 * measured in pixels. Step means subsequent events follow each other with a
 * constant distance. Nonlinear mode means distance measured in pixels is
 * proportional to a nonlinear function of the simulation time difference
 * between subsequent events.
 */
export enum TimelineMode {
  SIMULATION_TIME = 'SIMULATION_TIME',
  EVENT_NUMBER = 'EVENT_NUMBER',
  STEP = 'STEP',
  NONLINEAR = 'NONLINEAR',
}

/** Port of org.omnetpp.eventlog.EventLogTableFilterMode. */
export enum EventLogTableFilterMode {
  ALL_ENTRIES = 'ALL_ENTRIES',
  EVENT_AND_SEND_AND_MESSAGE_ENTRIES = 'EVENT_AND_SEND_AND_MESSAGE_ENTRIES',
  EVENT_AND_MESSAGE_ENTRIES = 'EVENT_AND_MESSAGE_ENTRIES',
  EVENT_ENTRIES = 'EVENT_ENTRIES',
  CUSTOM_ENTRIES = 'CUSTOM_ENTRIES',
}

/**
 * Port of org.omnetpp.eventlog.EventNumberKind. Variables that store event
 * numbers throughout the API may also hold these additional sentinel values
 * (positive values are real event numbers).
 */
export const EventNumberKind = {
  /** The event number has not yet been calculated. */
  EVENT_NOT_YET_CALCULATED: -1,
  /** There is no such event and will never be because it is impossible (e.g. the previous event of the first event). */
  NO_SUCH_EVENT: -2,
  /** The event is not and will never be in the log, although it could be (e.g. filtered out by the user). */
  FILTERED_EVENT: -3,
  /**
   * The event is not yet in the log, but it might appear in the future (e.g. simulation not there yet).
   * The last event number is added to this constant and returned (e.g. reading event 1000 when the file
   * ends at event 100 will give -104).
   */
  EVENT_NOT_YET_REACHED: -4,
} as const;

/**
 * Port of `FileReader::FileChange` (omnetpp-dev/src/common/filereader.h).
 * Result of comparing a file's current state against the last-synchronized state.
 */
export enum FileChange {
  UNCHANGED = 'UNCHANGED',
  APPENDED = 'APPENDED',
  OVERWRITTEN = 'OVERWRITTEN',
}
