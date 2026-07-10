// Snapshots the OMNeT++ icon set into resources/icons/ (checked into the
// repo, like the config-option snapshot) for the graphical NED preview and
// the Event Log table's per-entry-type row icons:
//
//   bun scripts/gen-icons.mjs <omnetpp-src-dir>
//
// Copies <omnetpp-src>/images/**/*.png (skipping the legacy old/ GIF folder)
// plus the IDE's _internal default/unknown placeholder icons and the
// eventlog entry-type icon set (ui/org.omnetpp.common/images/_internal/
// eventlog/*.png, one per EventLogTableRowRenderer.java entry-type icon id --
// see shared/src/eventlog/tableRowRenderer.ts), and writes an index.json
// mapping icon id -> [width, height] (parsed from the PNG headers) so the
// webview can lay out bundled-icon scenes before the images load.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = process.argv[2];
if (!srcDir) {
  console.error('usage: bun scripts/gen-icons.mjs <omnetpp-src-dir>');
  process.exit(1);
}
const imagesDir = join(resolve(srcDir), 'images');
const internalDir = join(resolve(srcDir), 'ui', 'org.omnetpp.common', 'images', '_internal');
if (!existsSync(imagesDir)) {
  console.error(`Not an OMNeT++ source tree (no images/ directory): ${srcDir}`);
  process.exit(1);
}

const outDir = join(root, 'resources', 'icons');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** Width/height from a PNG's IHDR chunk (bytes 16..23, big-endian). */
function pngSize(file) {
  const buf = readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const index = {};
let count = 0;

function snapshot(dir, base) {
  for (const entry of readdirSync(dir)) {
    const src = join(dir, entry);
    if (statSync(src).isDirectory()) {
      if (entry !== 'old') snapshot(src, base); // old/ holds legacy GIF-era icons
      continue;
    }
    if (!entry.endsWith('.png')) continue;
    const id = relative(base, src).replace(/\.png$/, '');
    const size = pngSize(src);
    if (!size) {
      console.warn(`skipping non-PNG content: ${src}`);
      continue;
    }
    const dest = join(outDir, relative(base, src));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    index[id] = size;
    count++;
  }
}

snapshot(imagesDir, imagesDir);

// the IDE's placeholder icons: shown for missing ids and icon-less submodules
for (const name of ['default.png', 'unknown.png']) {
  const src = join(internalDir, name);
  if (!existsSync(src)) {
    console.warn(`placeholder icon not found: ${src}`);
    continue;
  }
  const dest = join(outDir, '_internal', name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  index[`_internal/${name.replace(/\.png$/, '')}`] = pngSize(src);
  count++;
}

// the Event Log table's per-entry-type row icons (EventLogTableRowRenderer.java's
// getImage(), ~ImageFactory.EVENTLOG_IMAGE_DIR) -- kept under _internal/eventlog/ so
// this small, static id set (e.g. "ModuleCreated", "SelfEvent") never collides with the
// general images/ namespace above (see tableRowRenderer.ts's iconId computation).
const eventlogDir = join(internalDir, 'eventlog');
if (existsSync(eventlogDir)) {
  for (const entry of readdirSync(eventlogDir)) {
    if (!entry.endsWith('.png')) continue;
    const src = join(eventlogDir, entry);
    const size = pngSize(src);
    if (!size) {
      console.warn(`skipping non-PNG content: ${src}`);
      continue;
    }
    const dest = join(outDir, '_internal', 'eventlog', entry);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    index[`_internal/eventlog/${entry.replace(/\.png$/, '')}`] = size;
    count++;
  }
} else {
  console.warn(`eventlog icon set not found: ${eventlogDir}`);
}

writeFileSync(join(outDir, 'index.json'), JSON.stringify({ version: 1, icons: index }));
console.log(`Snapshotted ${count} icons from ${imagesDir} to ${outDir} (index.json written).`);
