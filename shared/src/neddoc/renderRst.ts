/**
 * reStructuredText (Sphinx) renderer of the NED documentation generator.
 * Cross-page links use :ref: roles against per-page/per-section labels
 * (`.. _neddoc-<id>:`) so they resolve build-wide; tables are list-table
 * directives (robust with long cells); the index page carries a hidden
 * toctree naming the overview pages, and the type and file pages are
 * `:orphan:`, so a plain `sphinx-build` works on the output directory as-is.
 */

import { emitRst, emitRstInlines, escapeRstText, flattenInlines, type RstEmitOpts } from './commentEmit';
import type { DocBlock } from './commentAst';
import type { DocCell, DocPage, DocPageRef, DocSection, NavNode } from './docModel';
import type { GeneratedFile, NeddocRenderer, RenderCtx } from './renderer';
import { defaultPagePath, dirOf, externalHref, pageById, relativeRef } from './renderer';
import { isAbsoluteUrl } from './externalDocs';

/** Sphinx label for a page or a page section (labels are global). */
export function rstLabel(pageId: string, anchor?: string): string {
  const raw = anchor ? `${pageId}-${anchor}` : pageId;
  return 'neddoc-' + raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Type and file pages stay out of the toctree: themes that render the
 *  global toctree into every page (sphinx_immaterial) would otherwise carry
 *  hundreds of entries on each page of the site. They are reached from the
 *  category listings. */
function isOrphan(ref: DocPageRef): boolean {
  return ref.kind === 'nedtype' || ref.kind === 'msgtype' || ref.kind === 'file';
}

export class RstRenderer implements NeddocRenderer {
  readonly format = 'rst' as const;
  readonly pageExtension = '.rst';

  pagePath(ref: DocPageRef): string {
    return defaultPagePath(ref, this.pageExtension);
  }

  renderPage(page: DocPage, ctx: RenderCtx): string {
    const fromDir = dirOf(this.pagePath(page.ref));
    const refFor = (targetId: string, text: string): string | undefined => {
      const target = pageById(ctx.model, targetId);
      if (!target) {
        // dependency types: an anonymous hyperlink marked with ↗, or plain text
        const ext = ctx.model.externalTypes.get(targetId);
        const href = ext && externalHref(ext, fromDir);
        return href ? `\`${text.replace(/[`<>]/g, '')} \u2197 <${href}>\`__` : undefined;
      }
      return `:ref:\`${text.replace(/[`<>]/g, '')} <${rstLabel(targetId)}>\``;
    };
    const emitOpts: RstEmitOpts = { refFor };
    const title = page.ref.title;
    const out: string[] = isOrphan(page.ref) ? [':orphan:', ''] : [];
    out.push(`.. _${rstLabel(page.ref.id)}:`, '', title, '='.repeat(Math.max(title.length, 3)));
    for (const section of page.sections) {
      const rendered = this.renderSection(section, page, ctx, emitOpts, fromDir);
      if (rendered) out.push('', rendered);
    }
    if (page.ref.kind === 'index') out.push('', this.indexToctree(ctx));
    return out.join('\n') + '\n';
  }

  /** Inline (single-paragraph) rendition of cell content for table cells. */
  private cellText(cells: DocCell[], emitOpts: RstEmitOpts): string {
    let out = '';
    let afterMarkup = false;
    // inline markup is only recognized at word boundaries (`host.src.x` with
    // `src` linked would leave the role as literal text): glue markup to
    // adjacent text with escaped spaces, which render as nothing
    const append = (text: string, markup: boolean): void => {
      if (!text) return;
      if ((markup || afterMarkup) && out && !/\s$/.test(out) && !/^\s/.test(text)) out += '\\ ';
      out += text;
      afterMarkup = markup;
    };
    for (const cell of cells) {
      switch (cell.kind) {
        case 'text':
          append(escapeRstText(cell.text), false);
          break;
        case 'label':
          append(cell.text ? `*${escapeRstText(cell.text)}*` : '', true);
          break;
        case 'link': {
          const ref = cell.page ? emitOpts.refFor(cell.page, cell.text) : undefined;
          append(ref ?? escapeRstText(cell.text), ref !== undefined);
          break;
        }
        case 'exlink':
          append(`\`${cell.text.replace(/[`<>]/g, '')} <${cell.href}>\`__`, true);
          break;
        case 'doc':
          append(this.docCellText(cell.blocks, emitOpts), false);
          break;
      }
    }
    return out.replace(/\s*\n\s*/g, ' ').trim();
  }

  /** Flatten doc-comment blocks to one line for table cells (lists become
   *  `; `-separated runs; pre blocks become literal spans). */
  private docCellText(blocks: DocBlock[], emitOpts: RstEmitOpts): string {
    const parts: string[] = [];
    for (const block of blocks) {
      switch (block.kind) {
        case 'para':
          parts.push(emitRstInlines(block.inlines, emitOpts));
          break;
        case 'list':
          parts.push(block.items.map((i) => emitRstInlines(i.inlines, emitOpts)).join('; '));
          break;
        case 'pre':
          parts.push(`\`\`${flattenInlines(block.inlines).replace(/\s+/g, ' ').trim()}\`\``);
          break;
        case 'hrule':
          break;
      }
    }
    return parts.join(' ');
  }

  private renderSection(
    section: DocSection,
    page: DocPage,
    ctx: RenderCtx,
    emitOpts: RstEmitOpts,
    fromDir: string,
  ): string {
    switch (section.kind) {
      case 'badge':
        return `**${escapeRstText(section.label)}**`;
      case 'para':
        return this.cellText(section.cells, emitOpts);
      case 'doc':
        return emitRst(section.blocks, emitOpts);
      case 'subheading': {
        const label = section.anchor ? `.. _${rstLabel(page.ref.id, section.anchor)}:\n\n` : '';
        return `${label}${section.text}\n${'-'.repeat(Math.max(section.text.length, 3))}`;
      }
      case 'table': {
        const lines: string[] = ['.. list-table::', '   :header-rows: 1', ''];
        const row = (cells: string[]): void => {
          cells.forEach((cell, i) => lines.push(`   ${i === 0 ? '* -' : '  -'} ${cell}`));
        };
        row(section.columns);
        for (const r of section.rows) {
          const cells = r.cells.map((c) => this.cellText(c, emitOpts));
          while (cells.length < section.columns.length) cells.push('');
          row(cells);
        }
        return lines.join('\n');
      }
      case 'diagram': {
        if (!ctx.hasImage(section.image)) return '';
        // pin the SVG's natural width: themes that stretch images to the
        // content width would otherwise blow small figures up
        const width = /^<svg\b[^>]*?\swidth="([\d.]+)"/.exec(ctx.imageContent(section.image) ?? '')?.[1];
        return `.. image:: ${relativeRef(fromDir, section.image)}\n   :alt: ${section.title}${width ? `\n   :width: ${width}px` : ''}`;
      }
      case 'source':
        return `.. code-block:: ${section.language}\n\n${section.code
          .split('\n')
          .map((l) => (l ? '   ' + l : ''))
          .join('\n')}`;
    }
  }

  /** Hidden toctree on the index page naming the other non-orphan pages, so
   *  they get into the navigation without cluttering the overview. Of the
   *  `@externalpage` links only URLs fit in; a relative one would name a
   *  missing document. */
  private indexToctree(ctx: RenderCtx): string {
    const entries = ctx.model.pages
      .filter((p) => p.ref.id !== 'index' && !isOrphan(p.ref))
      .map((p) => this.pagePath(p.ref).replace(/\.rst$/, ''));
    const walk = (node: NavNode): void => {
      if (node.href && isAbsoluteUrl(node.href)) entries.push(`${node.title.replace(/[<>]/g, '')} <${node.href}>`);
      node.children.forEach(walk);
    };
    walk(ctx.model.navRoot);
    return ['.. toctree::', '   :hidden:', '   :maxdepth: 2', '', ...entries.map((e) => `   ${e}`)].join('\n');
  }

  auxFiles(_ctx: RenderCtx): GeneratedFile[] {
    return [];
  }
}
