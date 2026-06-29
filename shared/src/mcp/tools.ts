// Host-agnostic MCP tool layer for the OMNeT++ semantic model.
//
// This module defines the tool schemas and a single `handleTool` dispatcher that
// answers queries (and refactorings) against an injected index context. It has NO
// dependency on the MCP SDK, `vscode`, or Node — the same handlers run both in the
// standalone stdio server (own ProjectIndex built from disk) and inside the LSP
// server (its live index). Transport/glue lives in the adapters.

import type { FileSystem } from '../fs/fileSystem';
import type { ParserService } from '../parser/parserService';
import type { Diagnostic, Location } from '../model/location';
import { DiagnosticSeverity } from '../model/location';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { SemanticDatabase } from '../xref/semanticDatabase';
import type { IniResourceCache } from '../ini/iniResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { nameNode } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import { nedRenameType, nedRenameMember } from '../ned/nedRename';
import { organizeImports } from '../ned/nedOrganizeImports';
import { syntaxDiagnostics } from '../features/syntaxDiagnostics';
import { nedLocalDiagnostics } from '../ned/nedLocalChecks';
import { nedValueDiagnostics } from '../ned/nedValueChecks';
import { nedSemanticDiagnostics } from '../ned/nedSemanticChecks';
import { msgLocalDiagnostics, msgSemanticDiagnostics } from '../msg/msgChecks';
import { nedMsgDiagnostics } from '../xref/nedMsgLinks';
import { iniLocalDiagnostics } from '../ini/iniLocalChecks';
import { iniVariableDiagnostics } from '../ini/iniVariables';
import { iniConfigDiagnostics } from '../ini/iniConfigChecks';
import { iniStructureDiagnostics } from '../ini/iniStructureChecks';
import {
  iniParamDiagnostics,
  effectiveNetwork,
  resolveNetworkType,
  configEntriesInScope,
  configResolver,
  findParamAssignments,
} from '../ini/iniParamResolution';
import { expandNetwork, paramSlots } from '../ini/moduleTree';
import { parseIni, configSummaries } from '../ini/iniDocument';
import { findMsgUsagesInNed, resolveNedClass, nedClassReferences } from '../xref/nedMsgLinks';
import type { ConnectionInfo, ConnEndpoint } from '../ned/nedAst';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/** The index + capabilities a tool handler needs. Supplied by each adapter. */
export interface ToolContext {
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  configRegistry: ConfigRegistry;
  /** Unified query surface (caches + cross-reference graph). */
  db: SemanticDatabase;
  /** Workspace-wide INI index (for reverse param-assignment queries). */
  iniCache: IniResourceCache;
  fs: FileSystem;
  parsers: ParserService;
  /** Normalize a path-or-uri argument to the URI form the caches are keyed by. */
  toUri(pathOrUri: string): string;
  /** Convert a cache URI to a filesystem path the FileSystem can read. */
  toPath(uri: string): string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, any>, ctx: ToolContext): Promise<unknown> | unknown;
}

// ---- serialization helpers ------------------------------------------------

function locOf(uri: string, node: SyntaxNode): Location {
  return { uri, range: nodeRange(node) };
}

function severityName(s: DiagnosticSeverity): string {
  return DiagnosticSeverity[s] ?? String(s);
}

function nedTypeSummary(t: NedTypeInfo) {
  return {
    fqName: t.fqName,
    simpleName: t.simpleName,
    package: t.packageName,
    kind: t.kind,
    isNetwork: t.isNetworkType(),
    file: t.file.uri,
  };
}

function connEndpointSummary(e: ConnEndpoint) {
  return {
    module: e.module,
    gate: e.gate,
    subgate: e.subgate,
    index: e.gateIndex,
    plusplus: e.gatePlusplus,
  };
}

function connectionSummary(c: ConnectionInfo) {
  return {
    direction: c.direction,
    src: connEndpointSummary(c.src),
    dest: connEndpointSummary(c.dest),
    channelType: c.channel?.typeName,
    loops: c.loops,
    conditions: c.conditions,
  };
}

function nedTypeDetail(t: NedTypeInfo) {
  const declNode = nameNode(t.node) ?? t.node;
  return {
    ...nedTypeSummary(t),
    isModule: t.isModuleType(),
    documentation: t.documentation(),
    extends: t.extendsNames(),
    interfaces: t.interfaceNames(),
    ancestors: t.ancestors().map((a) => a.fqName),
    params: [...t.params().values()].map((p) => ({
      name: p.name,
      type: p.type,
      default: p.value,
      volatile: p.volatile,
      unit: p.unit,
      enumValues: p.enumValues,
    })),
    gates: [...t.gates().values()].map((g) => ({ name: g.name, type: g.type, isVector: g.isVector })),
    submodules: [...t.submodules().values()].map((s) => ({
      name: s.name,
      type: s.type,
      likeType: s.likeType,
      isLike: s.isLike,
      isVector: s.isVector,
    })),
    connections: t.connections().map(connectionSummary),
    location: locOf(t.file.uri, declNode),
  };
}

