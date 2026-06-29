import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  IniResourceCache,
  SemanticDatabase,
  msgTypeSym,
  iniSectionSym,
} from '../index';
import type { Location, ParserService } from '../index';

/** A db wired over all three caches, mirroring ProjectIndex's add flow. */
async function makeDb(): Promise<{
  svc: ParserService;
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  iniCache: IniResourceCache;
  db: SemanticDatabase;
  addNed: (uri: string, text: string, pkg?: string) => void;
  addMsg: (uri: string, text: string) => void;
  addIni: (uri: string, text: string) => void;
  rmMsg: (uri: string) => void;
  rmNed: (uri: string) => void;
}> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const iniCache = new IniResourceCache();
  const db = new SemanticDatabase(nedCache, msgCache, new ConfigRegistry(), iniCache);
  const addNed = (uri: string, text: string, pkg = '') => {
    nedCache.addFile(uri, svc.parse('ned', text), pkg);
    db.onNedFile(uri);
  };
  const addMsg = (uri: string, text: string) => {
    msgCache.addFile(uri, svc.parse('msg', text));
    db.onMsgFile(uri);
  };
  const addIni = (uri: string, text: string) => {
    iniCache.addFile(uri, text);
    db.onIniFile(uri);
  };
  const rmMsg = (uri: string) => {
    msgCache.removeFile(uri);
    db.dropFile(uri);
  };
  const rmNed = (uri: string) => {
    nedCache.removeFile(uri);
    db.dropFile(uri);
  };
  return { svc, nedCache, msgCache, iniCache, db, addNed, addMsg, addIni, rmMsg, rmNed };
}

const locKey = (l: Location) => `${l.uri}:${l.range.start.line}:${l.range.start.character}`;
const locSet = (ls: Location[]) => ls.map(locKey).sort();

test('NED @class / @signal usages of a MSG type match the walker', async () => {
  const { db, addNed, addMsg } = await makeDb();
  addMsg('file:///msg.msg', 'namespace inet;\nclass FooPacket { }\nclass Sig { }');
  addNed(
    'file:///A.ned',
    '@namespace(inet);\nsimple A { @class(FooPacket); @signal[s](type=Sig); }',
  );
  addNed('file:///B.ned', '@namespace(inet);\nsimple B { @class(FooPacket); }');

  assert.deepEqual(
    locSet(db.findMsgUsages('inet::FooPacket')),
    locSet(db.findMsgUsagesByWalk('inet::FooPacket')),
  );
  assert.equal(db.findMsgUsages('inet::FooPacket').length, 2);
  assert.equal(db.findMsgUsages('inet::Sig').length, 1);
});

test('ned-class forward reference drains when the MSG file is added later', async () => {
  const { db, addNed, addMsg } = await makeDb();
  addNed('file:///A.ned', '@namespace(inet);\nsimple A { @class(FooPacket); }');
  assert.equal(db.findMsgUsages('inet::FooPacket').length, 0, 'no MSG target yet');

  addMsg('file:///msg.msg', 'namespace inet;\nclass FooPacket { }');
  assert.equal(db.findMsgUsages('inet::FooPacket').length, 1, 'drained on MSG add');
  assert.deepEqual(
    locSet(db.findMsgUsages('inet::FooPacket')),
    locSet(db.findMsgUsagesByWalk('inet::FooPacket')),
  );
});

test('dropping the MSG file demotes ned-class dependents; re-adding restores', async () => {
  const { db, addNed, addMsg, rmMsg } = await makeDb();
  addMsg('file:///msg.msg', 'namespace inet;\nclass FooPacket { }');
  addNed('file:///A.ned', '@namespace(inet);\nsimple A { @class(FooPacket); }');
  assert.equal(db.findMsgUsages('inet::FooPacket').length, 1);

  rmMsg('file:///msg.msg');
  assert.equal(db.findMsgUsages('inet::FooPacket').length, 0, 'demoted to pending');

  addMsg('file:///msg.msg', 'namespace inet;\nclass FooPacket { }');
  assert.equal(db.findMsgUsages('inet::FooPacket').length, 1, 'restored on re-add');
});

