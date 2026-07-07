import type { HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';

/** What a webview app needs from `acquireVsCodeApi()` to send messages -- kept minimal so tests can supply a fake. */
export interface RpcTransport {
  postMessage(message: WebviewToHostMessage): void;
}

/** Rejection reason for a request cancelled via `EngineRpc.cancel()`/`requestCancelable()`'s returned `cancel()` -- lets callers (`renderModelCache.ts`) tell "cancelled" apart from a real engine error via `instanceof`. */
export class RequestCancelledError extends Error {
  constructor(method: string) {
    super(`Request cancelled: ${method}`);
    this.name = 'RequestCancelledError';
  }
}

/**
 * `engineRequest`/`engineResponse` correlator (`client/webview/src/eventlog/common/
 * rpc.ts` per the port plan's "New code layout"). One instance per webview app;
 * `chartMain.ts`/`tableMain.ts` feed every incoming `engineResponse` message to
 * `handleResponse()` and call `request()` to issue a proxied `elogProtocol.ts` call.
 *
 * PHASE U4 ("Known follow-up" from the U3 commit message): `cancel()` now sends a
 * `cancelRequest` message to the host (`sequenceChartEditor.ts`'s message pump turns
 * this into a real `vscode.CancellationTokenSource.cancel()` against the pending
 * `WorkerClient` call, which `vscode-jsonrpc` turns into an actual `$/cancelRequest`
 * notification to the worker -- the worker's `engineThread.ts` already honors this via
 * its `progress()`-hook cancellation checks, verified in phase E8, ~60ms turnaround),
 * not just a local no-op. `requestCancelable()` is the variant callers that need to
 * actually cancel a specific in-flight request (as opposed to merely ignoring its
 * eventual answer) should use -- see `renderModelCache.ts`'s `EngineViewportSource`.
 */
export class EngineRpc {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

  constructor(private readonly transport: RpcTransport) {}

  request<TResult = unknown>(method: string, params: unknown): Promise<TResult> {
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.transport.postMessage({ type: 'engineRequest', id, method, params });
    });
  }

  /** Like `request()`, but also returns a `cancel()` that actually asks the host/engine to abandon the job (see this class's header) -- for callers that track a specific in-flight request and may need to reclaim its engine-side work, not just ignore its answer. */
  requestCancelable<TResult = unknown>(method: string, params: unknown): { promise: Promise<TResult>; cancel: () => void } {
    const id = this.nextId++;
    const promise = new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.transport.postMessage({ type: 'engineRequest', id, method, params });
    });
    // A cancelled request's promise rejection must never surface as an unhandled
    // rejection just because a caller only cares about `cancel()`, not the promise.
    promise.catch(() => {});
    return { promise, cancel: () => this.cancel(id) };
  }

  /** Feed every `engineResponse` message the webview receives to this. No-ops for an id it doesn't know (already cancelled, or a stray/duplicate). */
  handleResponse(message: Extract<HostToWebviewMessage, { type: 'engineResponse' }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  /** Rejects the pending request (with `RequestCancelledError`) AND notifies the host so it can actually cancel the underlying engine job -- see this class's header. No-op if `id` already resolved/rejected/was never pending. */
  cancel(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(new RequestCancelledError(pending.method));
    this.transport.postMessage({ type: 'cancelRequest', id });
  }

  /** Rejects every still-pending request (e.g. on a hard reset/reload). */
  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('EngineRpc disposed'));
    this.pending.clear();
  }
}
