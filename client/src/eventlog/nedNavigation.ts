import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { OmnetppMethods, type Range } from '@omnetpp/shared/protocol';

/**
 * nedNavigation.ts (phase U10) -- resolves a NED type name to its declaration's source
 * location through the language server's MCP surface (`omnetpp/mcp/callTool` /
 * `get_ned_type`, the same path `nedTypeQuery.ts` uses for the U8 preset-configuration
 * property lookups) and opens the editor there. Serves the "Go to NED Declaration"
 * context-menu item wired from the Sequence Chart's axis submenu
 * (`chartContextMenu.ts`'s `axisSection()`) and the Event Log table's per-row menu for
 * module-description rows (`tableContextMenu.ts`) -- see `uiProtocol.ts`'s
 * `gotoNedDeclaration` message doc for the full picture. Mirrors the Eclipse IDE's "Open
 * NED Declaration" action on a module, reachable from the same object menus there.
 *
 * `typeName` is always already a fully-qualified NED type name by the time it reaches
 * here (`ModuleDescriptionEntry.nedTypeName`'s own doc comment, `entries.ts:528`) -- no
 * `list_ned_types` simple-name fallback is needed here, unlike `nedPreviewPanel.ts`'s
 * `resolveKnownType()`, which exists for a DIFFERENT input (a user-typed/looser name).
 *
 * Unlike `nedTypeQuery.ts`, this is a one-shot navigation action (not a per-render
 * lookup), so it is neither cached nor batched: exactly one `get_ned_type` call per
 * invocation, always fresh -- a stale cached location after an edit would silently open
 * the wrong place, which (unlike a cosmetic preset) would be a real usability
 * regression. A missing/broken language client, or a type absent from the NED index
 * (`get_ned_type` returns `null`), degrades to a plain VS Code status message: this is
 * host-side code (unlike the axis-info NED lookups, which are webview-side), so there is
 * no need for a webview-facing notification-overlay round trip the way an in-content
 * failure would (`common/notificationOverlay.ts` is chart/table-content-area machinery,
 * overkill for a one-off action failure).
 */

/** The subset of `get_ned_type`'s result (`shared/src/mcp/tools.ts`'s `nedTypeDetail()`) this module actually reads. */
interface NedTypeLocationResult {
  location?: { uri: string; range: Range };
}

/**
 * Resolves `typeName` via `get_ned_type` and opens the editor at its declaration,
 * revealing the range in the center of the view. Falls back to a VS Code warning/info
 * message (never throws) when there is no language client, the request fails, or the
 * type isn't in the NED index.
 */
export async function gotoNedDeclaration(client: LanguageClient | undefined, typeName: string): Promise<void> {
  if (!client) {
    void vscode.window.showWarningMessage(`OMNeT++: cannot resolve NED type '${typeName}' -- no language server connection.`);
    return;
  }
  let detail: NedTypeLocationResult | null = null;
  try {
    detail = await client.sendRequest<NedTypeLocationResult | null>(OmnetppMethods.mcpCallTool, {
      name: 'get_ned_type',
      arguments: { fqName: typeName },
    });
  } catch {
    detail = null;
  }
  if (!detail?.location) {
    void vscode.window.showInformationMessage(`OMNeT++: no NED declaration found for type '${typeName}' (type not indexed).`);
    return;
  }
  const { uri, range } = detail.location;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
  const r = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
  editor.selection = new vscode.Selection(r.start, r.start);
  editor.revealRange(r, vscode.TextEditorRevealType.InCenter);
}