async function readText(uri: string, ctx: ToolContext): Promise<string> {
  return ctx.fs.readFile(ctx.toPath(uri));
}

async function getDiagnostics(uri: string, ctx: ToolContext): Promise<{ uri: string; diagnostics: any[] }> {
  const diags: Diagnostic[] = [];
  if (uri.endsWith('.ned')) {
    const f = ctx.nedCache.getFile(uri);
    let tree = f?.tree;
    let owned: ReturnType<ParserService['parse']> | undefined;
    if (!tree) {
      owned = ctx.parsers.parse('ned', await readText(uri, ctx));
      tree = owned;
    }
    try {
      diags.push(...syntaxDiagnostics(tree), ...nedLocalDiagnostics(tree), ...nedValueDiagnostics(tree));
      if (f) {
        diags.push(...nedSemanticDiagnostics(ctx.nedCache, uri));
        diags.push(...nedMsgDiagnostics(ctx.msgCache, ctx.nedCache, uri));
      }
    } finally {
      owned?.delete();
    }
  } else if (uri.endsWith('.msg')) {
    const f = ctx.msgCache.getFile(uri);
    let tree = f?.tree;
    let owned: ReturnType<ParserService['parse']> | undefined;
    if (!tree) {
      owned = ctx.parsers.parse('msg', await readText(uri, ctx));
      tree = owned;
    }
    try {
      diags.push(...syntaxDiagnostics(tree), ...msgLocalDiagnostics(tree));
      if (f) diags.push(...msgSemanticDiagnostics(ctx.msgCache, uri));
    } finally {
      owned?.delete();
    }
  } else if (uri.endsWith('.ini')) {
    const doc = parseIni(await readText(uri, ctx));
    diags.push(
      ...iniLocalDiagnostics(doc),
      ...iniVariableDiagnostics(doc),
      ...iniConfigDiagnostics(doc, ctx.configRegistry),
      ...iniStructureDiagnostics(doc, ctx.nedCache, ctx.configRegistry),
      ...iniParamDiagnostics(doc, ctx.nedCache, ctx.configRegistry),
    );
  } else {
    throw new Error(`unsupported file (expected .ned/.msg/.ini): ${uri}`);
  }
  return {
    uri,
    diagnostics: diags.map((d) => ({ ...d, severityName: severityName(d.severity) })),
  };
}

// ---- tool registry --------------------------------------------------------

