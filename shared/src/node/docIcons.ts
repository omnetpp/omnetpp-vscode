// Node-backed icon resolution for rendering NED figures outside the webview
// (the opp_neddoc CLI and the LSP server). Replicates the Eclipse search
// rules the preview panel uses (client/src/nedPreviewPanel.ts): ordered
// search roots, .png-then-.gif lookup, `name_<size>` variant fallback with
// the Eclipse scale percentages, and the bundled index.json natural sizes
// (with a PNG/GIF header sniff for non-bundled icons). Tinting is deferred
// to the SVG renderer via ResolvedIcon.tint (no pixel access needed).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IconProvider, ResolvedIcon } from '../graphics/diagramLayout';
import { parseColor } from '../graphics/colors';

const SIZE_SCALE: Record<string, number> = { vs: 40, s: 60, l: 150, vl: 250 };
const ICON_EXTENSIONS = ['.png', '.gif'];

/**
 * Enumerate every icon id available under the given ordered search roots
 * (same Eclipse order as {@link createNodeIconProvider}'s `iconDirs`: project
 * `images/` dirs, then `installDir/images`, then the bundled `dist/icons`
 * snapshot). An id is a `.png`/`.gif` file's path relative to its root, minus
 * the extension, with subdirectories preserved as `/`-joined prefixes (e.g.
 * `maps/city`) — the same id shape `createNodeIconProvider`'s `findFile`
 * resolves. When the same id exists under multiple roots, only the first
 * (highest-precedence) occurrence is kept, so a project-level icon shadows a
 * same-named bundled one instead of listing both. The result is sorted.
 *
 * The `_internal/` namespace (this module's own fallback icons, e.g.
 * `_internal/unknown` — resolved internally by `createNodeIconProvider`, not
 * an OMNeT++ icon a user would reference) is excluded: Eclipse's
 * `ImageFactory.getImageNameList()` has no equivalent category, so including
 * it would offer bogus completion candidates that don't exist in the IDE.
 */
export function listIconIds(iconDirs: string[]): string[] {
  const seen = new Set<string>();
  const walk = (root: string, dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // root (or a subdirectory) doesn't exist / isn't readable
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(root, abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = entry.name.slice(dot).toLowerCase();
      if (!ICON_EXTENSIONS.includes(ext)) continue;
      const rel = abs.slice(root.length + 1).split(/[\\/]/).join('/');
      const id = rel.slice(0, rel.length - ext.length);
      if (id === '_internal' || id.startsWith('_internal/')) continue;
      if (!seen.has(id)) seen.add(id);
    }
  };
  for (const dir of iconDirs) walk(dir, dir);
  return [...seen].sort();
}

export interface NodeIconProviderOptions {
  /** Ordered search roots (Eclipse order: project images/ dirs,
   *  installDir/images, the bundled dist/icons snapshot). */
  iconDirs: string[];
  /** The `icons` map of the bundled resources/icons/index.json (natural
   *  pixel sizes, saves the header sniff for bundled icons). */
  bundledIndex?: Record<string, [number, number]>;
  /** 'embed': hrefs become base64 data: URIs (self-contained SVGs).
   *  Otherwise called once per icon file — the host copies/serves the asset
   *  and returns the href the SVG should reference. */
  emit: 'embed' | ((absPath: string, suggestedRelName: string) => string);
}

/** Parse the pixel size out of a PNG (IHDR) or GIF header. */
export function sniffImageSize(bytes: Uint8Array): [number, number] | undefined {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return [width, height];
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return [bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8)];
  }
  return undefined;
}

export function createNodeIconProvider(opts: NodeIconProviderOptions): IconProvider {
  const cache = new Map<string, ResolvedIcon | undefined>();
  const emitted = new Map<string, string>(); // absPath -> href

  const findFile = (id: string): string | undefined => {
    if (id.includes('..')) return undefined; // display strings must not escape the roots
    for (const dir of opts.iconDirs) {
      for (const ext of ['.png', '.gif']) {
        const file = join(dir, ...`${id}${ext}`.split('/'));
        if (existsSync(file)) return file;
      }
    }
    return undefined;
  };

  const hrefFor = (absPath: string, iconId: string): string => {
    let href = emitted.get(absPath);
    if (href !== undefined) return href;
    const ext = absPath.toLowerCase().endsWith('.gif') ? 'gif' : 'png';
    if (opts.emit === 'embed') {
      const b64 = Buffer.from(readFileSync(absPath)).toString('base64');
      href = `data:image/${ext};base64,${b64}`;
    } else {
      href = opts.emit(absPath, `${iconId}.${ext}`);
    }
    emitted.set(absPath, href);
    return href;
  };

  const resolveOne = (id: string, sizeSuffix?: string): ResolvedIcon | undefined => {
    const candidates = sizeSuffix ? [`${id}_${sizeSuffix}`, id] : [id];
    for (const candidate of candidates) {
      const file = findFile(candidate);
      if (!file) continue;
      let size = opts.bundledIndex?.[candidate];
      if (!size) {
        try {
          size = sniffImageSize(readFileSync(file));
        } catch {
          /* unreadable file: fall through to the default box */
        }
      }
      let [width, height] = size ?? [40, 24];
      // only the base file exists for a sized request: apply the Eclipse scale
      if (candidate === id && sizeSuffix && SIZE_SCALE[sizeSuffix]) {
        const scale = SIZE_SCALE[sizeSuffix] / 100;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      return { href: hrefFor(file, candidate), width, height };
    }
    return undefined;
  };

  return {
    get(id, sizeSuffix, tintColor, tintPct): Promise<ResolvedIcon | undefined> {
      const tint = tintColor ? parseColor(tintColor) : undefined;
      const key = `${id}|${sizeSuffix ?? ''}|${tint ?? ''}|${tint ? tintPct ?? 30 : ''}`;
      if (!cache.has(key)) {
        const base = resolveOne(id, sizeSuffix) ?? resolveOne('_internal/unknown');
        cache.set(key, base && tint ? { ...base, tint: { color: tint, pct: tintPct ?? 30 } } : base);
      }
      return Promise.resolve(cache.get(key));
    },
  };
}
