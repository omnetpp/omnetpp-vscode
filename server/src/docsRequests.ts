// The omnetpp/generateDocs custom request: runs the shared NED documentation
// generator against the LIVE project index (so unsaved edits are reflected)
// and writes the output tree to disk, streaming progress notifications to the
// client. Method names + param/result types live in @omnetpp/shared/protocol.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import {
  OmnetppMethods,
  createDiagramRenderer,
  excludePatternRegex,
  generateNeddoc,
  type GenerateDocsParams,
  type GenerateDocsProgress,
  type GenerateDocsResult,
  type GeneratedFile,
  type IncludeResolution,
  type NeddocOptions,
} from '@omnetpp/shared';
import { createNodeIconProvider } from '@omnetpp/shared/node';
import type { ServerState } from './serverState';

export function registerDocsRequests(connection: Connection, state: ServerState): void {
  connection.onRequest(OmnetppMethods.generateDocs, async (params: GenerateDocsParams, token): Promise<GenerateDocsResult> => {
    const index = state.index;
    if (!index) throw new Error('project index not ready yet');
    const outputDir = resolve(params.outputDir);
    const folders = state.workspaceFolders;

    const projectRelative = (path: string): string | undefined => {
      for (const dir of folders) {
        if (path === dir || path.startsWith(dir + sep)) return relative(dir, path).split(sep).join('/');
      }
      return undefined;
    };
    const excludes = (params.excludeDirs ?? []).map(excludePatternRegex);
    const isTargetUri = (uri: string): boolean => {
      if (!uri.startsWith('file:')) return false;
      const rel = projectRelative(fileURLToPath(uri));
      if (rel === undefined) return false;
      return !excludes.some((re) => re.test(rel));
    };

    const includeResolver = (fileRef: string, fromId: string | undefined): IncludeResolution | undefined => {
      try {
        const fromPath = fromId?.startsWith('file:') ? fileURLToPath(fromId) : fromId;
        const target = resolve(fromPath ? dirname(fromPath) : folders[0] ?? '.', fileRef);
        return { id: target, content: readFileSync(target, 'utf8') };
      } catch {
        return undefined;
      }
    };

    const warnings: string[] = [];
    const optionOverrides: Partial<NeddocOptions> = {
      format: params.format,
      includeResolver,
      projectTitle: params.title || folders[0]?.split(sep).filter(Boolean).pop(),
      excludePatterns: params.excludeDirs ?? [],
      typeDiagrams: params.networkDiagrams ?? true,
      usageDiagrams: params.usageDiagrams ?? true,
      inheritanceDiagrams: params.inheritanceDiagrams ?? true,
      fullUsageDiagrams: params.fullUsageDiagram ?? false,
      fullInheritanceDiagrams: params.fullInheritanceDiagram ?? false,
      messageDefinitions: params.messageDefinitions ?? true,
      sourceSnippets: params.sourceListings ?? true,
      automaticHyperlinks: params.automaticHyperlinks ?? true,
      includeBuiltins: params.includeBuiltins ?? false,
    };
    if (params.customCssPath) {
      try {
        optionOverrides.customCss = readFileSync(params.customCssPath, 'utf8');
      } catch {
        warnings.push(`cannot read custom CSS file: ${params.customCssPath} (using the built-in stylesheet)`);
      }
    }
    if (params.doxytagsPath) {
      try {
        optionOverrides.doxytags = {
          xml: readFileSync(params.doxytagsPath, 'utf8'),
          urlPrefix: params.doxyUrlPrefix ?? '',
        };
      } catch {
        warnings.push(`cannot read doxygen tag file: ${params.doxytagsPath} (skipping C++ definition links)`);
      }
    }
    if (params.format === 'html-material') {
      const assetDir = join(__dirname, 'neddoc-material');
      if (!existsSync(join(assetDir, 'page.tmpl'))) throw new Error(`material template assets not found in ${assetDir}`);
      const materialAssets: Record<string, string | Uint8Array> = {};
      for (const f of readdirSync(assetDir)) materialAssets[f] = readFileSync(join(assetDir, f));
      optionOverrides.materialAssets = materialAssets;
    }

    let files = 0;
    const emit = async (file: GeneratedFile): Promise<void> => {
      const target = join(outputDir, ...file.relativePath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
      files++;
    };

    // icons: workspace images/ dirs → installDir/images → bundled dist/icons
    const iconDirs = [
      ...folders.map((d) => join(d, 'images')).filter(existsSync),
      ...(state.installDir ? [join(state.installDir, 'images')] : []),
      join(__dirname, 'icons'),
    ];
    let bundledIndex: Record<string, [number, number]> | undefined;
    try {
      bundledIndex = (JSON.parse(readFileSync(join(__dirname, 'icons', 'index.json'), 'utf8')) as {
        icons: Record<string, [number, number]>;
      }).icons;
    } catch {
      /* sizes come from image headers */
    }
    const iconHrefPrefix = params.format === 'html-material' ? 'icons/' : '../icons/';
    const emittedIcons = new Map<string, string>();
    const icons = createNodeIconProvider({
      iconDirs,
      bundledIndex,
      emit: (absPath, relName) => {
        let href = emittedIcons.get(absPath);
        if (!href) {
          href = iconHrefPrefix + relName;
          emittedIcons.set(absPath, href);
          void emit({ relativePath: `icons/${relName}`, content: readFileSync(absPath) });
        }
        return href;
      },
    });

    // throttled progress notifications
    let lastReport = 0;
    const progress = {
      report: (step: string, done: number, total: number, percent: number) => {
        const now = Date.now();
        if (now - lastReport < 100 && done !== total) return;
        lastReport = now;
        const payload: GenerateDocsProgress = { step, done, total, percent };
        void connection.sendNotification(OmnetppMethods.generateDocsProgress, payload);
      },
      cancelled: () => token.isCancellationRequested,
    };

    const result = await generateNeddoc(
      {
        nedCache: index.cache,
        msgCache: index.msgCache,
        isTargetUri,
        displayPath: (uri) => (uri.startsWith('file:') ? (projectRelative(fileURLToPath(uri)) ?? uri) : uri),
      },
      optionOverrides,
      emit,
      progress,
      createDiagramRenderer({ nedCache: index.cache, icons }),
    );

    const entry = params.format === 'markdown' ? 'index.md' : params.format === 'rst' ? 'index.rst' : 'index.html';
    return {
      pages: result.pages,
      diagrams: result.diagrams,
      files,
      warnings: [...warnings, ...result.warnings],
      indexPath: join(outputDir, entry),
    };
  });
}
