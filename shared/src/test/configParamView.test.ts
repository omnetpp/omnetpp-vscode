import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni, IniDocument } from '../ini/iniDocument';
import {
  effectiveNetwork,
  resolveNetworkType,
  configEntriesInScope,
  configResolver,
} from '../ini/iniParamResolution';
import {
  paramHierarchyRoot,
  paramHierarchyChildren,
  ParamHierNode,
  ParamViewOpts,
} from '../ned/nedParamHierarchy';

const registry = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
]);

async function nedCache(text: string) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///n.ned', svc.parse('ned', text), '');
  return cache;
}

const NED = `simple App {
    parameters:
        int numApps = default(1);
        bool forwarding = default(false);
        string label;
}
module Host {
    submodules:
        app: App;
}
network Net {
    submodules:
        host: Host;
}
`;

const INI_URI = 'file:///omnetpp.ini';

/** Build the config-resolution opts the server would build, for a given root path. */
function opts(cache: NedResourceCache, doc: IniDocument, name: string, path: string): ParamViewOpts {
  const section =
    name === 'General'
      ? doc.sections.find((s) => s.type === 'general')!
      : doc.sections.find((s) => s.configName === name)!;
  const base = configResolver(configEntriesInScope(doc, section, registry));
  return {
    path,
    configName: name,
    resolve: (p) => {
      const e = base(p);
      return e ? { value: e.value, uri: INI_URI, range: e.keyRange } : undefined;
    },
  };
}

function net(cache: NedResourceCache, doc: IniDocument, name: string) {
  const section =
    name === 'General'
      ? doc.sections.find((s) => s.type === 'general')!
      : doc.sections.find((s) => s.configName === name)!;
  return resolveNetworkType(cache, effectiveNetwork(doc, section)!)!;
}

const byLabel = (rows: ParamHierNode[], label: string) => rows.find((r) => r.label === label);

test('config param view: roots at the effective network', async () => {
  const cache = await nedCache(NED);
  const doc = parseIni('[General]\nnetwork = Net\n[Config Foo]\nNet.host.app.numApps = 5\n');
  const o = opts(cache, doc, 'Foo', net(cache, doc, 'Foo').simpleName);
  const root = paramHierarchyRoot(cache, net(cache, doc, 'Foo'), o);
  assert.equal(root.label, 'Net');
  assert.equal(root.path, 'Net');
  const host = byLabel(root.children!, 'host')!;
  assert.equal(host.kind, 'module');
  assert.equal(host.path, 'Net.host');
});

test('config param view: INI assignment overrides NED default; greyed default shown', async () => {
  const cache = await nedCache(NED);
  const doc = parseIni(
    '[General]\nnetwork = Net\n**.forwarding = true\n[Config Foo]\nNet.host.app.numApps = 5\n',
  );
  // drill Net -> host -> app
  const hostOpts = opts(cache, doc, 'Foo', 'Net.host');
  const hostKids = paramHierarchyChildren(cache, 'Host', hostOpts);
  assert.ok(byLabel(hostKids, 'app'));
  const appOpts = opts(cache, doc, 'Foo', 'Net.host.app');
  const appRows = paramHierarchyChildren(cache, 'App', appOpts).filter((r) => r.kind === 'param');

  // numApps: from config (5), NED default(1) shown greyed overridden
  const numApps = appRows.filter((r) => r.label === 'numApps' || r.label.endsWith('::numApps'));
  assert.equal(numApps[0].paramValue, '5');
  assert.equal(numApps[0].fromConfig, true);
  assert.equal(numApps[0].path, 'Net.host.app.numApps');
  assert.ok(numApps[1] && numApps[1].overridden && numApps[1].paramValue === 'default(1)');

  // forwarding: from config via **.forwarding (General scope), default(false) greyed
  const fwd = appRows.filter((r) => r.label === 'forwarding' || r.label.endsWith('::forwarding'));
  assert.equal(fwd[0].paramValue, 'true');
  assert.equal(fwd[0].fromConfig, true);
  assert.ok(fwd[1] && fwd[1].overridden && fwd[1].paramValue === 'default(false)');

  // label: no NED default, no assignment -> unset
  const label = byLabel(appRows, 'label')!;
  assert.equal(label.unset, true);
  assert.equal(label.paramValue, undefined);
});

