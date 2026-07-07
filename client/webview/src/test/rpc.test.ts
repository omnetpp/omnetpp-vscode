import { test } from 'bun:test';
import assert from 'node:assert';
import type { WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc, RequestCancelledError } from '../eventlog/common/rpc';

function fakeTransport() {
  const sent: WebviewToHostMessage[] = [];
  return { sent, postMessage: (m: WebviewToHostMessage) => sent.push(m) };
}

test('request(): posts an engineRequest and resolves on a matching engineResponse', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const promise = rpc.request('elog/getSummary', undefined);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].type, 'engineRequest');
  const id = (transport.sent[0] as { id: number }).id;
  rpc.handleResponse({ type: 'engineResponse', id, result: { ok: true } });
  assert.deepEqual(await promise, { ok: true });
});

test('request(): rejects on an engineResponse carrying an error', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const promise = rpc.request('elog/getSummary', undefined);
  const id = (transport.sent[0] as { id: number }).id;
  rpc.handleResponse({ type: 'engineResponse', id, error: { message: 'boom' } });
  await assert.rejects(promise, /boom/);
});

test('handleResponse(): unknown id is a silent no-op (already cancelled/stray/duplicate)', () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  rpc.handleResponse({ type: 'engineResponse', id: 999, result: {} }); // must not throw
});

// ---------------------------------------------------------------------------------
// cancel() / requestCancelable() -- phase U4 real cancellation (see rpc.ts's header:
// "Known follow-up" from the U3 commit message)
// ---------------------------------------------------------------------------------

test('cancel(): rejects the pending promise with RequestCancelledError AND sends a cancelRequest to the host', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const promise = rpc.request('elog/sc/getViewport', { some: 'params' });
  const id = (transport.sent[0] as { id: number }).id;

  rpc.cancel(id);
  await assert.rejects(promise, RequestCancelledError);

  const cancelMsg = transport.sent.find((m) => m.type === 'cancelRequest');
  assert.ok(cancelMsg, 'a cancelRequest message must have been sent to the host');
  assert.equal((cancelMsg as { id: number }).id, id);
});

test('cancel(): a late engineResponse for an already-cancelled id is ignored (no double-resolve)', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const promise = rpc.request('elog/sc/getViewport', {});
  const id = (transport.sent[0] as { id: number }).id;
  rpc.cancel(id);
  await assert.rejects(promise, RequestCancelledError);
  // the engine's answer arrives anyway (it kept running); must not throw or resolve anything now
  rpc.handleResponse({ type: 'engineResponse', id, result: { late: true } });
});

test('cancel(): unknown/already-resolved id is a no-op (no stray cancelRequest sent)', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const promise = rpc.request('elog/getSummary', undefined);
  const id = (transport.sent[0] as { id: number }).id;
  rpc.handleResponse({ type: 'engineResponse', id, result: {} });
  await promise;
  transport.sent.length = 0;
  rpc.cancel(id); // already resolved -- must not send a cancelRequest
  assert.equal(transport.sent.length, 0);
});

test('requestCancelable(): resolves normally when not cancelled', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const { promise } = rpc.requestCancelable<{ ok: boolean }>('elog/sc/getViewport', {});
  const id = (transport.sent[0] as { id: number }).id;
  rpc.handleResponse({ type: 'engineResponse', id, result: { ok: true } });
  assert.deepEqual(await promise, { ok: true });
});

test('requestCancelable(): its own cancel() rejects the promise and does not surface as an unhandled rejection', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const { promise, cancel } = rpc.requestCancelable('elog/sc/getViewport', {});
  cancel();
  await assert.rejects(promise, RequestCancelledError);
});

test('dispose(): rejects every still-pending request', async () => {
  const transport = fakeTransport();
  const rpc = new EngineRpc(transport);
  const p1 = rpc.request('a', undefined);
  const p2 = rpc.request('b', undefined);
  rpc.dispose();
  await assert.rejects(p1);
  await assert.rejects(p2);
});
