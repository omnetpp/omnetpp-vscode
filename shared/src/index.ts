// This barrel IS the public API of @omnetpp/shared. Named exports = curated
// public surface (exactly the names consumers use — functions, plus the
// result/param types their signatures mention); `export *` is reserved for
// modules that are public in their entirety. Internals not exported here are
// not API: server/, mcp/, and client/ (via '@omnetpp/shared/protocol') must
// not need anything this file doesn't surface.

// NOTE: shared/src/node (the Node-backed FileSystem) is deliberately absent
// here — the core barrel stays Node-free. It ships via '@omnetpp/shared/node'.
export * from './fs/fileSystem';
// Custom omnetpp/* LSP protocol contract (also exposed standalone as
// '@omnetpp/shared/protocol' so the client can import it without the core).
export * from './protocol';
export * from './model/location';
export * from './model/symbols';
export * from './model/completion';
export * from './parser/parserService';
export { nodeRange } from './parser/treeUtils';
export { syntaxDiagnostics } from './features/syntaxDiagnostics';
export { filterSuppressedDiagnostics, formatSuppressDirective } from './diagnostics/suppress';
export { type FoldingRange, treeFoldingRanges, iniFoldingRanges } from './features/folding';
export { type FormatOptions, formatDocumentEdits } from './features/format';
export { type WorkspaceSymbolInfo, workspaceSymbols } from './features/workspaceSymbols';

// NED
export { nameNode, fileNamespace } from './ned/nedAst';
export { nedDocumentSymbols } from './ned/nedSymbols';
export { nedLocalDiagnostics } from './ned/nedLocalChecks';
export { BUILTIN_URI, BUILTIN_NED_TEXT, type NedFileInfo, NedResourceCache } from './ned/nedResourceCache';
export { NedTypeInfo } from './ned/nedTypeInfo';
export { nedSemanticDiagnostics } from './ned/nedSemanticChecks';
export {
  referenceAt,
  type MemberKey,
  memberKeyFor,
  memberRefAt,
  nedDefinition,
  type HoverResult,
  nedDocRefResolver,
  nedHover,
  nedReferences,
} from './ned/nedNavigation';
export { nedCompletion } from './ned/nedCompletion';
export { nedPrepareRename, nedPrepareMemberRename, nedRename } from './ned/nedRename';
export {
  type NedHierarchyItem,
  prepareTypeHierarchy,
  typeSupertypes,
  typeSubtypes,
  inheritanceSpineFor,
} from './ned/nedHierarchy';
export { type ModuleHierNode, moduleHierarchyRoot, moduleHierarchyChildren } from './ned/nedModuleHierarchy';
export { type PreviewScene, buildPreviewScene, previewSceneByFq } from './ned/nedPreviewScene';
export {
  type ParamHierNode,
  type ParamAssign,
  type ParamResolve,
  type ParamViewOpts,
  paramHierarchyRoot,
  paramHierarchyChildren,
} from './ned/nedParamHierarchy';
export { organizeImports } from './ned/nedOrganizeImports';
export { nedValueDiagnostics } from './ned/nedValueChecks';

// Project model + disk indexing building blocks
export {
  type ProjectLayout,
  type NedSourceRoot,
  discoverProjectLayout,
  rootForPath,
  packageForFile,
  isExcludedPackage,
} from './project/projectModel';
export {
  type DiskFileMeta,
  type DiskFileSink,
  loadBuiltins,
  scanSourceRoots,
  collectIndexableFiles,
  populateDatabase,
} from './project/diskIndexer';

// Cross-reference graph + unified query surface
export {
  type SymbolId,
  type ParsedSymbol,
  nedTypeSym,
  msgTypeSym,
  nedMemberSym,
  iniSectionSym,
  cppSym,
  parseSymbolId,
} from './xref/symbolId';
export { type XrefEdge, type EdgeKind } from './xref/xrefModel';
export { XrefIndex } from './xref/xrefIndex';
export { SemanticDatabase } from './xref/semanticDatabase';
export {
  nedUnusedNetworkDiagnostics,
  nedMissingImplClassDiagnostics,
  suggestSimilar,
} from './xref/xrefDiagnostics';
export { type ImpactNode, impactOf } from './xref/impact';
export { type SymbolLookupDoc, symbolAtPosition, groupEdges, refDisplayName, edgeKindLabel } from './xref/xrefGrouping';
export { paramContainerSimpleNames } from './xref/paramContainers';
export {
  type NedClassRefAt,
  nedClassRefAt,
  nedClassDefinition,
  resolveNedClass,
  findMsgUsagesInNed,
} from './xref/nedMsgLinks';

