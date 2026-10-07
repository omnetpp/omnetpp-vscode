import { test } from 'bun:test';
import assert from 'node:assert';
import { editedFiles } from '../agents/hookInput';

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
