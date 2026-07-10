// The completionItem/resolve handler: lazily enriches a single highlighted
// completion item, on demand, instead of eagerly embedding data in every
// textDocument/completion response (which fires on every keystroke). Currently
// handles one kind of enrichment — a display-string icon-name candidate
// (`i=`/`i2=`/`bgi=`, see shared/src/ned/displayString.ts's `displayCompletions`)
// gets its `documentation` filled in with an embedded image preview. Any other
// `data` shape (or none — most completion kinds don't set `data` at all) is
// passed through unchanged, so this handler is safe to register globally for
// all languages the server serves (NED/MSG/INI).
import type { CompletionItem } from 'vscode-languageserver/node';
import type { createNodeIconProvider } from '@omnetpp/shared/node';

interface NedDisplayIconData {
  kind: 'nedDisplayIcon';
  iconId: string;
}

function isNedDisplayIconData(data: unknown): data is NedDisplayIconData {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { kind?: unknown }).kind === 'nedDisplayIcon' &&
    typeof (data as { iconId?: unknown }).iconId === 'string'
  );
}

/**
 * Resolve one completion item. Pure aside from the `icons.get()` lookup
 * (filesystem read via the injected provider), so it is unit-testable without
 * a live LSP connection — see `server/src/test/completionResolve.test.ts`.
 */
export async function resolveCompletionItem(
  item: CompletionItem,
  icons: ReturnType<typeof createNodeIconProvider>,
): Promise<CompletionItem> {
  if (!isNedDisplayIconData(item.data)) return item;
  const resolved = await icons.get(item.data.iconId);
  if (!resolved) return item;
  return {
    ...item,
    documentation: { kind: 'markdown', value: `![${item.data.iconId}](${resolved.href})` },
  };
}
