import { test } from 'bun:test';
import assert from 'node:assert';
import { resolveInstallDir } from '../protocol';

test('resolveInstallDir: the setting wins over the environment', () => {
  assert.strictEqual(resolveInstallDir('/opt/omnetpp', { OMNETPP_ROOT: '/env/omnetpp' }), '/opt/omnetpp');
});

test('resolveInstallDir: an empty setting falls back to OMNETPP_ROOT, then __omnetpp_root_dir', () => {
  assert.strictEqual(resolveInstallDir('', { OMNETPP_ROOT: '/a', __omnetpp_root_dir: '/b' }), '/a');
  assert.strictEqual(resolveInstallDir(undefined, { __omnetpp_root_dir: '/b' }), '/b');
  assert.strictEqual(resolveInstallDir('', {}), '');
});
