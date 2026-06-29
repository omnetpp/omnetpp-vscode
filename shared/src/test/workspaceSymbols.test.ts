import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  MsgResourceCache,
  IniResourceCache,
  SymbolKind,
  workspaceSymbols,
} from '../index';

async function makeCaches() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const iniCache = new IniResourceCache();
  nedCache.addFile('file:///Net.ned', svc.parse('ned', 'simple App { }\nnetwork Net { }'), '');
  msgCache.addFile('file:///m.msg', svc.parse('msg', 'namespace demo;\nclass AppPacket { }\nenum Color { }'));
  iniCache.addFile('file:///omnetpp.ini', '[Config Run1]\nnetwork = Net\n[Config Run2]\n');
  return { nedCache, msgCache, iniCache };
}

test('workspaceSymbols enumerates NED, MSG, and INI symbols', async () => {
  const caches = await makeCaches();
  const all = workspaceSymbols('', caches);
  const names = all.map((s) => s.name).sort();
  assert.deepEqual(names, ['App', 'AppPacket', 'Color', 'Net', 'Run1', 'Run2']);

  const app = all.find((s) => s.name === 'App')!;
  assert.equal(app.kind, SymbolKind.Class);
  assert.equal(app.location.uri, 'file:///Net.ned');

  const color = all.find((s) => s.name === 'Color')!;
  assert.equal(color.kind, SymbolKind.Enum);
  assert.equal(color.containerName, 'demo');

  const run1 = all.find((s) => s.name === 'Run1')!;
  assert.equal(run1.kind, SymbolKind.Namespace);
  assert.equal(run1.location.uri, 'file:///omnetpp.ini');
});

test('workspaceSymbols filters by case-insensitive substring', async () => {
  const caches = await makeCaches();
  const hits = workspaceSymbols('app', caches).map((s) => s.name).sort();
  assert.deepEqual(hits, ['App', 'AppPacket']);

  assert.deepEqual(workspaceSymbols('run', caches).map((s) => s.name).sort(), ['Run1', 'Run2']);
  assert.equal(workspaceSymbols('zzz', caches).length, 0);
});
