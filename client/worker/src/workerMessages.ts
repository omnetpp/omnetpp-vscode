/**
 * The internal main-thread ↔ engine-`worker_thread` message shapes (node:worker_threads
 * `postMessage`/`on('message')`), as distinct from the external JSON-RPC protocol
 * (`elogProtocol.ts`) the extension host speaks to this whole process over stdio.
 * One `elog/*` JSON-RPC request received by `main.ts` becomes one `JobMessage` posted
 * to the engine thread; `main.ts` maps `ResponseMessage`/`ProgressMessage` back onto
 * the JSON-RPC response/`elog/progress` notification for that request's id.
 */

import type { LogSummary } from '@omnetpp/shared/elog-protocol';

/** One RPC request to run. `cancelBuffer` is a `SharedArrayBuffer` (shared, not copied, by `postMessage`) holding a single Int32 cancel flag for this job -- see `main.ts`'s cancellation wiring. */
export interface JobMessage {
  kind: 'job';
  id: number | string;
  method: string;
  params: unknown;
  cancelBuffer: SharedArrayBuffer;
}

/** Only needed for a job still sitting in the engine thread's queue (not yet started) -- see engineThread.ts's header. A running job's cancellation goes through `cancelBuffer` directly, no message round-trip needed. */
export interface CancelMessage {
  kind: 'cancel';
  id: number | string;
}

/** Drives `EngineSession.checkForChanges()` -- see watcher.ts's header for why this exists already in E8 even though the real fs.watch push side is E9. */
export interface CheckChangesMessage {
  kind: 'checkChanges';
}

export type MainToEngineMessage = JobMessage | CancelMessage | CheckChangesMessage;

export interface ResponseMessage {
  kind: 'response';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ProgressMessage {
  kind: 'progress';
  id: number | string;
}

export interface ChangedMessage {
  kind: 'changed';
  change: 'appended' | 'overwritten';
  summary: LogSummary;
}

export type EngineToMainMessage = ResponseMessage | ProgressMessage | ChangedMessage;
