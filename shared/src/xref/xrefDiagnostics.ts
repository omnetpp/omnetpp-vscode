// Cross-reference-derived diagnostics + the name-suggestion helper behind the
// "did you mean …" quick-fixes. These read the reverse index, so they live next
// to the graph rather than in the per-language checkers.

import { Diagnostic, DiagnosticSeverity } from '../model/location';
import type { SemanticDatabase } from './semanticDatabase';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { IniResourceCache } from '../ini/iniResourceCache';
import { nedTypeSym } from './symbolId';
import { nameNode, nedClassRefs } from '../ned/nedAst';
import { nedImplClass } from './nedMsgLinks';
import { nodeRange } from '../parser/treeUtils';

/**
 * Hint: a NED `network` that no indexed configuration runs and no other NED type
 * references. Suppressed entirely when the workspace has no INI files (a pure NED
 * library is not expected to carry its own configs), to avoid false positives.
 */
export function nedUnusedNetworkDiagnostics(
  db: SemanticDatabase,
  nedCache: NedResourceCache,
  iniCache: IniResourceCache,
  uri: string,
): Diagnostic[] {
  if (iniCache.allDocs().length === 0) return [];
  const out: Diagnostic[] = [];
  for (const t of nedCache.typesInFile(uri)) {
    if (t.kind !== 'network') continue;
    if (db.index.inboundOf(nedTypeSym(t.fqName)).length > 0) continue;
    out.push({
      range: nodeRange(nameNode(t.node) ?? t.node),
      severity: DiagnosticSeverity.Hint,
      message: `Network '${t.simpleName}' is not run by any configuration or referenced by any NED type.`,
      source: 'omnetpp',
      code: 'unused-network',
    });
  }
  return out;
}

/**
 * Warning: a `simple` module with no C++ implementation class. A simple module
 * runs C++ code registered with `Define_Module()`; its class is the type's own
 * `@class` value (else its name), or a value inherited from a supertype. This
 * fires only when NEITHER the module NOR any supertype resolves to an indexed
 * `Define_Module`/`Define_Channel` class. The warning anchors on the module's own
 * `@class(...)` value when it declares one, otherwise on the `simple <Name>` line.
 *
 * Suppressed entirely when the workspace has no indexed C++ at all (a pure NED /
 * analysis-only project we cannot check), to avoid false positives.
 */
export function nedMissingImplClassDiagnostics(
  db: SemanticDatabase,
  nedCache: NedResourceCache,
  uri: string,
): Diagnostic[] {
  if (db.cppCache.allFiles().length === 0) return [];
  const out: Diagnostic[] = [];
  for (const t of nedCache.typesInFile(uri)) {
    if (t.kind !== 'simple') continue;
    const impl = nedImplClass(t);
    if (!impl) continue; // base type not indexed → the class is unknown, don't guess
    // implemented when the kernel-resolved class (own/inherited @class, else the
    // root type's own name) points at an indexed Define_Module/Define_Channel
    if (db.findImplClass(t.fqName)) continue;

    const ownClass = nedClassRefs(t.node)[0]; // the type's own @class(...) value, if any
    const className = impl.className;
    out.push({
      range: nodeRange(ownClass?.node ?? nameNode(t.node) ?? t.node),
      severity: DiagnosticSeverity.Warning,
      message: ownClass
        ? `No registered C++ class '${className}' (Define_Module/Register_Class/…) was found for simple module '${t.simpleName}'.`
        : `Simple module '${t.simpleName}' has no C++ implementation class registered with Define_Module('${className}').`,
      source: 'omnetpp',
      code: 'missing-cpp-class',
    });
  }
  return out;
}

/** Up to `max` candidate names within a small edit distance of `target`. */
export function suggestSimilar(target: string, candidates: Iterable<string>, max = 3): string[] {
  const t = target.toLowerCase();
  const threshold = t.length <= 4 ? 1 : 2;
  const scored: { c: string; d: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c === target || seen.has(c)) continue;
    seen.add(c);
    const d = levenshtein(t, c.toLowerCase());
    if (d <= threshold) scored.push({ c, d });
  }
  scored.sort((a, b) => a.d - b.d || a.c.localeCompare(b.c));
  return scored.slice(0, max).map((s) => s.c);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
