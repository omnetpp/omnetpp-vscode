import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { parseExpression } from '../expr/exprParser';
import { nedValueDiagnostics } from '../ned/nedValueChecks';
import { formatBraceIndent } from '../features/format';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedRename } from '../ned/nedRename';
import { nedDefinition, paramRefAt, connectionRefAt } from '../ned/nedNavigation';
import { parseIni } from '../ini/iniDocument';
import { leadingDocComment } from '../ned/nedAst';
import { treeFoldingRanges } from '../features/folding';

// review fix: expr parser must not crash past EOF (incomplete expressions while typing)
test('expr parser is EOF-safe on incomplete input', () => {
  for (const s of ['a +', '!', '(', '{x', 'a[', 'a ? b', 'foo(', '1 +']) {
    assert.doesNotThrow(() => parseExpression(s), `threw on: ${s}`);
  }
});

test('nedValueDiagnostics does not throw on incomplete default values', async () => {
  const svc = await getParsers();
  const t = svc.parse('ned', 'simple S { parameters: int n = 1 +; double d = (; }');
  assert.doesNotThrow(() => nedValueDiagnostics(t));
});

// review fix: MSG leading-:: (force-global) resolution
test('MSG resolves force-global :: type names', async () => {
  const svc = await getParsers();
  const cache = new MsgResourceCache();
  cache.addFile('file:///b.msg', svc.parse('msg', 'class Base { int x; }'));
  assert.ok(cache.lookupType('::Base', 'someNs'), '::Base resolves to global Base');
  assert.ok(cache.lookupType('Base', ''));
});

// review fix: formatter must treat char/string literals as opaque
test('formatter does not miscount braces inside char/string literals', () => {
  const src = 'class M {\n    char open = \'{\';\n    int x;\n}\nclass N {\n    int y;\n}\n';
  const out = formatBraceIndent(src, { tabSize: 4, insertSpaces: true });
  const lines = out.split('\n');
  assert.equal(lines[4], 'class N {', 'depth returned to 0 despite the { char literal');
  assert.equal(lines[5], '    int y;');
});

// review fix: per-file node-id keying isolates cross-tree id collisions
test('typeInfoForNode is isolated per file', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile('file:///a.ned', svc.parse('ned', 'simple A {}'), '');
  cache.addFile('file:///b.ned', svc.parse('ned', 'simple B {}'), '');
  const a = cache.getFile('file:///a.ned')!.tree.rootNode.namedChild(0)!;
  assert.equal(cache.typeInfoForNode(a, 'file:///a.ned')?.fqName, 'A');
  // same node object, wrong uri -> must not resolve
  assert.equal(cache.typeInfoForNode(a, 'file:///b.ned'), undefined);
});

// review fix: renaming a channel updates its references in connections
test('rename channel updates connection references', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  const src = `channel MyCh { }
network N {
  submodules: a: Foo; b: Foo;
  connections: a.out --> MyCh --> b.in;
}
simple Foo { gates: inout out; inout in; }`;
  cache.addFile('file:///c.ned', svc.parse('ned', src), '');
  const f = cache.getFile('file:///c.ned')!;
  const chPos = { line: 0, character: 'channel '.length };
  const edit = nedRename(cache, f, f.tree, chPos, 'Link');
  const edits = edit?.changes['file:///c.ned'] ?? [];
  // declaration + the connection channel reference
  assert.ok(edits.length >= 2, `expected channel + connection edit, got ${edits.length}`);
});

// review fix: extends/implements must not be shadowed by the type's own inner types
test('extends resolves to top-level base, not own inner type', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile('file:///base.ned', svc.parse('ned', 'module Bar { }'), '');
  const src = 'module Foo extends Bar {\n  types:\n    module Bar { }\n}';
  cache.addFile('file:///foo.ned', svc.parse('ned', src), '');
  const f = cache.getFile('file:///foo.ned')!;
  const pos = { line: 0, character: 'module Foo extends '.length };
  const def = nedDefinition(cache, f, f.tree, pos);
  assert.ok(def);
  assert.equal(def!.uri, 'file:///base.ned', 'jumps to the top-level Bar, not the inner one');
});

