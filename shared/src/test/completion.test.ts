import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedCompletion } from '../ned/nedCompletion';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import { iniCompletion } from '../ini/iniNavigation';

async function nedCache(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

/** Run NED completion with the cursor at the END of the given line index. */
function completeAt(cache: NedResourceCache, uri: string, lineIdx: number): string[] {
  const file = cache.getFile(uri)!;
  const lines = file.tree.rootNode.text.split('\n');
  const line = lines[lineIdx];
  return nedCompletion(cache, file, file.tree, { line: lineIdx, character: line.length }, line).map(
    (i) => i.label,
  );
}

const KINDS = `simple SBase { }
module MBase { }
channel CBase { }
moduleinterface IMod { }
channelinterface IChan { }
`;

test('completion: file top level offers only top-level keywords (no types)', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + '\n' });
  const labels = completeAt(cache, 'file:///k.ned', 5); // trailing blank line
  assert.ok(labels.includes('simple') && labels.includes('module') && labels.includes('import'));
  assert.ok(!labels.includes('SBase'), 'no type names at file top');
});

test('completion: extends filters by the kind being defined', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + 'simple S extends \n' });
  const labels = completeAt(cache, 'file:///k.ned', 5);
  assert.ok(labels.includes('SBase') && labels.includes('MBase'), 'modules offered');
  assert.ok(!labels.includes('CBase'), 'channels not offered for a simple module');
  assert.ok(!labels.includes('IMod'), 'interfaces not offered after extends');
});

test('completion: channel extends offers only channels', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + 'channel C extends \n' });
  const labels = completeAt(cache, 'file:///k.ned', 5);
  assert.ok(labels.includes('CBase'));
  assert.ok(!labels.includes('SBase') && !labels.includes('MBase'));
});

test('completion: like offers interfaces', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + 'module M2 like \n' });
  const labels = completeAt(cache, 'file:///k.ned', 5);
  assert.ok(labels.includes('IMod'));
  assert.ok(!labels.includes('SBase') && !labels.includes('IChan'));
});

test('completion: submodule type position offers module types', async () => {
  const src = KINDS + 'network N {\n  submodules:\n    h: \n}\n';
  const cache = await nedCache({ 'file:///k.ned': src });
  const labels = completeAt(cache, 'file:///k.ned', 7); // "    h: "
  assert.ok(labels.includes('SBase') || labels.includes('MBase'));
  assert.ok(!labels.includes('CBase'));
});

test('completion: section-header line does NOT offer types (gates: -> direction keywords)', async () => {
  const src = 'simple S {\n  gates:\n    input g;\n}\n';
  const cache = await nedCache({ 'file:///g.ned': src });
  const labels = completeAt(cache, 'file:///g.ned', 1); // "  gates:"
  assert.ok(labels.includes('input') && labels.includes('output') && labels.includes('inout'));
  assert.ok(!labels.includes('S'), 'no type names on a section header line');
});

test('completion: parameters section offers param type keywords + inherited params', async () => {
  const src = 'simple Base { parameters: int capacity; }\nsimple D extends Base {\n  parameters:\n    \n}\n';
  const cache = await nedCache({ 'file:///p.ned': src });
  const labels = completeAt(cache, 'file:///p.ned', 3); // blank line inside parameters
  assert.ok(labels.includes('int') && labels.includes('double'));
  assert.ok(labels.includes('capacity'), 'inherited parameter offered for assignment');
});

// ---- INI completion ----
const reg = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

test('ini completion: key position offers config options + extends', () => {
  const doc = parseIni('[General]\n\n');
  const items = iniCompletion(doc, reg, undefined, { line: 1, character: 0 }, '');
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('network') && labels.includes('sim-time-limit') && labels.includes('extends'));
});

test('ini completion: bool config value offers true/false', () => {
  const doc = parseIni('parallel-simulation = \n');
  const line = 'parallel-simulation = ';
  const items = iniCompletion(doc, reg, undefined, { line: 0, character: line.length }, line);
  const labels = items.map((i) => i.label);
  assert.deepEqual(labels.sort(), ['false', 'true']);
});

test('ini completion: extends = offers config section names', () => {
  const doc = parseIni('[Config Base]\n[Config Run]\nextends = \n');
  const line = 'extends = ';
  const items = iniCompletion(doc, reg, undefined, { line: 2, character: line.length }, line);
  assert.deepEqual(items.map((i) => i.label).sort(), ['Base', 'Run']);
});

