import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  IniResourceCache,
  SemanticDatabase,
  impactOf,
  nedTypeSym,
} from '../index';

test('impactOf walks the transitive reverse-dependency closure', async () => {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const iniCache = new IniResourceCache();
  const db = new SemanticDatabase(nedCache, new MsgResourceCache(), new ConfigRegistry(), iniCache);
  const addNed = (uri: string, text: string) => {
    nedCache.addFile(uri, svc.parse('ned', text), '');
    db.onNedFile(uri);
  };
  addNed('file:///Base.ned', 'simple Base { }');
  addNed('file:///Mid.ned', 'simple Mid extends Base { }');
  addNed('file:///Leaf.ned', 'simple Leaf extends Mid { }');
  addNed('file:///Net.ned', 'network Net { submodules: l: Leaf; }');
  iniCache.addFile('file:///omnetpp.ini', '[Config R]\nnetwork = Net\n');
  db.onIniFile('file:///omnetpp.ini');

  const impact = impactOf(db, nedTypeSym('Base'));
  const byName = new Map(impact.map((n) => [n.name, n]));

  assert.deepEqual([...byName.keys()].sort(), ['Config R', 'Leaf', 'Mid', 'Net'].sort());
  assert.equal(byName.get('Mid')!.depth, 1);
  assert.equal(byName.get('Mid')!.via, 'extends');
  assert.equal(byName.get('Leaf')!.depth, 2);
  assert.equal(byName.get('Net')!.depth, 3);
  assert.equal(byName.get('Net')!.via, 'submodule-type');
  assert.equal(byName.get('Config R')!.depth, 4);
  assert.equal(byName.get('Config R')!.via, 'ini-network');
  assert.equal(byName.get('Config R')!.lang, 'ini');

  // maxDepth bounds the walk
  const shallow = impactOf(db, nedTypeSym('Base'), { maxDepth: 1 });
  assert.deepEqual(shallow.map((n) => n.name), ['Mid']);
});
