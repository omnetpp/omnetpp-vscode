// Self-contained (no imports): re-exported to the client via protocol.ts.

export type NedTypeNameMatch =
  | { kind: 'exact'; fqName: string }
  | { kind: 'unique'; fqName: string }
  | { kind: 'ambiguous'; fqNames: string[] }
  | { kind: 'none' };

/** Match loose input against known NED type fq-names: an exact fq-name, else a
 *  case-insensitive simple-name match, which may name several types. */
export function matchNedTypeName(text: string, fqNames: readonly string[]): NedTypeNameMatch {
  if (fqNames.includes(text)) return { kind: 'exact', fqName: text };
  const needle = text.toLowerCase();
  const matches = fqNames.filter((fq) => (fq.split('.').pop() ?? fq).toLowerCase() === needle);
  if (matches.length === 1) return { kind: 'unique', fqName: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', fqNames: [...matches].sort() };
  return { kind: 'none' };
}
