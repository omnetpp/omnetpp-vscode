import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  DisplayString, Prop, parseDisplayString, unquoteNedString, displayStringLiteralOf,
  EMPTY_DEFAULTS, VARIABLE_DEFAULTS,
} from '../ned/displayStringModel';
import { topLevelTypes, submoduleNodes, connectionNodes } from '../ned/nedAst';

// ---- parseDisplayString -----------------------------------------------------

test('display model: basic tag/arg parsing preserves order and empty args', () => {
  const tags = parseDisplayString('p=100,50;i=device/pc,red,30;b=,24');
  assert.deepEqual([...tags.keys()], ['p', 'i', 'b']);
  assert.deepEqual(tags.get('p'), ['100', '50']);
  assert.deepEqual(tags.get('i'), ['device/pc', 'red', '30']);
  assert.deepEqual(tags.get('b'), ['', '24']);
});

test('display model: trailing tag without = and unknown tags are kept', () => {
  const tags = parseDisplayString('i=block/sink;x');
  assert.ok(tags.has('x'));
  assert.deepEqual(tags.get('x'), []);
});

test('display model: backslash escapes ; = , inside arguments', () => {
  const tags = parseDisplayString('t=a\\;b\\,c\\=d;tt=next');
  assert.deepEqual(tags.get('t'), ['a;b,c=d']);
  assert.deepEqual(tags.get('tt'), ['next']);
});

test('display model: ${...} expressions are carried verbatim, nesting-aware', () => {
  const tags = parseDisplayString('i=${expr(a,{b;c})},red;t=x');
  assert.deepEqual(tags.get('i'), ['${expr(a,{b;c})}', 'red']);
  assert.deepEqual(tags.get('t'), ['x']);
});

// ---- defaults, antivalue, variables, fallback chain --------------------------

test('display model: EMPTY_DEFAULTS fill in absent arguments', () => {
  const ds = new DisplayString('i=block/sink');
  assert.equal(ds.getAsString(Prop.IMAGE), 'block/sink');
  assert.equal(ds.getAsString(Prop.IMAGE_COLOR_PERCENTAGE), '30'); // from i=,,30
  assert.equal(ds.getAsString(Prop.SHAPE_FILL_COLOR), '#8080ff'); // from b defaults
  assert.equal(ds.getAsString(Prop.CONNECTION_STYLE), 'solid');
  assert.equal(new DisplayString().getAsString(Prop.MODULE_FILL_COLOR), 'grey82');
});

test('display model: $param values resolve to VARIABLE_DEFAULTS placeholders', () => {
  const ds = new DisplayString('i=$iconName;t=$label');
  assert.equal(ds.getAsString(Prop.IMAGE), 'abstract/server');
  assert.equal(ds.getAsString(Prop.TEXT), 'Sample text');
  assert.ok(ds.isVariable(Prop.IMAGE));
  assert.ok(!ds.isVariable(Prop.TEXT_COLOR));
  // with variable defaults off, the raw $ value comes through
  assert.equal(ds.getAsString(Prop.IMAGE, true, false), '$iconName');
});

test('display model: fallback chain resolves like the IDE (submodule → type → supertype)', () => {
  const superType = new DisplayString('i=abstract/router;is=l');
  const type = new DisplayString('i=device/router', superType);
  const submodule = new DisplayString('p=10,20', type);
  assert.equal(submodule.getAsString(Prop.IMAGE), 'device/router'); // nearest wins
  assert.equal(submodule.getAsString(Prop.IMAGE_SIZE), 'l'); // inherited from supertype
  assert.deepEqual(submodule.getLocation(), { x: 10, y: 20 });
  assert.ok(submodule.containsTag('is'));
  assert.ok(!submodule.containsTag('r'));
});

test('display model: "-" antivalue neutralizes an inherited value', () => {
  const base = new DisplayString('b=40,24,rect,red');
  const derived = new DisplayString('b=,,,-', base);
  assert.equal(derived.getAsString(Prop.SHAPE_FILL_COLOR), '#8080ff'); // EMPTY default, not red
  assert.equal(derived.getAsString(Prop.SHAPE_FILL_COLOR, false, true), '');
  assert.equal(derived.getAsString(Prop.SHAPE_WIDTH), '40'); // other args still inherit
});

// ---- typed getters ------------------------------------------------------------

test('display model: size mirroring when one b dimension is missing', () => {
  assert.deepEqual(new DisplayString('b=50').getSize(), { width: 50, height: 50 });
  assert.deepEqual(new DisplayString('b=,30').getSize(), { width: 30, height: 30 });
  assert.deepEqual(new DisplayString('b=50,30').getSize(), { width: 50, height: 30 });
  // no b tag anywhere: EMPTY defaults 40x24
  assert.deepEqual(new DisplayString('i=block/sink').getSize(), { width: 40, height: 24 });
});

