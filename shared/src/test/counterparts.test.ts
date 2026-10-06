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
  findCounterparts,
  nextCounterpart,
  type CounterpartResult,
} from '../index';

interface Project {
  ned?: Record<string, string>;
  cpp?: Record<string, string>;
  /** Files that exist on disk but are not indexed. */
  other?: string[];
}

async function build(p: Project) {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const cppCache = new CppResourceCache();
  const db = new SemanticDatabase(nedCache, new MsgResourceCache(), new ConfigRegistry(), new IniResourceCache(), cppCache);
  for (const [uri, text] of Object.entries(p.ned ?? {})) {
    nedCache.addFile(uri, svc.parse('ned', text), '');
    db.onNedFile(uri);
  }
  for (const [uri, text] of Object.entries(p.cpp ?? {})) {
    cppCache.addFile(uri, text);
    db.onCppFile(uri);
  }
  const files = new Set([...Object.keys(p.ned ?? {}), ...Object.keys(p.cpp ?? {}), ...(p.other ?? [])]);
  return (uri: string, position?: { line: number; character: number }) =>
    findCounterparts(db, uri, position, async (u) => files.has(u));
}

const uris = (r: CounterpartResult) => ({
  cc: r.cc.map((t) => t.uri),
  h: r.h.map((t) => t.uri),
  ned: r.ned.map((t) => t.uri),
});

const INET_NED = `
package inet.apps;
@namespace(inet);
simple Foo {
  parameters:
    double interval;
}
`;
const INET_H = `
namespace inet {
class INET_API Foo : public cSimpleModule {
  virtual void initialize() override;
};
}
`;
const INET_CC = `
#include "Foo.h"
namespace inet {
Define_Module(Foo);
void Foo::initialize() { par("interval"); }
}
`;

test('ring .cc → .h → .ned → .cc over semantic matches', async () => {
  const find = await build({
    ned: { 'file:///p/Foo.ned': INET_NED },
    cpp: { 'file:///p/Foo.h': INET_H, 'file:///p/Foo.cc': INET_CC },
  });

  const fromCc = await find('file:///p/Foo.cc');
  assert.equal(fromCc.kind, 'cc');
  assert.deepEqual(uris(fromCc), { cc: [], h: ['file:///p/Foo.h'], ned: ['file:///p/Foo.ned'] });
  assert.equal(fromCc.h[0].label, 'inet::Foo');
  assert.deepEqual(fromCc.h[0].range?.start, { line: 2, character: 15 });
  assert.equal(nextCounterpart(fromCc)?.kind, 'h');

  const fromH = await find('file:///p/Foo.h');
  assert.deepEqual(uris(fromH), { cc: ['file:///p/Foo.cc'], h: [], ned: ['file:///p/Foo.ned'] });
  assert.equal(fromH.ned[0].label, 'inet.apps.Foo');
  assert.equal(nextCounterpart(fromH)?.kind, 'ned');

  const fromNed = await find('file:///p/Foo.ned');
  assert.deepEqual(uris(fromNed), { cc: ['file:///p/Foo.cc'], h: ['file:///p/Foo.h'], ned: [] });
  assert.deepEqual(fromNed.cc[0].range?.start, { line: 3, character: 14 });
  assert.equal(nextCounterpart(fromNed)?.kind, 'cc');
});

test('@class pairs a NED type with differently named C++ files', async () => {
  const find = await build({
    ned: { 'file:///p/ned/Router.ned': 'package p; simple Router { @class(RouterImpl); }' },
    cpp: {
      'file:///p/src/RouterImpl.h': 'class RouterImpl : public cSimpleModule {};',
      'file:///p/src/RouterImpl.cc': 'Define_Module(RouterImpl);',
    },
    other: ['file:///p/ned/Router.cc'],
  });
  const fromNed = await find('file:///p/ned/Router.ned');
  assert.deepEqual(uris(fromNed), { cc: ['file:///p/src/RouterImpl.cc'], h: ['file:///p/src/RouterImpl.h'], ned: [] });
  const fromCc = await find('file:///p/src/RouterImpl.cc');
  assert.deepEqual(fromCc.ned.map((t) => t.uri), ['file:///p/ned/Router.ned']);
});

test('several modules in one NED file: the cursor picks one, else all', async () => {
  const ned = 'package p;\nsimple A {\n}\nsimple B {\n}\nnetwork Net {\n}\n';
  const find = await build({
    ned: { 'file:///p/all.ned': ned },
    cpp: { 'file:///p/A.cc': 'Define_Module(A);', 'file:///p/B.cc': 'Define_Module(B);' },
  });
  assert.deepEqual((await find('file:///p/all.ned', { line: 3, character: 3 })).cc.map((t) => t.uri), ['file:///p/B.cc']);
  assert.deepEqual((await find('file:///p/all.ned', { line: 5, character: 3 })).cc.map((t) => t.uri), [
    'file:///p/A.cc',
    'file:///p/B.cc',
  ]);
  assert.deepEqual((await find('file:///p/all.ned')).cc.length, 2);
});

test('several Define_Module in one .cc lead to several NED files', async () => {
  const find = await build({
    ned: { 'file:///p/A.ned': 'package p; simple A {}', 'file:///p/B.ned': 'package p; simple B {}' },
    cpp: { 'file:///p/AB.cc': 'Define_Module(A);\nDefine_Module(B);' },
  });
  const r = await find('file:///p/AB.cc');
  assert.deepEqual(r.ned.map((t) => t.uri).sort(), ['file:///p/A.ned', 'file:///p/B.ned']);
  assert.equal(nextCounterpart(r)?.kind, 'ned');
});

