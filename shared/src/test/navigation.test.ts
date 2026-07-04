import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers, posOf } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedDefinition, nedHover, nedReferences } from '../ned/nedNavigation';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { msgDocRefResolver, msgDefinition, msgHover } from '../msg/msgNavigation';
import { nedDocRefResolver } from '../ned/nedNavigation';
import type { Position } from '../model/location';

async function build(files: Record<string, { text: string; pkg?: string }>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, f] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', f.text), f.pkg ?? '');
  return cache;
}

const TEXT = `simple Base {
  parameters:
    int n = 1;
}
simple Derived extends Base {
}
module Net {
  submodules:
    host: Derived;
}`;

test('go-to-definition on extends target', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  const tree = file.tree;
  // position on the `Base` token in `extends Base`
  const ep = posOf(TEXT, 'extends Base');
  const refPos: Position = { line: ep.line, character: ep.character + 'extends '.length };
  const def = nedDefinition(cache, file, tree, refPos);
  assert.ok(def, 'definition found from extends reference');
  assert.equal(def!.range.start.line, 0, 'Base defined on line 0');
  // also: go-to-def on submodule type `host: Derived`
  const sp = posOf(TEXT, 'Derived;');
  const def2 = nedDefinition(cache, file, tree, sp);
  assert.ok(def2, 'definition found from submodule type');
  assert.equal(def2!.range.start.line, 4, 'Derived defined on line 4');
});

test('hover shows type signature and doc', async () => {
  const T = `// A great module
simple Base { }
simple D extends Base { }`;
  const cache = await build({ 'file:///b.ned': { text: T } });
  const file = cache.getFile('file:///b.ned')!;
  const hov = nedHover(cache, file, file.tree, posOf(T, 'Base { }'));
  assert.ok(hov);
  assert.match(hov!.markdown, /simple Base/);
  assert.match(hov!.markdown, /A great module/);
});

test('hover linkifies ~Type doc cross-references', async () => {
  const T = `// See ~Other for details, and ~Missing which does not exist.
simple Base { }
simple Other { }`;
  const cache = await build({ 'file:///x.ned': { text: T } });
  const file = cache.getFile('file:///x.ned')!;
  const hov = nedHover(cache, file, file.tree, posOf(T, 'Base { }'));
  assert.ok(hov);
  // resolvable ref -> markdown link to the declaration; tilde never rendered
  assert.match(hov!.markdown, /\[Other\]\(file:\/\/\/x\.ned#L3,8\)/);
  // unresolvable ref -> bare name, tilde stripped
  assert.match(hov!.markdown, /and Missing which/);
  assert.doesNotMatch(hov!.markdown, /~Other|~Missing/);
});

test('hover resolves a ~Type doc ref by unique simple name across the project', async () => {
  const main = `package a;
// related to ~Far and the ambiguous ~Dup
simple Node { }`;
  const cache = await build({
    'file:///main.ned': { text: main },
    'file:///far.ned': { text: 'package b;\nsimple Far { }' },
    'file:///dup1.ned': { text: 'package c;\nsimple Dup { }' },
    'file:///dup2.ned': { text: 'package d;\nsimple Dup { }' },
  });
  const file = cache.getFile('file:///main.ned')!;
  const hov = nedHover(cache, file, file.tree, posOf(main, 'Node { }'));
  assert.ok(hov);
  // unique simple name -> linked globally even though main.ned never imports it
  assert.match(hov!.markdown, /\[Far\]\(file:\/\/\/far\.ned#L2,8\)/);
  // ambiguous simple name -> stays plain text, no guess
  assert.match(hov!.markdown, /ambiguous Dup/);
  assert.doesNotMatch(hov!.markdown, /~Far|~Dup/);
});

test('hover linkifies a ~MsgType cross-language doc reference', async () => {
  const T = `// Carries a ~Payload message.
simple Node { }`;
  const cache = await build({ 'file:///n.ned': { text: T } });
  const file = cache.getFile('file:///n.ned')!;
  const svc = await getParsers();
  const msgCache = new MsgResourceCache();
  msgCache.addFile('file:///m.msg', svc.parse('msg', 'packet Payload { }'));
  const hov = nedHover(cache, file, file.tree, posOf(T, 'Node { }'), msgDocRefResolver(msgCache));
  assert.ok(hov);
  assert.match(hov!.markdown, /\[Payload\]\(file:\/\/\/m\.msg#L1,8\)/);
  assert.doesNotMatch(hov!.markdown, /~Payload/);
});

test('parameter hover includes trailing and leading doc comments', async () => {
  const T = `simple S {
  parameters:
    int foo = 5;  // documents foo
    // banner for bar
    string bar;
}`;
  const cache = await build({ 'file:///p.ned': { text: T } });
  const file = cache.getFile('file:///p.ned')!;
  // hover on the `foo` declaration -> trailing comment
  const hovFoo = nedHover(cache, file, file.tree, posOf(T, 'foo = 5'));
  assert.ok(hovFoo);
  assert.match(hovFoo!.markdown, /int foo/);
  assert.match(hovFoo!.markdown, /documents foo/);
  // hover on `bar` -> falls back to the leading banner comment
  const hovBar = nedHover(cache, file, file.tree, posOf(T, 'bar;'));
  assert.ok(hovBar);
  assert.match(hovBar!.markdown, /banner for bar/);
});

test('find references to a type', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  // references of Derived (defined + used in submodule + ... )
  const refs = nedReferences(cache, file, file.tree, posOf(TEXT, 'Derived extends'), true);
  // declaration + submodule type usage
  assert.ok(refs.length >= 2, `expected >=2 refs, got ${refs.length}`);
});

const BUILTINS = ['cMessage', 'cPacket', 'cObject', 'simtime_t'];

async function buildMsg(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new MsgResourceCache();
  cache.setBuiltins(BUILTINS);
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('msg', text));
  return cache;
}

test('MSG go-to-definition and hover', async () => {
  const text = 'class Base { }\nclass Derived extends Base { }';
  const cache = await buildMsg({ 'file:///m.msg': text });
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
  const msgCache = await buildMsg({ 'file:///pkt.msg': msgText });
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
