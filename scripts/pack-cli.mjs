// Stages the npm package @omnetpp/opp-tools (the opp_* command-line tools) into
// build/opp-tools/ from an already-built dist/, and packs it into a tarball.
// With --publish, publishes the staged package instead (bun publish).
//
// Usage: bun ./scripts/pack-cli.mjs [--publish]   (run after `bun run prepackage`)
import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const template = join(root, 'mcp', 'npm');
const outRoot = join(root, 'build');
const stage = join(outRoot, 'opp-tools');

const TOOLS = ['opp_lint.js', 'opp_neddoc.js', 'opp_ide_mcp.js'];
// Only what the CLI bundles resolve next to themselves (mcp/src/context.ts, neddoc.ts).
const ASSET_DIRS = ['wasm', 'config', 'icons', 'neddoc-material'];

function fail(msg) {
  console.error(`pack-cli: ${msg}`);
  process.exit(1);
}

for (const f of [...TOOLS, ...ASSET_DIRS]) {
  if (!existsSync(join(dist, f))) fail(`dist/${f} not found - run "bun run prepackage" first.`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });

// The package version follows the extension's, so a tool's behavior can be matched to
// the extension release it shipped with.
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const manifest = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8'));
manifest.version = version;
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(template, 'README.md'), join(stage, 'README.md'));
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));

for (const f of TOOLS) {
  copyFileSync(join(dist, f), join(stage, 'dist', f));
  chmodSync(join(stage, 'dist', f), 0o755);
}
for (const d of ASSET_DIRS) cpSync(join(dist, d), join(stage, 'dist', d), { recursive: true });

console.log(`staged ${manifest.name}@${version} -> ${stage}`);

const args = process.argv.includes('--publish')
  ? ['publish']
  : ['pm', 'pack', '--destination', outRoot];
const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit' });
if (r.status !== 0) fail(`bun ${args.join(' ')} failed`);