// parity: connection navigation (submodule + gate names)
test('connection references resolve to submodule and gate declarations', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  const src = 'simple Node { gates: inout port; }\nnetwork N {\n  submodules: a: Node; b: Node;\n  connections: a.port <--> b.port;\n}';
  cache.addFile('file:///n.ned', svc.parse('ned', src), '');
  const f = cache.getFile('file:///n.ned')!;
  const conn = '  connections: a.port <--> b.port;';
  const aCol = conn.indexOf('a.port');
  // submodule `a` -> its declaration on line 2
  const subDef = connectionRefAt(cache, f, f.tree, { line: 3, character: aCol });
  assert.ok(subDef && subDef.range.start.line === 2, 'submodule a -> decl line 2');
  // gate `port` -> Node's gate declaration on line 0
  const gateDef = connectionRefAt(cache, f, f.tree, { line: 3, character: aCol + 2 });
  assert.ok(gateDef && gateDef.range.start.line === 0, 'gate port -> Node gate line 0');
});

// parity: parameter-reference navigation (override -> inherited declaration)
test('param override resolves to the inherited declaration', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile('file:///x.ned', svc.parse('ned', 'simple Base { parameters: int cap = 1; }\nsimple D extends Base {\n  parameters:\n    cap = 5;\n}'), '');
  const f = cache.getFile('file:///x.ned')!;
  // cursor on `cap` in the override `cap = 5;` (line 3)
  const ref = paramRefAt(cache, f, f.tree, { line: 3, character: 4 });
  assert.ok(ref, 'param ref resolved');
  assert.equal(ref!.ownerFq, 'Base');
  assert.equal(ref!.type, 'int');
  assert.equal(ref!.decl.range.start.line, 0);
});

// review fix: ini value range excludes trailing comment/whitespace
test('ini value range excludes trailing comment', () => {
  const doc = parseIni('network = Foo   # the network\n');
  const e = doc.sections[0].entries[0];
  assert.equal(e.value, 'Foo');
  assert.equal(e.valueRange.end.character, 'network = Foo'.length);
});

// review fix: backslash-before-quote handled when stripping comments
test('ini comment strip respects escaped backslash before quote', () => {
  const doc = parseIni('**.f = "out\\\\" # dir\n');
  assert.equal(doc.sections[0].entries[0].value, '"out\\\\"');
});

// review fix: leadingDocComment ignores trailing comments on the prior line
test('leadingDocComment: banner yes, trailing no', async () => {
  const svc = await getParsers();
  const banner = svc.parse('ned', '// Doc here\nsimple A {}');
  assert.equal(leadingDocComment(banner.rootNode.namedChild(1)!), 'Doc here');
  const trailing = svc.parse('ned', 'package p; // trailing\nsimple A {}');
  const aNode = trailing.rootNode.namedChild(trailing.rootNode.namedChildCount - 1)!;
  assert.equal(leadingDocComment(aNode), undefined);
});

// grammar change: comments are now one node per `//` line, so a multi-line
// banner must be re-joined from the run of consecutive comment siblings
test('leadingDocComment: multi-line banner is joined', async () => {
  const svc = await getParsers();
  const t = svc.parse('ned', '//\n// Line one\n// Line two\nsimple A {}');
  const aNode = t.rootNode.namedChild(t.rootNode.namedChildCount - 1)!;
  assert.equal(aNode.type, 'simple');
  assert.equal(leadingDocComment(aNode), 'Line one\nLine two');
  // a trailing comment above the banner must not leak into it
  const mixed = svc.parse('ned', 'package p; // trailing\n// Real banner\nsimple A {}');
  const a2 = mixed.rootNode.namedChild(mixed.rootNode.namedChildCount - 1)!;
  assert.equal(leadingDocComment(a2), 'Real banner');
});

// grammar change: a multi-line `//` banner is now a run of per-line comment
// nodes; folding must group the run into a single comment fold
test('folding: a multi-line comment block folds as one range', async () => {
  const svc = await getParsers();
  const t = svc.parse('ned', '// l0\n// l1\n// l2\nsimple A {}');
  const ranges = treeFoldingRanges(t);
  const commentFold = ranges.find((r) => r.kind === 'comment');
  assert.ok(commentFold, 'expected a comment folding range');
  assert.equal(commentFold.startLine, 0);
  assert.equal(commentFold.endLine, 2);
});
