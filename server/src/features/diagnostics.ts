import {
  Diagnostic,
  syntaxDiagnostics,
  nedLocalDiagnostics,
  nedSemanticDiagnostics,
  nedValueDiagnostics,
  iniLocalDiagnostics,
  iniConfigDiagnostics,
  iniStructureDiagnostics,
  iniVariableDiagnostics,
  iniParamDiagnostics,
  msgLocalDiagnostics,
  msgSemanticDiagnostics,
  nedUnusedNetworkDiagnostics,
  nedMissingImplClassDiagnostics,
  filterSuppressedDiagnostics,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';

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
    diags.push(...iniLocalDiagnostics(parsed.ini));
    diags.push(...iniVariableDiagnostics(parsed.ini));
    if (ctx) {
      diags.push(...iniConfigDiagnostics(parsed.ini, ctx.registry));
      diags.push(...iniStructureDiagnostics(parsed.ini, ctx.nedCache, ctx.registry));
      diags.push(...iniParamDiagnostics(parsed.ini, ctx.nedCache, ctx.registry));
    }
  }
  return filterSuppressedDiagnostics(diags, {
    language: parsed.language,
    text: parsed.text,
    tree: parsed.tree,
  });
}
