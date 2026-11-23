import { test } from 'bun:test';
import assert from 'node:assert';
import { COPILOT_CONTEXT_LIMIT, editedFiles, hookAgent, hookProjectDir, hookReply } from '../agents/hookInput';

test('editedFiles reads file_path of Claude Edit/Write/MultiEdit', () => {
  assert.deepEqual(editedFiles({ tool_name: 'Edit', tool_input: { file_path: '/p/A.ned', old_string: 'a', new_string: 'b' } }), ['/p/A.ned']);
  assert.deepEqual(editedFiles({ tool_name: 'MultiEdit', tool_input: { file_path: '/p/B.msg', edits: [] } }), ['/p/B.msg']);
});

test('editedFiles reads the file headers of a Codex apply_patch', () => {
  const command = [
    '*** Begin Patch',
    '*** Update File: src/A.ned',
    '@@',
    '-simple A {}',
    '+simple A { parameters: int x; }',
    '*** Add File: omnetpp.ini',
    '+[General]',
    '*** Update File: src/Old.ned',
    '*** Move to: src/New.ned',
    '*** Delete File: src/Gone.ned',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(editedFiles({ tool_name: 'apply_patch', tool_input: { command } }), [
    'src/A.ned',
    'omnetpp.ini',
    'src/Old.ned',
    'src/New.ned',
  ]);
});

test('editedFiles ignores inputs without edited files', () => {
  assert.deepEqual(editedFiles({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), []);
  assert.deepEqual(editedFiles({}), []);
  assert.deepEqual(editedFiles(null), []);
  assert.deepEqual(editedFiles({ tool_input: 'text' }), []);
});

test('editedFiles reads the camelCase Copilot CLI input, whose toolArgs may be a JSON string', () => {
  assert.deepEqual(editedFiles({ toolName: 'edit', toolArgs: '{"path":"/p/A.ned","old_str":"a","new_str":"b"}' }), ['/p/A.ned']);
  assert.deepEqual(editedFiles({ toolName: 'create', toolArgs: { path: '/p/B.msg', file_text: '' } }), ['/p/B.msg']);
  assert.deepEqual(editedFiles({ tool_name: 'Edit', tool_input: '{"path":"/p/C.ini"}' }), ['/p/C.ini']);
  assert.deepEqual(editedFiles({ toolName: 'apply_patch', toolArgs: '*** Begin Patch\n*** Update File: D.ned\n*** End Patch' }), ['D.ned']);
});

test('hookAgent tells Copilot CLI and Cursor from the Claude-compatible agents', () => {
  assert.equal(hookAgent({ tool_name: 'Edit', tool_input: {}, tool_response: {} }, {}), 'claude');
  assert.equal(hookAgent({ tool_name: 'Edit', tool_input: {} }, { COPILOT_PLUGIN_ROOT: '/plugins/omnetpp' }), 'copilot');
  assert.equal(hookAgent({ toolName: 'edit', toolArgs: '{}' }, {}), 'copilot');
  assert.equal(hookAgent({ tool_name: 'Edit', tool_result: { result_type: 'success', text_result_for_llm: '' } }, {}), 'copilot');
  assert.equal(hookAgent({ hook_event_name: 'postToolUse', tool_name: 'Write', cursor_version: '2.1.0' }, {}), 'cursor');
  assert.equal(hookAgent(null, {}), 'claude');
});

test('hookProjectDir prefers the agent-provided project over the cwd, which Cursor may leave empty', () => {
  assert.equal(hookProjectDir({ cwd: '/p/sub' }, { CLAUDE_PROJECT_DIR: '/p' }), '/p');
  assert.equal(hookProjectDir({ cwd: '' }, { CURSOR_PROJECT_DIR: '/c' }), '/c');
  assert.equal(hookProjectDir({ cwd: '', workspace_roots: ['/w1', '/w2'] }, {}), '/w1');
  assert.equal(hookProjectDir({ cwd: '/p/sub' }, {}), '/p/sub');
  assert.equal(hookProjectDir({}, {}), undefined);
});

test('hookReply follows each agent\'s way of showing text to the model', () => {
  assert.deepEqual(hookReply('claude', 'R\n'), { stdout: '', stderr: 'R\n', exitCode: 2 });
  assert.deepEqual(hookReply('copilot', 'R\n'), { stdout: '{"additionalContext":"R\\n"}\n', stderr: '', exitCode: 0 });
  assert.deepEqual(hookReply('cursor', 'R\n'), { stdout: '{"additional_context":"R\\n"}\n', stderr: '', exitCode: 0 });
});

test('hookReply keeps the Copilot context within its size limit, cutting whole lines', () => {
  const line = `  1:1     error   ${'x'.repeat(80)}`;
  const report = Array.from({ length: 500 }, () => line).join('\n') + '\n';
  const context: string = JSON.parse(hookReply('copilot', report).stdout).additionalContext;
  assert.ok(new TextEncoder().encode(context).length <= COPILOT_CONTEXT_LIMIT);
  const lines = context.trimEnd().split('\n');
  assert.ok(lines.slice(0, -1).every((l) => l === line));
  assert.match(lines.at(-1)!, /^… \d+ more lines not shown$/);
});