test('ini completion: section header offers General/Config', () => {
  const doc = parseIni('[\n');
  const items = iniCompletion(doc, reg, undefined, { line: 0, character: 1 }, '[');
  assert.deepEqual(items.map((i) => i.label).sort(), ['Config ', 'General']);
});

// ---- NED completion (extends / submodule type, driven by a real cache) ----

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

test('completion after extends offers types', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  const prefix = 'simple X extends ';
  const items = nedCompletion(cache, file, file.tree, { line: 0, character: prefix.length }, prefix);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('Base'));
  assert.ok(labels.includes('Derived'));
});

test('completion after submodule colon offers module types', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  const prefix = '    host: ';
  const items = nedCompletion(cache, file, file.tree, { line: 0, character: prefix.length }, prefix);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('Net') || labels.includes('Base') || labels.includes('Derived'));
});

// ---- C6: bare type-header extends/like keyword offering ----

test('completion: bare type header offers both extends and like (module)', async () => {
  const src = 'simple SBase { }\nmodule MBase { }\nmodule Foo \n';
  const cache = await nedCache({ 'file:///h.ned': src });
  const labels = completeAt(cache, 'file:///h.ned', 2); // "module Foo "
  assert.deepEqual(labels.sort(), ['extends', 'like']);
});

test('completion: bare type header offers only extends for an interface', async () => {
  const src = 'moduleinterface IFoo \n';
  const cache = await nedCache({ 'file:///h2.ned': src });
  const labels = completeAt(cache, 'file:///h2.ned', 0); // "moduleinterface IFoo "
  assert.deepEqual(labels, ['extends']);
});

// ---- C1: connection endpoint completion ----

const CONN_SRC = `simple Leaf {
  gates:
    input in;
    output out;
}
channel C1 {
}
module Net {
  gates:
    input netIn;
  submodules:
    a: Leaf;
    b: Leaf;
  connections:

    a.out -->
    a.
    a.out --> C1 -->
    c:
}
`;

test('completion: connections line start offers submodules + enclosing gates, no channels without an arrow', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 14); // blank line right after "connections:"
  assert.ok(labels.includes('a') && labels.includes('b'), 'submodule names offered');
  assert.ok(labels.includes('netIn'), "enclosing type's own gate offered");
  assert.ok(!labels.includes('in') && !labels.includes('out'), "submodule's own gates not offered here");
  assert.ok(!labels.includes('C1'), 'no channel type without an arrow on the line');
});

test('completion: right after a single arrow offers submodules/gates and channel types', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 15); // "    a.out -->"
  assert.ok(labels.includes('a') && labels.includes('b') && labels.includes('netIn'));
  assert.ok(labels.includes('C1'), 'channel type offered with exactly one arrow on the line');
});

test('completion: after a dotted submodule reference offers only that submodule\'s gates', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 16); // "    a."
  assert.deepEqual(labels.sort(), ['in', 'out']);
  assert.ok(!labels.includes('a') && !labels.includes('b') && !labels.includes('C1'), 'not submodule/channel names');
});

test('completion: with a second arrow already present, channel types are withheld', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 17); // "    a.out --> C1 -->"
  assert.ok(labels.includes('a') && labels.includes('b'));
  assert.ok(!labels.includes('C1'), 'channel type withheld once more than one arrow is present');
});

test('completion: after a trailing channel-name colon offers channel types (not gates)', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 18); // "    c:"
  assert.ok(labels.includes('C1'));
  assert.ok(!labels.includes('in') && !labels.includes('out'), 'gate names are not channel-type candidates');
  assert.ok(!labels.includes('a') && !labels.includes('b'), 'submodule names are not channel-type candidates');
});

test('completion: bare "connections" keyword offers allowunconnected', async () => {
  const src = 'module Net4 {\n  connections\n}\n';
  const cache = await nedCache({ 'file:///ac.ned': src });
  const labels = completeAt(cache, 'file:///ac.ned', 1); // "  connections"
  assert.deepEqual(labels, ['allowunconnected']);
});

// ---- C6: `if` completion in the submodules section ----

const IF_SRC = `simple Leaf { }
moduleinterface ILeaf { }
module Net5 {
  submodules:
    a: Leaf${' '}
    b: <default("Leaf")> like ILeaf${' '}
}
`;

