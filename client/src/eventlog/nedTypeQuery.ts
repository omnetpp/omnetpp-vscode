/**
 * nedTypeQuery.ts (phase U8) -- resolves NED type names to their type-level property
 * names through the language server's MCP surface (`omnetpp/mcp/callTool` /
 * `get_ned_type`, the same path `nedPreviewPanel.ts` uses for its type list). Serves
 * the Sequence Chart webview's `nedTypeQuery` messages (see `uiProtocol.ts`): the
 * "Network Node"/"Network Interface" preset configurations check each module's NED
 * type for `@networkNode`/`@networkInterface`/`@wireJunction`, mirroring
 * `SequenceChartContributor.collectAxisModules()`'s NEDResources lookups.
 *
 * One `get_ned_type` call per unique type name, cached process-wide by fq-name (NED
 * type properties are static per index generation; a stale cache after an edit merely
 * affects a cosmetic preset -- acceptable, and the cache is bounded by the number of
 * distinct types ever queried). A type the index can't resolve (unknown name, no NED
 * index at all) caches `null` -- the webview degrades gracefully.
 */

import type { LanguageClient } from 'vscode-languageclient/node';
import { OmnetppMethods } from '@omnetpp/shared/protocol';

const cache = new Map<string, string[] | null>();

/** Exposed for tests/manual cache-busting (e.g. a future "refresh NED index" hook); not currently called from production code. */
export function clearNedTypePropertyCache(): void {
  cache.clear();
}

/**
 * Maps each of `typeNames` to its type-level NED property names (without the `@`),
 * or `null` when unresolvable. Never rejects: a missing/broken language client
 * resolves everything to `null`.
 */
export async function resolveNedTypeProperties(client: LanguageClient | undefined, typeNames: readonly string[]): Promise<Record<string, string[] | null>> {
  const result: Record<string, string[] | null> = {};
  for (const name of typeNames) {
    if (cache.has(name)) {
      result[name] = cache.get(name)!;
      continue;
    }
    let properties: string[] | null = null;
    if (client) {
      try {
        const detail = await client.sendRequest<{ properties?: string[] } | null>(OmnetppMethods.mcpCallTool, {
          name: 'get_ned_type',
          arguments: { fqName: name },
        });
        properties = detail && Array.isArray(detail.properties) ? detail.properties : null;
      } catch {
        properties = null;
      }
    }
    cache.set(name, properties);
    result[name] = properties;
  }
  return result;
}
