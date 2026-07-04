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
  handleTool,
  ToolContext,
  nedTypeSym,
  cppSym,
  nedMemberSym,
} from '../index';
import type { FileSystem, FileStat } from '../fs/fileSystem';

const NED = `
package demo;
@namespace(demo);
simple Foo {
  parameters:
    double interval;
  gates:
    input in;
}
`;

const CPP = `
namespace demo {
void Foo::initialize() {
  double x = par("interval");
  gate("in")->getId();
}
Define_Module(Foo);
}
`;

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
  return { svc, nedCache, cppCache, db };
}

function addNed(ctx: Awaited<ReturnType<typeof build>>) {
  ctx.nedCache.addFile('file:///Foo.ned', ctx.svc.parse('ned', NED), 'demo');
  ctx.db.onNedFile('file:///Foo.ned');
}
function addCpp(ctx: Awaited<ReturnType<typeof build>>) {
  ctx.cppCache.addFile('file:///Foo.cc', CPP);
  ctx.db.onCppFile('file:///Foo.cc');
}

const intervalKey = { kind: 'param' as const, ownerFq: 'demo.Foo', name: 'interval' };
const inKey = { kind: 'gate' as const, ownerFq: 'demo.Foo', name: 'in' };

function assertLinked(db: SemanticDatabase) {
  // NED type -> C++ class
  assert.deepEqual(db.findImplClass('demo.Foo')?.qualifiedName, 'demo::Foo');
  // reverse: cpp class inbound has the ned-impl edge
  const implInbound = db.index.inboundOf(cppSym('demo::Foo')).filter((e) => e.kind === 'ned-impl');
  assert.equal(implInbound.length, 1);
  assert.equal(implInbound[0].from, nedTypeSym('demo.Foo'));
  // member accesses resolved
  assert.equal(db.findCppMemberAccesses(intervalKey).length, 1);
  assert.equal(db.findCppMemberAccesses(inKey).length, 1);
  // reverse index keyed on the member symbol
  assert.equal(db.index.inboundOf(nedMemberSym(intervalKey)).length, 1);
}

test('C++↔NED links resolve when NED is indexed first', async () => {
  const ctx = await build();
  addNed(ctx);
  addCpp(ctx);
  assertLinked(ctx.db);
});

test('C++↔NED links resolve when C++ is indexed first', async () => {
  const ctx = await build();
  addCpp(ctx);
  addNed(ctx);
  assertLinked(ctx.db);
});

test('dropping the C++ file removes accesses and demotes ned-impl to pending', async () => {
  const ctx = await build();
  addNed(ctx);
  addCpp(ctx);
  assertLinked(ctx.db);

  ctx.cppCache.removeFile('file:///Foo.cc');
  ctx.db.dropFile('file:///Foo.cc');
  assert.equal(ctx.db.findImplClass('demo.Foo'), null);
  assert.equal(ctx.db.findCppMemberAccesses(intervalKey).length, 0);

  // re-adding restores the links
  addCpp(ctx);
  assertLinked(ctx.db);
});

test('renaming a NED parameter drops the stale C++ access count', async () => {
  const ctx = await build();
  addCpp(ctx);
  addNed(ctx);
  assert.equal(ctx.db.findCppMemberAccesses(intervalKey).length, 1);

  // rename `interval` -> `period` in NED; the C++ still reads "interval"
  ctx.nedCache.addFile(
    'file:///Foo.ned',
    ctx.svc.parse('ned', NED.replace('double interval;', 'double period;')),
    'demo',
  );
  ctx.db.onNedFile('file:///Foo.ned');
  assert.equal(ctx.db.findCppMemberAccesses(intervalKey).length, 0);
  assert.equal(ctx.db.findCppMemberAccesses({ ...intervalKey, name: 'period' }).length, 0); // C++ reads old name
});

test('find_member_accesses tool reports impl class and per-member access counts', async () => {
  const ctx = await build();
  addNed(ctx);
  addCpp(ctx);
  const memFs: FileSystem = {
    async readFile() {
      throw new Error('ENOENT');
    },
    async readDirectory() {
      return [];
    },
    async stat(): Promise<FileStat> {
      return { isFile: true, isDirectory: false };
    },
    async exists() {
      return false;
    },
  };
  const toolCtx: ToolContext = {
    nedCache: ctx.nedCache,
    msgCache: ctx.db.msgCache,
    configRegistry: ctx.db.configRegistry,
    db: ctx.db,
    iniCache: ctx.db.iniCache,
    fs: memFs,
    parsers: ctx.svc,
    toUri: (s) => s,
    toPath: (s) => s,
  };
  const res = (await handleTool('find_member_accesses', { fqName: 'demo.Foo' }, toolCtx)) as {
    implClass: { qualifiedName: string } | null;
    members: { kind: string; name: string; accesses: unknown[] }[];
  };
  assert.equal(res.implClass?.qualifiedName, 'demo::Foo');
  const interval = res.members.find((m) => m.name === 'interval');
  assert.equal(interval?.accesses.length, 1);
  const gate = res.members.find((m) => m.name === 'in');
  assert.equal(gate?.accesses.length, 1);
});

test('unattributed accesses and non-literal args are ignored', async () => {
  const ctx = await build();
  ctx.nedCache.addFile('file:///Foo.ned', ctx.svc.parse('ned', NED), 'demo');
  ctx.db.onNedFile('file:///Foo.ned');
  ctx.cppCache.addFile(
    'file:///g.cc',
    `namespace demo {\nDefine_Module(Foo);\nvoid Foo::f(){ par(dynamicName); }\n}\n`,
  );
  ctx.db.onCppFile('file:///g.cc');
  assert.equal(ctx.db.findCppMemberAccesses(intervalKey).length, 0);
});
