import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  IniResourceCache,
  SemanticDatabase,
  nedUnusedNetworkDiagnostics,
  suggestSimilar,
} from '../index';

async function setup(iniText?: string) {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const iniCache = new IniResourceCache();
  const db = new SemanticDatabase(nedCache, msgCache, new ConfigRegistry(), iniCache);
  nedCache.addFile('file:///Net.ned', svc.parse('ned', 'network Net { }\nnetwork Other { }'), '');
  db.onNedFile('file:///Net.ned');
  if (iniText !== undefined) {
    iniCache.addFile('file:///omnetpp.ini', iniText);
    db.onIniFile('file:///omnetpp.ini');
  }
  return { nedCache, iniCache, db };
}

test('unused-network hint: flagged only when an INI exists and no config runs it', async () => {
  // no INI files at all → suppressed (pure NED library)
  const a = await setup(undefined);
  assert.equal(nedUnusedNetworkDiagnostics(a.db, a.nedCache, a.iniCache, 'file:///Net.ned').length, 0);

  // an INI runs Net but not Other → only Other is flagged
  const b = await setup('[Config R]\nnetwork = Net\n');
  const diags = nedUnusedNetworkDiagnostics(b.db, b.nedCache, b.iniCache, 'file:///Net.ned');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Other/);
  assert.equal(diags[0].code, 'unused-network');
});

test('suggestSimilar returns near-miss candidates ranked by edit distance', () => {
  // short target (<=4 chars) → threshold 1; both within distance 1, ranked then sorted
  assert.deepEqual(suggestSimilar('Host', ['Hosts', 'Hose', 'Server']), ['Hose', 'Hosts']);
  // longer target → threshold 2 allows a transposition
  assert.deepEqual(suggestSimilar('Netwrok', ['Network', 'Channel']), ['Network']);
  // nothing within the threshold
  assert.deepEqual(suggestSimilar('Foo', ['Completely', 'Different']), []);
  // exact match is not suggested
  assert.deepEqual(suggestSimilar('Net', ['Net', 'Nets']), ['Nets']);
});
