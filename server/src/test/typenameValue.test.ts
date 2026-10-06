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
  IniResourceCache,
  SemanticDatabase,
  type Location,
} from '@omnetpp/shared';
import { getParsers, posOf } from '../../../shared/src/test/helpers';
import { computeDefinition } from '../features/definition';
import { computeHover } from '../features/hover';
import { computeReferences } from '../features/references';
import { computeRename } from '../features/rename';
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
  const msgCache = new MsgResourceCache();
  const iniCache = new IniResourceCache();
  iniCache.addFile('file:///omnetpp.ini', INI);
  const db = new SemanticDatabase(nedCache, msgCache, registry, iniCache);
  for (const uri of ['file:///net.ned', 'file:///other.ned']) db.onNedFile(uri);
  db.onIniFile('file:///omnetpp.ini');
  const ctx = { nedCache, msgCache, registry, iniCache, db, getIniDoc: (u: string) => iniCache.getDoc(u) } as unknown as IndexContext;
  const parsed: ParsedDocument = { uri: 'file:///omnetpp.ini', language: 'ini', version: 1, text: INI, ini: parseIni(INI, 'file:///omnetpp.ini') };
  return { ctx, parsed, nedCache };
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

function nedDoc(nedCache: NedResourceCache, uri: string, text: string): ParsedDocument {
  return { uri, language: 'ned', version: 1, text, tree: nedCache.getFile(uri)!.tree };
}

test('references to a NED type include INI typename values; references from the value list the type usages', async () => {
  const { ctx, parsed, nedCache } = await setup();
  const fromNed = computeReferences(nedDoc(nedCache, 'file:///net.ned', NED), posOf(NED, 'Twin like'), false, ctx);
  assert.ok(fromNed.some((l) => l.uri === 'file:///omnetpp.ini' && l.range.start.line === 2));
  const fromIni = computeReferences(parsed, posOf(INI, '"Twin"', 1), true, ctx);
  assert.ok(fromIni.some((l) => l.uri === 'file:///net.ned'), 'declaration');
  assert.ok(fromIni.some((l) => l.uri === 'file:///omnetpp.ini' && l.range.start.line === 2), 'the value itself');
  const fromOther = computeReferences(nedDoc(nedCache, 'file:///other.ned', OTHER_NED), posOf(OTHER_NED, 'Twin like'), false, ctx);
  assert.ok(!fromOther.some((l) => l.uri === 'file:///omnetpp.ini'), 'the a slot (IApp) cannot hold other.Twin');
});

test('renaming a NED type renames the INI typename values that can denote it', async () => {
  const { ctx, nedCache } = await setup();
  const edit = computeRename(nedDoc(nedCache, 'file:///net.ned', NED), posOf(NED, 'Twin like'), 'Triplet', ctx)!;
  const iniEdits = edit.changes!['file:///omnetpp.ini'];
  assert.equal(iniEdits?.length, 1);
  const line = INI.split('\n')[2];
  assert.equal(line.slice(iniEdits[0].range.start.character, iniEdits[0].range.end.character), 'Twin');
});

test('renaming a NED network renames the INI network= value that runs it', async () => {
  const { ctx, nedCache } = await setup();
  const edit = computeRename(nedDoc(nedCache, 'file:///net.ned', NED), posOf(NED, 'TNet {'), 'Lan', ctx)!;
  const iniEdits = edit.changes!['file:///omnetpp.ini'];
  assert.equal(iniEdits?.length, 1);
  assert.equal(iniEdits[0].range.start.line, 1);
  assert.equal(iniEdits[0].newText, 'Lan');
});