test('MSG subtypes come from the reverse index', async () => {
  const { db, msgCache, addMsg } = await makeDb();
  addMsg(
    'file:///msg.msg',
    'namespace inet;\nclass Base { }\nclass Mid extends Base { }\nclass Leaf extends Mid { }',
  );
  assert.deepEqual(
    db.findMsgSubtypes('inet::Base').map((t) => t.fqName).sort(),
    ['inet::Mid'],
  );
  // parity with a cache scan of direct subtypes
  const scanDirect = msgCache
    .allTypes()
    .filter((t) => t.superType()?.fqName === 'inet::Base')
    .map((t) => t.fqName)
    .sort();
  assert.deepEqual(db.findMsgSubtypes('inet::Base').map((t) => t.fqName).sort(), scanDirect);
});

test('msg-field-type edges skip primitives and resolve declared types', async () => {
  const { db, addMsg } = await makeDb();
  addMsg(
    'file:///msg.msg',
    'namespace inet;\nclass Inner { }\nclass Outer {\n int count;\n Inner payload;\n}',
  );
  // Outer references Inner via a field; primitive `int` produces no edge.
  const inbound = db.index.inboundOf(msgTypeSym('inet::Inner'));
  assert.equal(inbound.filter((e) => e.kind === 'msg-field-type').length, 1);
  assert.equal(inbound[0].from, msgTypeSym('inet::Outer'));
});

test('INI network= references a NED type; reverse query finds the config', async () => {
  const { db, addNed, addIni } = await makeDb();
  addNed('file:///Net.ned', 'network Net { }');
  addIni('file:///omnetpp.ini', '[Config Run1]\nnetwork = Net\n[Config Run2]\nnetwork = Net\n');

  const configs = db.findConfigsForNetwork('Net');
  assert.equal(configs.length, 2);
  assert.ok(configs.every((c) => c.uri === 'file:///omnetpp.ini'));
  // findTypeUsages must NOT include ini-network edges (NED type-position only)
  assert.equal(db.findTypeUsages('Net').length, 0);
});

test('INI network= forward reference drains when the NED network is added later', async () => {
  const { db, addNed, addIni } = await makeDb();
  addIni('file:///omnetpp.ini', '[Config Run1]\nnetwork = Net\n');
  assert.equal(db.findConfigsForNetwork('Net').length, 0, 'no NED network yet');

  addNed('file:///Net.ned', 'network Net { }');
  assert.equal(db.findConfigsForNetwork('Net').length, 1, 'drained on NED add');
});

test('dropping the NED network demotes ini-network dependents; re-adding restores', async () => {
  const { db, addNed, addIni, rmNed } = await makeDb();
  addNed('file:///Net.ned', 'network Net { }');
  addIni('file:///omnetpp.ini', '[Config Run1]\nnetwork = Net\n');
  assert.equal(db.findConfigsForNetwork('Net').length, 1);

  rmNed('file:///Net.ned');
  assert.equal(db.findConfigsForNetwork('Net').length, 0, 'demoted to pending');

  addNed('file:///Net.ned', 'network Net { }');
  assert.equal(db.findConfigsForNetwork('Net').length, 1, 'restored on re-add');
});

test('INI extends= links a config section to its base in the same file', async () => {
  const { db, addIni } = await makeDb();
  const uri = 'file:///omnetpp.ini';
  addIni(uri, '[Config Base]\nsim-time-limit = 1s\n[Config Run]\nextends = Base\n');
  // The Run section has an ini-extends edge resolved to the Base section symbol.
  const edges = db.index
    .inboundOf(iniSectionSym(uri, 'Config Base'))
    .filter((e) => e.kind === 'ini-extends');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, iniSectionSym(uri, 'Config Run'));
});
