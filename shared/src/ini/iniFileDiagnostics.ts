import type { Diagnostic } from '../model/location';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { ConfigRegistry } from './configRegistry';
import type { IniDocument } from './iniDocument';
import { expandIncludes, iniIncludeDiagnostics } from './iniInclude';
import { iniLocalDiagnostics } from './iniLocalChecks';
import { iniVariableDiagnostics } from './iniVariables';
import { iniConfigDiagnostics } from './iniConfigChecks';
import { sectionName, iniStructureDiagnostics } from './iniStructureChecks';
import { iniParamDiagnostics } from './iniParamChecks';

export interface IniFileDiagnosticsDeps {
  nedCache: NedResourceCache;
  registry: ConfigRegistry;
  /** Parsed document of an included file, if the host can supply it. */
  getIniDoc(uri: string): IniDocument | undefined;
  includeExists(uri: string): boolean;
}

/**
 * Every diagnostic of one INI file, unsuppressed. The IDE and the linter share
 * this list so that an INI file lints the same in both. Without `deps` only
 * the file-local checks run.
 */
export function iniFileDiagnostics(ownIni: IniDocument, uri: string, deps?: IniFileDiagnosticsDeps): Diagnostic[] {
  const diags = [...iniLocalDiagnostics(ownIni), ...iniVariableDiagnostics(ownIni)];
  if (!deps) return diags;
  // Expand `include`d files so extends= into a base config resolves and param
  // resolution sees inherited [General]/typenames. Own entries stay flagged in
  // this file; included entries only inform resolution (tagged by sourceUri).
  const merged = ownIni.includes.length
    ? expandIncludes(uri, (u) => (u === uri ? ownIni : deps.getIniDoc(u)))
    : ownIni;
  diags.push(
    ...iniConfigDiagnostics(ownIni, deps.registry),
    ...iniStructureDiagnostics(ownIni, deps.nedCache, deps.registry, merged.sections.map(sectionName)),
    ...iniParamDiagnostics(merged, deps.nedCache, deps.registry, uri),
  );
  if (ownIni.includes.length) diags.push(...iniIncludeDiagnostics(ownIni, deps.includeExists));
  return diags;
}
