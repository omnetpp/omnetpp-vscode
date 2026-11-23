import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { collectNeddoc } from '../neddoc/generate';

// Every way a NED type names another: extends, a submodule type, a `like` interface,
// a connection channel. With the library missing from the NED path, all four are unresolved.
const APP = `package app;
import lib.Base;
import lib.Node;
import lib.IApp;
import lib.Cable;
simple Derived extends Base { }
network Net
{
    submodules:
        n: Node;
        a: <> like IApp;
        d: Derived;
    connections allowunconnected:
        n.g <--> Cable <--> d.g;
}
`;
const LIB = `package lib;
simple Base { gates: inout g; }
simple Node { gates: inout g; }
moduleinterface IApp { }
channel Cable { }
`;

async function result(withLibrary: boolean) {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///app/Net.ned', svc.parse('ned', APP), '');
  if (withLibrary) nedCache.addFile('file:///lib/Lib.ned', svc.parse('ned', LIB), '');
  const { result } = await collectNeddoc({ nedCache, isTargetUri: (uri) => uri.startsWith('file:///app/') }, {});
  return result;
}

test('unresolved NED type references are reported, without counting as warnings', async () => {
  const r = await result(false);
  const unresolved = r.externalWarnings.filter((w) => w.includes('unresolved'));
  assert.equal(unresolved.length, 1, r.externalWarnings.join('\n'));
  assert.match(unresolved[0], /^4 references to unresolved NED types \(Base, Cable, IApp, Node\)/);
  assert.match(unresolved[0], /--ned-path/);
  assert.deepEqual(r.warnings, []);
});

test('no unresolved-type report when the library is indexed', async () => {
  const r = await result(true);
  assert.deepEqual(r.externalWarnings.filter((w) => w.includes('unresolved')), []);
});
