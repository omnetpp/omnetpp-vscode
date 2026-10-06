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
  resolveNedClass,
} from '../index';
import { cppSym, nedTypeSym } from '../xref/symbolId';

async function build() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const cppCache = new CppResourceCache();
  const db = new SemanticDatabase(nedCache, msgCache, new ConfigRegistry(), new IniResourceCache(), cppCache);
  const addNed = (uri: string, text: string) => {
    nedCache.addFile(uri, svc.parse('ned', text));
    db.onNedFile(uri);
  };
  const removeNed = (uri: string) => {
    nedCache.removeFile(uri);
    db.dropFile(uri);
  };
  const addCpp = (uri: string, text: string) => {
    cppCache.addFile(uri, text);
    db.onCppFile(uri);
  };
  const addMsg = (uri: string, text: string) => {
    msgCache.addFile(uri, svc.parse('msg', text));
    db.onMsgFile(uri);
  };
  const implEdgeTarget = (fq: string) =>
    db.index.outboundOf(nedTypeSym(fq)).find((e) => e.kind === 'ned-impl')?.to ?? null;
  return { db, nedCache, msgCache, addNed, removeNed, addCpp, addMsg, implEdgeTarget };
}

// A global class with the same simple name: what an unqualified lookup would pick.
const CPP = 'Define_Module(Server);\nnamespace aloha { Define_Module(Server); }';

test('the @namespace of package.ned qualifies the implementation class', async () => {
  const ctx = await build();
  ctx.addCpp('file:///w/Server.cc', CPP);
  ctx.addNed('file:///w/aloha/package.ned', 'package aloha;\n@namespace(aloha);');
  ctx.addNed('file:///w/aloha/Server.ned', 'package aloha;\nsimple Server { }');
  assert.equal(ctx.db.findImplClass('aloha.Server')?.qualifiedName, 'aloha::Server');
  assert.equal(ctx.implEdgeTarget('aloha.Server'), cppSym('aloha::Server'));
});

test('a package.ned indexed after the type re-resolves its edges', async () => {
  const ctx = await build();
  ctx.addCpp('file:///w/Server.cc', CPP);
  ctx.addNed('file:///w/aloha/Server.ned', 'package aloha;\nsimple Server { }');
  assert.equal(ctx.implEdgeTarget('aloha.Server'), cppSym('Server'));
  ctx.addNed('file:///w/aloha/package.ned', 'package aloha;\n@namespace(aloha);');
  assert.equal(ctx.implEdgeTarget('aloha.Server'), cppSym('aloha::Server'));
  ctx.removeNed('file:///w/aloha/package.ned');
  assert.equal(ctx.implEdgeTarget('aloha.Server'), cppSym('Server'));
});

test('the nearest parent package.ned supplies the namespace', async () => {
  const ctx = await build();
  ctx.addCpp('file:///w/Server.cc', 'namespace outer { Define_Module(Server); }\nnamespace inner { Define_Module(Server); }');
  ctx.addNed('file:///w/a/package.ned', 'package a;\n@namespace(outer);');
  ctx.addNed('file:///w/a/b/c/Server.ned', 'package a.b.c;\nsimple Server { }');
  assert.equal(ctx.db.findImplClass('a.b.c.Server')?.qualifiedName, 'outer::Server');
  ctx.addNed('file:///w/a/b/package.ned', 'package a.b;\n@namespace(inner);');
  assert.equal(ctx.db.findImplClass('a.b.c.Server')?.qualifiedName, 'inner::Server');
});

test("a file's own @namespace wins over package.ned", async () => {
  const ctx = await build();
  ctx.addCpp('file:///w/Server.cc', 'namespace pkg { Define_Module(Server); }\nnamespace own { Define_Module(Server); }');
  ctx.addNed('file:///w/p/package.ned', 'package p;\n@namespace(pkg);');
  ctx.addNed('file:///w/p/Server.ned', 'package p;\n@namespace(own);\nsimple Server { }');
  assert.equal(ctx.db.findImplClass('p.Server')?.qualifiedName, 'own::Server');
});

test('@class resolves to a MSG type via the package.ned namespace', async () => {
  const ctx = await build();
  ctx.addMsg('file:///w/a.msg', 'message Packet {}\nnamespace aloha;\nmessage Packet {}');
  ctx.addNed('file:///w/aloha/package.ned', 'package aloha;\n@namespace(aloha);');
  ctx.addNed('file:///w/aloha/Host.ned', 'package aloha;\nsimple Host {\n  @class(Packet);\n}');
  const host = ctx.nedCache.getType('aloha.Host')!;
  assert.equal(resolveNedClass(ctx.msgCache, host, 'Packet')?.fqName, 'aloha::Packet');
});
