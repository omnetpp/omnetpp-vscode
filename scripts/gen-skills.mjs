// Snapshots the end-user OMNeT++ agent skills into resources/skills/, from which they
// ship in the agent plugin and to Copilot via contributes.chatSkills. Usage:
//   bun scripts/gen-skills.mjs <skills-dir>
// omnetpp-tooling documents this extension's own tools, so it is maintained in
// resources/skills/ directly and is not touched here.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = [
  'omnetpp-modeling',
  'omnetpp-model-development',
  'omnetpp-coding-conventions',
  'omnetpp-sim-debugging',
  'omnetpp-fingerprint-testing',
  'omnetpp-model-refactoring',
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) {
  console.error('usage: bun scripts/gen-skills.mjs <skills-dir>');
  process.exit(2);
}
const srcDir = resolve(process.argv[2]);
const destDir = join(root, 'resources', 'skills');

// The Agent Skills spec (Codex, Copilot, Devin) requires both keys, and Copilot
// requires name to equal the directory name.
function checkFrontmatter(name, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new Error(`${name}: SKILL.md has no frontmatter`);
  const keys = [...m[1].matchAll(/^([A-Za-z_-]+):/gm)].map((k) => k[1]);
  if (!keys.includes('description')) throw new Error(`${name}: frontmatter has no description`);
  const nameValue = /^name:\s*(\S+)\s*$/m.exec(m[1])?.[1];
  if (nameValue !== name) throw new Error(`${name}: frontmatter name is "${nameValue}"`);
  const extra = keys.filter((k) => !['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(k));
  if (extra.length) throw new Error(`${name}: non-portable frontmatter keys: ${extra.join(', ')}`);
}

for (const name of SKILLS) {
  const src = join(srcDir, name);
  if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`skill not found: ${src}`);
  checkFrontmatter(name, readFileSync(join(src, 'SKILL.md'), 'utf8'));
  const dest = join(destDir, name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  const files = readdirSync(dest, { recursive: true }).filter((f) => statSync(join(dest, f)).isFile());
  console.log(`copied ${name} (${files.length} files)`);
}
