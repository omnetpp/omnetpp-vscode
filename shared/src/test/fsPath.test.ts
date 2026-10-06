import { test } from 'bun:test';
import assert from 'node:assert';
import { indexPath, uriToIndexPath } from '../node/fsPath';

test('indexPath on win32 uses forward slashes and a lowercase drive letter', () => {
  assert.equal(indexPath('C:\\inet\\src', 'win32'), 'c:/inet/src');
  assert.equal(indexPath('c:/proj\\sub/a.ned', 'win32'), 'c:/proj/sub/a.ned');
  assert.equal(indexPath('\\\\server\\share\\x', 'win32'), '//server/share/x');
});

test('indexPath leaves POSIX paths alone, backslashes included', () => {
  assert.equal(indexPath('/proj/a\\b.ned', 'linux'), '/proj/a\\b.ned');
  assert.equal(indexPath('/Proj/A.ned', 'darwin'), '/Proj/A.ned');
});

test('uriToIndexPath turns VS Code URIs into index paths', () => {
  assert.equal(uriToIndexPath('file:///c%3A/proj/a%2Bb.ned', 'win32'), 'c:/proj/a+b.ned');
  assert.equal(uriToIndexPath('file:///C:/proj/a.ned', 'win32'), 'c:/proj/a.ned');
  assert.equal(uriToIndexPath('file:///proj/a%2Bb.ned', 'linux'), '/proj/a+b.ned');
  assert.throws(() => uriToIndexPath('untitled:Untitled-1', 'linux'));
});
