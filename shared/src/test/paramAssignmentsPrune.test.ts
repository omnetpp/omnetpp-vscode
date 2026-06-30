import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  IniResourceCache,
  SemanticDatabase,
  findParamAssignments,
  paramContainerSimpleNames,
} from '../index';

const NED = `
moduleinterface IMod { gates: input in; }
simple App like IMod { gates: input in; parameters: int p = default(0); }
simple SubApp extends App { }
module Host { gates: input in; submodules: app: App; connections: app.in <-- in; }
module BaseNet { submodules: host: Host; }
network DerivedNet extends BaseNet { }
network Net { submodules: host: Host; s: SubApp; m: <> like IMod; }
network HostNet { submodules: h: <> like IMod; }
network NoApp { submodules: x: Host; }
`;

const INI = `
[Config Concrete]
network = Net
**.host.app.p = 1

[Config Derived]
network = DerivedNet
**.host.app.p = 2

[Config Sub]
network = Net
**.s.p = 3

[Config Like]
network = Net
**.m.typename = "App"
**.m.p = 4

[Config LikeNet]
network = HostNet
**.h.typename = "App"
**.h.p = 6

[Config Irrelevant]
network = NoApp
**.nope.p = 5
`;

async function makeCtx() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const iniCache = new IniResourceCache();
  const registry = new ConfigRegistry();
  const db = new SemanticDatabase(nedCache, msgCache, registry, iniCache);
  nedCache.addFile('file:///net.ned', svc.parse('ned', NED), '');
  db.onNedFile('file:///net.ned');
  iniCache.addFile('file:///omnetpp.ini', INI);
  db.onIniFile('file:///omnetpp.ini');
  return { nedCache, iniCache, registry, db };
}

const key = (a: { config: string; key: string; matchedPath: string }) => `${a.config}|${a.key}|${a.matchedPath}`;

test('pruned findParamAssignments equals the unpruned full scan (shadow oracle)', async () => {
  const { nedCache, iniCache, registry, db } = await makeCtx();
  const target = { typeFqName: 'App', param: 'p' };

  const full = findParamAssignments(iniCache, nedCache, registry, target);
  const relevant = paramContainerSimpleNames(db, 'App');
  const pruned = findParamAssignments(iniCache, nedCache, registry, target, undefined, relevant);

  assert.deepEqual(pruned.map(key).sort(), full.map(key).sort());
  // sanity: the four reachable configs are found, the irrelevant one is not
  const configs = new Set(full.map((a) => a.config));
  assert.deepEqual([...configs].sort(), ['Concrete', 'Derived', 'Like', 'LikeNet', 'Sub']);
  assert.ok(!configs.has('Irrelevant'));
});

test('the prune set covers concrete containers, subtypes, and inherited networks', async () => {
  const { db } = await makeCtx();
  const relevant = paramContainerSimpleNames(db, 'App');
  // App + subtype, the concrete host, and every network that concretely holds them
  for (const n of ['App', 'SubApp', 'Host', 'Net', 'BaseNet', 'DerivedNet', 'NoApp']) {
    assert.ok(relevant.has(n), `expected ${n} in the prune set`);
  }
  // HostNet only holds App through a `like` slot (no concrete edge) → not a container
  assert.ok(!relevant.has('HostNet'), 'HostNet should not be a concrete container');
});
