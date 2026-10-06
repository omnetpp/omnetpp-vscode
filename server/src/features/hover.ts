import {
  Position,
  Range,
  effectiveParamModules,
  MatchedParamModule,
  classifyKey,
  nedHover,
  nedDocRefResolver,
  nedClassRefAt,
  msgHover,
  msgDocRefResolver,
  iniHover,
  HoverResult,
  posInRange,
  iniEntryAt,
  leafSegment,
  typenameCandidates,
  typenameSlotInterfaces,
  typeCandidatesHover,
  mergedSection,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import { IndexContext, baseName, plural, mergedIniDoc } from './context';

/**
 * VS Code's hover widget reserves a minimum height (~4 rows): content shorter
 * than that leaves the bottom of the widget unpainted, so the editor behind it
 * shows through as a transparent strip. Built-in hovers never surface this
 * because they are rarely shorter than the minimum, but our signature-only and
 * short-doc hovers routinely are. Pad short hovers with trailing zero-width-space
 * paragraphs so every reserved row carries the hover background.
 */
const HOVER_MIN_ROWS = 4;
const ZWSP_PARAGRAPH = '\n\n​';

/** Rough count of the rows VS Code renders for a hover's markdown. */
function estimateHoverRows(md: string): number {
  let rows = 0;
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence; // a fence marker is the code box border, not a visible row
      continue;
    }
    if (inFence) rows += 1; // each code line is a row
    else if (line.trim() !== '') rows += 1; // a text line is ~a row; blank separators add only margin
  }
  return rows;
}

function padHoverMarkdown(md: string): string {
  let out = md;
  for (let rows = estimateHoverRows(md); rows < HOVER_MIN_ROWS; rows += 1) {
    out += ZWSP_PARAGRAPH;
  }
  return out;
}

export function computeHover(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
  fallbackNetwork?: string,
): HoverResult | null {
  const h = computeHoverRaw(parsed, pos, ctx, fallbackNetwork);
  return h ? { ...h, markdown: padHoverMarkdown(h.markdown) } : null;
}

/** How many matched module paths to list in a param-line hover before eliding. */
const HOVER_PATH_LIMIT = 12;

/** Markdown for a param-assignment hover: parameter type(s) + the matched modules. */
function paramAssignmentHover(matches: MatchedParamModule[], key: string, range: Range): HoverResult {
  const types = [...new Set(matches.map((m) => m.paramType).filter((t): t is string => !!t))];
  const typeStr = types.length === 1 ? ` — type \`${types[0]}\`` : types.length ? ` — types ${types.map((t) => `\`${t}\``).join(', ')}` : '';
  const paths = matches.map((m) => m.path);
  const shown = paths.slice(0, HOVER_PATH_LIMIT).map((p) => `- \`${p}\``);
  if (paths.length > HOVER_PATH_LIMIT) shown.push(`- …and ${paths.length - HOVER_PATH_LIMIT} more`);
  const header = `parameter \`${key}\`${typeStr} — **${matches.length}** matching module parameter${plural(matches.length)}`;
  return { markdown: `${header}\n\n${shown.join('\n')}`, range };
}

function computeHoverRaw(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
  fallbackNetwork?: string,
): HoverResult | null {
  if (parsed.language === 'ini' && parsed.ini) {
    const h = iniHover(parsed.ini, ctx.registry, pos);
    if (h) return h;
    // parameter assignment key: show the resolved NED parameter type + matched modules
    const hit = iniEntryAt(parsed.ini, pos);
    if (hit && posInRange(pos, hit.entry.keyRange) && classifyKey(ctx.registry, hit.entry.key).kind === 'param-assignment') {
      // only the parameters this key WINS (OMNeT++ first-match-wins precedence)
      const matches = effectiveParamModules(parsed.ini, ctx.nedCache, hit.section, hit.entry, ctx.registry, fallbackNetwork);
      if (matches.length) return paramAssignmentHover(matches, hit.entry.key, hit.entry.keyRange);
    }
    const typeName = hit?.entry.value.replace(/^"|"$/g, '').trim() ?? '';
    if (hit && leafSegment(hit.entry.key) === 'typename' && posInRange(pos, hit.entry.valueRange) && /^[A-Za-z_][\w.]*$/.test(typeName)) {
      const merged = mergedIniDoc(parsed.ini, parsed.uri, ctx);
      const section = mergedSection(merged, hit.section);
      const ifaces = typenameSlotInterfaces(merged, ctx.nedCache, section, hit.entry.key, fallbackNetwork);
      const candidates = typenameCandidates(ctx.nedCache, hit.entry.value, ifaces);
      return typeCandidatesHover(ctx.nedCache, typeName, candidates, hit.entry.valueRange, msgDocRefResolver(ctx.msgCache));
    }
    return null;
  }
  if (!parsed.tree) return null;
  if (parsed.language === 'ned') {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    // @class / @signal(type=) token: a data type resolves to its MSG declaration;
    // a module/channel @class names a C++ implementation class (Define_Module), so
    // fall back to the C++ index and report where the class is registered.
    const hit = nedClassRefAt(ctx.msgCache, ctx.nedCache, file, file.tree, pos);
    if (hit) {
      let md: string;
      if (hit.target) {
        md = `\`\`\`msg\n${hit.target.kind} ${hit.target.fqName}\n\`\`\``;
      } else {
        const ns = ctx.nedCache.cxxNamespace(hit.owner.file);
        const cpp = ctx.db.cppCache.lookupClass(hit.ref.className, ns);
        if (cpp) {
          const where = baseName(cpp.decl.uri);
          const line = cpp.decl.range.start.line + 1;
          md =
            `\`\`\`cpp\nclass ${cpp.qualifiedName}\n\`\`\`\n\n` +
            `Registered with \`${cpp.macro}\` in [${where}](${cpp.decl.uri}) (line ${line})`;
        } else {
          md =
            `C++ class \`${hit.ref.className}\` — no matching class registration ` +
            `(\`Define_Module\`/\`Define_Channel\`/\`Register_Class\`, …) found in the indexed C++ sources.`;
        }
      }
      return { markdown: md, range: hit.range };
    }
    // NED docs may cross-reference MSG types: resolve those against the MSG index.
    return nedHover(ctx.nedCache, file, file.tree, pos, msgDocRefResolver(ctx.msgCache));
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    // MSG docs may cross-reference NED types, and vice versa.
    return file ? msgHover(ctx.msgCache, file, file.tree, pos, nedDocRefResolver(ctx.nedCache)) : null;
  }
  return null;
}
