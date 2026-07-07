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
  /** Eclipse "event" data color (SequenceChartLabelProvider), flipped toward the foreground on dark themes instead of staying pure black. */
  eventColor: string;
  /** Eclipse "message send/reuse arrow" data color. */
  arrowColor: string;
  /** Eclipse "method call arrow" data color. */
  methodCallColor: string;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

export function readPalette(): EventLogPalette {
  const isDark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  return {
    foreground: cssVar('--vscode-foreground', '#cccccc'),
    background: cssVar('--vscode-editor-background', '#1e1e1e'),
    descriptionForeground: cssVar('--vscode-descriptionForeground', '#9d9d9d'),
    selectionBackground: cssVar('--vscode-list-activeSelectionBackground', '#04395e'),
    border: cssVar('--vscode-editorWidget-border', '#454545'),
    isDark,
    eventColor: isDark ? '#e06666' : '#cc0000',
    arrowColor: isDark ? '#6ea8fe' : '#0000cc',
    methodCallColor: isDark ? '#f0a35e' : '#cc6600',
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
