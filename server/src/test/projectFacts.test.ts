import { test } from 'bun:test';
import assert from 'node:assert';
import type { Connection } from 'vscode-languageserver/node';
import { OmnetppMethods, type ProjectFactsResult } from '@omnetpp/shared';
import { registerAgentRequests } from '../agentRequests';
import { ProjectIndex } from '../projectIndex';
import { ServerState } from '../serverState';
import { MemFS, getParsers } from './memIndex';

function projectFactsHandler(state: ServerState): () => ProjectFactsResult {
  let handler: (() => ProjectFactsResult) | undefined;
  const connection = {
    onRequest: (method: string, h: () => ProjectFactsResult) => {
      if (method === OmnetppMethods.projectFacts) handler = h;
    },
  } as unknown as Connection;
  registerAgentRequests(connection, state);
  return handler!;
}

test('projectFacts reports the scanned NED roots and INI files', async () => {
  const fs = new MemFS();
  fs.set('/proj/.nedfolders', 'src\nsimulations\n', 1);
  fs.set('/proj/src/A.ned', 'simple A { }', 1);
  fs.set('/proj/simulations/Net.ned', 'network Net { }', 1);
  fs.set('/proj/simulations/omnetpp.ini', '[General]\nnetwork = Net\n', 1);
  fs.set('/lib/L.ned', 'simple L { }', 1);
  const state = new ServerState();
  state.index = new ProjectIndex(fs, await getParsers(), '/no-config-dir', 'linux');
  await state.index.initialize(['/proj'], ['/lib']);

  const facts = projectFactsHandler(state)();
  assert.equal(facts.ready, true);
  assert.deepEqual([...facts.nedRoots].sort(), ['/lib', '/proj/simulations', '/proj/src']);
  assert.deepEqual(facts.iniFiles, ['file:///proj/simulations/omnetpp.ini']);
});

test('projectFacts is not ready before the index exists', () => {
  assert.deepEqual(projectFactsHandler(new ServerState())(), { ready: false, nedRoots: [], iniFiles: [] });
});
