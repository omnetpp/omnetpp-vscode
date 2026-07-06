/**
 * The graphical "type figure" on documentation pages: for compound modules
 * and networks the rendered NED layout (submodules with icons, connections —
 * the same figure the preview webview shows, via the shared diagramLayout/
 * diagramSvg pipeline); for other types the compact "card" with the type's
 * own icon/shape. Submodules link to their type's documentation page.
 */

import type { NedResourceCache } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import { buildPreviewScene } from '../ned/nedPreviewScene';
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
