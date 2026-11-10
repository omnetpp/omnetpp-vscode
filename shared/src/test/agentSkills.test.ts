import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SKILLS, OPTIONAL_SKILLS, SKILL_REQUIRES, withRequiredSkills } from '../agents/plugin';

const repo = join(__dirname, '..', '..', '..');
const skillsDir = join(repo, 'resources', 'skills');
const shipped = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());

function referencedSkills(name: string): Set<string> {
  const dir = join(skillsDir, name);
  const text = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  return new Set(shipped.filter((s) => s !== name && new RegExp(`\\b${s}\\b`).test(text)));
}

test('every bundled skill is a default or a SKILL_REQUIRES entry, and vice versa', () => {
  const known = [...DEFAULT_SKILLS, ...Object.keys(SKILL_REQUIRES)];
  assert.deepStrictEqual([...shipped].sort(), [...new Set(known)].sort());
  for (const s of OPTIONAL_SKILLS) assert.ok(s in SKILL_REQUIRES, s);
});

test('a default skill refers only to default skills', () => {
  for (const s of DEFAULT_SKILLS) {
    const extra = [...referencedSkills(s)].filter((r) => !DEFAULT_SKILLS.includes(r));
    assert.deepStrictEqual(extra, [], s);
  }
});

test('SKILL_REQUIRES lists exactly the non-default skills each skill refers to', () => {
  for (const [s, requires] of Object.entries(SKILL_REQUIRES)) {
    const referenced = [...referencedSkills(s)].filter((r) => !DEFAULT_SKILLS.includes(r));
    assert.deepStrictEqual([...requires].sort(), referenced.sort(), s);
  }
});

test('withRequiredSkills adds the requirements transitively and ignores unknown names', () => {
  assert.deepStrictEqual(withRequiredSkills([]), []);
  assert.deepStrictEqual(withRequiredSkills(['omnetpp-model-review-brief', 'no-such-skill', 'dev-design']), [
    'omnetpp-model-review-brief',
    'dev-commit-messages',
  ]);
  const branch = withRequiredSkills(['omnetpp-model-branch-rebase']);
  for (const s of ['omnetpp-model-branch-cleanup', 'dev-branch-cleanup', 'dev-git-workflow', 'dev-design']) {
    assert.ok(branch.includes(s), s);
  }
});

test('Copilot gets the default skills through chatSkills', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const chat = pkg.contributes.chatSkills.map((c: { path: string }) => c.path.split('/').at(-2));
  assert.deepStrictEqual(chat, DEFAULT_SKILLS);
});
