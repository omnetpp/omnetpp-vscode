import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

interface Pos {
  line: number;
  character: number;
}
interface Range {
  start: Pos;
  end: Pos;
}
interface HierarchyItem {
  fqName: string;
  name: string;
  kind: string;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  hasSubtypes?: boolean;
  children?: HierarchyItem[];
  lazy?: boolean;
  expanded?: boolean;
  isSelected?: boolean;
}

interface ParamHierNode {
  kind: 'module' | 'param';
  label: string;
  declUri?: string;
  declRange?: Range;
  inheritedFrom?: string;
  typeFqName?: string;
  isLike?: boolean;
  isSelected?: boolean;
  hasChildren?: boolean;
  children?: ParamHierNode[];
  path?: string;
  paramType?: string;
  paramValue?: string;
  paramUnit?: string;
  overridden?: boolean;
  fromConfig?: boolean;
  unset?: boolean;
  valueOwner?: string;
  declaredIn?: string;
  subAssign?: Record<string, { value: string; uri: string; range: Range }>;
}

interface ModuleHierNode {
  label: string;
  name: string;
  typeFqName?: string;
  typeUri?: string;
  typeRange?: Range;
  declUri?: string;
  declRange?: Range;
  inheritedFrom?: string;
  isLike?: boolean;
  hasChildren: boolean;
  isSelected?: boolean;
  children?: ModuleHierNode[];
}

const OMNETPP_LANGS = new Set(['OMNeT++ NED', 'OMNeT++ MSG', 'OMNeT++ INI']);

function activeContext(): { uri: string; position: Pos } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !OMNETPP_LANGS.has(ed.document.languageId)) return undefined;
  const p = ed.selection.active;
  return { uri: ed.document.uri.toString(), position: { line: p.line, character: p.character } };
}

function toVscodeRange(r: Range): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

/** A CodeLens fires this with LSP-shaped args; convert to vscode types and peek. */
async function showReferences(
  uri: string,
  position: Pos,
  locations: { uri: string; range: Range }[],
): Promise<void> {
  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    vscode.Uri.parse(uri),
    new vscode.Position(position.line, position.character),
    locations.map((l) => new vscode.Location(vscode.Uri.parse(l.uri), toVscodeRange(l.range))),
  );
}

interface ImpactResult {
  target?: string;
  items: { label: string; description: string; uri?: string; range?: Range }[];
}

/** Show the transitive impact of the symbol at the cursor in a navigable QuickPick. */
async function showImpact(client: LanguageClient): Promise<void> {
  const focus = activeContext();
  if (!focus) {
    void vscode.window.showInformationMessage('OMNeT++: place the cursor on a NED/MSG type or an INI network to analyze impact.');
    return;
  }
  let res: ImpactResult;
  try {
    res = await client.sendRequest<ImpactResult>('omnetpp/impact', focus);
  } catch {
    return;
  }
  if (!res.items.length) {
    void vscode.window.showInformationMessage('OMNeT++: nothing depends on the symbol at the cursor.');
    return;
  }
  const picks = res.items
    .filter((i) => i.uri)
    .map((i) => ({ label: i.label, description: i.description, uri: i.uri!, range: i.range }));
  const choice = await vscode.window.showQuickPick(picks, {
    title: res.target ? `Impact of ${res.target.replace(/^[a-z]+:/, '')} (${res.items.length})` : `Impact (${res.items.length})`,
    placeHolder: 'Symbols that depend on this — select to navigate',
    matchOnDescription: true,
  });
  if (choice) await openLocation(choice.uri, choice.range);
}

/** Reveal a location (uri + range) in the editor. */
async function openLocation(uri: string, range?: Range): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const editor = await vscode.window.showTextDocument(doc);
  if (range) {
    const r = toVscodeRange(range);
    editor.selection = new vscode.Selection(r.start, r.start);
    editor.revealRange(r, vscode.TextEditorRevealType.InCenter);
  }
}

/**
 * Base for the type-focused, editor-following, pinnable tree views (NED
 * Inheritance and Module Hierarchy). Tracks a single pin, fetches roots for the
 * current focus (pinned type or editor selection), keeps parent links for
 * `reveal`, and reveals+selects the focused node. Subclasses implement how to
 * fetch roots/children and which node is the focus.
 */
interface ActiveConfig {
  uri: string;
  name: string;
}

/** Where a focus-tree gets its roots: a pinned type or the editor selection. */
type Focus = { fqName: string } | { uri: string; position: Pos };

abstract class FocusTreeProvider<T extends object> implements vscode.TreeDataProvider<T> {
  treeView?: vscode.TreeView<T>;
  private readonly emitter = new vscode.EventEmitter<T | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  protected pinnedFqName?: string;
  protected roots: T[] = [];
  protected selected?: T;
  protected readonly parents = new WeakMap<T, T>();
  private loaded = false;
  /** fq-name the tree is currently focused on, to avoid needless rebuilds. */
  private focusKey?: string;

  constructor(protected readonly client: LanguageClient) {}

