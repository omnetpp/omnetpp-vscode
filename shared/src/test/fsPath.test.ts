import { test } from 'bun:test';
import assert from 'node:assert';
import { indexPath, indexRelative, splitNedPath, uriToIndexPath } from '../node/fsPath';

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

test('splitNedPath keeps Windows drive letters and splits on ; only', () => {
  assert.deepEqual(splitNedPath('C:\\inet\\src; D:/lib/ned;', 'win32'), ['C:\\inet\\src', 'D:/lib/ned']);
  assert.deepEqual(splitNedPath('C:\\inet\\src', 'win32'), ['C:\\inet\\src']);
});

test('splitNedPath accepts : and ; outside Windows', () => {
  assert.deepEqual(splitNedPath('/opt/inet/src:/opt/lib ; /x', 'linux'), ['/opt/inet/src', '/opt/lib', '/x']);
  assert.deepEqual(splitNedPath('  ', 'darwin'), []);
});

test('indexRelative matches a resolved Windows path against a path from an index URI', () => {
  // resolve() spells the drive letter as the user typed it; the index's URIs give it lowercase.
  const fromIndex = uriToIndexPath('file:///d%3A/a/proj/sub/x.ned', 'win32');
  assert.equal(indexRelative('D:\\a\\proj', fromIndex, 'win32'), 'sub/x.ned');
  assert.equal(indexRelative('D:\\a\\proj\\sub\\x.ned', fromIndex, 'win32'), '');
  assert.equal(indexRelative('D:\\a\\pro', fromIndex, 'win32'), undefined);
  assert.equal(indexRelative('D:\\', fromIndex, 'win32'), 'a/proj/sub/x.ned');
});

test('indexRelative compares POSIX paths as they are', () => {
  assert.equal(indexRelative('/proj', '/proj/a/b.ned', 'linux'), 'a/b.ned');
  assert.equal(indexRelative('/proj/', '/proj', 'linux'), '');
  assert.equal(indexRelative('/Proj', '/proj/a.ned', 'linux'), undefined);
  assert.equal(indexRelative('/', '/proj/a.ned', 'linux'), 'proj/a.ned');
});
