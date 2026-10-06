import { test } from 'bun:test';
import assert from 'node:assert';
import { configSummaries, fileUri, parseIni } from '@omnetpp/shared';
import { ProjectIndex } from '../projectIndex';
import { MemFS, getParsers } from './memIndex';

const INI_PATH = '/proj/omnetpp.ini';
const INI_URI = fileUri(INI_PATH);
const DISK_TEXT = '[General]\nnetwork = Net\n';
const BUFFER_TEXT = '[General]\nnetwork = Other\n[Config A]\n[Config B]\n';
const configCount = (text: string): number => configSummaries(parseIni(text)).length;

test('an INI file open during the startup scan is indexed from its buffer, then from disk once closed', async () => {
  const fs = new MemFS();
  fs.set('/proj/Nets.ned', 'network Net { }\nnetwork Other { }', 1000);
  fs.set(INI_PATH, DISK_TEXT, 1000);
  const idx = new ProjectIndex(fs, await getParsers(), '/no-config-dir');
  let open = true;
  idx.setOpenPredicate((u) => open && u === INI_URI);
  await idx.initialize(['/proj'], []);
  assert.equal(idx.iniCache.getText(INI_URI), undefined, 'the scan leaves open files to the editor');

  idx.updateOpenIniDocument(INI_URI, BUFFER_TEXT);
  assert.equal(idx.iniCache.getText(INI_URI), BUFFER_TEXT);
  assert.deepEqual(idx.stats().map((s) => [s.iniFiles, s.iniConfigs]), [[1, configCount(BUFFER_TEXT)]]);

  open = false;
  await idx.onFileChanged(INI_URI, false);
  assert.equal(idx.iniCache.getText(INI_URI), DISK_TEXT);
  assert.deepEqual(idx.stats().map((s) => [s.iniFiles, s.iniConfigs]), [[1, configCount(DISK_TEXT)]]);
});
