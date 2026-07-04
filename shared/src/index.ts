// NOTE: shared/src/node (the Node-backed FileSystem) is deliberately absent
// here — the core barrel stays Node-free. It ships via '@omnetpp/shared/node'.
export * from './fs/fileSystem';
// Custom omnetpp/* LSP protocol contract (also exposed standalone as
// '@omnetpp/shared/protocol' so the client can import it without the core).
export * from './protocol';
export * from './model/location';
export * from './model/resourceCacheBase';
export * from './model/symbols';
export * from './model/completion';
export * from './parser/parserService';
export * from './parser/treeUtils';
export * from './features/syntaxDiagnostics';
export * from './diagnostics/suppress';
export * from './features/folding';
export * from './features/format';
export * from './features/workspaceSymbols';

// NED
export * from './ned/nedAst';
export * from './ned/nedSymbols';
export * from './ned/nedLocalChecks';
export * from './ned/nedResourceCache';
export * from './ned/nedTypeInfo';
export * from './ned/nedSemanticChecks';
export * from './ned/nedNavigation';
export * from './ned/nedCompletion';
export * from './ned/nedRename';
export * from './ned/nedHierarchy';
export * from './ned/nedModuleHierarchy';
export * from './ned/nedParamHierarchy';
export * from './ned/nedOrganizeImports';

export * from './ned/nedValueChecks';

// Expressions
export * from './expr/exprParser';
export * from './expr/infer';

// Project model + disk indexing building blocks
export * from './project/projectModel';
export * from './project/diskIndexer';

// Cross-reference graph + unified query surface
export * from './xref/symbolId';
export * from './xref/xrefModel';
export * from './xref/xrefIndex';
export * from './xref/semanticDatabase';
export * from './xref/xrefDiagnostics';
export * from './xref/impact';
export * from './xref/paramContainers';
export * from './xref/nedMsgLinks';
export * from './xref/cppExtract';

// C++ scanner + cache (lightweight cross-referencing of .cc/.h)
export * from './cpp/cppScanner';
export * from './cpp/cppResourceCache';

// MCP tool layer (host-agnostic; no MCP SDK dependency)
export * from './mcp/tools';

// MSG
export * from './msg/msgAst';
export { msgDocumentSymbols } from './msg/msgSymbols';
export * from './msg/msgResourceCache';
export * from './msg/msgTypeInfo';
export { msgDefinition, msgHover, msgCompletion, msgTypeAt, msgRenameRangeAt, msgDocRefResolver } from './msg/msgNavigation';
export * from './msg/msgChecks';

// INI
export * from './ini/iniDocument';
export * from './ini/iniResourceCache';
export * from './ini/iniSymbols';
export * from './ini/iniLocalChecks';
export * from './ini/configRegistry';
export * from './ini/iniConfigChecks';
export * from './ini/iniStructureChecks';
export * from './ini/iniVariables';
export { iniHover, iniCompletion } from './ini/iniNavigation';
export * from './ini/moduleTree';
export * from './ini/iniParamResolution';
