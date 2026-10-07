// Node-only companions of @omnetpp/shared, published as the
// '@omnetpp/shared/node' subpath so the core barrel stays Node-free.
export { NodeFileSystem } from './nodeFileSystem';
export { indexPath, splitNedPath, uriToIndexPath } from './fsPath';
export { createNodeIconProvider, sniffImageSize, listIconIds, type NodeIconProviderOptions } from './docIcons';
export { NodeRandomAccessFile, NodeRandomAccessFileProvider } from './nodeRandomAccessFile';
export { loadExternalDocSets } from './externalDocSets';
export { readNedPathSetting, resolveNedPath } from './nedPathSetting';
