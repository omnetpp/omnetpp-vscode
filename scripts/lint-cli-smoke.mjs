// Drives the bundled CLI linter (dist/opp_lint.js) against a throwaway project
// and asserts: diagnostics are reported, inline suppression is honored, the JSON
// shape is correct, exit codes follow --fail-on, --version prints the package
// version, and --agent-hook follows each agent's post-edit hook contract (stdin JSON;
// report on stderr with exit 2, or as a JSON context field on stdout for Copilot CLI and
// Cursor). Run after `bun run dev:build`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'opp_lint.js');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const proj = mkdtempSync(join(tmpdir(), 'opp-lint-'));
writeFileSync(join(proj, 'Host.ned'), 'simple Host {\n  parameters:\n    int n;\n    int n;\n}\n');
writeFileSync(join(proj, 'Net.ned'), 'network Net {\n  submodules:\n    h: Nonexistent;\n}\n');
// a duplicate that is silenced by a trailing //# suppress on the offending line
writeFileSync(join(proj, 'Ok.ned'), 'simple Ok {\n  parameters:\n    int k;\n    int k; //# suppress(duplicate)\n}\n');

// a file in another package that uses Host: resolvable only through the whole project
mkdirSync(join(proj, 'sub'));
writeFileSync(join(proj, 'sub', 'Uses.ned'), 'package sub;\nimport Host;\nnetwork Uses {\n  submodules:\n    h: Host;\n}\n');

// The hook tests must not see the agent variables of a session that runs this script.
const { CLAUDE_PROJECT_DIR, CURSOR_PROJECT_DIR, COPILOT_PLUGIN_ROOT, ...cleanEnv } = process.env;
function run(args, input, env = cleanEnv) {
  const r = spawnSync(process.execPath, [cli, '--no-color', ...args], { encoding: 'utf8', input, cwd: proj, env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const hook = (input, env, args = ['--agent-hook']) => run(args, JSON.stringify(input), env);
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

  const ver = run(['--version']);
  assert(ver.code === 0 && ver.out === `opp_lint ${version}\n`, `unexpected --version output: ${ver.out}`);
  console.log('--version: OK');

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
  for (const text of ['not json', 'null', '42']) {
    assert(run(['--agent-hook'], text).code === 0, `hook must ignore input that is not a JSON object: ${text}`);
  }
  console.log('agent hook: OK');

  // 8) Copilot CLI, in its Claude-compatible input (detected by COPILOT_PLUGIN_ROOT) and
  // in its camelCase input with toolArgs as a JSON string: context on stdout, exit 0
  const copilotEnv = { ...cleanEnv, COPILOT_PLUGIN_ROOT: '/plugins/omnetpp', CLAUDE_PROJECT_DIR: proj };
  for (const input of [
    { hook_event_name: 'PostToolUse', cwd: proj, tool_name: 'Edit', tool_input: { path: join(proj, 'Host.ned') } },
    { cwd: proj, toolName: 'edit', toolArgs: JSON.stringify({ path: 'Host.ned', old_str: 'a', new_str: 'b' }) },
  ]) {
    const r = hook(input, input.toolName ? cleanEnv : copilotEnv);
    assert(r.code === 0 && r.err === '', `copilot hook: exit ${r.code}, stderr ${r.err}`);
    assert(/Duplicate parameter 'n'/.test(JSON.parse(r.out).additionalContext), `copilot hook stdout: ${r.out}`);
  }

  // 9) Cursor postToolUse: empty cwd, project from workspace_roots, context on stdout
  const cursorInput = {
    hook_event_name: 'postToolUse', cursor_version: '2.1.0', cwd: '', workspace_roots: [proj],
    tool_name: 'Write', tool_input: { file_path: join(proj, 'Net.ned') },
  };
  for (const args of [['--agent-hook'], ['--agent-hook=cursor']]) {
    const r = hook(cursorInput, cleanEnv, args);
    assert(r.code === 0 && r.err === '', `cursor hook ${args}: exit ${r.code}, stderr ${r.err}`);
    assert(/Unknown type 'Nonexistent'/.test(JSON.parse(r.out).additional_context), `cursor hook stdout: ${r.out}`);
  }

  // 10) an explicit mode wins over detection; an unknown one is a usage error
  const forced = hook(cursorInput, cleanEnv, ['--agent-hook=claude']);
  assert(forced.code === 2 && forced.out === '' && /Nonexistent/.test(forced.err), `--agent-hook=claude: exit ${forced.code}`);
  assert(run(['--agent-hook=gemini'], '{}').code === 2, 'unknown --agent-hook value must be rejected');
  // without the grammars: a runtime error, which must not exit 2 ("block") in Cursor
  const noWasm = { ...cleanEnv, OMNETPP_WASM_DIR: join(proj, 'sub') };
  const okInput = { cwd: proj, tool_input: { file_path: join(proj, 'Ok.ned') } };
  for (const [mode, code] of [['cursor', 1], ['claude', 2]]) {
    const r = hook(okInput, noWasm, [`--agent-hook=${mode}`]);
    assert(r.code === code && r.out === '' && /grammar wasm not found/.test(r.err), `${mode} hook runtime error: exit ${r.code}, ${r.err}`);
  }
  console.log('agent hook modes: OK');

  console.log('LINT CLI SMOKE PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('LINT CLI SMOKE ERROR:', e.message);
  cleanup();
  process.exit(1);
}
