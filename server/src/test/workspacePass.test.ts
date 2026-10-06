import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert';
import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { fileUri } from '@omnetpp/shared';
import { ProjectIndex } from '../projectIndex';
import { ServerState } from '../serverState';
import { registerWorkspaceDiagnostics } from '../workspaceDiagnostics';
import { MemFS, getParsers } from './memIndex';

const dup = (type: string, param: string) => `simple ${type} { parameters: int ${param}; int ${param}; }`;
const uri = (name: string) => fileUri(`/proj/${name}`);

// Each performance.now() call moves past the 20 ms slice budget, so every slice
// processes exactly one file and the test can act between slices.
const realNow = performance.now.bind(performance);
beforeEach(() => {
  let t = 0;
  performance.now = () => (t += 25);
});
afterEach(() => {
  performance.now = realNow;
});

function register(idx: ProjectIndex): { published: Map<string, string[]>; pass: () => void } {
  const state = new ServerState();
  state.index = idx;
  state.workspaceFolders = ['/proj'];
  state.iconIdsCache = [];
  const published = new Map<string, string[]>();
  const connection = {
    sendDiagnostics: (p: { uri: string; diagnostics: { message: string }[] }) =>
      published.set(p.uri, p.diagnostics.map((d) => d.message)),
  } as unknown as Connection;
  const documents = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
  const api = registerWorkspaceDiagnostics(connection, documents, state);
  return { published, pass: () => api.publishWorkspaceDiagnostics() };
}

async function setup(): Promise<{ idx: ProjectIndex; published: Map<string, string[]>; pass: () => void }> {
  const fs = new MemFS();
  for (const n of ['A', 'B', 'C']) fs.set(`/proj/${n}.ned`, dup(n, 'n'), 1000);
  const idx = new ProjectIndex(fs, await getParsers(), '/no-config-dir');
  idx.setOpenPredicate(() => false);
  await idx.initialize(['/proj'], []);
  return { idx, ...register(idx) };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('a file replaced between slices is checked in its current version', async () => {
  const { idx, published, pass } = await setup();
  pass(); // first slice: A
  idx.updateOpenDocument(uri('C.ned'), dup('C', 'm')); // frees C's old tree
  await settle();
  assert.deepEqual([...published.keys()].sort(), [uri('A.ned'), uri('B.ned'), uri('C.ned')]);
  assert.deepEqual(published.get(uri('C.ned')), ["Duplicate parameter 'm'"]);
});

class StallingFS extends MemFS {
  stalled: string | undefined;
  release: () => void = () => {};
  override async readFile(path: string): Promise<string> {
    if (path === this.stalled) await new Promise<void>((r) => (this.release = r));
    return super.readFile(path);
  }
}

test('no pass runs on the half-built index while a reindex scans', async () => {
  const fs = new StallingFS();
  fs.set('/proj/ANet.ned', 'network ANet { submodules: h: ZHost; }', 1000);
  fs.set('/proj/ZHost.ned', 'simple ZHost { }', 1000);
  const idx = new ProjectIndex(fs, await getParsers(), '/no-config-dir');
  idx.setOpenPredicate(() => false);
  await idx.initialize(['/proj'], []);
  const { published, pass } = register(idx);

  fs.stalled = '/proj/ZHost.ned';
  const reindex = idx.reindex(['/proj'], []);
  while (!idx.cache.getFile(uri('ANet.ned'))) await new Promise((r) => setTimeout(r, 1));
  pass(); // ANet is indexed, ZHost not yet: ANet would show an unresolved type
  await settle();
  fs.release();
  await reindex;
  assert.deepEqual([...published.keys()], []);
});