test('completion: "if" offered right after a submodule\'s type name', async () => {
  const cache = await nedCache({ 'file:///if.ned': IF_SRC });
  const labels = completeAt(cache, 'file:///if.ned', 4); // "    a: Leaf "
  assert.deepEqual(labels, ['if']);
});

test('completion: "if" offered right after a `like Interface` clause', async () => {
  const cache = await nedCache({ 'file:///if.ned': IF_SRC });
  const labels = completeAt(cache, 'file:///if.ned', 5); // '    b: <default("Leaf")> like ILeaf '
  assert.deepEqual(labels, ['if']);
});

// ---- C2 + C7: expression-context member-access completion + built-in library ----
//
// Each fixture below is a SYNTACTICALLY COMPLETE NED file (no unclosed parens/dots)
// so the tree parses cleanly with no ERROR nodes; the cursor is then placed
// mid-line, right after the trigger substring (`this.`, `sizeof(`, `a.`, `= `),
// while the rest of the line (whatever text follows the cursor in the buffer)
// is left untouched. `nedCompletion` only looks at the prefix up to the cursor
// for its trigger regexes, but resolving submodule/type info needs a genuinely
// valid parse tree at that position — an earlier version used truncated/unclosed
// lines, which tree-sitter's error recovery sometimes turned into a single ERROR
// blob spanning far more of the file than the incomplete line itself.
function completeAfter(cache: NedResourceCache, uri: string, lineIdx: number, marker: string): string[] {
  const file = cache.getFile(uri)!;
  const lines = file.tree.rootNode.text.split('\n');
  const line = lines[lineIdx];
  const character = line.indexOf(marker) + marker.length;
  assert.ok(character >= marker.length, `marker ${JSON.stringify(marker)} not found on line ${lineIdx}`);
  return nedCompletion(cache, file, file.tree, { line: lineIdx, character }, line).map((i) => i.label);
}

test('completion: "this." offers the submodule\'s own parameter names', async () => {
  const src = `simple Leaf {
  parameters:
    int leafParam = 1;
}
module Net6 {
  parameters:
    int ownParam = 1;
  submodules:
    host: Leaf {
      parameters:
        leafParam = this.leafOther;
    }
}
`;
  const cache = await nedCache({ 'file:///this.ned': src });
  const labels = completeAfter(cache, 'file:///this.ned', 10, 'this.'); // "        leafParam = this.leafOther;"
  assert.ok(labels.includes('leafParam'), "submodule's own param offered");
  assert.ok(!labels.includes('ownParam'), "enclosing type's param not offered for this.");
  assert.ok(labels.includes('true') && labels.includes('sizeof'), 'expression built-ins offered too');
});

test('completion: "sizeof(" offers gate + submodule names of the enclosing type', async () => {
  const src = `simple Leaf {
}
module Net6 {
  gates:
    input netIn;
  submodules:
    a: Leaf;
  parameters:
    int gcount = sizeof(a);
}
`;
  const cache = await nedCache({ 'file:///sizeof.ned': src });
  const labels = completeAfter(cache, 'file:///sizeof.ned', 8, 'sizeof('); // "    int gcount = sizeof(a);"
  assert.ok(labels.includes('netIn'), "enclosing type's gate offered");
  assert.ok(labels.includes('a'), "enclosing type's submodule offered");
});

test('completion: dotted submodule reference inside an expression offers that submodule\'s params', async () => {
  const src = `simple Leaf {
  parameters:
    int leafParam = 1;
  gates:
    input in;
}
module Net6 {
  submodules:
    a: Leaf;
  parameters:
    int viaSub = a.leafParam;
}
`;
  const cache = await nedCache({ 'file:///viasub.ned': src });
  const labels = completeAfter(cache, 'file:///viasub.ned', 10, 'a.'); // "    int viaSub = a.leafParam;"
  assert.ok(labels.includes('leafParam'), "resolved submodule's param offered");
  assert.ok(!labels.includes('in'), 'gates not offered outside sizeof(...)');
});