test('same-basename fallback, and a missing header is skipped in the ring', async () => {
  const find = await build({
    ned: { 'file:///p/Gen.ned': 'package p; module Gen {}' },
    cpp: { 'file:///p/Gen.cc': 'void helper() {}' },
    other: ['file:///p/Gen.hpp'],
  });
  const fromCc = await find('file:///p/Gen.cc');
  assert.deepEqual(uris(fromCc), { cc: [], h: ['file:///p/Gen.hpp'], ned: ['file:///p/Gen.ned'] });
  assert.equal(fromCc.h[0].range, undefined);
  assert.equal(fromCc.h[0].label, 'Gen.hpp');

  const noHeader = await build({
    ned: { 'file:///q/Sink.ned': 'package q; simple Sink {}' },
    cpp: { 'file:///q/Sink.cc': 'class Sink : public cSimpleModule {};\nDefine_Module(Sink);' },
  });
  const r = await noHeader('file:///q/Sink.cc');
  assert.deepEqual(uris(r), { cc: [], h: [], ned: ['file:///q/Sink.ned'] });
  assert.equal(nextCounterpart(r)?.kind, 'ned');
});

test('a derived NED type without @class navigates to the base type C++ class', async () => {
  const find = await build({
    ned: {
      'file:///p/Base.ned': 'package p; simple Base {}',
      'file:///p/Derived.ned': 'package p; simple Derived extends Base {}',
    },
    cpp: { 'file:///p/Base.cc': 'Define_Module(Base);', 'file:///p/Base.h': 'class Base : public cSimpleModule {};' },
  });
  const r = await find('file:///p/Derived.ned');
  assert.deepEqual(uris(r), { cc: ['file:///p/Base.cc'], h: ['file:///p/Base.h'], ned: [] });
});

test('copies of a header: the one named like the module files is preferred', async () => {
  const find = await build({
    ned: { 'file:///p/udp/Udp.ned': 'package p; @namespace(inet); simple Udp {}' },
    cpp: {
      'file:///p/udp/Udp.cc': 'namespace inet { Define_Module(Udp); }',
      'file:///p/udp/Udp.h': 'namespace inet { class INET_API Udp {}; }',
      'file:///p/tutorial/Udp_orig.h': 'namespace inet { class INET_API Udp {}; }',
    },
  });
  assert.deepEqual((await find('file:///p/udp/Udp.ned')).h.map((t) => t.uri), ['file:///p/udp/Udp.h']);
  assert.deepEqual((await find('file:///p/udp/Udp.cc')).h.map((t) => t.uri), ['file:///p/udp/Udp.h']);
});

test('nested classes of two headers do not pair the headers', async () => {
  const find = await build({
    cpp: {
      'file:///p/Ipv4.h': 'namespace inet { class INET_API Ipv4 { struct SocketDescriptor {}; }; }',
      'file:///p/Ipv6.h': 'namespace inet { class INET_API Ipv6 { struct SocketDescriptor {}; }; }',
    },
  });
  assert.deepEqual((await find('file:///p/Ipv4.h')).h, []);
});

test('one class serving several NED types: the same-named type wins, else all', async () => {
  const find = await build({
    ned: {
      'file:///p/Iface.ned': 'package p; simple Iface {}',
      'file:///p/WlanIface.ned': 'package p; simple WlanIface { @class(Iface); }',
      'file:///p/Omitted1.ned': 'package p; simple Omitted1 { @class(Omitted); }',
      'file:///p/Omitted2.ned': 'package p; simple Omitted2 { @class(Omitted); }',
    },
    cpp: { 'file:///p/Iface.cc': 'Define_Module(Iface);', 'file:///p/Omitted.cc': 'Define_Module(Omitted);' },
  });
  assert.deepEqual((await find('file:///p/Iface.cc')).ned.map((t) => t.uri), ['file:///p/Iface.ned']);
  assert.equal((await find('file:///p/Omitted.cc')).ned.length, 2);
});

test('a multi-module NED file without cursor prefers the same-named module', async () => {
  const find = await build({
    ned: { 'file:///p/Foo.ned': 'package p;\nsimple Foo {\n}\nsimple Other {\n  @class(OtherImpl);\n}\n' },
    cpp: { 'file:///p/Foo.cc': 'Define_Module(Foo);', 'file:///q/OtherImpl.cc': 'Define_Module(OtherImpl);' },
  });
  assert.deepEqual((await find('file:///p/Foo.ned')).cc.map((t) => t.uri), ['file:///p/Foo.cc']);
  assert.deepEqual((await find('file:///p/Foo.ned', { line: 4, character: 4 })).cc.map((t) => t.uri), ['file:///q/OtherImpl.cc']);
});

test('generated and unrelated files have no counterparts', async () => {
  const find = await build({ cpp: { 'file:///p/Foo.cc': INET_CC } });
  assert.equal((await find('file:///p/Foo_m.h')).kind, null);
  assert.equal((await find('file:///p/omnetpp.ini')).kind, null);
  assert.equal(nextCounterpart(await find('file:///p/Foo_m.h')), null);
});
