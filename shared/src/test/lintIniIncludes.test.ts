import { test } from 'bun:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  ConfigRegistry,
  IniResourceCache,
  MsgResourceCache,
  NedResourceCache,
  SemanticDatabase,
  fileUri,
  lintFile,
  type ToolContext,
} from '../index';
import type { FileSystem, FileStat } from '../fs/fileSystem';

const FILES: Record<string, string> = {
  '/proj/omnetpp.ini': [
    'include base.ini',
    'include ../other/common.ini',
    'include missing.ini',
    '[Config A]',
    'extends = Base',
    'Net.host.mod = "x"',
    '[Config B]',
    'extends = Common',
    '',
  ].join('\n'),
  // indexed; its own bad key must not be reported when linting omnetpp.ini
  '/proj/base.ini': '[General]\nnetwork = Net\nNet.host.zzz = 1\n[Config Base]\n',
  // outside every NED folder, so only on disk
  '/other/common.ini': '[Config Common]\n',
};

const fs: FileSystem = {
  async readFile(path: string): Promise<string> {
    if (path in FILES) return FILES[path];
    throw new Error(`ENOENT: ${path}`);
  },
  async readDirectory(): Promise<string[]> {
    return [];
  },
  async stat(): Promise<FileStat> {
    return { isFile: true, isDirectory: false };
  },
  async exists(path: string): Promise<boolean> {
    return path in FILES;
  },
};

async function buildCtx(): Promise<ToolContext> {
  const parsers = await getParsers();
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const configRegistry = new ConfigRegistry([]);
  const iniCache = new IniResourceCache();
  const db = new SemanticDatabase(nedCache, msgCache, configRegistry, iniCache);
  nedCache.addFile(BUILTIN_URI, parsers.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile(
    fileUri('/proj/Net.ned'),
    parsers.parse('ned', 'simple Host { parameters: string mode; }\nnetwork Net { submodules: host: Host; }'),
    '',
  );
  for (const p of ['/proj/omnetpp.ini', '/proj/base.ini']) iniCache.addFile(fileUri(p), FILES[p]);
  return {
    nedCache,
    msgCache,
    configRegistry,
    db,
    iniCache,
    fs,
    parsers,
    toUri: (p) => fileUri(p),
    toPath: (u) => fileURLToPath(u),
  };
}

test('lintFile expands INI includes like the IDE does', async () => {
  const { diagnostics } = await lintFile(fileUri('/proj/omnetpp.ini'), await buildCtx());
  const found = diagnostics.map((d) => `${d.range.start.line}:${d.code}`).sort();
  assert.deepEqual(found, [
    '2:include-not-found', // missing.ini
    '5:no-matching-param', // network Net comes from the included [General]
  ]);
});
