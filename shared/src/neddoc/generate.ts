/**
 * Orchestration of the NED documentation generator: extract the DocModel,
 * render diagrams, render pages with the format's renderer, and stream every
 * output file to the host through the `emit` callback (shared/ stays free of
 * filesystem access; the CLI and the LSP server do the writing).
 */

import { extractDocModel, type NeddocInput } from './extract';
import type { DiagramRequest, DocModel } from './docModel';
import { defaultNeddocOptions, type NeddocOptions } from './options';
import type { GeneratedFile, NeddocRenderer, RenderCtx } from './renderer';
import { HtmlRenderer } from './renderHtml';
import { MarkdownRenderer } from './renderMarkdown';
import { RstRenderer } from './renderRst';

export interface NeddocProgress {
  report?(step: string, done: number, total: number): void;
  cancelled?(): boolean;
}

/** Renders the SVG for a diagram request; wired up by the host (the diagram
 *  subsystem needs icon access, which shared/ cannot do on its own). */
export type DiagramSvgRenderer = (req: DiagramRequest, model: DocModel) => Promise<string | undefined> | string | undefined;

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
      try {
        const svg = await renderDiagram(req, model);
        if (svg) {
          images.set(req.image, svg);
          await emit({ relativePath: req.image, content: svg });
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
