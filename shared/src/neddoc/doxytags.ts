/**
 * Doxygen tag-file support for the "C++ definition" links on documentation
 * pages: parses a doxytags.xml (GENERATE_TAGFILE output of a doxygen run the
 * user did separately) into a class-name → page map. Unlike the Eclipse
 * generator, doxygen is never executed — this is link-out only.
 *
 * Host-agnostic: the XML content is passed in as a string (pre-read by the
 * host); a small regex scan is plenty for the tag-file subset we need.
 */

const COMPOUND_RE = /<compound kind="(?:class|struct)"(?:[^>]*)>([\s\S]*?)<\/compound>/g;

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Parse a doxygen tag file into a fully-qualified C++ class name → html
 *  file map. */
export function parseDoxyTags(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (let m = COMPOUND_RE.exec(xml); m; m = COMPOUND_RE.exec(xml)) {
    const body = m[1];
    const name = /<name>([\s\S]*?)<\/name>/.exec(body)?.[1];
    const filename = /<filename>([\s\S]*?)<\/filename>/.exec(body)?.[1];
    if (!name || !filename) continue;
    const file = filename.includes('.') ? filename : `${filename}.html`;
    out.set(unescapeXml(name.trim()), unescapeXml(file.trim()));
  }
  return out;
}

/** Resolve a C++ class (by any of the candidate spellings, most qualified
 *  first) to its documentation URL. */
export function doxyUrlFor(
  map: Map<string, string>,
  urlPrefix: string,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates) {
    const file = map.get(candidate);
    if (file) {
      if (!urlPrefix) return file;
      return urlPrefix.endsWith('/') ? urlPrefix + file : `${urlPrefix}/${file}`;
    }
  }
  return undefined;
}