const TOOLS: ToolDef[] = [
  {
    name: 'list_ned_types',
    description:
      'List NED types in the indexed project. Optional filters: kind (simple|compound|network|channel|moduleinterface|channelinterface), package (exact or dotted prefix), name (case-insensitive substring of the simple or fq name).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        package: { type: 'string' },
        name: { type: 'string' },
        includeBuiltins: { type: 'boolean', description: 'Include built-in ned.* types (default false).' },
      },
    },
    handler: (a, ctx) => {
      const name = (a.name as string | undefined)?.toLowerCase();
      return ctx.nedCache
        .allTypes()
        .filter((t) => {
          if (!a.includeBuiltins && t.file.uri.startsWith('omnetpp-builtin:')) return false;
          if (a.kind && t.kind !== a.kind) return false;
          if (a.package && t.packageName !== a.package && !t.packageName.startsWith(a.package + '.')) return false;
          if (name && !t.fqName.toLowerCase().includes(name) && !t.simpleName.toLowerCase().includes(name))
            return false;
          return true;
        })
        .map(nedTypeSummary);
    },
  },
  {
    name: 'get_ned_type',
    description:
      'Full detail for one NED type by fully-qualified name: merged (inherited + local) parameters, gates and submodules, inheritance, interfaces, documentation, and source location.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => {
      const t = ctx.nedCache.getType(a.fqName);
      if (!t) return null;
      const detail = nedTypeDetail(t);
      const cls = nedClassReferences(t)
        .map((r) => ({ className: r.className, resolved: resolveNedClass(ctx.msgCache, t, r.className)?.fqName ?? null }));
      return { ...detail, classRefs: cls };
    },
  },
  {
    name: 'find_subtypes',
    description: 'Types that extend or implement a NED type. Set direct=true for only immediate subtypes.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' }, direct: { type: 'boolean' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => ctx.db.findSubtypes(a.fqName, { direct: !!a.direct }).map(nedTypeSummary),
  },
  {
    name: 'get_inheritance',
    description: 'Inheritance view of a NED type: ancestor chain, implemented interfaces, and direct/all subtypes.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => {
      const t = ctx.nedCache.getType(a.fqName);
      if (!t) return null;
      return {
        fqName: t.fqName,
        ancestors: t.ancestors().map((x) => x.fqName),
        interfaces: t.allInterfaces().map((x) => x.fqName),
        directSubtypes: ctx.db.findSubtypes(t.fqName, { direct: true }).map((x) => x.fqName),
        allSubtypes: ctx.db.findSubtypes(t.fqName).map((x) => x.fqName),
      };
    },
  },
  {
    name: 'find_type_usages',
    description: 'Locations where a NED type is referenced project-wide (as a base type, like-interface, or submodule type).',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => ctx.db.findTypeUsages(a.fqName),
  },
  {
    name: 'get_connections',
    description:
      'Connections of a compound module/network (topology): each with direction, src/dest endpoints (submodule.gate), channel type, and loop/condition context.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => {
      const t = ctx.nedCache.getType(a.fqName);
      return t ? t.connections().map(connectionSummary) : [];
    },
  },
  {
    name: 'find_param_assignments',
    description:
      'Reverse of parameter go-to-definition: every INI key across the workspace that assigns the NED parameter declared by (typeFqName, param). Optionally restricted to one config.',
    inputSchema: {
      type: 'object',
      properties: { typeFqName: { type: 'string' }, param: { type: 'string' }, config: { type: 'string' } },
      required: ['typeFqName', 'param'],
    },
    handler: (a, ctx) =>
      findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.configRegistry, { typeFqName: a.typeFqName, param: a.param }, a.config),
  },
  {
    name: 'find_msg_usages',
    description: 'Where a MSG type is used: NED @class / @signal(type=) sites, plus its direct MSG subtypes.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => ({
      nedSites: findMsgUsagesInNed(ctx.msgCache, ctx.nedCache, a.fqName),
      msgSubtypes: ctx.msgCache
        .allTypes()
        .filter((t) => t.superType()?.fqName === a.fqName)
        .map((t) => t.fqName),
    }),
  },
  {
    name: 'resolve_class',
    description: "Resolve a NED type's @class / @signal backing-class tokens to their MSG type declarations (via the file @namespace).",
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => {
      const t = ctx.nedCache.getType(a.fqName);
      if (!t) return null;
      return nedClassReferences(t).map((r) => ({
        className: r.className,
        resolved: resolveNedClass(ctx.msgCache, t, r.className)?.fqName ?? null,
      }));
    },
  },
  {
    name: 'list_msg_types',
    description:
      'List MSG types. Optional filters: kind (class|struct|message|packet|enum), namespace (exact), name (case-insensitive substring).',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string' }, namespace: { type: 'string' }, name: { type: 'string' } },
    },
    handler: (a, ctx) => {
      const name = (a.name as string | undefined)?.toLowerCase();
      return ctx.msgCache
        .allTypes()
        .filter((t) => {
          if (a.kind && t.kind !== a.kind) return false;
          if (a.namespace && t.namespace !== a.namespace) return false;
          if (name && !t.fqName.toLowerCase().includes(name) && !t.simpleName.toLowerCase().includes(name))
            return false;
          return true;
        })
        .map((t) => ({ fqName: t.fqName, simpleName: t.simpleName, namespace: t.namespace, kind: t.kind, file: t.file.uri }));
    },
  },
  {
    name: 'get_msg_type',
    description: 'Detail for one MSG type: base type and fields (inherited + local), with source location.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' } },
      required: ['fqName'],
    },
    handler: (a, ctx) => {
      const t = ctx.msgCache.getType(a.fqName);
      if (!t) return null;
      return {
        fqName: t.fqName,
        simpleName: t.simpleName,
        namespace: t.namespace,
        kind: t.kind,
        extends: t.extendsName(),
        fields: t.fields().map((f) => ({ name: f.name, type: f.type, default: f.value, isVector: f.isVector })),
        location: locOf(t.file.uri, t.node),
      };
    },
  },
  {
    name: 'list_ini_configs',
    description:
      'List the [Config ...] sections of an INI file with their extends chain, abstract flag, description, and effective network.',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'INI file path or file:// URI.' } },
      required: ['uri'],
    },
    handler: async (a, ctx) => {
      const uri = ctx.toUri(a.uri);
      const doc = parseIni(await readText(uri, ctx));
      return configSummaries(doc).map((c) => {
        const section = doc.sections.find((s) => s.configName === c.name);
        return {
          name: c.name,
          extends: c.extends,
          abstract: c.abstract,
          description: c.description,
          network: section ? effectiveNetwork(doc, section) : undefined,
        };
      });
    },
  },
  {
    name: 'resolve_ini_params',
    description:
      'Resolve the effective parameter values for an INI config section: expands the network module tree, then reports each parameter slot with its value and source (ini assignment / NED default / unassigned). Omit "config" to use [General].',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'INI file path or file:// URI.' },
        config: { type: 'string', description: 'Config name (without the "Config " prefix). Defaults to [General].' },
      },
      required: ['uri'],
    },
    handler: async (a, ctx) => {
      const uri = ctx.toUri(a.uri);
      const doc = parseIni(await readText(uri, ctx));
      const section = a.config
        ? doc.sections.find((s) => s.configName === a.config)
        : doc.sections.find((s) => s.type === 'general');
      if (!section) return { error: `section not found: ${a.config ?? 'General'}` };
      const netName = effectiveNetwork(doc, section);
      if (!netName) return { network: null, resolved: false, params: [] };
      const net = resolveNetworkType(ctx.nedCache, netName);
      if (!net) return { network: netName, resolved: false, params: [] };
      const expansion = expandNetwork(ctx.nedCache, net);
      const resolve = configResolver(configEntriesInScope(doc, section, ctx.configRegistry));
      const params = paramSlots(expansion).map((slot) => {
        const entry = resolve(slot.norm);
        return {
          path: slot.path,
          name: slot.name,
          type: slot.type,
          unit: slot.unit,
          value: entry ? entry.value : slot.hasDefault ? slot.default : undefined,
          source: entry ? 'ini' : slot.hasDefault ? 'ned-default' : 'unassigned',
          assignedBy: entry ? entry.key : undefined,
        };
      });
      return { network: net.fqName, resolved: true, truncated: expansion.truncated, params };
    },
  },
  {
    name: 'lookup_config_option',
    description: 'Look up one OMNeT++ INI configuration option by name (e.g. "sim-time-limit"): type, unit, default, scope, description.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: (a, ctx) => ctx.configRegistry.get(a.name) ?? null,
  },
  {
    name: 'list_config_options',
    description: 'List known OMNeT++ INI configuration options. Optional filters: scope (global|per-run|per-object), name (case-insensitive substring).',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, name: { type: 'string' } },
    },
    handler: (a, ctx) => {
      const name = (a.name as string | undefined)?.toLowerCase();
      return ctx.configRegistry.all().filter((o) => {
        if (a.scope && o.scope !== a.scope) return false;
        if (name && !o.name.toLowerCase().includes(name)) return false;
        return true;
      });
    },
  },
  {
    name: 'get_diagnostics',
    description: 'Run the analyzer on a NED, MSG, or INI file and return its diagnostics (errors/warnings/info).',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'File path or file:// URI (.ned/.msg/.ini).' } },
      required: ['uri'],
    },
    handler: (a, ctx) => getDiagnostics(ctx.toUri(a.uri), ctx),
  },
  {
    name: 'rename_ned_type',
    description:
      'Rename a NED type project-wide. Returns a WorkspaceEdit (changes keyed by file URI) covering the declaration and every reference. Does not write files.',
    inputSchema: {
      type: 'object',
      properties: { fqName: { type: 'string' }, newName: { type: 'string' } },
      required: ['fqName', 'newName'],
    },
    handler: (a, ctx) => nedRenameType(ctx.nedCache, a.fqName, a.newName) ?? { error: `type not found: ${a.fqName}` },
  },
  {
    name: 'rename_member',
    description:
      'Rename a parameter, gate, or submodule of a NED type project-wide (kind auto-detected if omitted). Returns a WorkspaceEdit. Does not write files.',
    inputSchema: {
      type: 'object',
      properties: {
        typeFqName: { type: 'string' },
        member: { type: 'string' },
        newName: { type: 'string' },
        kind: { type: 'string', description: 'param | gate | submodule (optional; auto-detected).' },
      },
      required: ['typeFqName', 'member', 'newName'],
    },
    handler: (a, ctx) =>
      nedRenameMember(ctx.nedCache, a.typeFqName, a.member, a.newName, a.kind) ?? {
        error: `member not found: ${a.member} on ${a.typeFqName}`,
      },
  },
  {
    name: 'organize_imports',
    description: 'Compute import-statement edits (add missing, drop unused, sort) for a NED file. Returns TextEdit[]. Does not write the file.',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'NED file path or file:// URI.' } },
      required: ['uri'],
    },
    handler: (a, ctx) => {
      const uri = ctx.toUri(a.uri);
      const file = ctx.nedCache.getFile(uri);
      if (!file) return { error: `NED file not indexed: ${uri}` };
      return organizeImports(ctx.nedCache, file, file.tree);
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** MCP tool descriptors (name + description + JSON input schema) for tools/list. */
export const OMNETPP_TOOLS = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/** Dispatch an MCP tool call against an index context. Throws on unknown tool. */
export async function handleTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args ?? {}, ctx);
}
