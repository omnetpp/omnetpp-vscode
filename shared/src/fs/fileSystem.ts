// A minimal, Node-free filesystem abstraction so the semantic core can run in any
// host (Node language server today, web worker later). The server provides a concrete
// implementation backed by node:fs.

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  /** Last-modification time in epoch milliseconds, if the host provides it.
   *  Used by the server's self-healing revalidation to detect changed files. */
  mtimeMs?: number;
  /** File size in bytes, if the host provides it (a cheap change signal
   *  alongside mtime, since a rewrite with identical mtime still shifts size). */
  size?: number;
}

export interface FileSystem {
  /** Read a UTF-8 text file. Throws if it does not exist. */
  readFile(path: string): Promise<string>;
  /** List directory entry names (not full paths). */
  readDirectory(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
}