test('config param view: bare [Name] section (no "Config" prefix) resolves like aloha', async () => {
  // OMNeT++ allows `[Foo]` as a config section (Config prefix optional); a
  // path-specific key resolves when the param path is network-rooted.
  const cache = await nedCache(NED);
  const doc = parseIni('[General]\nnetwork = Net\n[PureAloha1]\nNet.host.app.numApps = 7\n');
  const section = doc.sections.find((s) => s.configName === 'PureAloha1');
  assert.ok(section, 'bare [PureAloha1] must parse with configName');
  const appOpts = opts(cache, doc, 'PureAloha1', 'Net.host.app');
  const appRows = paramHierarchyChildren(cache, 'App', appOpts).filter((r) => r.kind === 'param');
  const numApps = appRows.find((r) => r.label === 'numApps')!;
  assert.equal(numApps.paramValue, '7');
  assert.equal(numApps.fromConfig, true);
});

test('config param view: submodule-body assignment is the effective value (not unset)', async () => {
  const ned = `simple Leaf {
    parameters:
        int k = default(1);
        double r @unit(s);
}
network Net2 {
    submodules:
        leaf: Leaf { r = 5s; }
}
`;
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///n2.ned', svc.parse('ned', ned), '');
  const doc = parseIni('[General]\nnetwork = Net2\n[C]\nNet2.leaf.k = 9\n');
  const net2 = cache.getType('Net2')!;
  const o = opts(cache, doc, 'C', 'Net2');
  const root = paramHierarchyRoot(cache, net2, o);
  const leaf = root.children!.find((c) => c.label === 'leaf')!;
  assert.ok(leaf.subAssign && leaf.subAssign['r'], 'submodule assignment captured on node');
  const kids = paramHierarchyChildren(cache, leaf.typeFqName!, {
    path: leaf.path,
    configName: 'C',
    resolve: o.resolve,
    subAssign: leaf.subAssign,
  }).filter((n) => n.kind === 'param');
  // r: from the submodule body assignment (not unset, not from config)
  const r = kids.find((n) => n.label === 'r')!;
  assert.equal(r.paramValue, '5s');
  assert.ok(!r.unset && !r.fromConfig);
  // k: config Net2.leaf.k wins over the NED default(1), which is greyed
  const k = kids.filter((n) => n.label === 'k' || n.label.endsWith('::k'));
  assert.equal(k[0].paramValue, '9');
  assert.equal(k[0].fromConfig, true);
  assert.ok(k[1] && k[1].overridden && k[1].paramValue === 'default(1)');
});

test('param view: declared param with no default/assignment is unset even without a config', async () => {
  const cache = await nedCache(NED);
  // No active config (no opts) — App.label has no default and no assignment.
  const rows = paramHierarchyChildren(cache, 'App').filter((r) => r.kind === 'param');
  const label = rows.find((r) => r.label === 'label')!;
  assert.equal(label.unset, true);
  assert.equal(label.paramValue, undefined);
  // numApps has a NED default → not unset.
  const numApps = rows.find((r) => r.label === 'numApps')!;
  assert.equal(numApps.unset, undefined);
  assert.equal(numApps.paramValue, 'default(1)');
});

test('config param view: section assignment wins over [General] (precedence)', async () => {
  const cache = await nedCache(NED);
  const doc = parseIni(
    '[General]\nnetwork = Net\n**.numApps = 1\n[Config Foo]\n**.numApps = 9\n',
  );
  const appOpts = opts(cache, doc, 'Foo', 'Net.host.app');
  const appRows = paramHierarchyChildren(cache, 'App', appOpts).filter((r) => r.kind === 'param');
  const numApps = appRows.find((r) => r.label === 'numApps')!;
  assert.equal(numApps.paramValue, '9'); // Config Foo entry precedes General
  assert.equal(numApps.fromConfig, true);
});
