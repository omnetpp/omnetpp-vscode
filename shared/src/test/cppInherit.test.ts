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
  const addNed = (uri: string, text: string) => {
    nedCache.addFile(uri, svc.parse('ned', text), 'demo');
    db.onNedFile(uri);
  };
  const addCpp = (uri: string, text: string) => {
    cppCache.addFile(uri, text);
    db.onCppFile(uri);
  };
  return { db, nedCache, cppCache, addNed, addCpp };
}

const HDR = 'package demo;\n@namespace(demo);\n';

test('a derived simple module inherits the root type\'s default C++ class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///Base.cc', 'namespace demo { Define_Module(Base); }');
  ctx.addNed('file:///lib.ned', `${HDR}simple Base { }\nsimple Mid extends Base { }\nsimple Leaf extends Mid { }`);
  // every level resolves to Base's class (the only Define_Module in the chain)
  for (const fq of ['demo.Base', 'demo.Mid', 'demo.Leaf']) {
    assert.equal(ctx.db.findImplClass(fq)?.qualifiedName, 'demo::Base', fq);
  }
});

test('the nearest @class up the chain wins over an ancestor default', async () => {
  const ctx = await build();
  ctx.addCpp('file:///impl.cc', 'namespace demo { Define_Module(Base); Define_Module(MidImpl); }');
  ctx.addNed(
    'file:///lib.ned',
    `${HDR}simple Base { }\nsimple Mid extends Base {\n  @class(MidImpl);\n}\nsimple Leaf extends Mid { }`,
  );
  assert.equal(ctx.db.findImplClass('demo.Base')?.qualifiedName, 'demo::Base');
  // Mid overrides with @class(MidImpl); Leaf inherits Mid's @class, not Base's name
  assert.equal(ctx.db.findImplClass('demo.Mid')?.qualifiedName, 'demo::MidImpl');
  assert.equal(ctx.db.findImplClass('demo.Leaf')?.qualifiedName, 'demo::MidImpl');
});

test('a derived module does NOT expect a Define_Module named after itself', async () => {
  const ctx = await build();
  ctx.addCpp('file:///Base.cc', 'namespace demo { Define_Module(Base); }');
  ctx.addNed('file:///lib.ned', `${HDR}simple Base { }\nsimple Derived extends Base { }`);
  // no Define_Module(Derived) exists, yet Derived is fully resolved (via Base) and
  // therefore produces no missing-class warning
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///lib.ned');
  assert.equal(d.length, 0);
  assert.equal(ctx.db.findImplClass('demo.Derived')?.qualifiedName, 'demo::Base');
});

test('a root simple module with no @class and no Define_Module is unresolved', async () => {
  const ctx = await build();
  ctx.addCpp('file:///other.cc', 'namespace demo { Define_Module(Other); }');
  ctx.addNed('file:///Root.ned', `${HDR}simple Root { }`);
  assert.equal(ctx.db.findImplClass('demo.Root'), null);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///Root.ned');
  assert.equal(d.length, 1);
  assert.ok(/Define_Module\('Root'\)/.test(d[0].message));
});

test('an unresolved base type suppresses resolution (no false warning)', async () => {
  const ctx = await build();
  ctx.addCpp('file:///x.cc', 'namespace demo { Define_Module(Something); }');
  // Base is not indexed; Derived extends it → class is unknown, not "Derived"
  ctx.addNed('file:///d.ned', `${HDR}simple Derived extends UnknownBase { }`);
  assert.equal(ctx.db.findImplClass('demo.Derived'), null);
  const d = nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, 'file:///d.ned');
  assert.equal(d.length, 0); // cannot determine → no warning
});
