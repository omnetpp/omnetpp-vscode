/**
 * Orchestration of the NED documentation generator: extract the DocModel,
 * render diagrams, render pages with the format's renderer, and stream every
 * output file to the host through the `emit` callback (shared/ stays free of
 * filesystem access; the CLI and the LSP server do the writing).
 */

import { extractDocModel, type NeddocInput } from './extract';
import { pageIdForType, type DiagramRequest, type DocModel } from './docModel';
import { defaultNeddocOptions, type NeddocOptions } from './options';
import { dirOf, pageById, relativeRef, type GeneratedFile, type NeddocRenderer, type RenderCtx } from './renderer';
import { HtmlRenderer } from './renderHtml';
import { LegacyHtmlRenderer } from './renderLegacyHtml';
import { MarkdownRenderer } from './renderMarkdown';
import { RstRenderer } from './renderRst';
import { renderGraphDiagramSvg } from './graphDiagram';
import { renderTypeFigureSvg } from './typeFigure';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { IconProvider, TextMeasurer } from '../graphics/diagramLayout';

export interface NeddocProgress {
  report?(step: string, done: number, total: number): void;
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
    case 'legacy-html':
      if (!options.legacyAssets)
        throw new Error('legacy-html format needs the vendored template assets (options.legacyAssets)');
      return new LegacyHtmlRenderer(options.legacyAssets);
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

  progress?.report?.('Collecting types', 0, 1);
  const model = extractDocModel(input, options);
  checkCancelled();

  // diagrams first: pages inline/reference them
  const images = new Map<string, string>();
  if (renderDiagram) {
    let done = 0;
    for (const req of model.diagrams) {
      checkCancelled();
      progress?.report?.(`Rendering diagrams`, done++, model.diagrams.length);
      const imageOut = renderer.imagePath?.(req.image) ?? req.image;
      const diagramCtx: DiagramRenderCtx = {
        model,
        hrefForPage: (pageId) => {
          const ref = pageById(model, pageId);
          return ref ? relativeRef(dirOf(imageOut), renderer.pagePath(ref)) : undefined;
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
    progress?.report?.(`Writing pages`, done++, model.pages.length);
    await emit({ relativePath: renderer.pagePath(page.ref), content: renderer.renderPage(page, ctx) });
  }
  for (const file of renderer.auxFiles(ctx)) {
    checkCancelled();
    await emit(file);
  }
  progress?.report?.('Done', model.pages.length, model.pages.length);
  return { pages: model.pages.length, diagrams: images.size, warnings: model.warnings };
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
