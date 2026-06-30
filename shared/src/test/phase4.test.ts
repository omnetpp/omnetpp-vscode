import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { msgSemanticDiagnostics, msgLocalDiagnostics } from '../msg/msgChecks';
import { msgDefinition, msgHover } from '../msg/msgNavigation';
import { NedResourceCache } from '../ned/nedResourceCache';
import { nedDocRefResolver } from '../ned/nedNavigation';
import type { Position } from '../model/location';

const BUILTINS = ['cMessage', 'cPacket', 'cObject', 'simtime_t'];

async function build(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new MsgResourceCache();
  cache.setBuiltins(BUILTINS);
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('msg', text));
  return cache;
}

function posOf(text: string, needle: string): Position {
  const idx = text.indexOf(needle);
  const before = text.slice(0, idx);
  return { line: before.split('\n').length - 1, character: idx - (before.lastIndexOf('\n') + 1) };
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

test('MSG go-to-definition and hover', async () => {
  const text = 'class Base { }\nclass Derived extends Base { }';
  const cache = await build({ 'file:///m.msg': text });
  const file = cache.getFile('file:///m.msg')!;
  const def = msgDefinition(cache, file, file.tree, posOf(text, 'Base { }') === undefined ? { line: 0, character: 0 } : { line: 1, character: text.split('\n')[1].indexOf('Base') });
  assert.ok(def);
  assert.equal(def!.range.start.line, 0);
  const hov = msgHover(cache, file, file.tree, { line: 1, character: text.split('\n')[1].indexOf('Base') });
  assert.ok(hov && /class Base/.test(hov.markdown));
});

test('MSG hover renders doc and linkifies same- and cross-language refs', async () => {
  const msgText = `// A packet, see ~Other and the NED module ~Sink.
class Pkt { int x; }
class Other { }`;
  const msgCache = await build({ 'file:///pkt.msg': msgText });
  const file = msgCache.getFile('file:///pkt.msg')!;

  // a NED type referenced from the MSG doc comment
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile('file:///net.ned', svc.parse('ned', 'simple Sink { }'), '');

  const hov = msgHover(msgCache, file, file.tree, posOf(msgText, 'Pkt {'), nedDocRefResolver(nedCache));
  assert.ok(hov);
  assert.match(hov!.markdown, /A packet/); // doc comment is now rendered
  assert.match(hov!.markdown, /\[Other\]\(file:\/\/\/pkt\.msg#L3,7\)/); // same-language MSG link
  assert.match(hov!.markdown, /\[Sink\]\(file:\/\/\/net\.ned#L1,8\)/); // cross-language NED link
  assert.doesNotMatch(hov!.markdown, /~Other|~Sink/);
});
