/**
 * Markdown renderer of the NED documentation generator: same page content as
 * the HTML output, rendered as GitHub-flavored Markdown — pipe tables,
 * fenced code blocks, image references for diagrams, and a SUMMARY.md
 * (GitBook/mdBook-style nested list) as navigation.
 */

import { emitMarkdown, emitMarkdownInlines, escapeMdText, type MarkdownEmitOpts } from './commentEmit';
import type { DocCell, DocPage, DocPageRef, DocSection, NavNode } from './docModel';
import type { GeneratedFile, NeddocRenderer, RenderCtx } from './renderer';
import { defaultPagePath, dirOf, externalHref, pageById, relativeRef } from './renderer';

export class MarkdownRenderer implements NeddocRenderer {
  readonly format = 'markdown' as const;
  readonly pageExtension = '.md';

  pagePath(ref: DocPageRef): string {
    return defaultPagePath(ref, this.pageExtension);
  }

  renderPage(page: DocPage, ctx: RenderCtx): string {
    const fromDir = dirOf(this.pagePath(page.ref));
    const linkTo = (pageId: string, anchor?: string): string => {
      const target = pageById(ctx.model, pageId);
      if (!target) return '#';
      return relativeRef(fromDir, this.pagePath(target)) + (anchor ? `#${anchor}` : '');
    };
    // dependency types: a link marked with ↗, or plain text
    const externalRef = (pageId: string, text: string): string | undefined => {
      const ext = ctx.model.externalTypes.get(pageId);
      if (!ext) return undefined;
      const href = externalHref(ext, fromDir);
      return href ? `[${escapeMdText(text)} \u2197](${href})` : escapeMdText(text);
    };
    const emitOpts: MarkdownEmitOpts = {
      hrefFor: (target) => {
        const ext = ctx.model.externalTypes.get(target);
        return ext ? externalHref(ext, fromDir) : linkTo(target);
      },
      typeRef: externalRef,
    };
    const out: string[] = [`# ${escapeMdText(page.ref.title)}`];
    for (const section of page.sections) {
      const rendered = this.renderSection(section, ctx, linkTo, emitOpts, fromDir);
      if (rendered) out.push(rendered);
    }
    return out.join('\n\n') + '\n';
  }

  private renderCells(cells: DocCell[], linkTo: (p: string, a?: string) => string, emitOpts: MarkdownEmitOpts, inTable: boolean): string {
    let out = '';
    for (const cell of cells) {
      switch (cell.kind) {
        case 'text':
          out += escapeMdText(cell.text);
          break;
        case 'label':
          out += cell.text ? `*${escapeMdText(cell.text)}*` : '';
          break;
        case 'link': {
          const external = cell.page ? emitOpts.typeRef?.(cell.page, cell.text) : undefined;
          if (external !== undefined) out += external;
          else out += cell.page ? `[${escapeMdText(cell.text)}](${linkTo(cell.page, cell.anchor)})` : escapeMdText(cell.text);
          break;
        }
        case 'exlink':
          out += `[${escapeMdText(cell.text)}](${cell.href})`;
          break;
        case 'doc': {
          const md = emitMarkdown(cell.blocks, emitOpts);
          out += inTable ? md.replace(/\n\n/g, '<br>').replace(/\n/g, ' ') : md;
          break;
        }
      }
    }
    return out;
  }

  private renderSection(
    section: DocSection,
    ctx: RenderCtx,
    linkTo: (p: string, a?: string) => string,
    emitOpts: MarkdownEmitOpts,
    fromDir: string,
  ): string {
    switch (section.kind) {
      case 'badge':
        return `**${escapeMdText(section.label)}**`;
      case 'para':
        return this.renderCells(section.cells, linkTo, emitOpts, false);
      case 'doc':
        return emitMarkdown(section.blocks, emitOpts);
      case 'subheading':
        return (section.anchor ? `<a id="${section.anchor}"></a>\n\n` : '') + `## ${escapeMdText(section.text)}`;
      case 'table': {
        const header = `| ${section.columns.join(' | ')} |`;
        const divider = `|${section.columns.map(() => '---').join('|')}|`;
        const rows = section.rows.map((row) => {
          const cells = row.cells.map((c) => this.renderCells(c, linkTo, emitOpts, true).replace(/\n/g, ' '));
          while (cells.length < section.columns.length) cells.push('');
          return `| ${cells.join(' | ')} |`;
        });
        return [header, divider, ...rows].join('\n');
      }
      case 'diagram':
        if (!ctx.hasImage(section.image)) return '';
        return `![${escapeMdText(section.title)}](${relativeRef(fromDir, section.image)})`;
      case 'source':
        return `\`\`\`${section.language}\n${section.code}\n\`\`\``;
    }
  }

  auxFiles(ctx: RenderCtx): GeneratedFile[] {
    const lines: string[] = ['# Summary', ''];
    const walk = (node: NavNode, depth: number): void => {
      const indent = '  '.repeat(depth);
      const target = node.page ? pageById(ctx.model, node.page) : undefined;
      const anchor = node.anchor ? `#${node.anchor}` : '';
      lines.push(target ? `${indent}- [${node.title}](${this.pagePath(target)}${anchor})` : `${indent}- ${node.title}`);
      for (const child of node.children) walk(child, depth + 1);
    };
    for (const child of ctx.model.navRoot.children) walk(child, 0);
    return [{ relativePath: 'SUMMARY.md', content: lines.join('\n') + '\n' }];
  }
}
