// Node-side loading of the neddoc dependency-documentation mapping: reads the
// nedtags.xml / msgtags.xml of local targets (paths relative to the output
// directory) so links use the target's exact page names. URL targets are
// never fetched; they fall back to the Eclipse page naming.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAbsoluteUrl, normalizeExternalTarget, type ExternalDocSet } from '../neddoc/externalDocs';

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function loadExternalDocSets(mapping: Record<string, string>, outputDir: string): ExternalDocSet[] {
  return Object.entries(mapping).map(([prefix, rawTarget]) => {
    const target = normalizeExternalTarget(rawTarget);
    if (isAbsoluteUrl(target)) return { prefix, target };
    const dir = resolve(outputDir, target);
    return {
      prefix,
      target,
      nedTags: readIfExists(resolve(dir, 'nedtags.xml')),
      msgTags: readIfExists(resolve(dir, 'msgtags.xml')),
    };
  });
}
