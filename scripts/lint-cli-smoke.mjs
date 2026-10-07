// Drives the bundled CLI linter (dist/opp_lint.js) against a throwaway project
// and asserts: diagnostics are reported, inline suppression is honored, the JSON
// shape is correct, exit codes follow --fail-on, and --agent-hook follows the agent
// post-edit hook contract (stdin JSON, report on stderr, exit 2). Run after
// `bun run dev:build`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'opp_lint.js');

const proj = mkdtempSync(join(tmpdir(), 'opp-lint-'));
writeFileSync(join(proj, 'Host.ned'), 'simple Host {\n  parameters:\n    int n;\n    int n;\n}\n');
writeFileSync(join(proj, 'Net.ned'), 'network Net {\n  submodules:\n    h: Nonexistent;\n}\n');
// a duplicate that is silenced by a trailing //# suppress on the offending line
writeFileSync(join(proj, 'Ok.ned'), 'simple Ok {\n  parameters:\n    int k;\n    int k; //# suppress(duplicate)\n}\n');

// a file in another package that uses Host: resolvable only through the whole project
mkdirSync(join(proj, 'sub'));
writeFileSync(join(proj, 'sub', 'Uses.ned'), 'package sub;\nimport Host;\nnetwork Uses {\n  submodules:\n    h: Host;\n}\n');

function run(args, input) {
  const r = spawnSync(process.execPath, [cli, '--no-color', ...args], { encoding: 'utf8', input, cwd: proj });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const hook = (input) => run(['--agent-hook'], JSON.stringify(input));
function cleanup() {
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* ignore */ }
}
function assert(cond, msg) {
  if (!cond) {
    console.error('FAILED:', msg);
    cleanup();
    process.exit(1);
  }
}

try {
  // 1) default text run: two errors (Host duplicate, Net unknown-type), Ok.ned silent, exit 1
  const text = run([proj]);
  assert(text.code === 1, `expected exit 1 with errors, got ${text.code}`);
  assert(/Duplicate parameter 'n'/.test(text.out), 'missing duplicate-param diagnostic');
  assert(/Unknown type 'Nonexistent'/.test(text.out), 'missing unknown-type diagnostic');
  assert(!/Ok\.ned/.test(text.out), 'Ok.ned should be silenced by //# suppress(duplicate)');
  console.log('text run + suppression: OK');

  // 2) JSON shape + counts
  const json = run(['--format=json', proj]);
  const data = JSON.parse(json.out);
  assert(data.summary.errors === 2, `expected 2 errors in summary, got ${data.summary.errors}`);
  assert(Array.isArray(data.files) && data.files.length === 2, 'expected 2 files in json');
  const hasOneBased = data.files.every((f) => f.diagnostics.every((d) => d.line >= 1 && d.column >= 1));
  assert(hasOneBased, 'json line/column must be 1-based');
  console.log('json output: OK');

  // 3) --fail-on=never → exit 0 despite errors
  assert(run(['--fail-on=never', proj]).code === 0, '--fail-on=never should exit 0');

  // 4) linting only the clean (suppressed) file → no problems, exit 0
  const okOnly = run([join(proj, 'Ok.ned')]);
  assert(okOnly.code === 0, `suppressed-only file should exit 0, got ${okOnly.code}`);
  assert(/No problems found/.test(okOnly.out), 'expected "No problems found." for suppressed file');
  console.log('fail-on + single-file: OK');

  // 5) --agent-hook, Claude-style Edit input on a broken file: report on stderr, exit 2
  const claude = hook({ cwd: proj, tool_name: 'Edit', tool_input: { file_path: join(proj, 'Host.ned') } });
  assert(claude.code === 2, `hook on a broken file should exit 2, got ${claude.code}`);
  assert(/Duplicate parameter 'n'/.test(claude.err) && /Host\.ned/.test(claude.err), 'hook report missing on stderr');
  assert(claude.out === '', 'hook must keep stdout empty');
  assert(!/Unknown type 'Nonexistent'/.test(claude.err), 'hook must lint only the edited file');

  // 6) Codex-style apply_patch with a relative path
  const patch = '*** Begin Patch\n*** Update File: Net.ned\n@@\n-x\n+y\n*** End Patch';
  const codex = hook({ cwd: proj, tool_name: 'apply_patch', tool_input: { command: patch } });
  assert(codex.code === 2 && /Unknown type 'Nonexistent'/.test(codex.err), `apply_patch hook: exit ${codex.code}, ${codex.err}`);

  // 7) clean, suppressed, cross-package and non-NED edits: silent exit 0
  for (const [label, input] of [
    ['suppressed file', { cwd: proj, tool_input: { file_path: join(proj, 'Ok.ned') } }],
    ['cross-package import', { cwd: proj, tool_input: { file_path: join(proj, 'sub', 'Uses.ned') } }],
    ['non-NED file', { cwd: proj, tool_input: { file_path: join(proj, 'README.md') } }],
    ['shell command', { cwd: proj, tool_name: 'Bash', tool_input: { command: 'ls' } }],
  ]) {
    const r = hook(input);
    assert(r.code === 0 && r.err === '' && r.out === '', `hook on ${label}: exit ${r.code}, stderr ${r.err}`);
  }
  assert(run(['--agent-hook'], 'not json').code === 0, 'hook must ignore malformed input');
  console.log('agent hook: OK');

  console.log('LINT CLI SMOKE PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('LINT CLI SMOKE ERROR:', e.message);
  cleanup();
  process.exit(1);
}