  isPinned(): boolean {
    return this.pinnedFqName !== undefined;
  }
  pin(fqName: string): void {
    this.pinnedFqName = fqName;
    this.focusKey = undefined; // force a rebuild so the pinned state renders
  }
  unpin(): void {
    this.pinnedFqName = undefined;
    this.focusKey = undefined;
  }
  pinnedType(): string | undefined {
    return this.pinnedFqName;
  }
  /**
   * The fq-name the tree is currently focused on — the pin when pinned, else the
   * type resolved from the editor selection (`focusKey`, set during reload). Used
   * to title the view after the selected/pinned type.
   */
  focusedFqName(): string | undefined {
    return this.pinnedFqName ?? this.focusKey;
  }

  /** Drop the focus cache so the next reload rebuilds (used on pin/config change). */
  protected invalidateFocus(): void {
    this.focusKey = undefined;
  }
  /** The current focus source (pinned type or editor); subclasses may override. */
  protected focusSource(): Focus | undefined {
    if (this.pinnedFqName) return { fqName: this.pinnedFqName };
    const c = activeContext();
    // A NED editor selection takes priority. Otherwise, when a configuration is
    // active, default the focus to that config's network type. An ini/msg editor
    // (or no editor) is not a NED type selection, so it falls through to the network.
    if (c && vscode.window.activeTextEditor?.document.languageId === 'OMNeT++ NED') return c;
    const net = activeConfigNetworkFqName();
    return net ? { fqName: net } : c;
  }
  /** True when the focus is fixed (pinned) and empty roots should not be discarded. */
  protected hasFixedFocus(): boolean {
    return this.isPinned();
  }

  abstract getTreeItem(el: T): vscode.TreeItem;
  /** Fetch the roots for a focus (pinned `{fqName}`, editor `{uri,position}`, or `{activeConfig}`). */
  protected abstract fetchRoots(focus: Focus): Promise<T[]>;
  /** Fetch (or return prebuilt) children of a node. */
  protected abstract fetchChildren(el: T): Promise<T[]>;
  /** Prebuilt children of a node, used to wire parent links during reload. */
  protected abstract prebuiltChildren(el: T): T[] | undefined;
  protected abstract isSelectedNode(el: T): boolean;
  /** Identifying fq-name of a node (used to detect focus changes). */
  protected abstract nodeKey(el: T): string | undefined;

  getParent(el: T): T | undefined {
    return this.parents.get(el);
  }

  async getChildren(el?: T): Promise<T[]> {
    if (el) {
      const kids = await this.fetchChildren(el);
      for (const c of kids) this.parents.set(c, el);
      return kids;
    }
    if (!this.loaded) await this.reload();
    return this.roots;
  }

  private async reload(): Promise<boolean> {
    this.loaded = true;
    const focus = this.focusSource();
    const roots = focus ? await this.fetchRoots(focus) : [];
    if (!roots.length && !this.hasFixedFocus()) return false; // keep previous content

    // locate the selected node + its key in the freshly fetched tree
    let selected: T | undefined;
    const find = (nodes: T[]) => {
      for (const n of nodes) {
        if (this.isSelectedNode(n)) selected = n;
        const ch = this.prebuiltChildren(n);
        if (ch) find(ch);
      }
    };
    find(roots);
    const key = selected ? this.nodeKey(selected) : roots[0] ? this.nodeKey(roots[0]) : undefined;

    // same focus as before → keep the existing tree (and the user's expansions)
    if (key !== undefined && key === this.focusKey && this.roots.length) return false;

    this.focusKey = key;
    this.roots = roots;
    this.selected = selected;
    const walk = (node: T, parent?: T) => {
      if (parent) this.parents.set(node, parent);
      for (const c of this.prebuiltChildren(node) ?? []) walk(c, node);
    };
    for (const r of this.roots) walk(r);
    return true;
  }

  /** Mark stale and force a full rebuild on the next getChildren (no reveal). */
  refresh(): void {
    this.loaded = false;
    this.focusKey = undefined;
    this.emitter.fire();
  }

  /** Refetch, refresh, and reveal+select the focused node. */
  async update(): Promise<void> {
    if (!(await this.reload())) return;
    this.emitter.fire();
    if (this.selected && this.treeView?.visible) {
      try {
        await this.treeView.reveal(this.selected, { select: true, focus: false });
      } catch {
        /* not rendered yet — the expanded root keeps the focus visible */
      }
    }
  }
}

class InheritanceProvider extends FocusTreeProvider<HierarchyItem> {
  getTreeItem(it: HierarchyItem): vscode.TreeItem {
    const collapsibleState = it.expanded
      ? vscode.TreeItemCollapsibleState.Expanded // supertype chain + selected node
      : it.hasSubtypes
        ? vscode.TreeItemCollapsibleState.Collapsed // subtype nodes start closed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(it.name, collapsibleState);
    item.description = it.detail;
    item.tooltip = it.fqName;
    item.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [it.uri, it.selectionRange] };
    const isPinned = this.pinnedFqName === it.fqName;
    item.contextValue = isPinned ? 'nedTypePinned' : 'nedTypeUnpinned';
    // pinned nodes show a persistent (filled) pin icon as the state indicator
    item.iconPath = new vscode.ThemeIcon(isPinned ? 'pinned' : 'symbol-class');
    return item;
  }

  protected fetchRoots(focus: { fqName: string } | { uri: string; position: Pos }): Promise<HierarchyItem[]> {
    return this.client
      .sendRequest<HierarchyItem[]>('omnetpp/inheritanceRoots', focus)
      .then((r) => r ?? []);
  }
  protected async fetchChildren(el: HierarchyItem): Promise<HierarchyItem[]> {
    if (el.lazy) {
      return (await this.client.sendRequest<HierarchyItem[]>('omnetpp/subtypes', { fqName: el.fqName })) ?? [];
    }
    return el.children ?? [];
  }
  protected prebuiltChildren(el: HierarchyItem): HierarchyItem[] | undefined {
    return el.children;
  }
  protected isSelectedNode(el: HierarchyItem): boolean {
    return !!el.isSelected;
  }
  protected nodeKey(el: HierarchyItem): string | undefined {
    return el.fqName;
  }
}

