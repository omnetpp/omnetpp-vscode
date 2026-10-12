import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { msgSemanticDiagnostics, msgLocalDiagnostics } from '../msg/msgChecks';

const BUILTINS = ['cMessage', 'cPacket', 'cObject', 'simtime_t'];

async function build(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new MsgResourceCache();
  cache.setBuiltins(BUILTINS);
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('msg', text));
  return cache;
}

test('MSG resolution across imports and namespace', async () => {
  const cache = await build({
    'file:///base.msg': 'namespace a;\nclass Base { int x; }',
    'file:///d.msg': 'namespace a;\nclass Derived extends Base { double y; }',
  });
  const d = cache.getType('a::Derived')!;
  assert.ok(d);
  assert.equal(d.superType()?.fqName, 'a::Base');
  // merged fields
  assert.deepEqual(d.fields().map((f) => f.name), ['x', 'y']);
});

test('MSG unknown-type warning only for unresolved unqualified names', async () => {
  const text = `packet P extends cPacket {
  int seq;
  cMessage *enc;
  Mystery thing;
  std::vector<int> v;
}`;
  const cache = await build({ 'file:///p.msg': text });
  const diags = msgSemanticDiagnostics(cache, 'file:///p.msg');
  const msgs = diags.map((d) => d.message);
  // cPacket/cMessage are builtins; std::vector is qualified -> skipped; Mystery -> warning
  assert.equal(diags.length, 1, JSON.stringify(msgs));
  assert.match(msgs[0], /Unknown type 'Mystery'/);
});

test('MSG float is a recognized primitive type', async () => {
  const text = `message M {
  float f = 0;
  double d = 0;
  float arr[];
  const float *cf;
}`;
  const cache = await build({ 'file:///m.msg': text });
  // float must not be flagged as an unknown type (parallel to double)
  assert.equal(msgSemanticDiagnostics(cache, 'file:///m.msg').length, 0);
  const m = cache.getType('M')!;
  assert.deepEqual(m.fields().map((f) => f.name), ['f', 'd', 'arr', 'cf']);
});

test('MSG unknown-type respects cplusplus and forward decls', async () => {
  const text = `cplusplus {{ class ExternalThing; }}
class Fwd;
class C { ExternalThing a; Fwd b; }`;
  const cache = await build({ 'file:///c.msg': text });
  assert.equal(msgSemanticDiagnostics(cache, 'file:///c.msg').length, 0);
});

test('MSG duplicate field/type local diagnostics', async () => {
  const svc = await getParsers();
  const tree = svc.parse('msg', 'class A { int x; int x; }\nclass A { }');
  const diags = msgLocalDiagnostics(tree);
  assert.ok(diags.some((d) => /Duplicate field 'x'/.test(d.message)));
  assert.ok(diags.some((d) => /Duplicate type 'A'/.test(d.message)));
});

test('MSG qualified base type resolves in the enclosing namespaces (INET OSPF)', async () => {
  const cache = await build({
    'file:///base.msg': 'namespace inet::ospf;\nclass OspfPacketBase { int x; }',
    'file:///p.msg': 'namespace inet::ospfv2;\nclass Ospfv2Packet extends ospf::OspfPacketBase { int y; }',
    'file:///g.msg': 'namespace other;\nclass G extends ::inet::ospf::OspfPacketBase { }',
  });
  assert.equal(cache.getType('inet::ospfv2::Ospfv2Packet')!.superType()?.fqName, 'inet::ospf::OspfPacketBase');
  assert.equal(cache.getType('other::G')!.superType()?.fqName, 'inet::ospf::OspfPacketBase');
  assert.equal(cache.lookupType('::OspfPacketBase', 'inet::ospf'), undefined);
});
