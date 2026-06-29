import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  IniResourceCache,
  SemanticDatabase,
  XrefIndex,
  nedTypeSym,
  nedMemberSym,
  parseSymbolId,
} from '../index';
import type { XrefEdge, Location, ParserService } from '../index';

/** Build a cache + database with a helper that mirrors ProjectIndex's add flow. */
async function makeDb(): Promise<{
  svc: ParserService;
  cache: NedResourceCache;
  db: SemanticDatabase;
  add: (uri: string, text: string, pkg?: string) => void;
  remove: (uri: string) => void;
}> {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  const db = new SemanticDatabase(cache, new MsgResourceCache(), new ConfigRegistry(), new IniResourceCache());
  const add = (uri: string, text: string, pkg = '') => {
    cache.addFile(uri, svc.parse('ned', text), pkg);
    db.onNedFile(uri);
  };
  const remove = (uri: string) => {
    cache.removeFile(uri);
    db.dropFile(uri);
  };
  add(BUILTIN_URI, BUILTIN_NED_TEXT, 'ned');
  return { svc, cache, db, add, remove };
}

const locKey = (l: Location) => `${l.uri}:${l.range.start.line}:${l.range.start.character}`;
const locSet = (ls: Location[]) => ls.map(locKey).sort();

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

test('index-backed findSubtypes / findTypeUsages match the cache walkers', async () => {
  const { cache, db, add } = await makeDb();
  add('file:///Host.ned', 'simple Host { }');
  add('file:///Server.ned', 'simple Server extends Host { }');
  add('file:///Net.ned', 'network Net { submodules: h: Host; }');

  assert.deepEqual(
    db.findSubtypes('Host', { direct: true }).map((t) => t.fqName).sort(),
    cache.directSubtypesOf('Host').map((t) => t.fqName).sort(),
  );
  assert.deepEqual(
    db.findSubtypes('Host').map((t) => t.fqName).sort(),
    cache.subtypesOf('Host').map((t) => t.fqName).sort(),
  );

  const usages = db.findTypeUsages('Host');
  // referenced by `extends Host` and submodule `h: Host`
  assert.equal(locSet(usages).length, locSet(db.findTypeUsagesByWalk('Host')).length);
  assert.ok(usages.some((u) => u.uri === 'file:///Net.ned'));
  assert.ok(usages.some((u) => u.uri === 'file:///Server.ned'));
});

test('indexed type usages match the walker across a multi-file project', async () => {
  const { cache, db, add } = await makeDb();
  add('file:///Base.ned', 'package p;\nmoduleinterface IApp { }\nsimple Base { }', 'p');
  add('file:///App.ned', 'package p;\nsimple App extends Base like IApp { }', 'p');
  add('file:///Chan.ned', 'package p;\nchannel C extends ned.DelayChannel { }', 'p');
  add(
    'file:///Net.ned',
    'package p;\nimport p.App;\nnetwork Net {\n submodules:\n  a: App;\n  b: Base;\n connections:\n  a.g++ --> C --> b.g++;\n}',
    'p',
  );

  for (const fq of ['p.Base', 'p.IApp', 'p.App', 'p.C', 'ned.DelayChannel']) {
    assert.deepEqual(
      locSet(db.findTypeUsages(fq)),
      locSet(db.findTypeUsagesByWalk(fq)),
      `usages mismatch for ${fq}`,
    );
  }
  // direct subtypes parity
  assert.deepEqual(
    db.findDirectSubtypesIndexed('p.Base').map((t) => t.fqName).sort(),
    cache.directSubtypesOf('p.Base').map((t) => t.fqName).sort(),
  );
});

test('forward reference resolves when the target file is added later (drain)', async () => {
  const { db, add } = await makeDb();
  // referencing file added BEFORE its target exists
  add('file:///Net.ned', 'network Net { submodules: h: Host; }');
  assert.equal(db.findTypeUsages('Host').length, 0, 'no target yet');

  add('file:///Host.ned', 'simple Host { }');
  assert.equal(db.findTypeUsages('Host').length, 1, 'drained on target add');
  assert.deepEqual(locSet(db.findTypeUsages("Host")), locSet(db.findTypeUsagesByWalk("Host")));
});

test('dropping a target demotes dependents; re-adding restores them', async () => {
  const { db, add, remove } = await makeDb();
  add('file:///Host.ned', 'simple Host { }');
  add('file:///A.ned', 'simple A extends Host { }');
  add('file:///B.ned', 'network N { submodules: h: Host; }');
  assert.equal(db.findTypeUsages('Host').length, 2);

  remove('file:///Host.ned');
  assert.equal(db.findTypeUsages('Host').length, 0, 'dependents demoted to pending');

  add('file:///Host.ned', 'simple Host { }');
  assert.equal(db.findTypeUsages('Host').length, 2, 'restored on re-add');
});

test('renaming a type leaves stale references unresolved', async () => {
  const { db, add } = await makeDb();
  add('file:///Host.ned', 'simple Host { }');
  add('file:///A.ned', 'simple A extends Host { }');
  assert.equal(db.findTypeUsages('Host').length, 1);

  // rewrite Host.ned to declare a differently-named type
  add('file:///Host.ned', 'simple Hoster { }');
  assert.equal(db.findTypeUsages('Host').length, 0, 'old name no longer declared');
  assert.equal(db.findTypeUsages('Hoster').length, 0, 'A still references Host, not Hoster');
});

test('editing a referencing file does not re-walk unrelated files', async () => {
  const { db, add } = await makeDb();
  add('file:///Host.ned', 'simple Host { }');
  add('file:///A.ned', 'simple A extends Host { }');
  add('file:///B.ned', 'simple B extends Host { }');
  assert.equal(db.findTypeUsages('Host').length, 2);

  // edit A to stop referencing Host
  add('file:///A.ned', 'simple A { }');
  assert.deepEqual(locSet(db.findTypeUsages("Host")), locSet(db.findTypeUsagesByWalk("Host")));
  assert.equal(db.findTypeUsages('Host').length, 1, 'only B references Host now');
});
