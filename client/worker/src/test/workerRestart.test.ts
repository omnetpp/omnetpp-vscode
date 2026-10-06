import { afterAll, test } from 'bun:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerClient, type StoppedEvent } from '../../../src/eventlog/workerClient';

// Fake worker bundles: each start announces itself on stderr, then dies.
const dir = mkdtempSync(join(tmpdir(), 'opp-worker-restart-'));
const CRASHES_AT_ONCE = join(dir, 'crashAtOnce.js');
writeFileSync(CRASHES_AT_ONCE, "process.stderr.write('up\\n'); process.exit(1);\n");
const CRASHES_LATER = join(dir, 'crashLater.js');
writeFileSync(CRASHES_LATER, "process.stderr.write('up\\n'); setTimeout(() => process.exit(1), 150);\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function track(client: WorkerClient): { starts: () => number; stopped: Promise<StoppedEvent> } {
  let err = '';
  client.onStderr((chunk) => (err += chunk));
  const stopped = new Promise<StoppedEvent>((resolve) => client.onStopped(resolve));
  return { starts: () => err.split('up\n').length - 1, stopped };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a worker that keeps crashing is respawned maxRestarts times, then stopped', async () => {
  const client = new WorkerClient(CRASHES_AT_ONCE, { restartBackoffMs: [5], maxRestarts: 3, stableAfterMs: 60_000 });
  const { starts, stopped } = track(client);
  const e = await Promise.race([stopped, sleep(3000).then(() => undefined)]);
  assert.deepEqual(e, { crashes: 4 });
  await sleep(300);
  assert.equal(starts(), 4, 'the initial start plus 3 respawns, nothing after the stop');
  await assert.rejects(client.getSummary(), /stopped after 4 consecutive crashes/);
  client.dispose();
});

test('a crash after the worker ran stableAfterMs starts a new count', async () => {
  const client = new WorkerClient(CRASHES_LATER, { restartBackoffMs: [5], maxRestarts: 1, stableAfterMs: 50 });
  const { starts, stopped } = track(client);
  let wasStopped = false;
  void stopped.then(() => (wasStopped = true));
  for (let i = 0; i < 40 && starts() < 4; i++) await sleep(50);
  client.dispose();
  assert.ok(starts() >= 4, `expected repeated recoveries, got ${starts()} start(s)`);
  assert.equal(wasStopped, false);
});
