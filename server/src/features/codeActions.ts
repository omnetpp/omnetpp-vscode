import {
  Position,
  WorkspaceEdit,
  Range,
  organizeImports,
  addMissingKeys,
  IniDocument,
  isMsgTypeHeaderLine,
  suggestSimilar,
  sectionName,
  formatSuppressDirective,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import { IndexContext, lineAt } from './context';

export interface CodeActionResult {
  title: string;
  kind: string;
  edit: WorkspaceEdit;
}

/** The value text of the INI entry whose value occupies `range`, if any. */
function iniValueAtRange(ini: IniDocument, range: Range): string | undefined {
  for (const section of ini.sections) {
    for (const e of section.entries) {
      if (e.valueRange.start.line === range.start.line && e.valueRange.start.character === range.start.character) {
        return e.value;
      }
    }
  }
  return undefined;
}

export function computeCodeActions(
  parsed: ParsedDocument,
  ctx: IndexContext,
  contextDiagnostics?: { code?: string | number; range: Range }[],
): CodeActionResult[] {
  const out: CodeActionResult[] = [];
  if (parsed.language === 'ned' && parsed.tree) {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (file) {
      const edits = organizeImports(ctx.nedCache, file, file.tree);
      if (edits.length) {
        out.push({
          title: 'OMNeT++: Organize Imports',
          kind: 'source.organizeImports',
          edit: { changes: { [parsed.uri]: edits } },
        });
      }
    }
  }
  if (parsed.language === 'ini' && parsed.ini) {
    const edits = addMissingKeys(parsed.ini, ctx.nedCache);
    if (edits.length) {
      out.push({
        title: 'OMNeT++: Add Missing Parameter Keys',
        kind: 'source',
        edit: { changes: { [parsed.uri]: edits } },
      });
    }
    // "did you mean …" quick-fixes for broken network= / extends= targets
    const replace = (range: Range, name: string): CodeActionResult => ({
      title: `Change to '${name}'`,
      kind: 'quickfix',
      edit: { changes: { [parsed.uri]: [{ range, newText: name }] } },
    });
    for (const d of contextDiagnostics ?? []) {
      const value = iniValueAtRange(parsed.ini, d.range);
      if (!value) continue;
      if (d.code === 'network-type') {
        const cands = ctx.nedCache.allTypes().filter((t) => t.isNetworkType() && !t.isInnerType).map((t) => t.simpleName);
        for (const s of suggestSimilar(value, cands)) out.push(replace(d.range, s));
      } else if (d.code === 'no-such-section') {
        const cands = parsed.ini.sections.map(sectionName);
        for (const s of suggestSimilar(value, cands)) out.push(replace(d.range, s));
      }
    }
  }
  // "Suppress this diagnostic" — insert a //# (ned/msg) or ### (ini) suppress(code)
  // directive as a trailing comment on the reported line. Works for all langs.
  const seenSuppress = new Set<string>();
  for (const d of contextDiagnostics ?? []) {
    const code = typeof d.code === 'string' ? d.code : undefined;
    if (!code) continue;
    const line = d.range.start.line;
    const key = `${line}\0${code}`;
    if (seenSuppress.has(key)) continue;
    seenSuppress.add(key);
    const directive = formatSuppressDirective(parsed.language, code);
    const lineText = lineAt(parsed.text, line);
    const insert = (title: string, at: Position, newText: string): CodeActionResult => ({
      title,
      kind: 'quickfix',
      edit: { changes: { [parsed.uri]: [{ range: { start: at, end: at }, newText }] } },
    });
    // A trailing directive is dropped by the MSG grammar on a type-header line, so
    // there it must go on the line above; everywhere else, keep it trailing.
    if (parsed.language === 'msg' && parsed.tree && isMsgTypeHeaderLine(parsed.tree, line)) {
      const indent = /^\s*/.exec(lineText)?.[0] ?? '';
      out.push(insert(`Suppress '${code}' on the line above`, { line, character: 0 }, `${indent}${directive}\n`));
    } else {
      out.push(insert(`Suppress '${code}' on this line`, { line, character: lineText.length }, `  ${directive}`));
    }
  }
  return out;
}
