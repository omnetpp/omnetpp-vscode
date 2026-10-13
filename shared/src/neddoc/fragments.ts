/**
 * Documentation fragment files: a port of the Eclipse IDE's NeddocExtensions.
 * An XML file whose root element holds `<docfragment>` elements, each with
 * an `anchor` and one of `nedtype`, `msgtype` or `filename`; its text (usually
 * a CDATA section) is inserted at that anchor of the page it names:
 *
 *   <docfragments>
 *     <docfragment nedtype="inet.node.Host" anchor="after-signals">
 *       <![CDATA[ ... ]]>
 *     </docfragment>
 *   </docfragments>
 *
 * `nedtype` also names a package on the packages page and `msgtype` a
 * namespace on the namespaces page (anchors `top` and `bottom`), as in
 * Eclipse. Fragments with the same target and anchor are concatenated.
 *
 * Host-agnostic: the host reads the file; a small scanner covers the XML
 * subset these files use (declaration, comments, DOCTYPE, CDATA, the five
 * predefined entities and character references).
 */

export type FragmentTarget = 'nedtype' | 'msgtype' | 'filename';

export const NED_TYPE_ANCHORS = [
  'top',
  'after-description',
  'after-image',
  'after-diagrams',
  'after-usage',
  'after-inheritance',
  'after-parameters',
  'after-properties',
  'after-gates',
  'after-signals',
  'after-statistics',
  'after-unassigned-parameters',
  'bottom',
] as const;
export const MSG_TYPE_ANCHORS = [
  'top',
  'after-description',
  'after-diagrams',
  'after-inheritance',
  'after-fields',
  'after-properties',
  'bottom',
] as const;
/** Anchors of the package / namespace page sections. */
export const GROUP_ANCHORS = ['top', 'bottom'] as const;
/** Anchors of the file listing pages (which this generator does not produce). */
export const FILE_ANCHORS = ['top', 'after-types', 'bottom'] as const;

const ANCHORS: Record<FragmentTarget, readonly string[]> = {
  nedtype: NED_TYPE_ANCHORS,
  msgtype: MSG_TYPE_ANCHORS,
  filename: FILE_ANCHORS,
};

export interface DocFragment {
  target: FragmentTarget;
  key: string;
  anchor: string;
  content: string;
  /** Where it was defined, for warnings: `<source>:<line>`. */
  location: string;
}

export interface DocFragmentFile {
  /** Shown in warnings (the host passes the path). */
  source: string;
  xml: string;
}

class XmlError extends Error {}

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, ent: string) => {
    if (ent[0] === '#') return String.fromCodePoint(ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[ent]!;
  });
}

interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  /** Text content of the element and its descendants (DOM getTextContent). */
  text: string;
  children: XmlElement[];
  line: number;
}

/** Minimal XML parser: returns the root element. */
function parseXml(xml: string): XmlElement {
  let pos = 0;
  const lineAt = (p: number) => xml.slice(0, p).split('\n').length;
  const fail = (msg: string, p = pos): never => {
    throw new XmlError(`line ${lineAt(p)}: ${msg}`);
  };
  const skipMisc = () => {
    for (;;) {
      const ws = /^\s*/.exec(xml.slice(pos))![0];
      pos += ws.length;
      if (xml.startsWith('<?', pos)) {
        const end = xml.indexOf('?>', pos);
        if (end < 0) fail('unterminated processing instruction');
        pos = end + 2;
      } else if (xml.startsWith('<!--', pos)) {
        const end = xml.indexOf('-->', pos);
        if (end < 0) fail('unterminated comment');
        pos = end + 3;
      } else if (xml.startsWith('<!DOCTYPE', pos)) {
        const end = xml.indexOf('>', pos);
        if (end < 0) fail('unterminated DOCTYPE');
        pos = end + 1;
      } else return;
    }
  };
  const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
  const element = (): XmlElement => {
    const start = pos;
    pos++; // '<'
    const name = NAME.exec(xml.slice(pos))?.[0] ?? fail('expected an element name');
    pos += name.length;
    const el: XmlElement = { name, attrs: new Map(), text: '', children: [], line: lineAt(start) };
    for (;;) {
      pos += /^\s*/.exec(xml.slice(pos))![0].length;
      if (xml.startsWith('/>', pos)) {
        pos += 2;
        return el;
      }
      if (xml[pos] === '>') {
        pos++;
        break;
      }
      const attr = /^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(xml.slice(pos));
      if (!attr) return fail(`malformed attribute in <${name}>`);
      el.attrs.set(attr[1], unescapeXml(attr[3] ?? attr[4]));
      pos += attr[0].length;
    }
    for (;;) {
      if (pos >= xml.length) fail(`<${name}> is not closed`, start);
      if (xml.startsWith('<![CDATA[', pos)) {
        const end = xml.indexOf(']]>', pos);
        if (end < 0) fail('unterminated CDATA section');
        el.text += xml.slice(pos + 9, end);
        pos = end + 3;
      } else if (xml.startsWith('<!--', pos)) {
        const end = xml.indexOf('-->', pos);
        if (end < 0) fail('unterminated comment');
        pos = end + 3;
      } else if (xml.startsWith('</', pos)) {
        const close = /^<\/([^\s>]+)\s*>/.exec(xml.slice(pos));
        if (!close || close[1] !== name) return fail(`expected </${name}>`);
        pos += close[0].length;
        return el;
      } else if (xml[pos] === '<') {
        const child = element();
        el.children.push(child);
        el.text += child.text;
      } else {
        const next = xml.indexOf('<', pos);
        const end = next < 0 ? xml.length : next;
        el.text += unescapeXml(xml.slice(pos, end));
        pos = end;
      }
    }
  };
  skipMisc();
  if (xml[pos] !== '<') fail('expected a root element');
  const root = element();
  skipMisc();
  if (pos < xml.length) fail('content after the root element');
  return root;
}