class ModuleHierarchyProvider extends FocusTreeProvider<ModuleHierNode> {
  getTreeItem(n: ModuleHierNode): vscode.TreeItem {
    const collapsibleState = n.isSelected
      ? vscode.TreeItemCollapsibleState.Expanded // the focused type opens to its submodules
      : n.hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, collapsibleState);
    item.description = (n.isLike ? '~ ' : '') + (n.typeFqName ?? '');
    item.tooltip = n.typeFqName ?? n.name;
    const isPinned = !!n.typeFqName && this.pinnedFqName === n.typeFqName;
    item.contextValue = isPinned ? 'nedModulePinned' : 'nedModuleUnpinned';
    // pinned nodes show a persistent (filled) pin icon as the state indicator
    item.iconPath = new vscode.ThemeIcon(
      isPinned ? 'pinned' : n.isSelected ? 'symbol-class' : n.hasChildren ? 'symbol-structure' : 'symbol-field',
    );
    // navigate to the submodule's declaration; the root node has no declaration,
    // so it falls back to its type definition
    const navUri = n.declUri ?? n.typeUri;
    const navRange = n.declUri ? n.declRange : n.typeRange;
    if (navUri) {
      item.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [navUri, navRange] };
    }
    return item;
  }

  protected fetchRoots(focus: { fqName: string } | { uri: string; position: Pos }): Promise<ModuleHierNode[]> {
    return this.client
      .sendRequest<ModuleHierNode[]>('omnetpp/moduleHierarchy', focus)
      .then((r) => r ?? []);
  }
  protected async fetchChildren(el: ModuleHierNode): Promise<ModuleHierNode[]> {
    if (el.children) return el.children; // prebuilt root level
    if (!el.typeFqName) return [];
    return (
      (await this.client.sendRequest<ModuleHierNode[]>('omnetpp/moduleHierarchyChildren', {
        fqName: el.typeFqName,
      })) ?? []
    );
  }
  protected prebuiltChildren(el: ModuleHierNode): ModuleHierNode[] | undefined {
    return el.children;
  }
  protected isSelectedNode(el: ModuleHierNode): boolean {
    return !!el.isSelected;
  }
  protected nodeKey(el: ModuleHierNode): string | undefined {
    return el.typeFqName;
  }
}

class ModuleParamsProvider extends FocusTreeProvider<ParamHierNode> {
  private activeConfig?: ActiveConfig;

  /** The view keeps its normal (type-centric, editor-following) behavior; the
   * active config only changes how parameter values are resolved. */
  setActiveConfig(cfg?: ActiveConfig): void {
    this.activeConfig = cfg;
    this.invalidateFocus(); // re-resolve values for the current focus
    void this.update();
  }

  getTreeItem(n: ParamHierNode): vscode.TreeItem {
    if (n.kind === 'param') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
      const suffix = n.overridden
        ? ' (overridden)'
        : n.fromConfig
          ? ' (from config)'
          : n.unset
            ? ' — UNASSIGNED'
            : '';
      item.description =
        `${n.paramType ?? ''}${n.paramUnit ? ' (' + n.paramUnit + ')' : ''}` +
        `${n.paramValue !== undefined ? ' = ' + n.paramValue : ''}` +
        suffix;
      item.iconPath = new vscode.ThemeIcon(
        'symbol-parameter',
        n.overridden ? new vscode.ThemeColor('disabledForeground') : undefined,
      );
      if (n.overridden) {
        item.resourceUri = vscode.Uri.parse(
          'omnetpp-shadowed:/' + encodeURIComponent(`${n.label}#${n.paramValue ?? ''}`),
        );
        item.tooltip = 'Overridden — not in effect';
      } else if (n.unset) {
        // Unassigned is legitimate when inspecting a NED type directly — just
        // note it in the description; no color/badge/icon emphasis.
        item.tooltip = 'Unassigned: no value in effect (no NED default and no config assignment)';
      } else if (n.fromConfig) {
        item.tooltip = `value in effect from config${n.valueOwner ? ' ' + n.valueOwner : ''}: ${n.paramValue}`;
      } else if (n.paramValue !== undefined) {
        const where = n.valueOwner ? ` (set in ${n.valueOwner}` + (n.declaredIn && n.declaredIn !== n.valueOwner ? `, declared in ${n.declaredIn})` : ')') : '';
        item.tooltip = `value in effect: ${n.paramValue}${where}`;
      }
      item.contextValue = 'nedParamLeaf';
      if (n.declUri) {
        item.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [n.declUri, n.declRange] };
      }
      return item;
    }
    // module node
    const collapsibleState = n.isSelected
      ? vscode.TreeItemCollapsibleState.Expanded
      : n.hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, collapsibleState);
    item.description = (n.isLike ? '~ ' : '') + (n.typeFqName ?? '');
    item.tooltip = n.typeFqName ?? n.label;
    const isPinned = !!n.typeFqName && this.pinnedFqName === n.typeFqName;
    item.contextValue = isPinned ? 'nedParamPinned' : 'nedParamUnpinned';
    item.iconPath = new vscode.ThemeIcon(
      isPinned ? 'pinned' : n.isSelected ? 'symbol-class' : 'symbol-structure',
    );
    if (n.declUri) {
      item.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [n.declUri, n.declRange] };
    }
    return item;
  }

  protected fetchRoots(focus: Focus): Promise<ParamHierNode[]> {
    const req = this.activeConfig ? { ...focus, activeConfig: this.activeConfig } : focus;
    return this.client.sendRequest<ParamHierNode[]>('omnetpp/paramHierarchy', req).then((r) => r ?? []);
  }
  protected async fetchChildren(el: ParamHierNode): Promise<ParamHierNode[]> {
    if (el.kind === 'param') return [];
    if (el.children) return el.children; // prebuilt root level
    if (!el.typeFqName) return [];
    const req: {
      fqName: string;
      path?: string;
      activeConfig?: ActiveConfig;
      subAssign?: ParamHierNode['subAssign'];
    } = { fqName: el.typeFqName };
    if (el.path !== undefined) req.path = el.path;
    if (this.activeConfig) req.activeConfig = this.activeConfig;
    if (el.subAssign) req.subAssign = el.subAssign; // apply this instance's NED assignments
    return (await this.client.sendRequest<ParamHierNode[]>('omnetpp/paramHierarchyChildren', req)) ?? [];
  }
  protected prebuiltChildren(el: ParamHierNode): ParamHierNode[] | undefined {
    return el.children;
  }
  protected isSelectedNode(el: ParamHierNode): boolean {
    return !!el.isSelected;
  }
  protected nodeKey(el: ParamHierNode): string | undefined {
    return el.typeFqName;
  }
}

