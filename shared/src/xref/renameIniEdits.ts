// The INI side of a NED rename, shared by the IDE rename and the MCP rename
// tools so both return the same edits: INI files name NED types in `network =`
// and `typename` values and NED parameters in assignment keys.
import type { Location, TextEdit } from '../model/location';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { IniResourceCache } from '../ini/iniResourceCache';
import type { ConfigRegistry } from '../ini/configRegistry';
import { findParamAssignments, iniTypenameReferences } from '../ini/iniParamNavigation';
import type { SemanticDatabase } from './semanticDatabase';
import { nedTypeSym } from './symbolId';

export type RenameChanges = Record<string, TextEdit[]>;

/** Replace the trailing `oldName` segment of a single-line reference token. */
export function trailingNameEdit(loc: Location, oldName: string, newName: string): TextEdit | undefined {
  const r = loc.range;
  if (r.start.line !== r.end.line) return undefined;
  const start = { line: r.end.line, character: r.end.character - oldName.length };
  if (start.character < r.start.character) return undefined;
  return { range: { start, end: r.end }, newText: newName };
}

export function addRenameEdit(changes: RenameChanges, uri: string, edit?: TextEdit): void {
  if (edit) (changes[uri] ??= []).push(edit);
}

/** Add the INI edits for renaming NED type `target`: `network =` and `typename` values. */
export function addIniTypeRenameEdits(
  changes: RenameChanges,
  deps: { db: SemanticDatabase; iniCache: IniResourceCache; nedCache: NedResourceCache },
  target: NedTypeInfo,
  newName: string,
): void {
  const oldSimple = target.simpleName;
  for (const e of deps.db.index.inboundOf(nedTypeSym(target.fqName))) {
    if (e.kind === 'ini-network') addRenameEdit(changes, e.src.uri, trailingNameEdit(e.src, oldSimple, newName));
  }
  for (const loc of iniTypenameReferences(deps.iniCache, deps.nedCache, target)) {
    addRenameEdit(changes, loc.uri, trailingNameEdit(loc, oldSimple, newName));
  }
}

/** Add the INI edits for renaming parameter `param` of its canonical owner `ownerFq`:
 *  assignment keys whose last segment is the parameter. */
export function addIniParamRenameEdits(
  changes: RenameChanges,
  deps: { iniCache: IniResourceCache; nedCache: NedResourceCache; registry: ConfigRegistry },
  ownerFq: string,
  param: string,
  newName: string,
): void {
  for (const a of findParamAssignments(deps.iniCache, deps.nedCache, deps.registry, { typeFqName: ownerFq, param })) {
    if (a.key === param || a.key.endsWith('.' + param)) {
      addRenameEdit(changes, a.uri, trailingNameEdit({ uri: a.uri, range: a.keyRange }, param, newName));
    }
  }
}
