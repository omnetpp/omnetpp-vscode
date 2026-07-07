import type { HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';

/** What a webview app needs from `acquireVsCodeApi()` to send messages -- kept minimal so tests can supply a fake. */
export interface RpcTransport {
  postMessage(message: WebviewToHostMessage): void;
}

/**
 * Tiny `engineRequest`/`engineResponse` correlator (`client/webview/src/
 * eventlog/common/rpc.ts` per the port plan's "New code layout"). One
 * instance per webview app; `chartMain.ts`/`tableMain.ts` feed every incoming
 * `engineResponse` message to `handleResponse()` and call `request()` to issue
 * a proxied `elogProtocol.ts` call.
 *
 * The `cancel()` stub only drops the local pending entry (so a superseded
 * request's eventual response is silently ignored) -- it does NOT yet ask the
 * host to `$/cancelRequest` the in-flight engine job. Real cancellation
 * (`CancellationToken` plumbed through `engineRequest`) is a U3/U4 concern
 * (long-running viewport/filter jobs); U1 has no long-running requests on the
 * hot path yet (`getSummary`/`checkChanges`/`gotoEvent` are all fast engine
 * calls), so the stub is enough to keep the call sites future-proof.
 */
export class EngineRpc {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

  constructor(private readonly transport: RpcTransport) {}

  request<TResult = unknown>(method: string, params: unknown): Promise<TResult> {
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.transport.postMessage({ type: 'engineRequest', id, method, params });
    });
  }

  /** Feed every `engineResponse` message the webview receives to this. No-ops for an id it doesn't know (already cancelled, or a stray/duplicate). */
  handleResponse(message: Extract<HostToWebviewMessage, { type: 'engineResponse' }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  /** Cancellation stub -- see this class's header. */
  cancel(id: number): void {
    this.pending.delete(id);
  }

  /** Rejects every still-pending request (e.g. on a hard reset/reload). */
  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('EngineRpc disposed'));
    this.pending.clear();
  }
}
