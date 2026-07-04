import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { effectiveNetwork, configSummaries, OmnetppMethods } from '@omnetpp/shared';
import type {
  ActiveConfig,
  CursorParams,
  FqNameParams,
  IniDocument,
  IniFileConfigs,
  ListConfigurationsParams,
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
import type { IndexContext } from './features/context';
import { ServerState, ctx, iniDocFor, languageOfDoc } from './serverState';

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
      const uris = new Set<string>(params.uris ?? []);
      for (const doc of documents.all()) if (languageOfDoc(doc) === 'ini') uris.add(doc.uri);

      const result: IniFileConfigs[] = [];
      for (const uri of uris) {
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
