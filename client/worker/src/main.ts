/**
 * Process entry point for the dedicated per-`.elog` eventlog worker (`dist/
 * eventlogWorker.js`, spawned by `client/src/eventlog/workerClient.ts`). Speaks
 * `elogProtocol.ts`'s JSON-RPC methods over stdio (`vscode-jsonrpc/node`'s
 * `StreamMessageReader`/`StreamMessageWriter`, Content-Length framing -- NOT the
 * newline-delimited framing the MCP stdio transport uses, see scripts/mcp-smoke.mjs
 * vs. scripts/elog-worker-smoke.mjs for the two styles side by side).
 *
 * SINGLE-BUNDLE RE-ENTRY (port plan/E8 task list): esbuild bundles this file (plus
 * everything it imports, including engineThread.ts) into ONE file,
 * `dist/eventlogWorker.js`. The engine itself runs on a `node:worker_threads`
 * `Worker` spawned as `new Worker(__filename, { workerData: { role: 'engine' } })`
 * -- i.e. the *same* bundle file, re-executed from the top by the worker_threads
 * runtime. That means BOTH `main.ts`'s and `engineThread.ts`'s module-level code run
 * on every thread that ever executes this bundle; each guards its own entry point:
 *   - `engineThread.ts` exports `maybeStartEngineThread()`, which no-ops unless
 *     `!isMainThread && workerData?.role === 'engine'`.
 *   - `main.ts` (here) only calls `runMain()` when `isMainThread` is true.
 * Verified (see scripts/elog-worker-smoke.mjs / the E8 phase report): this produces
 * exactly one engine thread per process, never a recursive re-spawn (the worker
 * thread's own `isMainThread` is `false`, so its copy of this file's top-level code
 * takes the "do nothing" branch instead of spawning yet another worker).
 *
 * LIVE FOLLOW (phase E9): change detection (`watcher.ts`'s fs.watch + poll-timer
 * hybrid) only ever *requests* a check -- `requestCheckFileChange()` below turns any
 * number of such requests into at most one outstanding `elog/checkChanges` job,
 * posted through the exact same `JobMessage` queue as every other `elog/*` request
 * (`engineThread.ts`'s `queue` is a plain FIFO array). That gives both properties the
 * phase's task list asks for, "for free", from the queue's own ordering semantics:
 *   - "must not preempt in-flight jobs": it's appended to the end of the queue like
 *     any other job, so it only runs once every already-queued/running request has
 *     been serviced -- never jumps ahead of them.
 *   - "dedupe if one is already queued": `checkFileChangeRequestId` tracks whether a
 *     check is currently outstanding (queued or running); `requestCheckFileChange()`
 *     is a no-op while one is, so fs.watch firing spuriously and/or a poll tick
 *     landing before the previous check's response comes back never queues more than
 *     one.
 * The corresponding `elog/checkChanges` JSON-RPC method (for a UI "refresh" button)
 * needs none of this bookkeeping: it's just another entry in `ElogMethods`, handled
 * by the generic per-method loop below like any other request -- routed through
 * `callEngine()`, which always allocates a fresh id and never dedupes (a user asking
 * to refresh should always get a real round trip, even if a background check happens
 * to be outstanding at the same moment).
 */

import { isMainThread, Worker } from 'node:worker_threads';
import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter, type CancellationToken } from 'vscode-jsonrpc/node';
import { ElogMethods, ElogNotifications, type ElogChangedParams, type ElogProgressParams, type OpenParams } from '@omnetpp/shared/elog-protocol';
import { maybeStartEngineThread } from './engineThread';
import type { CancelMessage, EngineToMainMessage, JobMessage } from './workerMessages';
import { watchFile, type FileWatcher } from './watcher';

// Runs (harmlessly no-ops) on every thread that executes this bundle -- see this
// file's header. Must run unconditionally, before the `isMainThread` branch below,
// so the engine worker_thread's copy of this module actually starts the engine.
maybeStartEngineThread();

if (isMainThread) runMain();