const PIN_KEY = 'omnetpp.pinnedType';
const MODULE_PIN_KEY = 'omnetpp.pinnedModule';
const PARAM_PIN_KEY = 'omnetpp.pinnedParamModule';
const USEDBY_PIN_KEY = 'omnetpp.pinnedUsedBy';
const ACTIVE_CONFIG_KEY = 'omnetpp.activeConfig';

/** The active configuration (ini file + config name), if any. */
let activeConfigState: ActiveConfig | undefined;
/** Fq-name of the active configuration's network type (resolved lazily by the server). */
let activeConfigNetwork: string | undefined;
/** The active configuration, for other features (run/launch, preview, ...). */
export function getActiveConfig(): ActiveConfig | undefined {
  return activeConfigState;
}
/** The active config's network type fq-name, used as a default focus for the views. */
function activeConfigNetworkFqName(): string | undefined {
  return activeConfigState ? activeConfigNetwork : undefined;
}

/** The canonical config name of the nearest `[...]` header at/above `line`, if any. */
function configNameAtLine(doc: vscode.TextDocument, line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const m = /^\s*\[(.+?)\]\s*$/.exec(doc.lineAt(i).text);
    if (!m) continue;
    const raw = m[1].trim();
    if (/^General$/i.test(raw)) return 'General';
    const cm = /^Config\s+(.+)$/.exec(raw); // [Config X] -> X ; [X] -> X
    return cm ? cm[1].trim() : raw;
  }
  return undefined;
}

function iniFsPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/** A short, identifying label: parent dir for a generic `omnetpp.ini`, else the file name. */
function activeConfigLabel(cfg: ActiveConfig): string {
  const parts = iniFsPath(cfg.uri).split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? cfg.uri;
  const parent = parts[parts.length - 2];
  const ident = base.toLowerCase() === 'omnetpp.ini' && parent ? parent : base;
  return `${ident} - ${cfg.name}`;
}

/** Whether `cfg` (uri+name) is the currently active configuration. */
function isActiveConfig(uri: string, name: string): boolean {
  return !!activeConfigState && activeConfigState.uri === uri && activeConfigState.name === name;
}

/** A config section as reported by the server's `omnetpp/listConfigurations`. */
interface ConfigEntryDto {
  name: string;
  rawName: string;
  range: Range;
  abstract: boolean;
  extends: string[];
  description?: string;
}
interface IniFileConfigs {
  uri: string;
  configs: ConfigEntryDto[];
}

/** Tree nodes for the Configurations view: ini files at the top, configs beneath. */
type ConfigTreeNode =
  | { kind: 'file'; uri: string; configs: ConfigEntryDto[] }
  | { kind: 'config'; uri: string; entry: ConfigEntryDto };

/**
 * Lists every non-abstract configuration in the workspace, grouped by ini file.
 * The client finds the ini files (`workspace.findFiles`) and the server parses
 * them (`omnetpp/listConfigurations`). Supports a path/name substring filter and
 * highlights the active configuration.
 */
class ConfigurationsProvider implements vscode.TreeDataProvider<ConfigTreeNode> {
  treeView?: vscode.TreeView<ConfigTreeNode>;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private files: IniFileConfigs[] = [];
  private filter = '';
  private loaded = false;
  // Cached node model (stable references) so `getParent`/`reveal` can locate nodes.
  private roots: ConfigTreeNode[] = [];
  private readonly childrenOf = new WeakMap<ConfigTreeNode, ConfigTreeNode[]>();
  private readonly parents = new WeakMap<ConfigTreeNode, ConfigTreeNode>();
  private activeNode?: ConfigTreeNode;
  private dirty = true;

