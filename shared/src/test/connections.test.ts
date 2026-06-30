import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  nedSemanticDiagnostics,
} from '../index';
import type { ParserService } from '../index';

async function cacheWith(files: Record<string, string>): Promise<NedResourceCache> {
  const svc: ParserService = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

const codes = (cache: NedResourceCache, uri: string) =>
  nedSemanticDiagnostics(cache, uri).map((d) => d.code);

const HOST = 'simple Host { gates: inout g; input in; output out; }\n';

test('NedTypeInfo.connections() models endpoints, direction and channel', async () => {
  const cache = await cacheWith({
    'file:///N.ned':
      HOST +
      'network N {\n submodules: a: Host; b: Host;\n connections:\n' +
      '  a.out --> ned.DelayChannel --> b.in;\n' +
      '  a.g <--> b.g;\n}',
  });
  const conns = cache.getType('N')!.connections();
  assert.equal(conns.length, 2);

  const [c0, c1] = conns;
  assert.equal(c0.direction, '-->');
  assert.equal(c0.src.module, 'a');
  assert.equal(c0.src.gate, 'out');
  assert.equal(c0.dest.module, 'b');
  assert.equal(c0.dest.gate, 'in');
  assert.equal(c0.channel?.typeName, 'ned.DelayChannel');

  assert.equal(c1.direction, '<-->');
  assert.equal(c1.src.gate, 'g');
});

test('valid connections produce no connection diagnostics', async () => {
  const cache = await cacheWith({
    'file:///N.ned':
      HOST +
      'module M {\n gates: input pin; output pout;\n submodules: a: Host; b: Host;\n connections:\n' +
      '  pin --> a.in;\n' +       // parent input as source: ok
      '  a.out --> b.in;\n' +     // submodule output→input: ok
      '  b.out --> pout;\n' +     // submodule output → parent output: ok
      '  a.g <--> b.g;\n}',       // inout bidirectional: ok
  });
  assert.deepEqual(codes(cache, 'file:///N.ned'), []);
});

test('unknown gate and unknown channel type are flagged', async () => {
  const cache = await cacheWith({
    'file:///N.ned':
      HOST +
      'network N {\n submodules: a: Host; b: Host;\n connections:\n' +
      '  a.nope --> b.in;\n' +                 // unknown-gate
      '  a.out --> Bogus --> b.in;\n}',        // unknown-channel-type
  });
  const c = codes(cache, 'file:///N.ned');
  assert.ok(c.includes('unknown-gate'), `expected unknown-gate in ${c}`);
  assert.ok(c.includes('unknown-channel-type'), `expected unknown-channel-type in ${c}`);
});

test('gate index on a scalar gate is flagged', async () => {
  const cache = await cacheWith({
    'file:///N.ned':
      HOST +
      'network N {\n submodules: a: Host; b: Host;\n connections:\n' +
      '  a.out++ --> b.in;\n}',                // out is scalar
  });
  assert.ok(codes(cache, 'file:///N.ned').includes('gate-index-on-scalar'));
});

test('direction mismatch: two outputs connected', async () => {
  const cache = await cacheWith({
    'file:///N.ned':
      HOST +
      'network N {\n submodules: a: Host; b: Host;\n connections:\n' +
      '  a.out --> b.out;\n}',                 // b.out (output) used as dest
  });
  assert.ok(codes(cache, 'file:///N.ned').includes('gate-direction-mismatch'));
});

test('connections through `like` submodules and channels are not falsely flagged', async () => {
  const cache = await cacheWith({
    'file:///N.ned':
      HOST +
      'moduleinterface IHost { gates: inout g; }\n' +
      'network N {\n submodules: a: Host; h: <> like IHost;\n connections:\n' +
      '  a.g <--> h.g;\n}',                    // h is a like submodule → opaque, unchecked
  });
  // h.g cannot be validated (opaque), a.g is inout → no false positives
  assert.deepEqual(codes(cache, 'file:///N.ned'), []);
});
