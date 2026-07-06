import { parseColor } from '@omnetpp/shared/preview';

/** What the host resolved for one icon id (see nedPreviewPanel.ts). */
export interface IconAsset {
  uri: string;
  size?: [number, number];
  scalePct?: number;
}

/** A ready-to-render icon: data URI (export-safe) + drawing dimensions.
 *  Structurally satisfies the shared ResolvedIcon interface (`href` carries
 *  the data URI; tinting happens here in canvas, so `tint` is never set). */
export interface LoadedIcon {
  href: string;
  width: number;
  height: number;
}

/**
 * Loads, scales and tints icons. Icon bytes are fetch()ed (allowed by the
 * panel's connect-src CSP) so canvas pixel access is never tainted; every
 * icon becomes a data URI, which also makes exported SVGs self-contained.
 * Tinting replicates the IDE's luminance-weighted blend
 * (NedImageDescriptor.determineShading), NOT a plain alpha composite:
 * `lum = (2126R+7152G+722B)/10000; c' = ((100-w)*c + w*lum*tint/128)/100`.
 */
export class IconStore {
  private assets: Record<string, IconAsset> = {};
  private readonly cache = new Map<string, Promise<LoadedIcon | undefined>>();

  setAssets(assets: Record<string, IconAsset>): void {
    this.assets = assets;
    this.cache.clear();
  }

  /** The icon for an id/size/tint, falling back to the IDE's `unknown` icon. */
  get(id: string, sizeSuffix?: string, tintColor?: string, tintPct?: number): Promise<LoadedIcon | undefined> {
    const asset = this.assets[`${id}|${sizeSuffix ?? ''}`] ?? this.assets['_internal/unknown|'];
    if (!asset) return Promise.resolve(undefined);
    const tint = tintColor ? parseColor(tintColor) : undefined;
    const key = `${asset.uri}|${tint ?? ''}|${tint ? tintPct ?? 30 : ''}`;
    let loaded = this.cache.get(key);
    if (!loaded) {
      loaded = this.load(asset, tint, tintPct ?? 30).catch(() => undefined);
      this.cache.set(key, loaded);
    }
    return loaded;
  }

  private async load(asset: IconAsset, tint: string | undefined, tintPct: number): Promise<LoadedIcon> {
    const response = await fetch(asset.uri);
    const bitmap = await createImageBitmap(await response.blob());
    const scale = (asset.scalePct ?? 100) / 100;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    if (tint) {
      const rgb = [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16));
      const weight = Math.max(0, Math.min(100, tintPct));
      const data = ctx.getImageData(0, 0, width, height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue; // keep fully transparent pixels
        const lum = (2126 * px[i] + 7152 * px[i + 1] + 722 * px[i + 2]) / 10000;
        for (let ch = 0; ch < 3; ch++) {
          const c = ((100 - weight) * px[i + ch] + (weight * lum * rgb[ch]) / 128) / 100;
          px[i + ch] = Math.max(0, Math.min(255, Math.round(c)));
        }
      }
      ctx.putImageData(data, 0, 0);
    }

    return { href: canvas.toDataURL('image/png'), width, height };
  }
}