  constructor(private readonly client: LanguageClient) {}

  get filterText(): string {
    return this.filter;
  }
  setFilter(f: string): void {
    this.filter = f.trim();
    this.dirty = true;
    this.emitter.fire();
  }
  /** Refetch the config list from the workspace on the next read. */
  refresh(): void {
    this.loaded = false;
    this.dirty = true;
    this.emitter.fire();
  }
  /** Re-render without refetching (e.g. the active-config highlight changed). */
  rerender(): void {
    this.dirty = true;
    this.emitter.fire();
    void this.revealActive();
  }

  private async load(): Promise<void> {
    const uris = (
      await vscode.workspace.findFiles('**/*.ini', '**/{node_modules,out,.git}/**')
    ).map((u) => u.toString());
    this.files =
      (await this.client.sendRequest<IniFileConfigs[]>('omnetpp/listConfigurations', { uris })) ?? [];
    this.loaded = true;
    this.dirty = true;
  }

  /** Rebuild the cached node tree (file → config nodes) and locate the active node. */
  private rebuild(): void {
    this.roots = [];
    this.activeNode = undefined;
    for (const { uri, configs } of this.visibleFiles()) {
      const fileNode: ConfigTreeNode = { kind: 'file', uri, configs };
      const children = configs.map<ConfigTreeNode>((entry) => {
        const child: ConfigTreeNode = { kind: 'config', uri, entry };
        this.parents.set(child, fileNode);
        if (isActiveConfig(uri, entry.name)) this.activeNode = child;
        return child;
      });
      this.childrenOf.set(fileNode, children);
      this.roots.push(fileNode);
    }
    this.dirty = false;
  }

  /** Expand to and select the active configuration, when the view is visible. */
  async revealActive(): Promise<void> {
    if (!this.treeView?.visible) return;
    if (!this.loaded) await this.load();
    if (this.dirty) this.rebuild();
    if (!this.activeNode) return;
    try {
      await this.treeView.reveal(this.activeNode, { select: true, focus: false, expand: true });
    } catch {
      /* node not rendered yet — the expanded file keeps it visible */
    }
  }

  getParent(node: ConfigTreeNode): ConfigTreeNode | undefined {
    return this.parents.get(node);
  }

  /** Files (with their non-abstract configs) that survive the current filter. */
  private visibleFiles(): { uri: string; configs: ConfigEntryDto[] }[] {
    const f = this.filter.toLowerCase();
    const out: { uri: string; configs: ConfigEntryDto[] }[] = [];
    for (const file of this.files) {
      const nonAbstract = file.configs.filter((c) => !c.abstract);
      if (!nonAbstract.length) continue;
      const pathMatch =
        !f ||
        vscode.workspace.asRelativePath(vscode.Uri.parse(file.uri)).toLowerCase().includes(f) ||
        iniFsPath(file.uri).toLowerCase().includes(f);
      const configs = pathMatch
        ? nonAbstract
        : nonAbstract.filter((c) => c.name.toLowerCase().includes(f));
      if (configs.length) out.push({ uri: file.uri, configs });
    }
    return out;
  }

  async getChildren(el?: ConfigTreeNode): Promise<ConfigTreeNode[]> {
    if (!el) {
      if (!this.loaded) await this.load();
      if (this.dirty) this.rebuild();
      return this.roots;
    }
    if (el.kind === 'file') {
      return this.childrenOf.get(el) ?? [];
    }
    return [];
  }

  getTreeItem(node: ConfigTreeNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const rel = vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri));
      // Start collapsed; open only the file that holds the active config (or all
      // files while a filter is narrowing the list).
      const hasActive =
        !!activeConfigState &&
        node.uri === activeConfigState.uri &&
        node.configs.some((c) => c.name === activeConfigState!.name);
      const state =
        this.filterText || hasActive
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(rel, state);
      item.tooltip = iniFsPath(node.uri);
      item.resourceUri = vscode.Uri.parse(node.uri);
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = 'omnetppIniFile';
      item.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [node.uri] };
      return item;
    }
    const { uri, entry } = node;
    const active = isActiveConfig(uri, entry.name);
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    if (active) item.description = 'active';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.name}**${active ? ' — _active configuration_' : ''}\n\n`);
    if (entry.description) md.appendMarkdown(`${entry.description}\n\n`);
    md.appendMarkdown(`File: \`${iniFsPath(uri)}\``);
    if (entry.extends.length) md.appendMarkdown(`\n\nExtends: ${entry.extends.join(', ')}`);
    item.tooltip = md;
    item.iconPath = active
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('gear');
    item.contextValue = active ? 'omnetppConfigActive' : 'omnetppConfig';
    item.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [uri, entry.range] };
    return item;
  }
}

interface UsedByItem {
  label: string;
  description?: string;
  uri: string;
  range: Range;
}
interface UsedByGroupData {
  label: string;
  items: UsedByItem[];
}
type UsedByNode =
  | { kind: 'group'; label: string; children: UsedByNode[] }
  | ({ kind: 'leaf' } & UsedByItem);