test('display model: compound size, range and numeric getters', () => {
  const ds = new DisplayString('bgb=600,400;r=150,,red,2');
  assert.deepEqual(ds.getCompoundSize(), { width: 600, height: 400 });
  assert.equal(ds.getRange(), 150);
  assert.equal(ds.getAsInt(Prop.RANGE_BORDER_WIDTH, 1), 2);
  assert.deepEqual(new DisplayString('bgb=300').getCompoundSize(), { width: 300, height: undefined });
  assert.equal(new DisplayString().getRange(), undefined); // r default has no radius
  assert.equal(new DisplayString().getLocation(), undefined); // unpinned
});

test('display model: enum shorthand matching is reverse-order like EnumSpec', () => {
  assert.equal(new DisplayString('ls=,,da').getAsEnum(Prop.CONNECTION_STYLE), 'dashed');
  assert.equal(new DisplayString('ls=,,d').getAsEnum(Prop.CONNECTION_STYLE), 'dotted');
  assert.equal(new DisplayString('p=,,ri').getAsEnum(Prop.LAYOUT), 'ring');
  assert.equal(new DisplayString('p=,,r').getAsEnum(Prop.LAYOUT), 'row');
  assert.equal(new DisplayString('p=,,x').getAsEnum(Prop.LAYOUT), 'exact');
  assert.equal(new DisplayString('b=,,o').getAsEnum(Prop.SHAPE), 'oval');
  assert.equal(new DisplayString('is=vl').getAsEnum(Prop.IMAGE_SIZE), 'very large');
  assert.equal(new DisplayString('is=vs').getAsEnum(Prop.IMAGE_SIZE), 'very small');
  assert.equal(new DisplayString('m=m').getAsEnum(Prop.ROUTING_CONSTRAINT), 'manual');
});

// ---- NED literal unescaping ---------------------------------------------------

test('display model: unquoteNedString interprets NED escapes, keeps display escapes', () => {
  assert.equal(unquoteNedString('"plain"'), 'plain');
  assert.equal(unquoteNedString('"a\\\\;b"'), 'a\\;b'); // \\ → \, ; stays: display-level escape
  assert.equal(unquoteNedString('"tab\\there"'), 'tab\there');
  assert.equal(unquoteNedString('"q\\"q"'), 'q"q');
  assert.equal(unquoteNedString('"\\x41"'), 'A');
  assert.equal(unquoteNedString('"a\\;b"'), 'a\\;b'); // illegal NED escape kept verbatim
});

test('display model: double-backslash NED source round-trips to an escaped separator', () => {
  // NED source @display("t=a\\;b"): literal is a\;b → display parser sees escaped ;
  const literal = unquoteNedString('"t=a\\\\;b"');
  const tags = parseDisplayString(literal);
  assert.deepEqual(tags.get('t'), ['a;b']);
});

// ---- AST extraction -------------------------------------------------------------

const NED = `module Foo extends Bar
{
    parameters:
        @display("bgb=600,400;bgg=100,2,grey");
    submodules:
        sub: Node {
            parameters:
                @display("p=100,50;i=device/pc,red,30");
        }
        router: <default("Router")> like INode { @display("p=200,50"); }
        plain: Node;
    connections:
        sub.g++ <--> Eth { @display("ls=blue,2"); } <--> router.g++;
        sub.g++ --> router.g++;
}
`;

test('display model: displayStringLiteralOf extracts type/submodule/connection values', async () => {
  const svc = await getParsers();
  const tree = svc.parse('ned', NED);
  const [foo] = topLevelTypes(tree);
  assert.equal(displayStringLiteralOf(foo), 'bgb=600,400;bgg=100,2,grey');

  const [sub, router, plain] = submoduleNodes(foo);
  assert.equal(displayStringLiteralOf(sub), 'p=100,50;i=device/pc,red,30');
  assert.equal(displayStringLiteralOf(router), 'p=200,50');
  assert.equal(displayStringLiteralOf(plain), undefined);

  const [withChannel, bare] = connectionNodes(foo);
  assert.equal(displayStringLiteralOf(withChannel), 'ls=blue,2');
  assert.equal(displayStringLiteralOf(bare), undefined);
});

test('display model: defaults tables parse cleanly', () => {
  assert.equal(EMPTY_DEFAULTS.tagArg('b', 2), 'rect');
  assert.equal(VARIABLE_DEFAULTS.tagArg('ls', 2), 'dashed');
});
