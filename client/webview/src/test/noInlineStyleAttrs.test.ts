/**
 * Source lint: no CSP-blocked inline-style vectors in webview code.
 *
 * The eventlog webviews run under a CSP whose `style-src` carries a nonce and no
 * `style-src-attr` allowance, so `style="..."` attributes in generated HTML and
 * `setAttribute('style', ...)` calls are silently BLOCKED in real VS Code (Chromium
 * logs a violation and drops the style). This bit for real: the chart's canvas
 * container was scaffolded with an inline style attribute, collapsed to zero height,
 * and the chart rendered nothing while every DOM-free test and the happy-dom smoke
 * (no CSP enforcement) stayed green. Allowed styling vectors: the nonce'd <style>
 * sheet built by client/src/eventlog/webviewHtml.ts, and CSSOM property assignments
 * (el.style.x = ..., el.style.cssText = ...).
 */
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', 'eventlog');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /style\s*=\s*"/, reason: 'inline style="..." attribute in generated HTML (blocked by style-src-attr)' },
  { pattern: /setAttribute\(\s*['"`]style['"`]/, reason: "setAttribute('style', ...) (blocked by style-src-attr)" },
];

test('webview sources contain no CSP-blocked inline-style vectors', () => {
  const violations: string[] = [];
  for (const file of collectTsFiles(ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return; // prose about the rule is fine
      for (const { pattern, reason } of FORBIDDEN) {
        if (pattern.test(line)) violations.push(`${file}:${i + 1}: ${reason}\n    ${trimmed.slice(0, 120)}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
