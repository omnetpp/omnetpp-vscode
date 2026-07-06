// Regenerates the vendored Eclipse-neddoc "material" template snapshot at
// resources/neddoc-legacy/ from an OMNeT++ source tree. The snapshot is what
// the legacy-html output format of opp_neddoc ships (same look & feel as the
// Eclipse IDE's generated documentation).
//
// Usage: bun scripts/gen-neddoc-legacy-assets.mjs <omnetpp-src-dir>
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: bun scripts/gen-neddoc-legacy-assets.mjs <omnetpp-src-dir>');
  process.exit(2);
}
const templateDir = join(resolve(src), 'ui', 'org.omnetpp.neddoc', 'src', 'org', 'omnetpp', 'neddoc', 'templates', 'material');
if (!existsSync(templateDir)) {
  console.error(`template dir not found: ${templateDir}`);
  process.exit(2);
}

// everything HtmlRenderer.copyStaticResources() ships, plus the two templates
const FILES = [
  'page.tmpl',
  'navtree.tmpl',
  'style.css',
  'material.blue-light_blue.min.css',
  'material-icons.css',
  'material-icons.woff2',
  'jquery.js',
  'navtree.js',
  'material.min.js',
];

const outDir = join(root, 'resources', 'neddoc-legacy');
mkdirSync(outDir, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(templateDir, f), join(outDir, f));
  console.log(`copied ${f}`);
}
writeFileSync(
  join(outDir, 'README.md'),
  `Snapshot of the Eclipse neddoc "material" template (org.omnetpp.neddoc,\n` +
    `templates/material/), used by opp_neddoc's legacy-html output format.\n` +
    `Regenerate with: bun scripts/gen-neddoc-legacy-assets.mjs <omnetpp-src-dir>\n`,
);
console.log(`snapshot written to ${outDir}`);
