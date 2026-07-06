// The typed contract for the custom `omnetpp/*` LSP methods between client/
// and server/. Both sides import the method names from OmnetppMethods and the
// Params/Result types from here, so a rename or shape change is a compile
// error on both ends instead of a silent runtime failure.
//
// Deliberately dependency-light: the only runtime exports are the
// OmnetppMethods constant and the tiny self-contained ini-header helper below —
// everything else is `import type`/`export type` (erased at compile time), so
// the client can bundle '@omnetpp/shared/protocol' without dragging in the
// semantic core.
import type { Position, Range } from './model/location';
import type { NedHierarchyItem } from './ned/nedHierarchy';
import type { ModuleHierNode } from './ned/nedModuleHierarchy';
import type { ParamAssign, ParamHierNode } from './ned/nedParamHierarchy';
import type { ConfigSummary } from './ini/iniDocument';
import type { ToolDef } from './mcp/tools';
import type { PreviewScene, PreviewSubmodule, PreviewConnection, PreviewIcon } from './ned/nedPreviewScene';

export type {
  Position,
  Range,
  NedHierarchyItem,
  ModuleHierNode,
  ParamHierNode,
  ParamAssign,
  ConfigSummary,
  ToolDef,
  PreviewScene,
  PreviewSubmodule,
  PreviewConnection,
  PreviewIcon,
};

// Runtime re-export for the client: the canonical `[Config X]` header-name rule
// (used when building ActiveConfig from the cursor position without a server
// round trip). iniDocument.js is self-contained — no transitive requires.
export { configNameAtHeaderLine } from './ini/iniDocument';

/** Method names of every custom request/notification (see per-key comments). */
export const OmnetppMethods = {
  /** notification client→server, no params: trigger index revalidation */
  revalidate: 'omnetpp/revalidate',
  /** request: CursorParams → UsedByResult */
  usedBy: 'omnetpp/usedBy',
  /** request: CursorParams → ImpactResult */
  impact: 'omnetpp/impact',
  /** request: ViewFocusParams → NedHierarchyItem[] */
  inheritanceRoots: 'omnetpp/inheritanceRoots',
  /** request: FqNameParams → NedHierarchyItem[] */
  subtypes: 'omnetpp/subtypes',
  /** request: ViewFocusParams → ModuleHierNode[] */
  moduleHierarchy: 'omnetpp/moduleHierarchy',
  /** request: FqNameParams → ModuleHierNode[] */
  moduleHierarchyChildren: 'omnetpp/moduleHierarchyChildren',
  /** request: ParamHierarchyParams → ParamHierNode[] */
  paramHierarchy: 'omnetpp/paramHierarchy',
  /** request: ParamHierarchyChildrenParams → ParamHierNode[] */
  paramHierarchyChildren: 'omnetpp/paramHierarchyChildren',
  /** notification client→server: ActiveConfig | null */
  activeConfigChanged: 'omnetpp/activeConfigChanged',
  /** request: ActiveConfig → string | undefined (the config's network fq-name) */
  configNetwork: 'omnetpp/configNetwork',
  /** request: ListConfigurationsParams → IniFileConfigs[] */
  listConfigurations: 'omnetpp/listConfigurations',
  /** request: ViewFocusParams → PreviewScene | null (graphical NED preview) */
  nedPreview: 'omnetpp/nedPreview',
  /** request: void → ToolDef[] (the MCP tool schemas) */
  mcpListTools: 'omnetpp/mcp/listTools',
  /** request: McpCallToolParams → tool-specific result */
  mcpCallTool: 'omnetpp/mcp/callTool',
  /** request: GenerateDocsParams → GenerateDocsResult (NED documentation) */
  generateDocs: 'omnetpp/generateDocs',
  /** notification server→client during generateDocs: GenerateDocsProgress */
  generateDocsProgress: 'omnetpp/generateDocsProgress',
} as const;

/** Parameters of the omnetpp/generateDocs request. All option fields are
 *  optional and default to the generator defaults (the client resolves the
 *  omnetpp.neddoc.* settings into them; types inlined to keep this module
 *  self-contained). */
export interface GenerateDocsParams {
  /** Absolute filesystem path of the output directory. */
  outputDir: string;
  /** Output format (see the neddoc DocFormat). */
  format: 'html' | 'html-readthedocs' | 'html-material' | 'markdown' | 'rst';
  /** Documentation title (defaults to the workspace folder name). */
  title?: string;
  /** Directory exclusion patterns (`*`/`**` globs, project-relative). */
  excludeDirs?: string[];
  /** Module figures on type pages. */
  networkDiagrams?: boolean;
  usageDiagrams?: boolean;
  inheritanceDiagrams?: boolean;
  fullUsageDiagram?: boolean;
  fullInheritanceDiagram?: boolean;
  messageDefinitions?: boolean;
  sourceListings?: boolean;
  automaticHyperlinks?: boolean;
  includeBuiltins?: boolean;
  /** Absolute path of a stylesheet replacing the generated style.css. */
  customCssPath?: string;
  /** Absolute path of a doxygen tag file for "C++ definition" links. */
  doxytagsPath?: string;
  doxyUrlPrefix?: string;
}

export interface GenerateDocsProgress {
  step: string;
  done: number;
  total: number;
  /** Overall completion across all generation phases, 0-100. */
  percent: number;
}

export interface GenerateDocsResult {
  pages: number;
  diagrams: number;
  files: number;
  warnings: string[];
  /** Absolute path of the generated entry page (index.html / index.md / ...). */
  indexPath: string;
}

/** An editor cursor: the document and the position inside it. */
export interface CursorParams {
  uri: string;
  position: Position;
}

/** Focus for the tree views: a pinned type ({fqName}) or an editor position. */
export interface ViewFocusParams {
  uri?: string;
  position?: Position;
  fqName?: string;
}

export interface FqNameParams {
  fqName: string;
}

/** The globally-selected active configuration (ini file + config name). */
export interface ActiveConfig {
  uri: string;
  name: string;
}

export type { UsedByGroup, UsedByItem } from './xref/xrefGrouping';
import type { UsedByGroup } from './xref/xrefGrouping';
export interface UsedByResult {
  /** Display name of the symbol the view reports on, if one resolved. */
  target?: string;
  groups: UsedByGroup[];
}

export interface ImpactResult {
  /** The starting symbol's display name, or undefined if nothing resolved. */
  target?: string;
  items: { label: string; description: string; uri?: string; range?: Range }[];
}

export interface ParamHierarchyParams extends ViewFocusParams {
  activeConfig?: ActiveConfig;
}

export interface ParamHierarchyChildrenParams {
  fqName: string;
  /** Normalized instance path from the network root (config mode only). */
  path?: string;
  activeConfig?: ActiveConfig;
  /** This instance's NED submodule-body assignments, applied to the subtree. */
  subAssign?: Record<string, ParamAssign>;
}

export interface ListConfigurationsParams {
  /** Candidate ini uris found by the client; the server unions in open buffers. */
  uris?: string[];
}
export interface IniFileConfigs {
  uri: string;
  configs: ConfigSummary[];
}

export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** The `omnetpp.*` settings the server consumes, sent as initializationOptions
 *  and re-sent as `settings.omnetpp` on every configuration change. */
export interface OmnetppSettings {
  nedPath?: string;
  installDir?: string;
  diagnostics?: { scope?: string };
  codeLens?: { iniParams?: boolean };
}
