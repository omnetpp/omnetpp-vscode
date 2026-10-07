// The AI agent setup surface, published as the '@omnetpp/shared/agents' subpath so
// the extension bundle does not pull in the parser stack through the main barrel.
export * from './plugin';
export * from './projectFiles';
export { editedFiles } from './hookInput';
