/**
 * Approximate text-width measurement for hosts without a canvas (the doc
 * generator CLI, the LSP server). The preview webview measures labels with
 * canvas `measureText`; this is the drop-in fallback used when rendering the
 * same figures to static SVG.
 *
 * Widths are the Adobe Helvetica AFM advance widths (1/1000 em) — the metrics
 * of the generic sans-serif stack the diagrams use. Within ±5% of real browser
 * measurements for typical identifiers, which only affects label centering and
 * auto-size padding.
 *
 * Browser-safe: pure math, no Node/vscode imports.
 */

// ASCII 32..126 advance widths in 1/1000 em (Helvetica AFM).
// prettier-ignore
const HELVETICA_WIDTHS = new Uint16Array([
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, // ' '..')'
  389, 584, 278, 333, 278, 278, 556, 556, 556, 556, // '*'..'3'
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, // '4'..'='
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, // '>'..'G'
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, // 'H'..'Q'
  722, 667, 611, 722, 667, 944, 667, 667, 611, 278, // 'R'..'['
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, // '\'..'e'
  278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 'f'..'o'
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, // 'p'..'y'
  500, 334, 260, 334, 584,                          // 'z'..'~'
]);

const DEFAULT_WIDTH = 600; // other Latin/Greek/Cyrillic etc.
const CJK_WIDTH = 1000; // full-width ideographs

/** Approximate advance width in px of `text` at `sizePx` in the generic
 *  sans-serif stack (the diagrams' `12px sans-serif` font). */
export function approxTextWidth(text: string, sizePx = 12): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) units += HELVETICA_WIDTHS[code - 32];
    else if (
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals..Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
      (code >= 0xff00 && code <= 0xff60) || // full-width forms
      (code >= 0x20000 && code <= 0x3fffd) // CJK extensions
    )
      units += CJK_WIDTH;
    else units += DEFAULT_WIDTH;
  }
  return (units / 1000) * sizePx;
}
