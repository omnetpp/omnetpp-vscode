import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers, posOf } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedHover, nedTypeStringDefinition } from '../ned/nedNavigation';
import type { Location } from '../model/location';

async function build(files: Record<string, { text: string; pkg?: string }>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, f] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', f.text), f.pkg ?? '');
  return cache;
}

const LIB = `package lib;
moduleinterface IApp { }
moduleinterface IOther { }
channelinterface IChan { }
simple AppA like IApp { }
simple Twin like IApp { }
channel FastChan like IChan { }`;

const OTHER = `package other;
simple Twin like lib.IOther { }
simple AppA { }`;

function defsAt(cache: NedResourceCache, uri: string, text: string, needle: string, offset = 1): Location[] | null {
  const file = cache.getFile(uri)!;
  return nedTypeStringDefinition(cache, file, file.tree, posOf(text, needle, offset));
}

function targetUris(defs: Location[] | null): string[] {
  return (defs ?? []).map((d) => d.uri).sort();
}

test('like default("X") string navigates to the interface implementor', async () => {
  const T = `package app;
import lib.IApp;
module Host {
  submodules:
    a: <default("AppA")> like IApp;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  const defs = defsAt(cache, 'file:///h.ned', T, '"AppA"');
  assert.deepEqual(targetUris(defs), ['file:///lib.ned'], 'other.AppA does not implement IApp');
  assert.equal(defs![0].range.start.line, 4);
});

test('fixed <"X"> with a fully qualified name navigates to that type', async () => {
  const T = `package app;
module Host {
  submodules:
    a: <"lib.AppA"> like lib.IApp;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  const defs = defsAt(cache, 'file:///h.ned', T, 'AppA"', 0);
  assert.deepEqual(targetUris(defs), ['file:///lib.ned']);
});

test('string in a conditional like expression navigates', async () => {
  const T = `package app;
module Host {
  parameters:
    bool b;
  submodules:
    a: <(b ? "AppA" : "Twin")> like lib.IApp;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  const defs = defsAt(cache, 'file:///h.ned', T, '"Twin"');
  assert.deepEqual(targetUris(defs), ['file:///lib.ned'], 'only lib.Twin implements IApp');
});

test('connection channel like string navigates', async () => {
  const T = `package app;
module Host {
  gates:
    input i; output o;
  connections:
    o --> <default("FastChan")> like lib.IChan --> i;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///h.ned': { text: T } });
  const defs = defsAt(cache, 'file:///h.ned', T, '"FastChan"');
  assert.deepEqual(targetUris(defs), ['file:///lib.ned']);
  assert.equal(defs![0].range.start.line, 6);
});

test('typename assignment in the parameters section uses the submodule interface', async () => {
  const T = `package app;
module Host {
  parameters:
    a.typename = default("Twin");
    b.typename = "Twin";
  submodules:
    a: <> like lib.IApp;
    b: <> like lib.IOther;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  assert.deepEqual(targetUris(defsAt(cache, 'file:///h.ned', T, '"Twin"')), ['file:///lib.ned']);
  assert.deepEqual(targetUris(defsAt(cache, 'file:///h.ned', T, '"Twin";')), ['file:///other.ned']);
});

test('typename assignment in a submodule body uses that submodule interface', async () => {
  const T = `package app;
module Host {
  submodules:
    a: <> like lib.IOther {
      typename = "Twin";
    }
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  assert.deepEqual(targetUris(defsAt(cache, 'file:///h.ned', T, '"Twin"')), ['file:///other.ned']);
});

test('deep typename path walks through submodule types', async () => {
  const T = `package app;
module Inner {
  submodules:
    app: <> like lib.IApp;
}
module Host {
  parameters:
    in.app.typename = "Twin";
  submodules:
    in: Inner;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  assert.deepEqual(targetUris(defsAt(cache, 'file:///h.ned', T, '"Twin"')), ['file:///lib.ned']);
});

test('unresolvable slot falls back to every type with that simple name', async () => {
  const T = `package app;
module Host {
  parameters:
    **.typename = "Twin";
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  assert.deepEqual(targetUris(defsAt(cache, 'file:///h.ned', T, '"Twin"')), ['file:///lib.ned', 'file:///other.ned']);
});

test('a name no type implementing the interface has falls back to every type with that name', async () => {
  const T = `package app;
module Host {
  submodules:
    a: <"AppA"> like lib.IOther;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  assert.deepEqual(targetUris(defsAt(cache, 'file:///h.ned', T, '"AppA"')), ['file:///lib.ned', 'file:///other.ned']);
});

test('strings in ordinary parameters and positions outside the quotes do not navigate', async () => {
  const T = `package app;
module Host {
  parameters:
    string s = "AppA";
  submodules:
    a: <default("AppA")> like lib.IApp;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///h.ned': { text: T } });
  assert.equal(defsAt(cache, 'file:///h.ned', T, '"AppA";'), null);
  assert.equal(defsAt(cache, 'file:///h.ned', T, 'default(', 0), null);
});

test('hover on a type string shows the type signature, or the candidates when ambiguous', async () => {
  const T = `package app;
module Host {
  parameters:
    **.typename = "Twin";
  submodules:
    a: <"AppA"> like lib.IApp;
}`;
  const cache = await build({ 'file:///lib.ned': { text: LIB }, 'file:///other.ned': { text: OTHER }, 'file:///h.ned': { text: T } });
  const file = cache.getFile('file:///h.ned')!;
  const one = nedHover(cache, file, file.tree, posOf(T, '"AppA"', 1));
  assert.ok(one);
  assert.match(one!.markdown, /simple lib\.AppA/);
  const many = nedHover(cache, file, file.tree, posOf(T, '"Twin"', 1));
  assert.ok(many);
  assert.match(many!.markdown, /lib\.Twin/);
  assert.match(many!.markdown, /other\.Twin/);
});