/** Parse fragment files into fragments; problems go to `warnings`. */
export function parseDocFragments(files: DocFragmentFile[], warnings: string[]): DocFragment[] {
  const out: DocFragment[] = [];
  for (const file of files) {
    let root: XmlElement;
    try {
      root = parseXml(file.xml);
    } catch (e) {
      if (!(e instanceof XmlError)) throw e;
      warnings.push(`doc fragments ${file.source}: ${e.message} (file skipped)`);
      continue;
    }
    for (const el of root.children) {
      const location = `${file.source}:${el.line}`;
      if (el.name !== 'docfragment') {
        warnings.push(`${location}: unexpected <${el.name}> element (expected <docfragment>)`);
        continue;
      }
      const target = (['nedtype', 'msgtype', 'filename'] as const).find((t) => el.attrs.has(t));
      if (!target) {
        warnings.push(`${location}: <docfragment> needs a nedtype, msgtype or filename attribute`);
        continue;
      }
      const anchor = el.attrs.get('anchor');
      if (!anchor || !ANCHORS[target].includes(anchor)) {
        warnings.push(
          `${location}: ${anchor ? `unknown anchor "${anchor}"` : 'missing anchor'} for ${target} (expected one of: ${ANCHORS[target].join(', ')})`,
        );
        continue;
      }
      out.push({ target, key: el.attrs.get(target)!, anchor, content: el.text, location });
    }
  }
  return out;
}

/** Strip the indentation common to all non-blank lines, so that list items
 *  in an indented CDATA block start a top-level list. */
export function dedent(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(common, /^[ \t]*/.exec(l)![0].length))).join('\n');
}

/** Fragment lookup by target, key and anchor; remembers which ones were
 *  inserted so the rest can be reported. */
export class DocFragmentSet {
  private byKey = new Map<string, DocFragment[]>();
  private used = new Set<DocFragment>();

  constructor(fragments: DocFragment[]) {
    for (const f of fragments) {
      const k = DocFragmentSet.mapKey(f.target, f.key, f.anchor);
      const list = this.byKey.get(k);
      if (list) list.push(f);
      else this.byKey.set(k, [f]);
    }
  }

  private static mapKey(target: FragmentTarget, key: string, anchor: string): string {
    return `${target}\0${key}\0${anchor}`;
  }

  get size(): number {
    return this.byKey.size;
  }

  /** The concatenated content for this anchor, or undefined. */
  take(target: FragmentTarget, key: string, anchor: string): string | undefined {
    const list = this.byKey.get(DocFragmentSet.mapKey(target, key, anchor));
    if (!list) return undefined;
    for (const f of list) this.used.add(f);
    return list.map((f) => dedent(f.content)).join('\n');
  }

  unused(): DocFragment[] {
    return [...this.byKey.values()].flat().filter((f) => !this.used.has(f));
  }
}