function runMain(): void {
  const worker = new Worker(__filename, { workerData: { role: 'engine' } });

  const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

  let nextJobId = 1;
  const pendingResolvers = new Map<number, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();
  const pendingCancelDisposables = new Map<number, { dispose(): void }>();

  let openPath: string | null = null;
  let watcher: FileWatcher | null = null;

  // Phase E9: id of the currently-outstanding (queued or running) internal
  // `elog/checkChanges` job the watcher triggered, or `null` if none -- see this
  // file's header. Deliberately untracked in `pendingResolvers` (fire-and-forget: no
  // caller is awaiting it), so its eventual `response` message is simply dropped by
  // the "response for an id we've already stopped tracking" branch below, same as any
  // other response nobody is listening for.
  let checkFileChangeRequestId: number | null = null;

  function requestCheckFileChange(): void {
    if (openPath === null || checkFileChangeRequestId !== null) return;
    const id = nextJobId++;
    checkFileChangeRequestId = id;
    const cancelBuffer = new SharedArrayBuffer(4); // never signaled -- this internal check is never cancelled
    const jobMessage: JobMessage = { kind: 'job', id, method: ElogMethods.checkChanges, params: undefined, cancelBuffer };
    worker.postMessage(jobMessage);
  }

  worker.on('message', (message: EngineToMainMessage) => {
    switch (message.kind) {
      case 'response': {
        const id = message.id as number;
        if (id === checkFileChangeRequestId) checkFileChangeRequestId = null;
        const resolver = pendingResolvers.get(id);
        pendingResolvers.delete(id);
        pendingCancelDisposables.get(id)?.dispose();
        pendingCancelDisposables.delete(id);
        if (resolver === undefined) return; // response for an id we've already stopped tracking (e.g. late reply after a drop, or the internal checkFileChange job above)
        if (message.error !== undefined) resolver.reject(new ResponseError(message.error.code, message.error.message, message.error.data));
        else resolver.resolve(message.result);
        break;
      }
      case 'progress': {
        const params: ElogProgressParams = { requestId: message.id };
        void connection.sendNotification(ElogNotifications.progress, params);
        break;
      }
      case 'changed': {
        const params: ElogChangedParams = { change: message.change, summary: message.summary };
        void connection.sendNotification(ElogNotifications.changed, params);
        break;
      }
    }
  });

  function callEngine(method: string, params: unknown, token: CancellationToken): Promise<unknown> {
    const id = nextJobId++;
    const cancelBuffer = new SharedArrayBuffer(4);
    const cancelFlag = new Int32Array(cancelBuffer);
    return new Promise((resolve, reject) => {
      pendingResolvers.set(id, { resolve, reject });
      pendingCancelDisposables.set(
        id,
        token.onCancellationRequested(() => {
          // The active job's own progress hook observes this flag directly (no
          // message round trip); the `cancel` message below is only needed in case
          // the job is still queued (not yet started) on the engine thread -- see
          // engineThread.ts's header.
          Atomics.store(cancelFlag, 0, 1);
          const cancelMessage: CancelMessage = { kind: 'cancel', id };
          worker.postMessage(cancelMessage);
        }),
      );
      const jobMessage: JobMessage = { kind: 'job', id, method, params, cancelBuffer };
      worker.postMessage(jobMessage);
    });
  }

  for (const method of Object.values(ElogMethods)) {
    connection.onRequest(method, (params: unknown, token: CancellationToken) => {
      if (method === ElogMethods.open) {
        return callEngine(method, params, token).then((result) => {
          const openParams = params as OpenParams;
          openPath = openParams.path;
          watcher?.dispose();
          checkFileChangeRequestId = null; // any check against the previous file is now moot
          watcher = watchFile(openPath, requestCheckFileChange, { pollIntervalMs: openParams.options?.pollIntervalMs });
          return result;
        });
      }
      if (method === ElogMethods.close) {
        watcher?.dispose();
        watcher = null;
        openPath = null;
        checkFileChangeRequestId = null;
      }
      return callEngine(method, params, token);
    });
  }

  connection.onClose(() => {
    watcher?.dispose();
    void worker.terminate();
    process.exit(0);
  });

  connection.listen();
}
