import { renderCardSvg, renderDiagramSvg } from '@omnetpp/shared/preview';
import type { DiagramModel, SubFigure } from '@omnetpp/shared/preview';
import type { PreviewScene } from '@omnetpp/shared/protocol';

/**
 * Webview adapter over the shared string SVG renderer
 * (shared/src/graphics/diagramSvg.ts): the diagram is rendered to markup by
 * the same code path the doc generator uses, then parsed back into a live
 * SVGSVGElement for the preview panel (zoom, hit-testing and SVG/PNG export
 * in main.ts keep working on the element as before).
 */

function toElement(svg: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return doc.documentElement as unknown as SVGSVGElement;
}

/** Render a full compound-module diagram. */
export function renderDiagram(model: DiagramModel, title: string): SVGSVGElement {
  return toElement(renderDiagramSvg(model, { title }).svg);
}

/** Render the non-compound "card": the type's own icon/shape + name + kind. */
export function renderCard(scene: PreviewScene, figure: SubFigure): SVGSVGElement {
  return toElement(renderCardSvg(scene, figure).svg);
}