test('completion: bare assignment RHS offers the enclosing type\'s params + constants/keywords/distribution templates', async () => {
  const src = `module Net6 {
  parameters:
    int ownParam = 1;
    int bare = true;
}
`;
  const cache = await nedCache({ 'file:///bare.ned': src });
  const labels = completeAfter(cache, 'file:///bare.ned', 3, '= '); // "    int bare = true;"
  assert.ok(labels.includes('ownParam'), "enclosing type's own param offered");
  // constants (Keywords.java BOOL_CONSTANTS) and keywords (NED_EXPR_KEYWORDS)
  assert.ok(['false', 'true', 'nan', 'inf', 'undefined', 'null', 'nullptr'].every((c) => labels.includes(c)));
  assert.ok(['sizeof', 'const', 'default', 'ask', 'this', 'parent', 'index', 'typename'].every((k) => labels.includes(k)));
  // spot-check exact template transcriptions against NedCompletionHelper.java
  assert.ok(labels.includes('const(x)') && labels.includes('default(x)') && labels.includes('sizeof(gateOrSubmod)'));
  assert.ok(labels.includes('normal(mean, stddev)'), 'continuous distribution template');
  assert.ok(labels.includes('normal(mean, stddev, rngNum)'), 'continuous distribution ...Ext (RNG index) variant');
  assert.ok(labels.includes('bernoulli(p)'), 'discrete distribution template');
  assert.ok(labels.includes('bernoulli(p, rngNum)'), 'discrete distribution ...Ext (RNG index) variant');
  assert.ok(labels.includes('fullPath()') && labels.includes('simTime()'), 'reflection/misc function templates');
  assert.ok(labels.includes('ancestorIndex(int)'), 'reflection function template with argument');
});

test('completion: a non-expression parameters-section position does NOT offer expression built-ins', async () => {
  const src = 'simple Base { parameters: int capacity; }\nsimple D extends Base {\n  parameters:\n    \n}\n';
  const cache = await nedCache({ 'file:///neg.ned': src });
  const labels = completeAt(cache, 'file:///neg.ned', 3); // blank line inside parameters, no '=' on the line
  assert.ok(labels.includes('capacity'), 'still offers the normal parameter-body bundle');
  assert.ok(!labels.includes('true') && !labels.includes('sizeof'), 'no expression constants/keywords leak in');
  assert.ok(!labels.includes('normal(mean, stddev)'), 'no distribution templates leak in');
});

// ---- C8: whole-block skeleton / topology snippet library ----
// Ported from NedCompletionHelper.java's proposedNedGlobalTempl/
// proposedNedSubmoduleTempl/proposedNedConnectionTempl. Each test checks the
// skeleton labels coexist with the pre-existing (C1/C6) candidates for the same
// context, not replace them.

test('completion: file top level offers module/simple/network/channel skeletons alongside the keywords', async () => {
  const cache = await nedCache({ 'file:///skel.ned': '\n' });
  const labels = completeAt(cache, 'file:///skel.ned', 0);
  // pre-existing top-level keyword candidates still present
  assert.ok(labels.includes('simple') && labels.includes('module') && labels.includes('import'));
  // new whole-block skeleton snippets, additive
  for (const n of ['simple1', 'simple2', 'simple3', 'module1', 'module2', 'module3',
    'moduleinterface', 'network1', 'channel1', 'channel2', 'channelinterface',
    'moduletree', 'modulemesh', 'moduletrimesh', 'modulehexmesh']) {
    assert.ok(labels.includes(n), `missing global skeleton ${n}`);
  }
});

test('completion: `types:` section offers the same module/type skeletons alongside inner-type keywords', async () => {
  const src = 'module Outer {\n  types:\n    \n}\n';
  const cache = await nedCache({ 'file:///types.ned': src });
  const labels = completeAt(cache, 'file:///types.ned', 2); // blank line inside types:
  assert.ok(labels.includes('simple') && labels.includes('module') && labels.includes('channel'));
  assert.ok(labels.includes('simple1') && labels.includes('module1') && labels.includes('network1'));
});

test('completion: `import` keyword is NOT duplicated among `types:` section keywords', async () => {
  const src = 'module Outer {\n  types:\n    \n}\n';
  const cache = await nedCache({ 'file:///types2.ned': src });
  const labels = completeAt(cache, 'file:///types2.ned', 2);
  assert.ok(!labels.includes('import'), '`import` is only valid at file top level, not inside types:');
});

test('completion: empty line in `submodules:` section offers submodule skeleton snippets', async () => {
  const src = 'simple Leaf { }\nmodule Net7 {\n  submodules:\n    \n}\n';
  const cache = await nedCache({ 'file:///subskel.ned': src });
  const labels = completeAt(cache, 'file:///subskel.ned', 3); // blank line in submodules:
  for (const n of ['submodule1', 'submodule2', 'submodule3', 'submodule4', 'submodule5']) {
    assert.ok(labels.includes(n), `missing submodule skeleton ${n}`);
  }
});

