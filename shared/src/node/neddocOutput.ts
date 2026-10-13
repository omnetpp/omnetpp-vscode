import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Lists the files the last documentation run wrote into its output folder. */
export const NEDDOC_MANIFEST = '.neddoc-files';

const HEADER =
  '# Written by the OMNeT++ NED documentation generator. The next run into this\n' +
  '# folder deletes the files listed here that it does not write again.\n';

/**
 * Tracks the files of a documentation run so that the files of the previous
 * run that this one does not write again (renamed or deleted types, files,
 * pages) are removed. Only files listed in the previous run's manifest are
 * ever deleted, never other content of the output folder.
 */
export class NeddocOutputTracker {
  private readonly outputDir: string;
  private readonly previous: string[];
  private readonly written = new Set<string>();

  constructor(outputDir: string) {
    this.outputDir = resolve(outputDir);
    this.previous = readManifest(this.outputDir);
  }

  record(relativePath: string): void {
    this.written.add(relativePath);
  }

  /** After a complete run, deletes the stale files (and the folders they
   *  leave empty) and returns their paths; after a failed or canceled one
   *  deletes nothing and keeps listing the previous files too. */
  finish(complete: boolean): string[] {
    const removed: string[] = [];
    if (complete) {
      for (const rel of this.previous) {
        if (this.written.has(rel)) continue;
        const target = join(this.outputDir, ...rel.split('/'));
        try {
          if (!lstatSync(target).isFile()) continue;
          unlinkSync(target);
          removed.push(rel);
          this.pruneEmptyDirs(dirname(target));
        } catch {
          /* already gone */
        }
      }
    }
    const listed = complete ? [...this.written] : [...new Set([...this.previous, ...this.written])];
    writeFileSync(join(this.outputDir, NEDDOC_MANIFEST), HEADER + listed.sort().join('\n') + '\n');
    return removed;
  }

  private pruneEmptyDirs(dir: string): void {
    for (let d = dir; d.length > this.outputDir.length && d.startsWith(this.outputDir); d = dirname(d)) {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    }
  }
}

/** The manifest's paths; lines that could point outside the folder are
 *  ignored. */
function readManifest(outputDir: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(outputDir, NEDDOC_MANIFEST), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .filter((rel) => !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split(/[/\\]/).includes('..') && rel !== NEDDOC_MANIFEST);
}
