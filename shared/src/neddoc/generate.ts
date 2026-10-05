/**
 * Orchestration of the NED documentation generator: extract the DocModel,
 * render diagrams, render pages with the format's renderer, and stream every
 * output file to the host through the `emit` callback (shared/ stays free of
 * filesystem access; the CLI and the LSP server do the writing).
 */

import { extractDocModel, type NeddocInput } from './extract';
import { pageIdForType, type DiagramRequest, type DocModel } from './docModel';
import { cooperativeYielder, defaultNeddocOptions, type NeddocOptions } from './options';
import { dirOf, externalHref, pageById, relativeRef, type GeneratedFile, type NeddocRenderer, type RenderCtx } from './renderer';
import { HtmlRenderer } from './renderHtml';
import { RtdHtmlRenderer } from './renderRtdHtml';
import { MaterialHtmlRenderer } from './renderMaterialHtml';
import { MarkdownRenderer } from './renderMarkdown';
import { RstRenderer } from './renderRst';
import { renderGraphDiagramSvg } from './graphDiagram';
import { renderTypeFigureSvg } from './typeFigure';
import { msgTagFile, nedTagFile } from './tagFiles';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { IconProvider, TextMeasurer } from '../graphics/diagramLayout';

export interface NeddocProgress {
  /** `percent` is the overall 0-100 completion across all phases (the
   *  generator computes it; hosts can drive determinate progress bars). */
  report?(step: string, done: number, total: number, percent: number): void;
  cancelled?(): boolean;
}

/** What the generator hands a diagram renderer per request. */
export interface DiagramRenderCtx {
  model: DocModel;
  /** href from the diagram's SVG output location to a documented page. */
  hrefForPage: (pageId: string) => string | undefined;
}

/** Renders the SVG for a diagram request; wired up by the host (the diagram
 *  subsystem needs icon access, which shared/ cannot do on its own). */
export type DiagramSvgRenderer = (
  req: DiagramRequest,
  ctx: DiagramRenderCtx,
) => Promise<string | undefined> | string | undefined;

export interface DiagramRendererConfig {
  nedCache: NedResourceCache;
  icons: IconProvider;
  measureText?: TextMeasurer;
  seed?: number;
}

/** The standard diagram renderer: module figures via the shared preview
 *  pipeline, usage/inheritance graphs via the built-in layered layout. */
export function createDiagramRenderer(cfg: DiagramRendererConfig): DiagramSvgRenderer {
  return async (req, ctx) => {
    if (req.diagram === 'type') {
      if (req.language !== 'ned') return undefined;
      const type = cfg.nedCache.getType(req.typeFqName);
      if (!type) return undefined;
      const figure = await renderTypeFigureSvg(cfg.nedCache, type, {
        icons: cfg.icons,
        measureText: cfg.measureText,
        seed: cfg.seed,
        linkHrefFor: (fq) => ctx.hrefForPage(pageIdForType(fq, 'ned')),
      });
      return figure?.svg;
    }
    if (!req.graph || req.graph.nodes.length < 2) return undefined;
    return renderGraphDiagramSvg(req.graph, { hrefFor: (id) => ctx.hrefForPage(id) }).svg;
  };
}

export interface NeddocResult {
  pages: number;
  diagrams: number;
  warnings: string[];
  /** References to dependency types that could not be linked, one line per
   *  dependency (informational: not counted as generation warnings). */
  externalWarnings: string[];
  cancelled?: boolean;
}

export class NeddocCancelled extends Error {
  constructor() {
    super('documentation generation cancelled');
  }
}

export function rendererForFormat(options: NeddocOptions): NeddocRenderer {
  switch (options.format) {
    case 'html':
      return new HtmlRenderer();
    case 'html-readthedocs':
      return new RtdHtmlRenderer();
    case 'html-material':
      if (!options.materialAssets)
        throw new Error('html-material format needs the vendored template assets (options.materialAssets)');
      return new MaterialHtmlRenderer(options.materialAssets);
    case 'markdown':
      return new MarkdownRenderer();
    case 'rst':
      return new RstRenderer();
    default:
      throw new Error(`output format not implemented yet: ${options.format}`);
  }
}

