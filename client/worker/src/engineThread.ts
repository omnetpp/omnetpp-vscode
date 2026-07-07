/**
 * The engine worker_thread's entry point. `main.ts` spawns this same bundle as a
 * `Worker` (`new Worker(__filename, { workerData: { role: 'engine' } })` -- see
 * main.ts's header for the single-bundle re-entry trick); `startEngineThread()`
 * below is only ever invoked from that worker's own module-scope guard.
 *
 * Owns: one `EngineSession`, a serial FIFO job queue (only one `elog/*` request
 * executes at a time -- the engine itself is synchronous, per the port plan), and
 * the cancellation wiring: each `JobMessage` carries a `SharedArrayBuffer`-backed
 * Int32 cancel flag; `EngineSession.runJob()`'s progress hook checks it on every
 * `eventLog.progress()` call and throws `RequestCancelledError` the moment it's set
 * -- true mid-scan cancellation, not just "don't start the next queued job".
 * `main.ts` flips the flag via `Atomics.store()` directly (no message round-trip)
 * when a `vscode-jsonrpc` `CancellationToken` fires for the currently-running job; a
 * `CancelMessage` is only needed to drop a still-*queued* (not yet started) job.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CONTENT_CHANGED_ERROR_CODE, ElogMethods, REQUEST_CANCELLED_ERROR_CODE, type CheckChangesResult, type ContentChangedErrorData } from '@omnetpp/shared/elog-protocol';
import { ContentChangedError, EngineSession, RequestCancelledError } from './engineSession';
import { handleElogRequest } from './handlers';
import type { CancelMessage, EngineToMainMessage, JobMessage, MainToEngineMessage } from './workerMessages';

/** Guard per this file's header: only actually start when running as the spawned engine worker_thread, never when this same bundled module is merely `import`-ed by `main.ts` running on the main thread. */
export function maybeStartEngineThread(): void {
  if (isMainThread) return;
  if ((workerData as { role?: string } | undefined)?.role !== 'engine') return;
  startEngineThread();
}

function startEngineThread(): void {
  const port = parentPort;
  if (port === null) throw new Error('engineThread: parentPort is null (not actually running as a worker_thread)');

  const session = new EngineSession();
  const queue: JobMessage[] = [];
  let runningJobId: number | string | null = null;
  let processing = false;

  const post = (message: EngineToMainMessage): void => port.postMessage(message);

  function pump(): void {
    if (processing) return;
    processing = true;
    try {
      let job: JobMessage | undefined;
      while ((job = queue.shift()) !== undefined) {
        runningJobId = job.id;
        const cancelFlag = new Int32Array(job.cancelBuffer);
        try {
          const result = handleElogRequest(session, job.method, job.params, cancelFlag, () => post({ kind: 'progress', id: job!.id }));
          post({ kind: 'response', id: job.id, result });
          // Phase E9 ("live follow"): `elog/checkChanges` is a normal, low-priority job
          // like any other (see main.ts's header on why it's routed through this same
          // FIFO queue rather than a separate immediate side-channel) -- but on top of
          // the ordinary request/response round trip above, a *positive* result also
          // gets broadcast as an unsolicited `elog/changed` notification, exactly like
          // the mid-request case below. This covers both triggers uniformly: the
          // watcher-driven check (fire-and-forget from `main.ts`'s perspective -- see
          // its `requestCheckFileChange()`) and a client's own manual `elog/checkChanges`
          // request both end up here, and either way every listener learns about the
          // change, not just whoever happened to ask.
          if (job.method === ElogMethods.checkChanges) {
            const checkResult = result as CheckChangesResult;
            if (checkResult.changed) post({ kind: 'changed', change: checkResult.change!, summary: checkResult.summary });
          }
        } catch (err) {
          post({ kind: 'response', id: job.id, error: toRpcError(err) });
          // Phase E9: a request that was interrupted mid-scan by a file change has
          // already been synchronized (see EngineSession.runJob()'s catch clause,
          // which converts the underlying `FileChangedError` into this
          // `ContentChangedError` only after calling `synchronizeToCurrentFileState()`)
          // -- so broadcast the same `elog/changed` notification here too, not just to
          // this one caller via the error response above (item 3 of the phase's task
          // list: "runs the full synchronize flow (incl. notification)").
          if (err instanceof ContentChangedError) post({ kind: 'changed', change: err.change, summary: err.summary });
        } finally {
          runningJobId = null;
        }
      }
    } finally {
      processing = false;
    }
  }

  port.on('message', (message: MainToEngineMessage) => {
    switch (message.kind) {
      case 'job':
        queue.push(message);
        pump();
        break;
      case 'cancel':
        dropQueuedJob(message);
        break;
    }
  });

  function dropQueuedJob(message: CancelMessage): void {
    // A running job's cancellation is handled entirely via the shared cancel-flag
    // buffer (see this file's header) -- nothing to do here for `runningJobId`.
    if (message.id === runningJobId) return;
    const index = queue.findIndex((j) => j.id === message.id);
    if (index < 0) return;
    queue.splice(index, 1);
    post({ kind: 'response', id: message.id, error: { code: REQUEST_CANCELLED_ERROR_CODE, message: 'request cancelled before it started' } });
  }
}

function toRpcError(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof RequestCancelledError) return { code: REQUEST_CANCELLED_ERROR_CODE, message: err.message };
  if (err instanceof ContentChangedError) {
    const data: ContentChangedErrorData = { change: err.change, summary: err.summary };
    return { code: CONTENT_CHANGED_ERROR_CODE, message: err.message, data };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: -32001 /* ErrorCodes.UnknownErrorCode */, message };
}
