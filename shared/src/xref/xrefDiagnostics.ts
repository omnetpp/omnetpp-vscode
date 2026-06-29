// Cross-reference-derived diagnostics + the name-suggestion helper behind the
// "did you mean …" quick-fixes. These read the reverse index, so they live next
// to the graph rather than in the per-language checkers.

import { Diagnostic, DiagnosticSeverity } from '../model/location';
import type { SemanticDatabase } from './semanticDatabase';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { IniResourceCache } from '../ini/iniResourceCache';
import { nedTypeSym } from './symbolId';
import { nameNode } from '../ned/nedAst';
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
