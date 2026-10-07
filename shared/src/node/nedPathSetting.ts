import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonc } from '../project/jsonc';
import { splitNedPath } from './fsPath';

// Outside VS Code (the standalone tools, opp_lsp in other editors, agents) the
// project's committed `.vscode/settings.json` is the one place a NED path can be
// shared with teammates, so the tools read the same setting the IDE uses.

/** The `omnetpp.nedPath` value of `<projectDir>/.vscode/settings.json`, or ''. */
export function readNedPathSetting(projectDir: string): string {
  let text: string;
  try {
    text = readFileSync(join(projectDir, '.vscode', 'settings.json'), 'utf8');
  } catch {
    return '';
  }
  try {
    const value = (parseJsonc(text) as Record<string, unknown> | null)?.['omnetpp.nedPath'];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** A NED path list with every entry made absolute against `baseDir`, ';'-joined. */
export function resolveNedPath(list: string, baseDir: string): string {
  return splitNedPath(list).map((p) => resolve(baseDir, p)).join(';');
}
