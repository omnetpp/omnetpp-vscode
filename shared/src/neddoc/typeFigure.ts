/**
 * The graphical "type figure" on documentation pages: for compound modules
 * and networks the rendered NED layout (submodules with icons, connections —
 * the same figure the preview webview shows, via the shared diagramLayout/
 * diagramSvg pipeline); for other types the compact "card" with the type's
 * own icon/shape. Submodules link to their type's documentation page.
 */

import type { NedResourceCache } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import { buildPreviewScene, type PreviewSubmodule } from '../ned/nedPreviewScene';
import { leadingDocCommentRaw } from '../ned/nedAst';
import { briefText } from './commentAst';
import {
  buildCardFigure,
  buildDiagram,
  type IconProvider,
  type TextMeasurer,
} from '../graphics/diagramLayout';
import { renderCardSvg, renderDiagramSvg, type RenderedSvg } from '../graphics/diagramSvg';
import { approxTextWidth } from '../graphics/textMetrics';

export interface TypeFigureOptions {
  icons: IconProvider;
  /** Text measurer for label placement (default: the Helvetica table). */
  measureText?: TextMeasurer;
  /** Layout seed (default 1 — matches the preview's initial layout). */
  seed?: number;
  /** href for a submodule's resolved type page. */
  linkHrefFor?: (fqName: string) => string | undefined;
  title?: string;
}

export async function renderTypeFigureSvg(
  cache: NedResourceCache,
  type: NedTypeInfo,
  opts: TypeFigureOptions,
): Promise<RenderedSvg | undefined> {
  const scene = buildPreviewScene(cache, type);
  const buildOpts = {
    icons: opts.icons,
    measureText: opts.measureText ?? ((text: string) => approxTextWidth(text)),
    seed: opts.seed ?? 1,
    submoduleTooltip: submoduleTooltip(cache, type),
  };
  // same dispatch as the preview panel: scenes with a submodule list render
  // as full diagrams, all other kinds as the compact card
  if (scene.submodules) {
    const model = await buildDiagram(scene, buildOpts);
    return renderDiagramSvg(model, { title: opts.title ?? type.simpleName, linkHrefFor: opts.linkHrefFor });
  }
  const figure = await buildCardFigure(scene, buildOpts);
  return renderCardSvg(scene, figure, { linkHrefFor: opts.linkHrefFor });
}

/** Eclipse's makeSubmoduleTooltip, after our declaration line: the brief
 *  description of the type (for `like` submodules "Type: ..." of the
 *  resolved type and of the interface), then the submodule's source. */
function submoduleTooltip(cache: NedResourceCache, type: NedTypeInfo): (sub: PreviewSubmodule) => string[] {
  const submodules = type.submodules();
  const brief = (t: NedTypeInfo | undefined, prefixed: boolean): string | undefined => {
    const raw = t && leadingDocCommentRaw(t.node);
    const doc = raw ? briefText(raw, 100) : '';
    if (!doc) return undefined;
    return prefixed ? `${t!.simpleName}: ${doc}` : doc;
  };
  return (p) => {
    const sub = submodules.get(p.name);
    if (!sub) return [];
    const resolved = p.resolvedTypeFqName ? cache.getType(p.resolvedTypeFqName) : undefined;
    const parts: (string | undefined)[] = [];
    if (!sub.isLike) {
      parts.push(brief(resolved, false));
    } else {
      const owner = type.submoduleDecl(p.name)?.owner ?? type;
      const iface = sub.likeType ? cache.lookupType(sub.likeType, owner.file, owner.fqName) : undefined;
      parts.push(brief(resolved, true));
      if (iface && iface !== resolved) parts.push(brief(iface, true));
    }
    const lines = sub.node.text.trim().split('\n');
    let first = 0;
    while (first < lines.length && lines[first].trimStart().startsWith('//')) first++;
    const source = lines.slice(first).join('\n');
    parts.push(`Source:\n${source.length > 300 ? source.slice(0, 297) + '...' : source}`);
    return parts.filter((part): part is string => part !== undefined);
  };
}
