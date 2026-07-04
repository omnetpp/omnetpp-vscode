// The one Node-backed FileSystem implementation, shared by every Node host
// (the LSP server, the standalone MCP server, the CLI linter). Deliberately
// NOT exported from the core barrel (shared/src/index.ts) so the semantic core
// stays free of Node imports; consumers import '@omnetpp/shared/node'.
import { promises as fs } from 'node:fs';
import type { FileStat, FileSystem } from '../fs/fileSystem';

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }
  async readDirectory(path: string): Promise<string[]> {
    return fs.readdir(path);
  }
  async stat(path: string): Promise<FileStat> {
    const s = await fs.stat(path);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