test('completion: empty line in `connections:` section offers topology snippets alongside submodule/gate candidates', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 14); // blank line right after "connections:"
  // pre-existing (C1) candidates for this same context still present
  assert.ok(labels.includes('a') && labels.includes('b') && labels.includes('netIn'));
  // new topology skeleton snippets, additive
  assert.ok(labels.includes('connection1'), 'one-way-pair template offered');
  assert.ok(labels.includes('connection2'), 'inout-pair template offered');
  assert.ok(labels.includes('connection5'), 'channel-mediated template offered');
  for (const n of ['forloop', 'forbus', 'forstar', 'forchain', 'forfullgraph', 'forrandomgraph', 'forring']) {
    assert.ok(labels.includes(n), `missing for-loop topology template ${n}`);
  }
});

test('completion: connection topology snippets are withheld right after an arrow', async () => {
  const cache = await nedCache({ 'file:///c.ned': CONN_SRC });
  const labels = completeAt(cache, 'file:///c.ned', 15); // "    a.out -->"
  assert.ok(labels.includes('C1'), 'channel type still offered here (pre-existing C1 behavior)');
  assert.ok(!labels.includes('connection1'), 'no whole-block templates right after an arrow');
  assert.ok(!labels.includes('forbus'), 'no for-loop templates right after an arrow');
});

test('completion: skeleton snippet bodies match NedCompletionHelper.java\'s templates (spot-check)', async () => {
  const globalCache = await nedCache({ 'file:///skel2.ned': '\n' });
  const globalFile = globalCache.getFile('file:///skel2.ned')!;
  const globalItems = nedCompletion(globalCache, globalFile, globalFile.tree, { line: 0, character: 0 }, '');
  const byGlobalLabel = new Map(globalItems.map((i) => [i.label, i]));

  const simple1 = byGlobalLabel.get('simple1')!;
  assert.ok(simple1, 'simple1 present');
  assert.ok(simple1.insertText!.includes('simple ${1:SomeModule}'), 'simple1: type name is tabstop 1');
  assert.ok(simple1.insertText!.includes('parameters:$0'), 'simple1: ${cursor} -> final tabstop $0');
  assert.ok(simple1.insertText!.includes('gates:'), 'simple1: has a gates: section');

  const connCache = await nedCache({ 'file:///c2.ned': CONN_SRC });
  const connFile = connCache.getFile('file:///c2.ned')!;
  const connLines = connFile.tree.rootNode.text.split('\n');
  const connLine = connLines[14]; // blank line right after "connections:"
  const connItems = nedCompletion(connCache, connFile, connFile.tree, { line: 14, character: connLine.length }, connLine);
  const byConnLabel = new Map(connItems.map((i) => [i.label, i]));

  // connection1: "two one-way connections" — mod1/mod2 are LINKED tabstops (same
  // number reused on the repeated occurrence), matching Eclipse's variable linking.
  const connection1 = byConnLabel.get('connection1')!;
  assert.ok(connection1, 'connection1 present');
  assert.strictEqual(
    connection1.insertText,
    '${1:mod1}.${2:outgate1} --> ${3:mod2}.${4:ingate2};\n$1.${5:ingate1} <-- $3.${6:outgate2};',
  );

  // connection3: the Eclipse-side "$$i"/"$$o" escape (literal "$i"/"$o" subgate
  // suffixes for an inout gate) must survive as an escaped literal dollar, not be
  // (mis)parsed as an LSP snippet variable reference.
  const connection3 = byConnLabel.get('connection3')!;
  assert.ok(connection3, 'connection3 present');
  assert.ok(connection3.insertText!.includes('\\$i;'), 'connection3: $$i -> escaped literal \\$i');
  assert.ok(connection3.insertText!.includes('\\$o;'), 'connection3: $$o -> escaped literal \\$o');

  // forbus: the loop variable "i" is linked across all three uses.
  const forbus = byConnLabel.get('forbus')!;
  assert.ok(forbus, 'forbus present');
  assert.strictEqual(
    forbus.insertText,
    'for ${1:i} = 0..${2:n}-1 {\n    ${3:node1}.${4:out}[$1] --> ${5:node2}.${6:in}[$1];\n}$0',
  );
});
