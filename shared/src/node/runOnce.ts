import * as fs from 'node:fs';
import * as path from 'node:path';

/** A claim older than this is taken over: the process that made it may have died. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Claims the one-time task `name` for this process, through a file in `dir` that every
 * process with the same `dir` sees (VS Code windows share the global storage folder).
 * Returns false while another process holds a fresh claim. It fails open: when the file
 * cannot be written or read, it returns true, because a task done twice is better than a
 * task never done.
 */
export function claimOnce(dir: string, name: string, now = Date.now()): boolean {
  const file = path.join(dir, `${name}.claim`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return true;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return true;
    }
    try {
      if (now - fs.statSync(file).mtimeMs < CLAIM_STALE_MS) return false;
      fs.rmSync(file, { force: true });
    } catch {
      return true;
    }
  }
  return false;
}
