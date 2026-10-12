/**
 * Fully qualified candidates for a C++ name used in a namespace context, in the
 * order C++ name lookup and the OMNeT++ kernel (`cRegistrationList::lookup`) try
 * them: a leading `::` pins the name to the global namespace; otherwise the name,
 * even an already qualified one like `dymo::Dymo`, is tried in the context
 * namespace, then in each enclosing namespace, and finally globally.
 */
export function scopedNameCandidates(name: string, contextNamespace: string): string[] {
  if (name.startsWith('::')) return [name.slice(2)];
  const out: string[] = [];
  let ns = contextNamespace.replace(/^::/, '');
  while (ns) {
    out.push(`${ns}::${name}`);
    const i = ns.lastIndexOf('::');
    ns = i >= 0 ? ns.slice(0, i) : '';
  }
  out.push(name);
  return out;
}
