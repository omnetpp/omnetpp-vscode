import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { buildPreviewScene, displayStringFromChain, previewSceneByFq } from '../ned/nedPreviewScene';
import { Prop } from '../ned/displayStringModel';

async function nedCache(files: Record<string, string>): Promise<NedResourceCache> {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

const LIB = `
simple Node { parameters: @display("i=device/pc"); gates: inout g[]; }
simple Sink extends Node { parameters: @display("i=block/sink,red"); }
channel Eth { parameters: @display("ls=blue,2"); }
moduleinterface IApp { }
simple UdpApp like IApp { parameters: @display("i=block/app;is=s"); }
`;

const NET = `
module Base
{
    parameters:
        @display("bgb=600,400");
    submodules:
        inherited: Node { @display("p=50,50"); }
}
network Net extends Base
{
    parameters:
        app.typename = default("UdpApp");
    gates:
        inout ext;
    submodules:
        a: Node { @display("p=100,100;i=,gold,40"); }
        nodes[8]: Node;
        s: Sink;
        app: <> like IApp;
    connections allowunconnected:
        a.g++ <--> Eth <--> s.g++;
        ext <--> a.g++;
        for i=0..6 {
            nodes[i].g++ --> nodes[i+1].g++ if i!=3;
        }
}
`;

test('preview scene: compound module with submodules, inherited members, connections', async () => {
  const cache = await nedCache({ 'file:///lib.ned': LIB, 'file:///net.ned': NET });
  const scene = previewSceneByFq(cache, 'Net')!;
  assert.ok(scene);
  assert.equal(scene.kind, 'network');
  assert.ok(scene.isNetwork);
  assert.deepEqual(displayStringFromChain(scene.displayChain).getCompoundSize(), { width: 600, height: 400 });

  const subs = scene.submodules!;
  const byName = new Map(subs.map((s) => [s.name, s]));
  assert.deepEqual([...byName.keys()].sort(), ['a', 'app', 'inherited', 'nodes', 's']);

  // inherited submodule carries its origin and its own display chain
  const inh = byName.get('inherited')!;
  assert.equal(inh.inheritedFrom, 'Base');
  const inhDs = displayStringFromChain(inh.displayChain);
  assert.deepEqual(inhDs.getLocation(), { x: 50, y: 50 });
  assert.equal(inhDs.getAsString(Prop.IMAGE), 'device/pc');

  // local submodule display: own tint over the type's icon
  const a = byName.get('a')!;
  assert.equal(a.resolvedTypeFqName, 'Node');
  const aDs = displayStringFromChain(a.displayChain);
  assert.equal(aDs.getAsString(Prop.IMAGE), 'device/pc'); // from type chain
  assert.equal(aDs.getAsString(Prop.IMAGE_COLOR), 'gold'); // own override

  // vector submodule: one box labeled nodes[8]
  const nodes = byName.get('nodes')!;
  assert.equal(nodes.vectorSize, '8');

  // supertype display chain: Sink -> Node
  const s = byName.get('s')!;
  const sDs = displayStringFromChain(s.displayChain);
  assert.equal(sDs.getAsString(Prop.IMAGE), 'block/sink');
  assert.equal(sDs.getAsString(Prop.IMAGE_COLOR), 'red');

  // like submodule resolved through the typename pattern default
  const app = byName.get('app')!;
  assert.ok(app.isLike);
  assert.equal(app.resolvedTypeFqName, 'UdpApp');
  assert.equal(displayStringFromChain(app.displayChain).getAsString(Prop.IMAGE), 'block/app');

  // connections: channel display chain, border connection, loop/conditional flags
  const conns = scene.connections!;
  assert.equal(conns.length, 3);
  const [chan, border, loop] = conns;
  assert.equal(chan.srcModule, 'a');
  assert.equal(chan.destModule, 's');
  assert.ok(chan.bidirectional);
  assert.equal(chan.channelTypeName, 'Eth');
  assert.equal(displayStringFromChain(chan.displayChain).getAsString(Prop.CONNECTION_COLOR), 'blue');

  assert.equal(border.srcModule, undefined); // parent gate `ext`
  assert.equal(border.srcGate, 'ext');
  assert.equal(border.destModule, 'a');

  assert.deepEqual(loop.loops, ['i=0..6']);
  assert.deepEqual(loop.conditions, ['i!=3']);
  assert.ok(!loop.bidirectional);

  // icons: everything referenced after resolution, incl. the `is=s` variant
  const iconKeys = scene.icons.map((i) => `${i.id}|${i.sizeSuffix ?? ''}`).sort();
  assert.deepEqual(iconKeys, ['block/app|s', 'block/sink|', 'device/pc|']);
});

test('preview scene: non-compound types produce an icon card, not a diagram', async () => {
  const cache = await nedCache({ 'file:///lib.ned': LIB });
  const scene = previewSceneByFq(cache, 'Sink')!;
  assert.equal(scene.kind, 'simple');
  assert.equal(scene.submodules, undefined);
  assert.equal(scene.connections, undefined);
  const ds = displayStringFromChain(scene.displayChain);
  assert.equal(ds.getAsString(Prop.IMAGE), 'block/sink'); // own, over Node's device/pc
  assert.equal(ds.getAsString(Prop.IMAGE_COLOR), 'red');
  assert.deepEqual(scene.icons.map((i) => i.id), ['block/sink']);
});

test('preview scene: $param display values are marked variable through the chain', async () => {
  const cache = await nedCache({
    'file:///p.ned': `simple P { parameters: string icon; @display("i=$icon"); }
module M { submodules: p: P; }`,
  });
  const scene = previewSceneByFq(cache, 'M')!;
  const p = scene.submodules![0];
  const ds = displayStringFromChain(p.displayChain);
  assert.ok(ds.isVariable(Prop.IMAGE));
  assert.equal(ds.getAsString(Prop.IMAGE), 'abstract/server'); // VARIABLE_DEFAULTS placeholder
  // the placeholder icon must be in the prefetch list
  assert.ok(scene.icons.some((i) => i.id === 'abstract/server'));
});

test('preview scene: buildPreviewScene on the type at hand equals fq lookup', async () => {
  const cache = await nedCache({ 'file:///lib.ned': LIB, 'file:///net.ned': NET });
  const type = cache.getType('Net')!;
  assert.deepEqual(buildPreviewScene(cache, type), previewSceneByFq(cache, 'Net'));
});
