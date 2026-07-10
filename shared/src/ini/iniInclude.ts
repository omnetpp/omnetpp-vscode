import { Diagnostic, DiagnosticSeverity } from '../model/location';
import type { IniDocument, IniEntry, IniSection } from './iniDocument';
import { sectionCanonicalName } from './iniDocument';

/**
 * `include` support. OMNeT++ processes an `include otherfile.ini` directive by
 * textually inserting the included file's lines at that point, so its sections
 * merge with same-named sections of the including file and its parameter
 * assignments participate in resolution (with first-match-wins precedence).
 *
 * {@link expandIncludes} builds that merged "effective" document: sections with
 * the same canonical name are combined, their entries concatenated in
 * include-expansion (textual) order. Every entry/section carries a `sourceUri`
 * pointing at the file it physically lives in, so callers can keep diagnostics
 * and navigation attached to the right file.
 *
 * Adapted from OMNeT++'s `InifileReader::doReadFile()` / `getOrCreateSection()`
 * (src/envir/inifilereader.cc): same textual, recursive include expansion and
 * same-canonical-name section merging. The include-cycle guard is reimplemented
 * as a `visited` set of resolved URIs here, in place of the C++ side's
 * `includedFiles` vector that is pushed/popped around each recursive call.
 */

/**
 * Resolve an `include` path (relative to the including file) to a `file:` URI.
 * Surrounding quotes are tolerated. Returns undefined for an empty/invalid path.
 */
export function resolveIncludeUri(fromUri: string, includePath: string): string | undefined {
  const p = includePath.trim().replace(/^["']|["']$/g, '').trim();
  if (!p) return undefined;
  try {
    return new URL(p, fromUri).toString();
  } catch {
    return undefined;
  }
}

/** Whether an entry belongs to `uri` (its own file, or unmerged). */
export function entryInFile(e: IniEntry, uri: string): boolean {
  return !e.sourceUri || e.sourceUri === uri;
}

/**
 * Warn about `include` directives whose target cannot be found. `exists` reports
 * whether a resolved `file:` URI is available (open buffer or on disk); the
 * caller supplies it since path/existence checks are host-specific.
 */
export function iniIncludeDiagnostics(
  doc: IniDocument,
  exists: (uri: string) => boolean,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const inc of doc.includes) {
    const uri = doc.uri ? resolveIncludeUri(doc.uri, inc.path) : undefined;
    if (uri && exists(uri)) continue;
    out.push({
      range: inc.range,
      severity: DiagnosticSeverity.Warning,
      message: `Cannot find included file: ${inc.path}`,
      source: 'omnetpp',
      code: 'include-not-found',
    });
  }
  return out;
}

/** Line used to order a section against `include` directives on the timeline. The
 *  implicit [General] has its header pinned at line 0 though its entries come
 *  later, so order it by its first entry (an include above those entries must
 *  precede them). */
function orderLine(sec: IniSection): number {
  const implicitGeneral =
    sec.type === 'general' && sec.headerRange.start.line === 0 && sec.headerRange.end.character === 0;
  if (implicitGeneral) return sec.entries[0]?.line ?? sec.range.start.line;
  return sec.headerRange.start.line;
}

interface Fragment {
  uri: string;
  section: IniSection;
}

/** Depth-first, textual-order collection of every section reachable from `uri`. */
function collect(
  uri: string,
  getDoc: (uri: string) => IniDocument | undefined,
  visited: Set<string>,
  out: Fragment[],
): void {
  if (visited.has(uri)) return; // cycle / diamond guard
  visited.add(uri);
  const doc = getDoc(uri);
  if (!doc) return;

  const events: { line: number; section?: IniSection; includeUri?: string }[] = [];
  for (const section of doc.sections) events.push({ line: orderLine(section), section });
  for (const inc of doc.includes) {
    events.push({ line: inc.line, includeUri: resolveIncludeUri(uri, inc.path) });
  }
  events.sort((a, b) => a.line - b.line);

  for (const ev of events) {
    if (ev.section) out.push({ uri, section: ev.section });
    else if (ev.includeUri) collect(ev.includeUri, getDoc, visited, out);
  }
}

/**
 * Build the effective document rooted at `rootUri` with `include` directives
 * expanded and same-named sections merged. `getDoc` supplies parsed documents
 * (open buffers first, then the on-disk index); an include whose target it
 * cannot supply is skipped. When the root has no includes the returned document
 * is equivalent to the root's own parsed document (with entries tagged).
 */
export function expandIncludes(
  rootUri: string,
  getDoc: (uri: string) => IniDocument | undefined,
): IniDocument {
  const fragments: Fragment[] = [];
  collect(rootUri, getDoc, new Set(), fragments);

  const byName = new Map<string, IniSection>();
  const order: IniSection[] = [];
  for (const { uri, section } of fragments) {
    const name = sectionCanonicalName(section);
    const tagged = section.entries.map((e) => ({ ...e, sourceUri: e.sourceUri ?? uri }));
    const existing = byName.get(name);
    if (!existing) {
      const merged: IniSection = {
        ...section,
        sourceUri: section.sourceUri ?? uri,
        entries: [...tagged],
        extends: [...section.extends],
      };
      byName.set(name, merged);
      order.push(merged);
    } else {
      existing.entries.push(...tagged);
      // Prefer a header located in the root file, so extends-navigation lands in
      // the file the user is editing when the section exists there too.
      if (uri === rootUri && existing.sourceUri !== rootUri) {
        existing.sourceUri = rootUri;
        existing.headerRange = section.headerRange;
        existing.range = section.range;
        existing.rawName = section.rawName;
      }
    }
  }

  // Recompute `extends` from the merged entries (last `extends=` wins, as parseIni
  // does within a single section) so it reflects included base sections too.
  for (const sec of order) {
    let ex: string[] | undefined;
    for (const e of sec.entries) {
      if (e.key === 'extends') ex = e.value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (ex) sec.extends = ex;
  }

  return { sections: order, includes: getDoc(rootUri)?.includes ?? [], uri: rootUri };
}
