import { test } from 'bun:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { createNodeIconProvider } from '@omnetpp/shared/node';
import { resolveCompletionItem } from '../features/completionResolve';

// Exercises the completionItem/resolve handler end to end against a small
// fixture icon directory: a nedDisplayIcon-tagged item (set by
// shared/src/ned/displayString.ts's displayCompletions for i=/i2=/bgi=
// candidates) must come back with an embedded data:image/... preview; any
// other item must pass through unchanged.

function fixtureProvider() {
  const dir = mkdtempSync(join(tmpdir(), 'completion-resolve-'));
  writeFileSync(join(dir, 'device.png'), 'fake-png-bytes');
  const icons = createNodeIconProvider({ iconDirs: [dir], emit: 'embed' });
  return { dir, icons };
}

test('completionResolve: embeds a data:image/png;base64,... preview for a nedDisplayIcon item', async () => {
  const { dir, icons } = fixtureProvider();
  try {
    const item = {
      label: 'device',
      kind: CompletionItemKind.Value,
      data: { kind: 'nedDisplayIcon', iconId: 'device' },
    };
    const resolved = await resolveCompletionItem(item, icons);
    assert.ok(resolved.documentation, 'expected documentation to be set');
    const doc = resolved.documentation as { kind: string; value: string };
    assert.equal(doc.kind, 'markdown');
    assert.ok(doc.value.includes('data:image/png;base64,'), doc.value);
    assert.ok(doc.value.includes('device'), doc.value);
    // the rest of the item survives untouched
    assert.equal(resolved.label, 'device');
    assert.equal(resolved.kind, CompletionItemKind.Value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completionResolve: passes an item without nedDisplayIcon data through unchanged', async () => {
  const { dir, icons } = fixtureProvider();
  try {
    const item = { label: 'row', kind: CompletionItemKind.Property, detail: 'p — arrangement' };
    const resolved = await resolveCompletionItem(item, icons);
    assert.deepStrictEqual(resolved, item);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completionResolve: passes an item with an unrelated data shape through unchanged', async () => {
  const { dir, icons } = fixtureProvider();
  try {
    const item = { label: 'foo', kind: CompletionItemKind.Field, data: { kind: 'somethingElse' } };
    const resolved = await resolveCompletionItem(item, icons);
    assert.deepStrictEqual(resolved, item);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completionResolve: an unresolvable icon id still falls back gracefully (provider default icon)', async () => {
  const { dir, icons } = fixtureProvider();
  try {
    // createNodeIconProvider falls back to its built-in _internal/unknown icon
    // rather than returning undefined, so this still gets a preview — assert
    // the handler doesn't throw and still returns a well-formed item either way.
    const item = { label: 'missing', kind: CompletionItemKind.Value, data: { kind: 'nedDisplayIcon', iconId: 'missing' } };
    const resolved = await resolveCompletionItem(item, icons);
    assert.equal(resolved.label, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