// C++ scanner + cache (lightweight cross-referencing of .cc/.h)
export { isCppSourceFile } from './cpp/cppScanner';
export { CppResourceCache } from './cpp/cppResourceCache';

// MCP tool layer (host-agnostic; no MCP SDK dependency)
export { type ToolContext, lintFile, OMNETPP_TOOLS, handleTool } from './mcp/tools';

// NED documentation generator (neddoc)
export { type DocFormat, type NeddocOptions, defaultNeddocOptions, excludePatternRegex } from './neddoc/options';
export {
  type DocModel,
  type DocPage,
  type DocPageRef,
  type DocSection,
  type DocCell,
  type DiagramRequest,
  type NavNode,
  type SearchEntry,
} from './neddoc/docModel';
export { type NeddocInput, extractDocModel } from './neddoc/extract';
export { type GeneratedFile, type NeddocRenderer, type RenderCtx } from './neddoc/renderer';
export {
  type NeddocProgress,
  type NeddocResult,
  type DiagramSvgRenderer,
  type DiagramRenderCtx,
  type DiagramRendererConfig,
  NeddocCancelled,
  generateNeddoc,
  collectNeddoc,
  rendererForFormat,
  createDiagramRenderer,
} from './neddoc/generate';
export { type IncludeResolution } from './neddoc/commentAst';
export {
  type ExternalDocSet,
  type ExternalTypeRef,
  ExternalDocsResolver,
  parseExternalDocsSpec,
} from './neddoc/externalDocs';
export { renderTypeFigureSvg, type TypeFigureOptions } from './neddoc/typeFigure';
export { renderGraphDiagramSvg, type DocGraph, type DocGraphNode, type DocGraphEdge } from './neddoc/graphDiagram';
export { layeredLayout, type LayeredNode, type LayeredEdge, type LayeredResult } from './neddoc/layeredLayout';

// MSG
export { msgNameNode, isMsgTypeHeaderLine } from './msg/msgAst';
export { msgDocumentSymbols } from './msg/msgSymbols';
export { MsgResourceCache } from './msg/msgResourceCache';
export { MsgTypeInfo } from './msg/msgTypeInfo';
export { msgDefinition, msgHover, msgCompletion, msgTypeAt, msgRenameRangeAt, msgDocRefResolver } from './msg/msgNavigation';
export { msgLocalDiagnostics, msgSemanticDiagnostics } from './msg/msgChecks';

// INI
export {
  type IniEntry,
  type IniSection,
  type IniDocument,
  type ConfigSummary,
  parseIni,
  configSummaries,
} from './ini/iniDocument';
export { IniResourceCache } from './ini/iniResourceCache';
export { expandIncludes, resolveIncludeUri, entryInFile, iniIncludeDiagnostics } from './ini/iniInclude';
export { iniDocumentSymbols } from './ini/iniSymbols';
export { iniLocalDiagnostics } from './ini/iniLocalChecks';
export { type ConfigOption, ConfigRegistry } from './ini/configRegistry';
export { type KeyClass, classifyKey, iniConfigDiagnostics } from './ini/iniConfigChecks';
export { sectionName, iniStructureDiagnostics } from './ini/iniStructureChecks';
export { iniVariableDiagnostics } from './ini/iniVariables';
export { iniHover, iniCompletion } from './ini/iniNavigation';
export { iniEntryAt, leafSegment, keySegmentPrefixAt, isWildcardSegment, extendsLabelAt } from './ini/iniKeySegments';
export {
  effectiveNetwork,
  sectionChain,
  findSection,
  generalSection,
  configEntriesInScope,
  effectiveResolver,
  resolveNetworkType,
  type MatchedParamModule,
  effectiveParamModules,
  configResolver,
  matchedParamModules,
} from './ini/iniParamResolution';
export { iniParamDiagnostics } from './ini/iniParamChecks';
export { addMissingKeys } from './ini/iniParamCodeActions';
export {
  typenameTypeTargets,
  modulesAtPath,
  matchedModules,
  iniParamDefinition,
  type ParamAssignment,
  findParamAssignments,
} from './ini/iniParamNavigation';
