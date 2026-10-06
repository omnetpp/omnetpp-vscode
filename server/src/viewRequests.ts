import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { effectiveNetwork, configSummaries, findCounterparts, OmnetppMethods, unquotePropertyValue } from '@omnetpp/shared';
import type {
  ActiveConfig,
  CounterpartParams,
  CounterpartResult,
  CursorParams,
  FqNameParams,
  IniDocument,
  IniFileConfigs,
  ListConfigurationsParams,
  NedDefaultStatistic,
  ParamHierarchyChildrenParams,
  ParamHierarchyParams,
  ViewFocusParams,
} from '@omnetpp/shared';
import { computeUsedBy, computeImpact } from './features/usedBy';
import {
  computeInheritanceRoots,
  computeInheritanceSpineByFq,
  computeModuleHierarchy,
  computeModuleHierarchyByFq,
  computeModuleHierarchyChildren,
  computeParamHierarchy,
  computeParamHierarchyByFq,
  computeParamHierarchyChildren,
  computeConfigNetwork,
  buildConfigCtx,
} from './features/hierarchyViews';
import { computeTypeHierarchySubtypes } from './features/typeHierarchy';
import { computePreviewScene, computePreviewSceneByFq } from './features/nedPreview';
import type { IndexContext } from './features/context';
import { ServerState, ctx, iniDocFor, isUnderWorkspace, languageOfDoc, safeFsPath } from './serverState';

/**
 * A conservative test that an `.ini` file is actually an OMNeT++ ini, so that
 * unrelated `*.ini` files in the workspace (tox.ini, pytest.ini, ...) are not
 * listed as configurations. Every real OMNeT++ ini has a `[General]` section or
 * a `network`/`extends` key or module-path/wildcard parameter keys.
 */
function looksLikeOmnetppIni(doc: IniDocument): boolean {
  return doc.sections.some(
    (s) =>
      s.type === 'general' ||
      s.entries.some(
        (e) => e.key === 'network' || e.key === 'extends' || e.key.includes('**') || e.key.includes('.'),
      ),
  );
}

/**
 * Registers the custom `omnetpp/*` requests/notifications for the auxiliary tree
 * views and the active-configuration overlay (method names + param/result types
 * live in @omnetpp/shared's protocol module).
 */
