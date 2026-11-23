import { afterEach, test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLAIM_STALE_MS, claimOnce } from '../node/runOnce';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-once-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

test('claimOnce gives a task to the first claimant only', () => {
  const dir = tempDir();
  assert.equal(claimOnce(dir, 'update-1.1.0'), true);
  assert.equal(claimOnce(dir, 'update-1.1.0'), false);
  assert.equal(claimOnce(dir, 'update-1.2.0'), true);
});

test('claimOnce creates the folder', () => {
  const dir = path.join(tempDir(), 'globalStorage', 'omnetpp');
  assert.equal(claimOnce(dir, 'update-1.1.0'), true);
  assert.equal(claimOnce(dir, 'update-1.1.0'), false);
});

test('claimOnce takes over a stale claim', () => {
  const dir = tempDir();
  assert.equal(claimOnce(dir, 'update-1.1.0'), true);
  assert.equal(claimOnce(dir, 'update-1.1.0', Date.now() + CLAIM_STALE_MS + 1000), true);
  assert.equal(claimOnce(dir, 'update-1.1.0'), false);
});

test('claimOnce fails open when the folder cannot be created', () => {
  const file = path.join(tempDir(), 'not-a-folder');
  fs.writeFileSync(file, '');
  assert.equal(claimOnce(path.join(file, 'sub'), 'update-1.1.0'), true);
});
