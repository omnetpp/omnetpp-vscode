import { test } from 'bun:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NEDDOC_MANIFEST, NeddocOutputTracker } from '../node/neddocOutput';

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'neddoc-out-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir: string, files: string[], complete = true): string[] {
  const tracker = new NeddocOutputTracker(dir);
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), 'x');
    tracker.record(f);
  }
  return tracker.finish(complete);
}

const listed = (dir: string) =>
  readFileSync(join(dir, NEDDOC_MANIFEST), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));

test('NeddocOutputTracker: removes the files of the previous run that are not written again', () =>
  withDir((dir) => {
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    assert.deepEqual(run(dir, ['index.html', 'types/a.Old.html', 'types/b.Keep.html', 'files/x.ned.html']), []);
    assert.deepEqual(listed(dir), ['files/x.ned.html', 'index.html', 'types/a.Old.html', 'types/b.Keep.html']);

    assert.deepEqual(run(dir, ['index.html', 'types/b.Keep.html']).sort(), ['files/x.ned.html', 'types/a.Old.html']);
    assert.ok(!existsSync(join(dir, 'types/a.Old.html')));
    assert.ok(!existsSync(join(dir, 'files')), 'emptied folder removed');
    assert.ok(existsSync(join(dir, 'types/b.Keep.html')));
    assert.ok(existsSync(join(dir, 'notes.txt')), 'files the generator did not write stay');
    assert.deepEqual(listed(dir), ['index.html', 'types/b.Keep.html']);
  }));

test('NeddocOutputTracker: a failed run deletes nothing and keeps listing the old files', () =>
  withDir((dir) => {
    run(dir, ['index.html', 'types/a.Old.html']);
    assert.deepEqual(run(dir, ['index.html', 'types/c.New.html'], false), []);
    assert.ok(existsSync(join(dir, 'types/a.Old.html')));
    assert.deepEqual(listed(dir), ['index.html', 'types/a.Old.html', 'types/c.New.html']);
    // the next complete run cleans up both
    assert.deepEqual(run(dir, ['index.html']).sort(), ['types/a.Old.html', 'types/c.New.html']);
  }));

test('NeddocOutputTracker: manifest lines that leave the folder are ignored', () =>
  withDir((dir) => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'keep');
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, NEDDOC_MANIFEST), `../outside.txt\n${outside}\nsub/../../outside.txt\n${NEDDOC_MANIFEST}\n`);
    assert.deepEqual(run(out, ['index.html']), []);
    assert.ok(existsSync(outside));
    assert.ok(existsSync(join(out, NEDDOC_MANIFEST)));
  }));