type UsedByFocus = { uri: string; position: Pos };

/**
 * The "Used By" view: reverse dependencies of the symbol under the editor cursor
 * (or a pinned symbol), grouped by relation (extended by, instantiated by, backing
 * class for, …). Driven entirely by the cross-reference graph via `omnetpp/usedBy`.
 */
class UsedByProvider implements vscode.TreeDataProvider<UsedByNode> {
  treeView?: vscode.TreeView<UsedByNode>;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: UsedByNode[] = [];
  private target?: string;
  /** When set, the view is frozen on this symbol instead of following the cursor. */
  private pinnedFocus?: UsedByFocus;
  /** The focus that produced the current content, captured when the user pins. */
  private lastFocus?: UsedByFocus;

  constructor(private readonly client: LanguageClient) {}

  /** Simple name of the symbol the view is reporting on, for the view title. */
  focusedName(): string | undefined {
    return this.target;
  }
  isPinned(): boolean {
    return this.pinnedFocus !== undefined;
  }
  /** Whether there is a current symbol that could be pinned. */
  hasTarget(): boolean {
    return this.target !== undefined;
  }
  /** Freeze the view on the symbol it is currently showing. */
  pin(): void {
    if (this.lastFocus) this.pinnedFocus = this.lastFocus;
  }
  unpin(): void {
    this.pinnedFocus = undefined;
  }
  /** The pinned focus, for persistence across sessions. */
  pinnedFocusValue(): UsedByFocus | undefined {
    return this.pinnedFocus;
  }
  restorePin(focus: UsedByFocus): void {
    this.pinnedFocus = focus;
  }

  async update(): Promise<void> {
    const focus = this.pinnedFocus ?? activeContext();
    if (!focus) {
      this.target = undefined;
      this.lastFocus = undefined;
      if (this.roots.length) {
        this.roots = [];
        this.emitter.fire();
      }
      return;
    }
    this.lastFocus = focus;
    let groups: UsedByGroupData[] = [];
    try {
      const res = await this.client.sendRequest<{ target?: string; groups: UsedByGroupData[] }>('omnetpp/usedBy', focus);
      groups = res?.groups ?? [];
      this.target = res?.target;
    } catch {
      groups = [];
      this.target = undefined;
    }
    this.roots = groups.map((g) => ({
      kind: 'group' as const,
      label: g.label,
      children: g.items.map((i) => ({ kind: 'leaf' as const, ...i })),
    }));
    this.emitter.fire();
  }

  getChildren(el?: UsedByNode): UsedByNode[] {
    if (!el) return this.roots;
    return el.kind === 'group' ? el.children : [];
  }

  getTreeItem(el: UsedByNode): vscode.TreeItem {
    if (el.kind === 'group') {
      const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Expanded);
      it.description = String(el.children.length);
      it.iconPath = new vscode.ThemeIcon('references');
      return it;
    }
    const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
    it.description = el.description;
    it.tooltip = `${el.label} — ${el.description ?? ''}`;
    it.iconPath = new vscode.ThemeIcon('symbol-reference');
    it.command = { command: 'omnetpp.openLocation', title: 'Open', arguments: [el.uri, el.range] };
    return it;
  }
}

