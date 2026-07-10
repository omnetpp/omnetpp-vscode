import { test } from 'bun:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createNodeIconProvider, listIconIds, sniffImageSize } from '../node/docIcons';

// Exercises the Node icon provider against the real bundled icon snapshot
// (resources/icons/), the same files dist/icons ships.

const iconsDir = resolve(__dirname, '..', '..', '..', 'resources', 'icons');
const index = (JSON.parse(readFileSync(join(iconsDir, 'index.json'), 'utf8')) as {
  icons: Record<string, [number, number]>;
}).icons;

function provider(emit: 'embed' | ((abs: string, rel: string) => string) = 'embed', withIndex = true) {
  return createNodeIconProvider({ iconDirs: [iconsDir], bundledIndex: withIndex ? index : undefined, emit });
}

test('docIcons: resolves an icon with its natural size from index.json', async () => {
  const icon = await provider().get('device/pc');
  assert.ok(icon);
  assert.deepEqual([icon!.width, icon!.height], index['device/pc']);
  assert.ok(icon!.href.startsWith('data:image/png;base64,'), icon!.href.slice(0, 40));
});

test('docIcons: header sniff agrees with index.json when no index is given', async () => {
  const withIndex = await provider('embed', true).get('device/pc');
  const sniffed = await provider('embed', false).get('device/pc');
  assert.deepEqual([sniffed!.width, sniffed!.height], [withIndex!.width, withIndex!.height]);
});

test('docIcons: sized variant file is preferred over scaling', async () => {
  assert.ok(index['device/pc_s'], 'fixture assumes device/pc_s exists');
  const icon = await provider().get('device/pc', 's');
  assert.deepEqual([icon!.width, icon!.height], index['device/pc_s']);
});

test('docIcons: size suffix falls back to scaling the base icon', async () => {
  // _internal/default has no sized variants in the snapshot
  assert.ok(!index['_internal/default_s'], 'fixture assumes no _internal/default_s');
  const base = await provider().get('_internal/default');
  const small = await provider().get('_internal/default', 's');
  assert.equal(small!.width, Math.max(1, Math.round(base!.width * 0.6)));
  assert.equal(small!.height, Math.max(1, Math.round(base!.height * 0.6)));
});

test('docIcons: unknown ids fall back to _internal/unknown; .. is rejected', async () => {
  const p = provider();
  const unknown = await p.get('no/such/icon');
  const internal = await p.get('_internal/unknown');
  assert.ok(unknown);
  assert.equal(unknown!.href, internal!.href);
  const escape = await p.get('../../etc/passwd');
  assert.equal(escape!.href, internal!.href); // rejected id also falls back
});

test('docIcons: tint is passed through for the renderer, color normalized', async () => {
  const icon = await provider().get('device/pc', undefined, 'red', 50);
  assert.deepEqual(icon!.tint, { color: '#ff0000', pct: 50 });
  const untinted = await provider().get('device/pc');
  assert.equal(untinted!.tint, undefined);
});

test('docIcons: emit callback runs once per file and controls hrefs', async () => {
  const calls: string[] = [];
  const p = provider((abs, rel) => {
    calls.push(rel);
    return `icons/${rel}`;
  });
  const a = await p.get('device/pc');
  const b = await p.get('device/pc', undefined, 'blue', 30); // same file, tinted
  assert.equal(a!.href, 'icons/device/pc.png');
  assert.equal(b!.href, 'icons/device/pc.png');
  assert.deepEqual(calls, ['device/pc.png']);
});

test('docIcons: sniffImageSize parses PNG and GIF headers', () => {
  const png = readFileSync(join(iconsDir, 'device', 'pc.png'));
  assert.deepEqual(sniffImageSize(png), index['device/pc']);
  assert.equal(sniffImageSize(new Uint8Array([1, 2, 3])), undefined);
  // minimal GIF header: GIF89a, 7x9 logical screen
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 7, 0, 9, 0, 0]);
  assert.deepEqual(sniffImageSize(gif), [7, 9]);
});

test('listIconIds: enumerates the real bundled snapshot, including subdirectory-prefixed ids', () => {
  const ids = listIconIds([iconsDir]);
  assert.ok(ids.includes('device/pc'), 'expected a subdirectory-prefixed id, got none matching device/pc');
  assert.ok(ids.includes('maps/world'), 'expected maps/world (maps/ category used by bgi= restriction)');
  assert.deepEqual(ids, [...ids].sort(), 'result must be sorted');
  assert.equal(new Set(ids).size, ids.length, 'result must be deduped');
  // _internal/* are this module's own fallback icons (e.g. _internal/unknown),
  // not real OMNeT++ icons a user would reference — must not leak into completion.
  assert.ok(!ids.some((id) => id.startsWith('_internal')), '_internal/* must be excluded');
});

test('listIconIds: basic enumeration + .gif recognized alongside .png, using a fixture dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docicons-'));
  try {
    mkdirSync(join(dir, 'maps'), { recursive: true });
    writeFileSync(join(dir, 'alpha.png'), 'x');
    writeFileSync(join(dir, 'beta.gif'), 'x');
    writeFileSync(join(dir, 'notanicon.txt'), 'x');
    writeFileSync(join(dir, 'maps', 'city.png'), 'x');
    assert.deepEqual(listIconIds([dir]), ['alpha', 'beta', 'maps/city']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listIconIds: dedup by search-root precedence — first root shadows later ones with the same id', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'docicons-project-'));
  const bundledDir = mkdtempSync(join(tmpdir(), 'docicons-bundled-'));
  try {
    writeFileSync(join(projectDir, 'device_pc.png'), 'project-version');
    writeFileSync(join(bundledDir, 'device_pc.png'), 'bundled-version');
    writeFileSync(join(bundledDir, 'only_bundled.png'), 'x');
    // projectDir listed first: its id list wins for shared ids, but ids unique
    // to a later root are still included.
    assert.deepEqual(listIconIds([projectDir, bundledDir]), ['device_pc', 'only_bundled']);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  }
});

test('listIconIds: nonexistent root is skipped without throwing', () => {
  assert.deepEqual(listIconIds([join(iconsDir, 'no-such-dir')]), []);
});
