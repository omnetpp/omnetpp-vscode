/**
 * Dispatch table from `ElogMethods` request names to `EngineSession` methods --
 * kept as a separate, tiny, framework-free module (per the E8 task list) so
 * `client/worker/src/test/handlers.test.ts` can drive it directly, in-process,
 * without spawning `engineThread.ts`'s real worker_thread. `engineThread.ts` is the
 * only other caller: it wraps `handleElogRequest()` in the actual job queue/
 * cancellation/postMessage plumbing.
 *
 * `handleElogRequest()` itself does not decide which calls are cancellable/long-
 * running -- every call is routed through `session.runJob()` uniformly (cheap calls
 * just never observe the cancel flag or call `notify()`, since they never trigger
 * `eventLog.progress()`), which keeps this table a flat, boring switch instead of a
 * two-tiered "long-running vs. not" dispatch.
 */

import { ElogMethods } from '@omnetpp/shared/elog-protocol';
import { EngineSession } from './engineSession';

/** Executes one `elog/*` request against `session`, inside the given job's cancel/progress context (see `EngineSession.runJob()`). Throws on an unknown method (an engineThread-level bug, not a client-facing error path). */
export function handleElogRequest(session: EngineSession, method: string, params: unknown, cancelFlag: Int32Array, notify: () => void): unknown {
  return session.runJob(cancelFlag, notify, () => dispatch(session, method, params));
}

function dispatch(session: EngineSession, method: string, params: unknown): unknown {
  switch (method) {
    case ElogMethods.open:
      return session.open(params as Parameters<EngineSession['open']>[0]);
    case ElogMethods.getSummary:
      return session.getSummary();
    case ElogMethods.getModuleTree:
      return session.getModuleTree();
    case ElogMethods.setFilter:
      return session.setFilter(params as Parameters<EngineSession['setFilter']>[0]);
    case ElogMethods.scSetTimelineMode:
      return session.scSetTimelineMode(params as Parameters<EngineSession['scSetTimelineMode']>[0]);
    case ElogMethods.scRelocateOrigin:
      return session.scRelocateOrigin(params as Parameters<EngineSession['scRelocateOrigin']>[0]);
    case ElogMethods.scGetViewport:
      return session.scGetViewport(params as Parameters<EngineSession['scGetViewport']>[0]);
    case ElogMethods.scMapCoords:
      return session.scMapCoords(params as Parameters<EngineSession['scMapCoords']>[0]);
    case ElogMethods.scAdjacencyMatrix:
      return session.scAdjacencyMatrix(params as Parameters<EngineSession['scAdjacencyMatrix']>[0]);
    case ElogMethods.tableGetRows:
      return session.tableGetRows(params as Parameters<EngineSession['tableGetRows']>[0]);
    case ElogMethods.tableNavigate:
      return session.tableNavigate(params as Parameters<EngineSession['tableNavigate']>[0]);
    case ElogMethods.tablePosition:
      return session.tablePosition(params as Parameters<EngineSession['tablePosition']>[0]);
    case ElogMethods.gotoEvent:
      return session.gotoEvent(params as Parameters<EngineSession['gotoEvent']>[0]);
    case ElogMethods.gotoSimTime:
      return session.gotoSimTime(params as Parameters<EngineSession['gotoSimTime']>[0]);
    case ElogMethods.findText:
      return session.findText(params as Parameters<EngineSession['findText']>[0]);
    case ElogMethods.getEventDetail:
      return session.getEventDetail(params as Parameters<EngineSession['getEventDetail']>[0]);
    case ElogMethods.close:
      session.close();
      return null;
    default:
      throw new Error(`handleElogRequest: unknown method '${method}'`);
  }
}
