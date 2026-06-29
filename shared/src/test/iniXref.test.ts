import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  ConfigRegistry,
  IniResourceCache,
  parseIni,
  iniParamDiagnostics,
  findParamAssignments,
} from '../index';
import type { ParserService } from '../index';

const REGISTRY = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
  { name: 'sim-time-limit', type: 'double', unit: 's', default: null, scope: 'global', description: '' },
]);

async function nedCacheWith(files: Record<string, string>): Promise<NedResourceCache> {
  const svc: ParserService = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

const LIKE_NED =
  'moduleinterface IMob { parameters: double speed; }\n' +
  'simple ConstMob like IMob { parameters: double speed; double accel = default(1); }\n' +
  'module Host { submodules: mob: <> like IMob; }\n' +
  'network Net { submodules: host: Host; }\n';

test('like-typename binding resolves params behind the like boundary', async () => {
  const cache = await nedCacheWith({ 'file:///m.ned': LIKE_NED });

  const withTypename = parseIni(
    '[General]\nnetwork = Net\n[Config A]\n' +
      '**.host.mob.typename = "ConstMob"\n' +
      'Net.host.mob.accel = 5\n' +   // real param of ConstMob → ok
      'Net.host.mob.bogus = 1\n',    // not a param → flagged once resolved
  );
  const codesWith = iniParamDiagnostics(withTypename, cache, REGISTRY).map((d) => d.code);
  assert.ok(codesWith.includes('no-matching-param'), `expected no-matching-param, got ${codesWith}`);
  // the bogus key is the only no-matching-param; accel/typename must NOT be flagged
  assert.equal(codesWith.filter((c) => c === 'no-matching-param').length, 1);
});

test('without a typename binding, params behind like are not falsely flagged', async () => {
  const cache = await nedCacheWith({ 'file:///m.ned': LIKE_NED });
  const noTypename = parseIni(
    '[General]\nnetwork = Net\n[Config A]\n' +
      'Net.host.mob.accel = 5\n' +
      'Net.host.mob.bogus = 1\n',
  );
  // mob is open (concrete type unknown) → no no-matching-param at all
  const codes = iniParamDiagnostics(noTypename, cache, REGISTRY).map((d) => d.code);
  assert.ok(!codes.includes('no-matching-param'), `unexpected no-matching-param: ${codes}`);
});

test('findParamAssignments returns every INI key that assigns a NED parameter', async () => {
  const cache = await nedCacheWith({
    'file:///n.ned': 'simple Host { parameters: int n; }\nnetwork Net { submodules: a: Host; b: Host; }\n',
  });
  const iniCache = new IniResourceCache();
  iniCache.addFile(
    'file:///omnetpp.ini',
    '[General]\nnetwork = Net\n[Config A]\n**.a.n = 5\nNet.b.n = 3\n',
  );

  const rows = findParamAssignments(iniCache, cache, REGISTRY, { typeFqName: 'Host', param: 'n' });
  const byPath = new Map(rows.map((r) => [r.matchedPath, r]));

  assert.ok(byPath.has('Net.a.n'), 'should find the **.a.n assignment');
  assert.ok(byPath.has('Net.b.n'), 'should find the Net.b.n assignment');
  assert.equal(byPath.get('Net.a.n')!.key, '**.a.n');
  assert.equal(byPath.get('Net.b.n')!.key, 'Net.b.n');
  assert.equal(byPath.get('Net.a.n')!.config, 'A');
  assert.ok(byPath.get('Net.a.n')!.isWinner);
  assert.ok(byPath.get('Net.b.n')!.isWinner);
});

test('findParamAssignments can be scoped to a single config', async () => {
  const cache = await nedCacheWith({
    'file:///n.ned': 'simple Host { parameters: int n; }\nnetwork Net { submodules: a: Host; }\n',
  });
  const iniCache = new IniResourceCache();
  iniCache.addFile(
    'file:///omnetpp.ini',
    '[General]\nnetwork = Net\n[Config A]\n**.a.n = 1\n[Config B]\n**.a.n = 2\n',
  );

  const all = findParamAssignments(iniCache, cache, REGISTRY, { typeFqName: 'Host', param: 'n' });
  assert.ok(all.some((r) => r.config === 'A') && all.some((r) => r.config === 'B'));

  const onlyB = findParamAssignments(iniCache, cache, REGISTRY, { typeFqName: 'Host', param: 'n' }, 'B');
  assert.ok(onlyB.length > 0 && onlyB.every((r) => r.config === 'B'));
});
