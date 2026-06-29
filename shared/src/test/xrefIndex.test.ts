import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  SemanticDatabase,
  XrefIndex,
  nedTypeSym,
  nedMemberSym,
  parseSymbolId,
} from '../index';
import type { XrefEdge } from '../index';

test('SymbolId constructors round-trip through parseSymbolId', () => {
  const ned = nedTypeSym('inet.Host');
  assert.deepEqual(parseSymbolId(ned), { lang: 'ned', fqName: 'inet.Host' });

  const mem = nedMemberSym({ kind: 'param', ownerFq: 'inet.Host', name: 'numApps' });
  assert.deepEqual(parseSymbolId(mem), {
    lang: 'nedmem',
    member: { kind: 'param', ownerFq: 'inet.Host', name: 'numApps' },
  });
});

function edge(from: string, to: string | null, rawTarget: string): XrefEdge {
  return {
    kind: 'submodule-type',
    from: nedTypeSym(from),
    to: to ? nedTypeSym(to) : null,
    rawTarget,
    src: { uri: `file:///${from}.ned`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    originUri: `file:///${from}.ned`,
    unresolved: !to,
  };
}

test('XrefIndex maintains reverse edges and drops them per file', () => {
  const idx = new XrefIndex();
  idx.addEdge('file:///A.ned', edge('A', 'Host', 'Host'));
  idx.addEdge('file:///B.ned', edge('B', 'Host', 'Host'));

  const inbound = idx.inboundOf(nedTypeSym('Host'));
  assert.equal(inbound.length, 2);
  assert.deepEqual(
    inbound.map((e) => e.from).sort(),
    [nedTypeSym('A'), nedTypeSym('B')].sort(),
  );

  idx.dropFile('file:///A.ned');
  assert.equal(idx.inboundOf(nedTypeSym('Host')).length, 1);
});

test('XrefIndex buckets unresolved edges by simple name for drain', () => {
  const idx = new XrefIndex();
  idx.addEdge('file:///A.ned', edge('A', null, 'pkg.Mobility'));
  const pending = idx.pendingForName('Mobility');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rawTarget, 'pkg.Mobility');
  // resolved targets are not in the pending buckets
  assert.equal(idx.pendingForName('Host').length, 0);
});

test('SemanticDatabase delegates findSubtypes / findTypeUsages to the caches', async () => {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///Host.ned', svc.parse('ned', 'simple Host { }'), '');
  nedCache.addFile('file:///Server.ned', svc.parse('ned', 'simple Server extends Host { }'), '');
  nedCache.addFile('file:///Net.ned', svc.parse('ned', 'network Net { submodules: h: Host; }'), '');

  const db = new SemanticDatabase(nedCache, new MsgResourceCache(), new ConfigRegistry());

  assert.deepEqual(
    db.findSubtypes('Host', { direct: true }).map((t) => t.fqName),
    nedCache.directSubtypesOf('Host').map((t) => t.fqName),
  );

  const usages = db.findTypeUsages('Host');
  // referenced by `extends Host` and submodule `h: Host`
  assert.ok(usages.length >= 2, `expected >=2 Host usages, got ${usages.length}`);
  assert.ok(usages.some((u) => u.uri === 'file:///Net.ned'));
  assert.ok(usages.some((u) => u.uri === 'file:///Server.ned'));
});
