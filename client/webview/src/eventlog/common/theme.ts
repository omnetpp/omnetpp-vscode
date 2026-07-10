/**
 * Reads VS Code's CSS custom properties into a plain palette object (port
 * plan's "Theming" section: "Canvas colors from VS Code CSS vars read at
 * runtime... Eclipse semantic data colors kept as literals... with
 * BLACK->foreground flip on dark"). U1 only needs this for the status
 * strip/toolbar (plain DOM, mostly styled via CSS already) -- the canvas
 * consumer (U3) will read the same palette for `ctx.fillStyle`/`strokeStyle`,
 * since `var(--vscode-*)` only works in CSS/DOM, not on a 2D canvas context.
 */
export interface EventLogPalette {
  foreground: string;
  background: string;
  descriptionForeground: string;
  selectionBackground: string;
  border: string;
  /** True for `vscode-dark`/`vscode-high-contrast` body classes. */
  isDark: boolean;
  /**
   * Phase U9 -- true for VS Code's `vscode-high-contrast`/`vscode-high-contrast-light`
   * body classes specifically (a STRICT subset of `isDark`'s true cases: HC-dark sets
   * both, HC-light sets only this one). Canvas-drawn decorations that would otherwise
   * use a fixed Eclipse-semantic-data-color literal (selection ring, bookmark flag --
   * see `drawList.ts`'s `selectionMarkColor()`/`bookmarkMarkColor()`) switch to
   * `focusBorder` under this flag instead, since VS Code's high-contrast themes
   * guarantee that color's visibility against every other chrome color by
   * construction, whereas an arbitrary literal is not guaranteed to survive an
   * arbitrary user-authored HC theme.
   */
  isHighContrast: boolean;
  /** Eclipse "event" data color (SequenceChartLabelProvider), flipped toward the foreground on dark themes instead of staying pure black. */
  eventColor: string;
  /** Eclipse "message send/reuse arrow" data color. */
  arrowColor: string;
  /** Eclipse "method call arrow" data color. */
  methodCallColor: string;
  /** Bookmark flag glyph color -- a deliberately eye-catching amber/gold so a bookmark stands out from every other chart color, tuned separately for dark/light so it stays readable against both editor backgrounds (see `drawList.ts`'s `bookmarkMarkColor()`). */
  bookmarkColor: string;
  /** Phase U9 -- `--vscode-focusBorder` (a color VS Code guarantees stays visible under every theme, including every high-contrast theme) -- used as the canvas-drawn selection ring / bookmark flag color under `isHighContrast` (see this interface's own doc on `isHighContrast`). */
  focusBorder: string;
  /**
   * Phase U9 -- zero-simulation-time region band fill, split out of `drawList.ts`'s
   * former inline `theme.isDark ? '#2a2a2a' : '#f0f0f0'` literal so it can be made
   * more visible under high contrast (where a one-step-off-background grey can vanish
   * against a pure-black/pure-white HC background) without duplicating the isDark/
   * isHighContrast branching at every call site.
   */
  regionBandColor: string;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

export function readPalette(): EventLogPalette {
  // Phase U9: VS Code toggles a `vscode-high-contrast-light` class for the HC-LIGHT
  // theme (there is no plain `vscode-light`-and-high-contrast combination -- HC themes
  // are always exactly one of these two exclusive classes) -- both count as
  // `isHighContrast`; only the (dark) `vscode-high-contrast` one also counts as
  // `isDark` (matches this function's pre-existing `isDark` computation exactly, kept
  // unchanged below so no prior behavior shifts).
  const isHighContrastDark = document.body.classList.contains('vscode-high-contrast');
  const isHighContrastLight = document.body.classList.contains('vscode-high-contrast-light');
  const isDark = document.body.classList.contains('vscode-dark') || isHighContrastDark;
  const isHighContrast = isHighContrastDark || isHighContrastLight;
  return {
    foreground: cssVar('--vscode-foreground', '#cccccc'),
    background: cssVar('--vscode-editor-background', '#1e1e1e'),
    descriptionForeground: cssVar('--vscode-descriptionForeground', '#9d9d9d'),
    selectionBackground: cssVar('--vscode-list-activeSelectionBackground', '#04395e'),
    border: cssVar('--vscode-editorWidget-border', '#454545'),
    isDark,
    isHighContrast,
    eventColor: isDark ? '#e06666' : '#cc0000',
    arrowColor: isDark ? '#6ea8fe' : '#0000cc',
    methodCallColor: isDark ? '#f0a35e' : '#cc6600',
    bookmarkColor: isDark ? '#e0c341' : '#b8860b',
    focusBorder: cssVar('--vscode-focusBorder', '#007fd4'),
    regionBandColor: isHighContrast ? (isDark ? '#3a3a3a' : '#dcdcdc') : isDark ? '#2a2a2a' : '#f0f0f0',
  };
}

/**
 * Watches VS Code's theme-switch signal (it toggles `vscode-light`/
 * `vscode-dark`/`vscode-high-contrast`/`vscode-high-contrast-light` classes on
 * `<body>`) and invokes `onChange` with the freshly recomputed palette. Returns
 * an unsubscribe function. Later phases (U3+) additionally flush any cached
 * canvas tile on this callback (port plan: "Theme switch = MutationObserver on
 * body class -> palette recompute + tile flush").
 */
export function watchThemeChange(onChange: (palette: EventLogPalette) => void): () => void {
  const observer = new MutationObserver(() => onChange(readPalette()));
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
