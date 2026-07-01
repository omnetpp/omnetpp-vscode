import { promises as fs } from 'node:fs';
import type { FileStat, FileSystem } from '@omnetpp/shared';

/** Node-backed FileSystem for the language server. */
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