export function registerViewRequests(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  state: ServerState,
): void {
  connection.onRequest(OmnetppMethods.usedBy, (params: CursorParams) => {
    const parsed = state.store?.get(params.uri);
    const c = ctx(state);
    if (!parsed || !c) return { groups: [] };
    return computeUsedBy(parsed, params.position, c);
  });

  connection.onRequest(OmnetppMethods.impact, (params: CursorParams) => {
    const parsed = state.store?.get(params.uri);
    const c = ctx(state);
    if (!parsed || !c) return { items: [] };
    return computeImpact(parsed, params.position, c);
  });

  connection.onRequest(OmnetppMethods.inheritanceRoots, (params: ViewFocusParams) => {
    const c = ctx(state);
    if (!c) return [];
    if (params.fqName) return computeInheritanceSpineByFq(params.fqName, c);
    const parsed = params.uri ? state.store?.get(params.uri) : undefined;
    if (!parsed) return [];
    return computeInheritanceRoots(parsed, params.position, c);
  });

  connection.onRequest(OmnetppMethods.moduleHierarchy, (params: ViewFocusParams) => {
    const c = ctx(state);
    if (!c) return [];
    if (params.fqName) return computeModuleHierarchyByFq(params.fqName, c);
    const parsed = params.uri ? state.store?.get(params.uri) : undefined;
    if (!parsed) return [];
    return computeModuleHierarchy(parsed, params.position, c);
  });

  connection.onRequest(OmnetppMethods.nedPreview, (params: ViewFocusParams) => {
    const c = ctx(state);
    if (!c) return null;
    if (params.fqName) return computePreviewSceneByFq(params.fqName, c) ?? null;
    const parsed = params.uri ? state.store?.get(params.uri) : undefined;
    if (!parsed) return null;
    return computePreviewScene(parsed, params.position, c) ?? null;
  });

  // Served from the index, not the open-document store: C++ editors are not LSP
  // documents. The URI is re-encoded the way the disk indexer keys files.
  connection.onRequest(OmnetppMethods.counterparts, async (params: CounterpartParams): Promise<CounterpartResult> => {
    const c = ctx(state);
    const fsPath = safeFsPath(params.uri);
    const uri = fsPath ? pathToFileURL(fsPath).toString() : params.uri;
    if (!c) return { kind: null, cc: [], h: [], ned: [] };
    return findCounterparts(c.db, uri, params.position, async (u) => {
      const p = safeFsPath(u);
      return p !== undefined && existsSync(p);
    });
  });

  connection.onRequest(OmnetppMethods.moduleHierarchyChildren, (params: FqNameParams) => {
    const c = ctx(state);
    if (!c) return [];
    return computeModuleHierarchyChildren(params.fqName, c);
  });

  /** Resolve (and cache) the active config's effective network name. */
  async function refreshActiveNetwork(): Promise<void> {
    state.currentActiveNetwork = undefined;
    const cfg = state.currentActiveConfig;
    if (!cfg) return;
    const ini = await iniDocFor(state, cfg.uri);
    if (!ini) return;
    const section =
      cfg.name === 'General'
        ? ini.sections.find((s) => s.type === 'general')
        : ini.sections.find((s) => s.configName === cfg.name);
    if (section) state.currentActiveNetwork = effectiveNetwork(ini, section);
  }

  connection.onNotification(OmnetppMethods.activeConfigChanged, (cfg: ActiveConfig | null) => {
    state.currentActiveConfig = cfg ?? undefined;
    void refreshActiveNetwork();
  });

  /** Build the active-configuration value overlay; reads the ini from the open
   *  buffer or from disk (so it works even when the ini isn't open, e.g. on startup). */
  async function activeConfigCtx(cfg: ActiveConfig | undefined, c: IndexContext | undefined) {
    if (!cfg || !c) return undefined;
    const ini = await iniDocFor(state, cfg.uri);
    return ini ? buildConfigCtx(ini, cfg.uri, cfg.name, c) : undefined;
  }

  connection.onRequest(OmnetppMethods.paramHierarchy, async (params: ParamHierarchyParams) => {
    const c = ctx(state);
    if (!c) return [];
    const cfg = await activeConfigCtx(params.activeConfig, c);
    if (params.fqName) return computeParamHierarchyByFq(params.fqName, c, cfg);
    const parsed = params.uri ? state.store?.get(params.uri) : undefined;
    if (!parsed) return [];
    return computeParamHierarchy(parsed, params.position, c, cfg);
  });

  connection.onRequest(OmnetppMethods.paramHierarchyChildren, async (params: ParamHierarchyChildrenParams) => {
    const c = ctx(state);
    if (!c) return [];
    const cfg = await activeConfigCtx(params.activeConfig, c);
    return computeParamHierarchyChildren(params.fqName, c, params.path, cfg, params.subAssign);
  });

  connection.onRequest(OmnetppMethods.subtypes, (params: FqNameParams) => {
    const c = ctx(state);
    if (!c) return [];
    return computeTypeHierarchySubtypes(params.fqName, c);
  });

  // A NED type's `@defaultStatistic(vectorName; module=subPath)` -- the Sequence Chart uses
  // it to auto-attach a vector to a module axis (Eclipse's `@defaultStatistic` auto-attach).
  connection.onRequest(OmnetppMethods.nedDefaultStatistic, (params: FqNameParams): NedDefaultStatistic | null => {
    const c = ctx(state);
    const prop = c?.nedCache.getType(params.fqName)?.findTypeProperty('defaultStatistic');
    if (!prop) return null;
    // First value = the statistic/vector name; a `module=...` tag = the sub-path (Eclipse
    // reads the property's default value + optional `module` key).
    const valueOf = (tag: { value: string } | undefined) => unquotePropertyValue(tag?.value ?? '');
    const vectorName = valueOf(prop.tags.find((t) => !t.key)) || valueOf(prop.tags[0]);
    if (!vectorName) return null;
    const moduleSubPath = valueOf(prop.tags.find((t) => t.key === 'module')) || null;
    return { vectorName, moduleSubPath };
  });

  // ---- configuration listing for the Configurations view ----

  connection.onRequest(OmnetppMethods.configNetwork, async (params: ActiveConfig): Promise<string | undefined> => {
    const c = ctx(state);
    if (!c) return undefined;
    const ini = await iniDocFor(state, params.uri);
    return ini ? computeConfigNetwork(ini, params.name, c) : undefined;
  });

  connection.onRequest(
    OmnetppMethods.listConfigurations,
    async (params: ListConfigurationsParams): Promise<IniFileConfigs[]> => {
      // The client supplies the candidate ini uris (found via workspace.findFiles);
      // union in any open ini buffers so freshly-created/unsaved files appear too.
      // Only workspace files in NED folders count: `nedPath` roots are libraries.
      const uris = new Set<string>(params.uris ?? []);
      for (const doc of documents.all()) if (languageOfDoc(doc) === 'ini') uris.add(doc.uri);

      const result: IniFileConfigs[] = [];
      for (const uri of uris) {
        if (!isUnderWorkspace(state, uri) || !state.index?.isInNedFolder(uri)) continue;
        const doc = await iniDocFor(state, uri);
        if (!doc || !looksLikeOmnetppIni(doc)) continue;
        const configs = configSummaries(doc);
        if (configs.length) result.push({ uri, configs });
      }
      result.sort((a, b) => a.uri.localeCompare(b.uri));
      return result;
    },
  );
}
