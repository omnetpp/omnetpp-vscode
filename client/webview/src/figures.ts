import {
  buildCardFigure as sharedBuildCardFigure,
  buildDiagram as sharedBuildDiagram,
} from '@omnetpp/shared/preview';
import type { PreviewScene } from '@omnetpp/shared/protocol';
import type { IconStore } from './icons';

/**
 * Webview adapter over the shared diagram layout (which moved to
 * shared/src/graphics/diagramLayout.ts so the doc generator can reuse it):
 * supplies the canvas-based text measurer and the fetch/canvas IconStore.
 */

// the model/figure types continue to be importable from here
export type { BackgroundSpec, ConnFigure, DiagramModel, ShapeSpec, SubFigure } from '@omnetpp/shared/preview';

const FONT = '12px sans-serif';
let measureCtx: CanvasRenderingContext2D | undefined;

export function textWidth(text: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')!;
    measureCtx.font = FONT;
  }
  return measureCtx.measureText(text).width;
}

/** Build the whole positioned diagram for a compound-module scene. */
export function buildDiagram(scene: PreviewScene, icons: IconStore, seed: number) {
  return sharedBuildDiagram(scene, { icons, measureText: textWidth, seed });
}

/** The non-compound "card": the type rendered with its own icon/shape rules. */
export function buildCardFigure(scene: PreviewScene, icons: IconStore) {
  return sharedBuildCardFigure(scene, { icons, measureText: textWidth, seed: 1 });
}
