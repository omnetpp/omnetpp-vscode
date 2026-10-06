import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  IniResourceCache,
  CppResourceCache,
  SemanticDatabase,
  nedMissingImplClassDiagnostics,
} from '../index';

async function build() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const cppCache = new CppResourceCache();
  const db = new SemanticDatabase(
    nedCache,
    new MsgResourceCache(),
    new ConfigRegistry(),
    new IniResourceCache(),
    cppCache,
  );
  const addNed = (uri: string, text: string, pkg = 'demo') => {
    nedCache.addFile(uri, svc.parse('ned', text), pkg);
    db.onNedFile(uri);
  };
  const addCpp = (uri: string, text: string) => {
    cppCache.addFile(uri, text);
    db.onCppFile(uri);
  };
  return { db, nedCache, cppCache, addNed, addCpp };
}

const HDR = 'package demo;\n@namespace(demo);\n';

test('no warning when the C++ class is registered with Define_Module', async () => {
  const ctx = await build();
  ctx.addCpp('file:///Foo.cc', 'namespace demo { Define_Module(Foo); }');
  ctx.addNed('file:///Foo.ned', `${HDR}simple Foo { }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 0);
});

test('warns on the type name when no @class and no Define_Module', async () => {
  const ctx = await build();
  ctx.addCpp('file:///Other.cc', 'namespace demo { Define_Module(Other); }'); // C++ exists, but not Foo
  ctx.addNed('file:///Foo.ned', `${HDR}simple Foo { }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'missing-cpp-class');
  assert.equal(d[0].severity, 2 /* Warning */);
  // anchored on the `Foo` name token (line 2: `simple Foo { }`)
  assert.equal(d[0].range.start.line, 2);
  assert.ok(/Define_Module\('Foo'\)/.test(d[0].message));
});

test('warns on the @class value when it names an unregistered class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(SomethingElse); }');
  ctx.addNed('file:///Foo.ned', `${HDR}simple Foo {\n  @class(Bar);\n}`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 1);
  // anchored on the @class(Bar) value on line 3
  assert.equal(d[0].range.start.line, 3);
  assert.ok(/C\+\+ class 'Bar'/.test(d[0].message));
});

test('no warning when @class points to a Register_Class / Register_Abstract_Class', async () => {
  const ctx = await build();
  ctx.addCpp(
    'file:///reg.cc',
    'namespace demo { Register_Class(Concrete); Register_Abstract_Class(AbstractBase); }',
  );
  ctx.addNed(
    'file:///Foo.ned',
    `${HDR}simple Uses { @class(Concrete); }\nsimple UsesAbstract { @class(AbstractBase); }`,
  );
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 0);
  assert.equal(ctx.db.findImplClass('demo.Uses')?.qualifiedName, 'demo::Concrete');
  assert.equal(ctx.db.findImplClass('demo.UsesAbstract')?.qualifiedName, 'demo::AbstractBase');
});

test('no warning when a supertype provides the C++ class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///Base.cc', 'namespace demo { Define_Module(Base); }');
  ctx.addNed('file:///lib.ned', `${HDR}simple Base { }\nsimple Derived extends Base { }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///lib.ned');
  // Base is registered; Derived reuses it via the chain → neither warns
  assert.equal(d.length, 0);
});

test('suppressed entirely when the workspace has no indexed C++', async () => {
  const ctx = await build();
  ctx.addNed('file:///Foo.ned', `${HDR}simple Foo { }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 0);
});

test('only simple modules are checked (compound/network are exempt)', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(Anything); }');
  ctx.addNed('file:///Net.ned', `${HDR}module Comp { }\nnetwork Net { }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Net.ned');
  assert.equal(d.length, 0);
});

test('a quoted @class("Name") value finds the registered class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(X2AppServer); }');
  ctx.addNed('file:///Foo.ned', `${HDR}simple Foo {\n  @class("X2AppServer");\n}`);
  assert.equal(ctx.db.findImplClass('demo.Foo')?.qualifiedName, 'demo::X2AppServer');
  assert.equal(nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned').length, 0);
});

test('a quoted unregistered @class value is reported without its quotes', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(SomethingElse); }');
  ctx.addNed('file:///Foo.ned', `${HDR}simple Foo {\n  @class("Bar");\n}`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 1);
  assert.ok(/C\+\+ class 'Bar'/.test(d[0].message));
  // `  @class("Bar");` → the name spans columns 10..13, inside the quotes
  assert.deepEqual(d[0].range, { start: { line: 3, character: 10 }, end: { line: 3, character: 13 } });
});

test('@class(-) and @class("-") mark an abstract type with no C++ class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(SomethingElse); }');
  ctx.addNed('file:///Foo.ned', `${HDR}simple Bare { @class(-); }\nsimple Quoted { @class("-"); }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Foo.ned');
  assert.equal(d.length, 0);
});

test('a subtype of an @class(-) type inherits the abstract marker', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(SomethingElse); }');
  ctx.addNed('file:///Base.ned', `${HDR}simple Base { @class(-); }`);
  ctx.addNed('file:///Derived.ned', `${HDR}simple Derived extends Base { }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Derived.ned');
  assert.equal(d.length, 0);
});

test('a subtype of an @class(-) type is checked when it declares its own @class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(SomethingElse); }');
  ctx.addNed('file:///Base.ned', `${HDR}simple Base { @class(-); }`);
  ctx.addNed('file:///Derived.ned', `${HDR}simple Derived extends Base { @class(Impl); }`);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Derived.ned');
  assert.equal(d.length, 1);
  assert.ok(/C\+\+ class 'Impl'/.test(d[0].message));
});
