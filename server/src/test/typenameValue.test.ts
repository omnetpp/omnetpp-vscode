import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  ConfigRegistry,
  MsgResourceCache,
  NedResourceCache,
  parseIni,
  type Location,
} from '@omnetpp/shared';
import { getParsers, posOf } from '../../../shared/src/test/helpers';
import { computeDefinition } from '../features/definition';
import { computeHover } from '../features/hover';
import type { IndexContext } from '../features/context';
import type { ParsedDocument } from '../documentModel';

const NED = `
moduleinterface IApp { }
moduleinterface IOther { }
simple Twin like IApp { }
network TNet { submodules: a: <> like IApp; }
`;
const OTHER_NED = `package other;
import IOther;
simple Twin like IOther { }
`;
const INI = `[General]
network = TNet
**.a.typename = "Twin"
**.b.typename = "\${t}"
`;

async function setup() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///net.ned', svc.parse('ned', NED), '');
  nedCache.addFile('file:///other.ned', svc.parse('ned', OTHER_NED), 'other');
  const registry = new ConfigRegistry(
    JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
  );
  const ctx = { nedCache, msgCache: new MsgResourceCache(), registry, getIniDoc: () => undefined } as unknown as IndexContext;
  const parsed: ParsedDocument = { uri: 'file:///omnetpp.ini', language: 'ini', version: 1, text: INI, ini: parseIni(INI, 'file:///omnetpp.ini') };
  return { ctx, parsed };
}

test('INI typename value navigates only to types implementing the slot interface', async () => {
  const { ctx, parsed } = await setup();
  const def = computeDefinition(parsed, posOf(INI, '"Twin"', 1), ctx);
  const locs = (Array.isArray(def) ? def : def ? [def] : []) as Location[];
  assert.deepEqual(locs.map((l) => l.uri), ['file:///net.ned']);
});

test('INI typename value hover shows the resolved type; variable-driven values get none', async () => {
  const { ctx, parsed } = await setup();
  const hov = computeHover(parsed, posOf(INI, '"Twin"', 1), ctx);
  assert.ok(hov);
  assert.match(hov!.markdown, /simple Twin like IApp/);
  assert.equal(computeHover(parsed, posOf(INI, '"${t}"', 1), ctx), null);
});
