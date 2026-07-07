import { test } from 'bun:test';
import assert from 'node:assert';
import { classifyEngineError } from '../eventlog/common/notificationOverlay';
import { RequestCancelledError } from '../eventlog/common/rpc';

test('classifyEngineError: a bare RequestCancelledError (our own superseded fetch) stays silent', () => {
  const err = new RequestCancelledError('elog/sc/getViewport');
  assert.strictEqual(classifyEngineError(err), null);
});

test('classifyEngineError: a RequestCancelledError marked userCanceled surfaces the "canceled" screen', () => {
  const err = new RequestCancelledError('elog/setFilter');
  const state = classifyEngineError(err, { userCanceled: true });
  assert.ok(state);
  assert.strictEqual(state!.kind, 'canceled');
  assert.ok(!state!.details, 'a cancellation has nothing extra to show in a Details expander');
});

test('classifyEngineError: a ContentChanged-worded message (the automatic single retry also failed) routes to "outOfSync"', () => {
  const err = new Error('eventlog file changed (overwritten)');
  const state = classifyEngineError(err);
  assert.ok(state);
  assert.strictEqual(state!.kind, 'outOfSync');
  assert.match(state!.message, /file changed/i);
  assert.strictEqual(state!.details, 'eventlog file changed (overwritten)');
});

test('classifyEngineError: a ContentChanged-worded message for an appended change also routes to "outOfSync"', () => {
  const state = classifyEngineError(new Error('eventlog file changed (appended)'));
  assert.strictEqual(state?.kind, 'outOfSync');
});

test('classifyEngineError: any other Error is an unexpected "error", with the raw message carried as details', () => {
  const err = new Error('ENOENT: no such file or directory');
  const state = classifyEngineError(err);
  assert.ok(state);
  assert.strictEqual(state!.kind, 'error');
  assert.strictEqual(state!.details, 'ENOENT: no such file or directory');
});

test('classifyEngineError: a non-Error thrown value (string/other) is still classified defensively, never throws', () => {
  const state = classifyEngineError('a plain string rejection');
  assert.strictEqual(state?.kind, 'error');
  assert.strictEqual(state?.details, 'a plain string rejection');
});

test('classifyEngineError: userCanceled has no effect on a non-cancellation error (still classified by its own content)', () => {
  const state = classifyEngineError(new Error('eventlog file changed (appended)'), { userCanceled: true });
  assert.strictEqual(state?.kind, 'outOfSync');
});