/** Register the auxiliary tree views and keep them in sync with the editor. */
export function registerViews(context: vscode.ExtensionContext, client: LanguageClient): void {
  const inheritance = new InheritanceProvider(client);
  const moduleHierarchy = new ModuleHierarchyProvider(client);
  const moduleParams = new ModuleParamsProvider(client);
  const configurations = new ConfigurationsProvider(client);
  const usedBy = new UsedByProvider(client);

  // grey out overridden (shadowed) parameter rows in the Module Parameters view
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) =>
        // colour only; the tree item supplies the tooltip (avoid duplicating it)
        uri.scheme === 'omnetpp-shadowed'
          ? { color: new vscode.ThemeColor('disabledForeground') }
          : undefined,
    }),
  );

  // restore persisted (single) pins
  const savedTypePin = context.workspaceState.get<string | undefined>(PIN_KEY, undefined);
  if (savedTypePin) inheritance.pin(savedTypePin);
  const savedModulePin = context.workspaceState.get<string | undefined>(MODULE_PIN_KEY, undefined);
  if (savedModulePin) moduleHierarchy.pin(savedModulePin);
  const savedParamPin = context.workspaceState.get<string | undefined>(PARAM_PIN_KEY, undefined);
  if (savedParamPin) moduleParams.pin(savedParamPin);
  const savedUsedByPin = context.workspaceState.get<UsedByFocus | undefined>(USEDBY_PIN_KEY, undefined);
  if (savedUsedByPin) usedBy.restorePin(savedUsedByPin);
  const persistPin = () => context.workspaceState.update(PIN_KEY, inheritance.pinnedType());
  const persistModulePin = () =>
    context.workspaceState.update(MODULE_PIN_KEY, moduleHierarchy.pinnedType());
  const persistParamPin = () =>
    context.workspaceState.update(PARAM_PIN_KEY, moduleParams.pinnedType());
  const persistUsedByPin = () =>
    context.workspaceState.update(USEDBY_PIN_KEY, usedBy.pinnedFocusValue());

  // context keys gate the view-title pin/unpin buttons (shown per pinned state;
  // the Used By "Pin" button also needs a current symbol to pin).
  const syncPinContext = () => {
    void vscode.commands.executeCommand('setContext', 'omnetpp.typePinned', inheritance.isPinned());
    void vscode.commands.executeCommand('setContext', 'omnetpp.modulePinned', moduleHierarchy.isPinned());
    void vscode.commands.executeCommand('setContext', 'omnetpp.paramPinned', moduleParams.isPinned());
    void vscode.commands.executeCommand('setContext', 'omnetpp.usedByPinned', usedBy.isPinned());
    void vscode.commands.executeCommand('setContext', 'omnetpp.usedByHasTarget', usedBy.hasTarget());
  };

  // Title each view after the selected/pinned type ("<Type> <Noun>"), falling
  // back to the generic name when nothing is focused. `name` may be a NED
  // (`pkg.Type`) or MSG (`ns::Type`) fq-name, so strip up to the last separator.
  const simpleName = (name: string) => name.replace(/^.*[.:]/, '');
  const focusTitle = (generic: string, noun: string, name?: string) =>
    name ? `${simpleName(name)} ${noun}` : generic;
  const syncTitles = () => {
    inheritanceView.title = focusTitle('NED Inheritance', 'Inheritance', inheritance.focusedFqName());
    moduleHierarchyView.title = focusTitle('Module Hierarchy', 'Hierarchy', moduleHierarchy.focusedFqName());
    moduleParamsView.title = focusTitle('Module Parameters', 'Parameters', moduleParams.focusedFqName());
    usedByView.title = focusTitle('Used By', 'Usage', usedBy.focusedName());
  };

  syncPinContext();

  const inheritanceView = vscode.window.createTreeView('omnetppInheritance', {
    treeDataProvider: inheritance,
  });
  inheritance.treeView = inheritanceView;
  const moduleHierarchyView = vscode.window.createTreeView('omnetppModuleHierarchy', {
    treeDataProvider: moduleHierarchy,
  });
  moduleHierarchy.treeView = moduleHierarchyView;
  const moduleParamsView = vscode.window.createTreeView('omnetppModuleParams', {
    treeDataProvider: moduleParams,
  });
  moduleParams.treeView = moduleParamsView;
  const configurationsView = vscode.window.createTreeView('omnetppActiveConfig', {
    treeDataProvider: configurations,
  });
  configurations.treeView = configurationsView;
  const usedByView = vscode.window.createTreeView('omnetppUsedBy', {
    treeDataProvider: usedBy,
  });
  usedBy.treeView = usedByView;
  // When the view is (re)opened, expand and reveal the active configuration.
  context.subscriptions.push(
    configurationsView.onDidChangeVisibility((e) => {
      if (e.visible) void configurations.revealActive();
    }),
  );
  syncTitles(); // reflect any restored pins

  // The view title doubles as the active-config banner so it stays visible even
  // when the whole tree is collapsed: "Active Config: <ini> - <name>".
  const syncConfigTitle = () => {
    configurationsView.title = activeConfigState
      ? `Active Config: ${activeConfigLabel(activeConfigState)}`
      : 'Configurations';
  };
  const syncFilterDescription = () => {
    configurationsView.description = configurations.filterText
      ? `filter: ${configurations.filterText}`
      : undefined;
  };
  // Set/clear/restore the active configuration from one place.
  const applyActiveConfig = (cfg?: ActiveConfig) => {
    activeConfigState = cfg;
    activeConfigNetwork = undefined; // resolved asynchronously below
    void context.workspaceState.update(ACTIVE_CONFIG_KEY, cfg);
    // let the server track the active config so INI param navigation (hover, refs,
    // codelens, go-to-def) can use its network as the fallback for [General] lines.
    void client.sendNotification('omnetpp/activeConfigChanged', cfg ?? null);
    void vscode.commands.executeCommand('setContext', 'omnetpp.hasActiveConfig', !!cfg);
    syncConfigTitle();
    configurations.rerender(); // re-highlight the active node + open its path
    moduleParams.setActiveConfig(cfg);
    if (cfg) {
      // Resolve the config's network so the views can default to it when no NED
      // editor is focused. followEditor() runs in the .then so it never fires
      // during the synchronous restore (followEditor is defined later).
      void client
        .sendRequest<string | undefined>('omnetpp/configNetwork', { uri: cfg.uri, name: cfg.name })
        .then((fq) => {
          if (activeConfigState?.uri !== cfg.uri || activeConfigState?.name !== cfg.name) return;
          activeConfigNetwork = fq;
          followEditor(); // re-evaluate focus for the non-pinned views
        });
    } else {
      followEditor(); // cleared → revert the views to the editor focus
    }
  };

  // restore the persisted active configuration
  const savedActive = context.workspaceState.get<ActiveConfig | undefined>(ACTIVE_CONFIG_KEY, undefined);
  if (savedActive) applyActiveConfig(savedActive);
  else syncConfigTitle();

  context.subscriptions.push(
    inheritanceView,
    moduleHierarchyView,
    moduleParamsView,
    configurationsView,
    usedByView,
    vscode.commands.registerCommand('omnetpp.openLocation', (uri: string, range?: Range) =>
      openLocation(uri, range),
    ),
    vscode.commands.registerCommand(
      'omnetpp.showReferences',
      (uri: string, position: Pos, locations: { uri: string; range: Range }[]) =>
        showReferences(uri, position, locations),
    ),
    vscode.commands.registerCommand('omnetpp.showImpact', () => showImpact(client)),
    vscode.commands.registerCommand('omnetpp.pinType', (it?: HierarchyItem) => {
      if (!it?.fqName) return;
      inheritance.pin(it.fqName); // single pin: replaces any previous
      void persistPin();
      syncPinContext();
      void inheritance.update().then(syncTitles);
    }),
    vscode.commands.registerCommand('omnetpp.unpinType', () => {
      inheritance.unpin();
      void persistPin();
      syncPinContext();
      void inheritance.update().then(syncTitles);
    }),
    vscode.commands.registerCommand('omnetpp.pinModule', (n?: ModuleHierNode) => {
      if (!n?.typeFqName) return;
      moduleHierarchy.pin(n.typeFqName);
      void persistModulePin();
      syncPinContext();
      void moduleHierarchy.update().then(syncTitles);
    }),
    vscode.commands.registerCommand('omnetpp.unpinModule', () => {
      moduleHierarchy.unpin();
      void persistModulePin();
      syncPinContext();
      void moduleHierarchy.update().then(syncTitles);
    }),
    vscode.commands.registerCommand('omnetpp.pinParam', (n?: ParamHierNode) => {
      if (!n?.typeFqName) return;
      moduleParams.pin(n.typeFqName);
      void persistParamPin();
      syncPinContext();
      void moduleParams.update().then(syncTitles);
    }),
    vscode.commands.registerCommand('omnetpp.unpinParam', () => {
      moduleParams.unpin();
      void persistParamPin();
      syncPinContext();
      void moduleParams.update().then(syncTitles);
    }),
    vscode.commands.registerCommand('omnetpp.pinUsedBy', () => {
      usedBy.pin(); // freeze on the symbol currently shown
      void persistUsedByPin();
      syncPinContext();
      syncTitles();
    }),
    vscode.commands.registerCommand('omnetpp.unpinUsedBy', () => {
      usedBy.unpin();
      void persistUsedByPin();
      void usedBy.update().then(() => {
        syncTitles();
        syncPinContext();
      });
    }),
    vscode.commands.registerCommand('omnetpp.setActiveConfiguration', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'OMNeT++ INI') {
        void vscode.window.showWarningMessage(
          'Set as Active Configuration: place the cursor in a config section of an .ini file.',
        );
        return;
      }
      const name = configNameAtLine(ed.document, ed.selection.active.line);
      if (!name) {
        void vscode.window.showWarningMessage('No [Config ...] section found at the cursor.');
        return;
      }
      applyActiveConfig({ uri: ed.document.uri.toString(), name });
    }),
    vscode.commands.registerCommand('omnetpp.clearActiveConfiguration', () => {
      applyActiveConfig(undefined);
    }),
    // Set the active configuration from a node in the Configurations view.
    vscode.commands.registerCommand('omnetpp.setActiveConfigItem', (node?: ConfigTreeNode) => {
      if (!node || node.kind !== 'config') return;
      applyActiveConfig({ uri: node.uri, name: node.entry.name });
    }),
    vscode.commands.registerCommand('omnetpp.refreshConfigurations', () => configurations.refresh()),
    vscode.commands.registerCommand('omnetpp.filterConfigurations', async () => {
      const v = await vscode.window.showInputBox({
        prompt: 'Filter configurations by ini path or config name',
        placeHolder: 'substring match (case-insensitive)',
        value: configurations.filterText,
      });
      if (v === undefined) return; // cancelled — keep the current filter
      configurations.setFilter(v);
      void vscode.commands.executeCommand('setContext', 'omnetpp.configFilterActive', !!v.trim());
      syncFilterDescription();
    }),
    vscode.commands.registerCommand('omnetpp.clearConfigurationsFilter', () => {
      configurations.setFilter('');
      void vscode.commands.executeCommand('setContext', 'omnetpp.configFilterActive', false);
      syncFilterDescription();
    }),
  );

  // Keep the Configurations view in sync as ini files are created/saved/deleted.
  const iniWatcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
  const refreshConfigs = () => configurations.refresh();
  context.subscriptions.push(
    iniWatcher,
    iniWatcher.onDidCreate(refreshConfigs),
    iniWatcher.onDidDelete(refreshConfigs),
    iniWatcher.onDidChange(refreshConfigs),
  );

  // all views follow the editor unless individually pinned; re-title once the
  // updates resolve (the focused type is only known after the reload completes).
  const followEditor = () => {
    void Promise.all([
      inheritance.isPinned() ? undefined : inheritance.update(),
      moduleHierarchy.isPinned() ? undefined : moduleHierarchy.update(),
      moduleParams.isPinned() ? undefined : moduleParams.update(),
      usedBy.update(),
    ]).then(() => {
      syncTitles();
      syncPinContext(); // the Used By pin button depends on the current target
    });
  };

  let timer: NodeJS.Timeout | undefined;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(followEditor, 300);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (OMNETPP_LANGS.has(e.textEditor.document.languageId)) debounced();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (OMNETPP_LANGS.has(e.document.languageId)) debounced();
    }),
  );

  // Populate the views and titles for the already-active editor: activation does
  // not fire onDidChangeActiveTextEditor for an editor that is open at startup.
  followEditor();
}
