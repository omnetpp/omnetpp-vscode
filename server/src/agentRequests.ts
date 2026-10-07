import type { Connection } from 'vscode-languageserver/node';
import { OmnetppMethods, type ProjectFactsResult } from '@omnetpp/shared';
import { ServerState } from './serverState';

/** Serves the facts that the "Set Up AI Agents" command writes into AGENTS.md. */
export function registerAgentRequests(connection: Connection, state: ServerState): void {
  connection.onRequest(OmnetppMethods.projectFacts, (): ProjectFactsResult => {
    const index = state.index;
    if (!index) return { ready: false, nedRoots: [], iniFiles: [] };
    return {
      ready: !index.scanning,
      nedRoots: index.stats().map((r) => r.dir),
      iniFiles: index.iniCache.allDocs().map((d) => d.uri),
    };
  });
}
