import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Diagnostic,
  IniDocument,
  syntaxDiagnostics,
  nedLocalDiagnostics,
  nedSemanticDiagnostics,
  nedValueDiagnostics,
  iniLocalDiagnostics,
  iniConfigDiagnostics,
  iniStructureDiagnostics,
  iniVariableDiagnostics,
  iniParamDiagnostics,
  iniIncludeDiagnostics,
  expandIncludes,
  sectionName,
  msgLocalDiagnostics,
  msgSemanticDiagnostics,
  nedUnusedNetworkDiagnostics,
  nedMissingImplClassDiagnostics,
  filterSuppressedDiagnostics,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';

/** An included file is resolvable if it is indexed/open or exists on disk. */
function includeExists(uri: string, ctx: IndexContext): boolean {
  if (ctx.getIniDoc(uri)) return true;
  try {
    return existsSync(fileURLToPath(uri));
  } catch {
    return false;
  }
}

export function computeDiagnostics(parsed: ParsedDocument, ctx?: IndexContext): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (parsed.tree) {
    diags.push(...syntaxDiagnostics(parsed.tree));
    if (parsed.language === 'ned') {
      diags.push(...nedLocalDiagnostics(parsed.tree));
      diags.push(...nedValueDiagnostics(parsed.tree));
      if (ctx) {
        diags.push(...nedSemanticDiagnostics(ctx.nedCache, parsed.uri));
        diags.push(...nedUnusedNetworkDiagnostics(ctx.db, ctx.nedCache, ctx.iniCache, parsed.uri));
        diags.push(...nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, parsed.uri));
      }
    } else if (parsed.language === 'msg') {
      diags.push(...msgLocalDiagnostics(parsed.tree));
      if (ctx) diags.push(...msgSemanticDiagnostics(ctx.msgCache, parsed.uri));
    }
  }
  if (parsed.ini) {
    const ownIni = parsed.ini;
    diags.push(...iniLocalDiagnostics(ownIni));
    diags.push(...iniVariableDiagnostics(ownIni));
    if (ctx) {
      // Expand `include`d files so extends= into a base config resolves and param
      // resolution sees inherited [General]/typenames. Own entries stay flagged in
      // this file; included entries only inform resolution (tagged by sourceUri).
      const merged: IniDocument = ownIni.includes.length
        ? expandIncludes(parsed.uri, (u) => (u === parsed.uri ? ownIni : ctx.getIniDoc(u)))
        : ownIni;
      diags.push(...iniConfigDiagnostics(ownIni, ctx.registry));
      diags.push(
        ...iniStructureDiagnostics(ownIni, ctx.nedCache, ctx.registry, merged.sections.map(sectionName)),
      );
      diags.push(...iniParamDiagnostics(merged, ctx.nedCache, ctx.registry, parsed.uri));
      if (ownIni.includes.length) {
        diags.push(...iniIncludeDiagnostics(ownIni, (u) => includeExists(u, ctx)));
      }
    }
  }
  return filterSuppressedDiagnostics(diags, {
    language: parsed.language,
    text: parsed.text,
    tree: parsed.tree,
  });
}
