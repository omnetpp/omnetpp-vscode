/**
 * Links to separately generated documentation of dependencies (the Eclipse
 * generator's "External documentation" option / `opp_docgen -l`). Types that
 * are indexed but not documented in this run belong to a dependency; the
 * longest matching NED package prefix in the configured mapping says where its
 * documentation lives.
 *
 * Host-agnostic: the host reads the target's nedtags.xml / msgtags.xml (only
 * for local targets) and passes their content in.
 */

import { parseDoxyTags } from './doxytags';

/** One configured dependency documentation set. */
export interface ExternalDocSet {
  /** NED package prefix (e.g. `inet`); MSG types match on their C++ name. */
  prefix: string;
  /** Absolute URL, or a path relative to the output root directory. */
  target: string;
  /** Content of the target's nedtags.xml, when the host could read it. */
  nedTags?: string;
  /** Content of the target's msgtags.xml, when the host could read it. */
  msgTags?: string;
}

/** Where an indexed-but-not-documented type's documentation is. */
export interface ExternalTypeRef {
  /** Dependency label shown in tooltips and warnings (the matched prefix, or
   *  the type's top-level package when nothing matched). */
  from: string;
  /** Absolute URL or output-root-relative path of the type's page; undefined
   *  when the type cannot be linked. */
  target?: string;
  /** Why `target` is missing. */
  reason?: 'unconfigured' | 'not-in-tagfile';
}

/**
 * Parse the legacy list syntax: `name=target` items separated by commas
 * and/or whitespace. Throws on malformed items so hosts can fail before
 * touching the output directory.
 */
export function parseExternalDocsSpec(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of spec.split(/[,\s]+/).filter(Boolean)) {
    const eq = item.indexOf('=');
    const name = eq < 0 ? '' : item.slice(0, eq).trim();
    const target = eq < 0 ? '' : item.slice(eq + 1).trim();
    if (!name || !target) throw new Error(`invalid external documentation entry "${item}" (expected <package>=<url-or-path>)`);
    out[name] = target;
  }
  return out;
}

export function isAbsoluteUrl(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !/^[a-zA-Z]:[\\/]/.test(target);
}

/** Normalize a configured target: one trailing `/` stripped, a leading `./`
 *  dropped (relativeRef() works on plain segment lists). */
export function normalizeExternalTarget(target: string): string {
  let t = target.trim().replace(/\/$/, '');
  if (!isAbsoluteUrl(t)) t = t.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return t;
}

/** Resolves dependency types to their external documentation pages. */
export class ExternalDocsResolver {
  private sets: { prefix: string; target: string; ned?: Map<string, string>; msg?: Map<string, string> }[];

  constructor(sets: ExternalDocSet[]) {
    this.sets = sets
      .map((s) => ({
        prefix: s.prefix.replace(/::/g, '.').replace(/\.+$/, ''),
        target: normalizeExternalTarget(s.target),
        ned: s.nedTags !== undefined ? parseDoxyTags(s.nedTags) : undefined,
        msg: s.msgTags !== undefined ? parseDoxyTags(s.msgTags) : undefined,
      }))
      // longest prefix first
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  private match(dotted: string) {
    return this.sets.find((s) => dotted === s.prefix || dotted.startsWith(s.prefix + '.'));
  }

  private static topLevel(dotted: string): string {
    const dot = dotted.indexOf('.');
    return dot < 0 ? '(default package)' : dotted.slice(0, dot);
  }

  private static join(target: string, file: string): string {
    return target ? `${target}/${file}` : file;
  }

  resolveNed(fqName: string): ExternalTypeRef {
    const set = this.match(fqName);
    if (!set) return { from: ExternalDocsResolver.topLevel(fqName), reason: 'unconfigured' };
    if (set.ned) {
      const file = set.ned.get(fqName);
      return file
        ? { from: set.prefix, target: ExternalDocsResolver.join(set.target, file) }
        : { from: set.prefix, reason: 'not-in-tagfile' };
    }
    return { from: set.prefix, target: ExternalDocsResolver.join(set.target, `${fqName}.html`) };
  }

  /** `cppName` is the C++ qualified name (ns::Foo); msgtags.xml lists MSG
   *  types under their simple name (as the Eclipse generator writes it). */
  resolveMsg(cppName: string, simpleName: string): ExternalTypeRef {
    const dotted = cppName.replace(/::/g, '.');
    const set = this.match(dotted);
    if (!set) return { from: ExternalDocsResolver.topLevel(dotted), reason: 'unconfigured' };
    if (set.msg) {
      const file = set.msg.get(simpleName);
      return file
        ? { from: set.prefix, target: ExternalDocsResolver.join(set.target, file) }
        : { from: set.prefix, reason: 'not-in-tagfile' };
    }
    return { from: set.prefix, target: ExternalDocsResolver.join(set.target, `${cppName.replace(/::/g, '-')}.html`) };
  }
}
