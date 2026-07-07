// Node-backed implementation of the RandomAccessFile abstraction (see
// shared/src/fs/randomAccess.ts). Deliberately NOT exported from the core
// barrel (shared/src/index.ts) so the semantic core stays free of Node
// imports; consumers import '@omnetpp/shared/node'.
import * as fs from 'node:fs';
import type { RandomAccessFile, RandomAccessFileProvider } from '../fs/randomAccess';

export class NodeRandomAccessFile implements RandomAccessFile {
  readonly path: string;
  private fd: number | undefined;

  constructor(path: string) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
  }

  getSize(): number {
    return fs.fstatSync(this.ensureOpen()).size;
  }

  getMtimeMs(): number {
    return fs.fstatSync(this.ensureOpen()).mtimeMs;
  }

  readAt(buffer: Uint8Array, fileOffset: number): number {
    if (buffer.length === 0) return 0;
    // fs.readSync with an explicit `position` is a true pread: it does not
    // move (and is unaffected by) any other file position/cursor.
    return fs.readSync(this.ensureOpen(), buffer, 0, buffer.length, fileOffset);
  }

  close(): void {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }

  private ensureOpen(): number {
    if (this.fd === undefined) throw new Error(`NodeRandomAccessFile: file is closed: ${this.path}`);
    return this.fd;
  }
}

export class NodeRandomAccessFileProvider implements RandomAccessFileProvider {
  openRandomAccess(path: string): RandomAccessFile {
    return new NodeRandomAccessFile(path);
  }
}
