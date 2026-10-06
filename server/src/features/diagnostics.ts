import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Diagnostic,
  syntaxDiagnostics,
  nedLocalDiagnostics,
  nedSemanticDiagnostics,
  nedValueDiagnostics,
  iniFileDiagnostics,
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
    diags.push(
      ...iniFileDiagnostics(
        parsed.ini,
        parsed.uri,
        ctx && {
          nedCache: ctx.nedCache,
          registry: ctx.registry,
          getIniDoc: ctx.getIniDoc,
          includeExists: (u) => includeExists(u, ctx),
        },
      ),
    );
  }
  return filterSuppressedDiagnostics(diags, {
    language: parsed.language,
    text: parsed.text,
    tree: parsed.tree,
  });
}