export async function generateNeddoc(
  input: NeddocInput,
  optionOverrides: Partial<NeddocOptions>,
  emit: (file: GeneratedFile) => void | Promise<void>,
  progress?: NeddocProgress,
  renderDiagram?: DiagramSvgRenderer,
): Promise<NeddocResult> {
  const options: NeddocOptions = { ...defaultNeddocOptions(), ...optionOverrides };
  const renderer = rendererForFormat(options);
  const checkCancelled = () => {
    if (progress?.cancelled?.()) throw new NeddocCancelled();
  };

  // overall progress: extraction gets a fixed 0-15% band; the remaining 85%
  // is split between diagrams, pages and aux files by unit count, diagrams
  // weighted x3 (layout + SVG per diagram dominates wall-clock)
  const EXTRACT_BAND = 15;
  const DIAGRAM_WEIGHT = 3;
  // CPU-bound stretches yield periodically (cooperativeYielder inside
  // extraction, maybeYield below) so hosts can flush queued progress
  // notifications and paint the bar while we work
  const maybeYield = cooperativeYielder();
  progress?.report?.('Extracting types', 0, 1, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); // let the 0% report out
  const model = await extractDocModel(input, options, (done, total) => {
    checkCancelled();
    progress?.report?.('Extracting types', done, total, total ? (done / total) * EXTRACT_BAND : EXTRACT_BAND);
  });
  checkCancelled();

  const diagramUnits = renderDiagram ? model.diagrams.length * DIAGRAM_WEIGHT : 0;
  const totalUnits = Math.max(1, diagramUnits + model.pages.length + 1); // +1 for aux/tag files
  const percentAt = (unitsDone: number) => EXTRACT_BAND + (unitsDone / totalUnits) * (100 - EXTRACT_BAND);

  // diagrams first: pages inline/reference them
  const images = new Map<string, string>();
  if (renderDiagram) {
    let done = 0;
    for (const req of model.diagrams) {
      checkCancelled();
      progress?.report?.('Rendering diagrams', done, model.diagrams.length, percentAt(done * DIAGRAM_WEIGHT));
      done++;
      await maybeYield();
      const imageOut = renderer.imagePath?.(req.image) ?? req.image;
      const diagramCtx: DiagramRenderCtx = {
        model,
        hrefForPage: (pageId) => {
          const ref = pageById(model, pageId);
          if (ref) return relativeRef(dirOf(imageOut), renderer.pagePath(ref));
          const ext = model.externalTypes.get(pageId);
          return ext && externalHref(ext, dirOf(imageOut));
        },
      };
      try {
        const svg = await renderDiagram(req, diagramCtx);
        if (svg) {
          images.set(req.image, svg);
          await emit({ relativePath: imageOut, content: svg });
        }
      } catch (err) {
        model.warnings.push(`diagram ${req.image}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const ctx: RenderCtx = {
    model,
    options,
    hasImage: (image) => images.has(image),
    imageContent: (image) => images.get(image),
  };

  let done = 0;
  for (const page of model.pages) {
    checkCancelled();
    progress?.report?.('Writing pages', done, model.pages.length, percentAt(diagramUnits + done));
    done++;
    await maybeYield();
    await emit({ relativePath: renderer.pagePath(page.ref), content: renderer.renderPage(page, ctx) });
  }
  for (const file of renderer.auxFiles(ctx)) {
    checkCancelled();
    await emit(file);
  }
  // doxygen-style tag files for cross-project linking (as in Eclipse:
  // nedtags.xml always, msgtags.xml when MSG types are documented)
  await emit({ relativePath: 'nedtags.xml', content: nedTagFile(model, renderer) });
  if (options.messageDefinitions) await emit({ relativePath: 'msgtags.xml', content: msgTagFile(model, renderer) });
  progress?.report?.('Done', model.pages.length, model.pages.length, 100);
  return { pages: model.pages.length, diagrams: images.size, warnings: model.warnings, externalWarnings: model.externalWarnings };
}

/** Convenience wrapper collecting all output files in memory (tests, MCP). */
export async function collectNeddoc(
  input: NeddocInput,
  optionOverrides: Partial<NeddocOptions>,
  renderDiagram?: DiagramSvgRenderer,
): Promise<{ files: GeneratedFile[]; result: NeddocResult }> {
  const files: GeneratedFile[] = [];
  const result = await generateNeddoc(input, optionOverrides, (f) => {
    files.push(f);
  }, undefined, renderDiagram);
  return { files, result };
}
