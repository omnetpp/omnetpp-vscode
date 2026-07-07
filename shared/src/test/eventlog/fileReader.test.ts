import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RandomAccessFile } from '../../fs/randomAccess';
import { FileReader, FileChangedError, type Line } from '../../eventlog/fileReader';
import { FileChange } from '../../eventlog/enums';
import { NodeRandomAccessFile } from '../../node/nodeRandomAccessFile';

// ---- an in-memory RandomAccessFile fake, so most tests need no disk I/O -----------------

class FakeRandomAccessFile implements RandomAccessFile {
  readonly path = 'fake:///test.elog';
  private data: Uint8Array;
  private mtimeMs: number;

  constructor(data: Uint8Array | string, mtimeMs = 1_000_000) {
    this.data = typeof data === 'string' ? encodeLatin1(data) : data;
    this.mtimeMs = mtimeMs;
  }

  getSize(): number {
    return this.data.length;
  }
  getMtimeMs(): number {
    return this.mtimeMs;
  }
  readAt(buffer: Uint8Array, fileOffset: number): number {
    if (fileOffset >= this.data.length) return 0;
    const n = Math.min(buffer.length, this.data.length - fileOffset);
    buffer.set(this.data.subarray(fileOffset, fileOffset + n));
    return n;
  }
  close(): void {}

  /** Test helper: replace the file's content (and bump/set mtime), simulating an external write. */
  setContent(data: Uint8Array | string, mtimeMs: number): void {
    this.data = typeof data === 'string' ? encodeLatin1(data) : data;
    this.mtimeMs = mtimeMs;
  }
}

function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---- deterministic PRNG for the fuzz test -----------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

interface GeneratedFile {
  bytes: Uint8Array;
  /**
   * Reference lines both a forward scan and a (reversed) backward scan must produce:
   * only fully `\n`-terminated lines. Like forward reading, backward reading also never
   * returns a trailing *unterminated* line — reading backward from EOF when the file
   * doesn't end in `\n` snaps past that partial content to find the preceding complete
   * line instead (mirrors `FileReader::getPreviousLineBufferPointer`'s use of
   * `findPreviousLineStart` to align to a line boundary before returning anything).
   */
  lines: string[];
}

/** Builds random line-oriented content with random line lengths (incl. 0), optional CRLF, and an optionally-unterminated last line. */
function generateFile(rnd: () => number, lineCount: number, maxLineLen: number, endsWithNewline: boolean): GeneratedFile {
  const parts: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const len = Math.floor(rnd() * (maxLineLen + 1));
    let content = '';
    for (let j = 0; j < len; j++) content += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    const isLast = i === lineCount - 1;
    const terminated = !isLast || endsWithNewline;
    const useCrlf = terminated && rnd() < 0.5;
    parts.push(content + (terminated ? (useCrlf ? '\r\n' : '\n') : ''));
    if (terminated) lines.push(content);
  }
  return { bytes: encodeLatin1(parts.join('')), lines };
}

function collectForward(reader: FileReader): Line[] {
  reader.seekTo(0);
  const lines: Line[] = [];
  let line: Line | null;
  while ((line = reader.getNextLine()) !== null) lines.push(line);
  return lines;
}

function collectBackward(reader: FileReader): Line[] {
  reader.seekTo(reader.getFileSize());
  const lines: Line[] = [];
  let line: Line | null;
  while ((line = reader.getPreviousLine()) !== null) lines.push(line);
  return lines;
}

const BUFFER_SIZES = [64, 256, 4096, 262144];

test('fileReader: forward iteration matches a split() reference at several buffer sizes', () => {
  const rnd = mulberry32(12345);
  for (const bufferSize of BUFFER_SIZES) {
    for (let trial = 0; trial < 8; trial++) {
      const maxLineLen = Math.max(1, Math.floor(bufferSize / 2) - 4); // stay safely under maxLineSize
      const endsWithNewline = trial % 2 === 0;
      const gen = generateFile(rnd, 15, Math.min(maxLineLen, 24), endsWithNewline);
      const reader = new FileReader(new FakeRandomAccessFile(gen.bytes), bufferSize);
      const forward = collectForward(reader);
      assert.deepEqual(
        forward.map((l) => l.text),
        gen.lines,
        `bufferSize=${bufferSize} trial=${trial}`,
      );
    }
  }
});

test('fileReader: backward iteration matches the reversed reference at several buffer sizes', () => {
  const rnd = mulberry32(54321);
  for (const bufferSize of BUFFER_SIZES) {
    for (let trial = 0; trial < 8; trial++) {
      const maxLineLen = Math.max(1, Math.floor(bufferSize / 2) - 4);
      const endsWithNewline = trial % 2 === 0;
      const gen = generateFile(rnd, 15, Math.min(maxLineLen, 24), endsWithNewline);
      const reader = new FileReader(new FakeRandomAccessFile(gen.bytes), bufferSize);
      const backward = collectBackward(reader);
      assert.deepEqual(
        backward.map((l) => l.text),
        [...gen.lines].reverse(),
        `bufferSize=${bufferSize} trial=${trial}`,
      );
    }
  }
});

test('fileReader: forward line offsets chain together (endOffset[n] === startOffset[n+1])', () => {
  const rnd = mulberry32(999);
  const gen = generateFile(rnd, 30, 20, true);
  const reader = new FileReader(new FakeRandomAccessFile(gen.bytes), 64);
  const lines = collectForward(reader);
  assert.equal(lines.length, gen.lines.length);
  assert.equal(lines[0]!.startOffset, 0);
  for (let i = 0; i + 1 < lines.length; i++) assert.equal(lines[i]!.endOffset, lines[i + 1]!.startOffset);
  assert.equal(lines[lines.length - 1]!.endOffset, gen.bytes.length);
});

test('fileReader: backward line offsets chain together and match forward offsets', () => {
  const rnd = mulberry32(7777);
  const gen = generateFile(rnd, 30, 20, true);
  const reader = new FileReader(new FakeRandomAccessFile(gen.bytes), 128);
  const forward = collectForward(reader);
  const backward = [...collectBackward(reader)].reverse();
  assert.deepEqual(
    backward.map((l) => [l.startOffset, l.endOffset]),
    forward.map((l) => [l.startOffset, l.endOffset]),
  );
});

test('fileReader: an incomplete last line (no trailing newline) is not returned by forward reading', () => {
  const reader = new FileReader(new FakeRandomAccessFile('one\ntwo\nincomplete'), 64);
  assert.deepEqual(
    collectForward(reader).map((l) => l.text),
    ['one', 'two'],
  );
});

test('fileReader: an incomplete last line is also skipped by backward reading (symmetric with forward)', () => {
  // Reading backward from EOF snaps past the unterminated trailing content to align to a
  // line boundary before returning anything (mirrors getPreviousLineBufferPointer's use of
  // findPreviousLineStart) -- so "incomplete" is never returned by either direction.
  const reader = new FileReader(new FakeRandomAccessFile('one\ntwo\nincomplete'), 64);
  assert.deepEqual(
    collectBackward(reader).map((l) => l.text),
    ['two', 'one'],
  );
});

test('fileReader: a fully-terminated file returns the same last line both ways', () => {
  const reader = new FileReader(new FakeRandomAccessFile('one\ntwo\nthree\n'), 64);
  assert.deepEqual(collectForward(reader).map((l) => l.text), ['one', 'two', 'three']);
  assert.deepEqual(collectBackward(reader).map((l) => l.text), ['three', 'two', 'one']);
});

test('fileReader: empty lines and CRLF handling', () => {
  const reader = new FileReader(new FakeRandomAccessFile('a\r\n\nb\r\n'), 64);
  const lines = collectForward(reader);
  assert.deepEqual(
    lines.map((l) => l.text),
    ['a', '', 'b'],
  );
  // offsets stay byte-exact (include the \r before the \n)
  assert.equal(lines[0]!.startOffset, 0);
  assert.equal(lines[0]!.endOffset, 3); // "a\r\n"
  assert.equal(lines[1]!.startOffset, 3);
  assert.equal(lines[1]!.endOffset, 4); // "\n"
  assert.equal(lines[2]!.startOffset, 4);
  assert.equal(lines[2]!.endOffset, 7); // "b\r\n"
});

test('fileReader: empty file has no lines in either direction', () => {
  const reader = new FileReader(new FakeRandomAccessFile(''), 64);
  assert.deepEqual(collectForward(reader), []);
  assert.deepEqual(collectBackward(reader), []);
});

test('fileReader: seekTo the middle of a line discards its remainder/prefix (getNext/getPrevious symmetry)', () => {
  const content = 'aaaa\nbbbb\ncccc\n';
  const reader = new FileReader(new FakeRandomAccessFile(content), 64);
  // seek into the middle of "bbbb" (offset 7, within the second line [5,10))
  reader.seekTo(7);
  const next = reader.getNextLine();
  assert.equal(next?.text, 'cccc'); // remainder of "bbbb" is discarded, "cccc" is next
  reader.seekTo(7);
  const prev = reader.getPreviousLine();
  assert.equal(prev?.text, 'aaaa'); // "bbbb"'s prefix is discarded, "aaaa" is the previous complete line
});

test('fileReader: line longer than the buffer throws', () => {
  const reader = new FileReader(new FakeRandomAccessFile('a'.repeat(1000) + '\n'), 64);
  assert.throws(() => reader.getNextLine());
});

test('fileReader: getCurrentOffset/getFileSize/seekTo bounds', () => {
  const reader = new FileReader(new FakeRandomAccessFile('abc\ndef\n'), 64);
  assert.equal(reader.getFileSize(), 8);
  assert.equal(reader.getCurrentOffset(), 0);
  reader.seekTo(4);
  assert.equal(reader.getCurrentOffset(), 4);
  assert.throws(() => reader.seekTo(-1));
  assert.throws(() => reader.seekTo(9));
});

// ---- change detection -----------------------------------------------------------------

test('fileReader: getFileChange reports UNCHANGED when nothing changed', () => {
  const fake = new FakeRandomAccessFile('abc\ndef\n', 1000);
  const reader = new FileReader(fake, 64);
  assert.equal(reader.getFileChange(), FileChange.UNCHANGED);
});

test('fileReader: getFileChange reports APPENDED when the file grows with the same tail', () => {
  const fake = new FakeRandomAccessFile('abc\ndef\n', 1000);
  const reader = new FileReader(fake, 64);
  fake.setContent('abc\ndef\nghi\n', 2000);
  assert.equal(reader.getFileChange(), FileChange.APPENDED);
});

test('fileReader: getFileChange reports OVERWRITTEN when the tail differs', () => {
  const fake = new FakeRandomAccessFile('abc\ndef\n', 1000);
  const reader = new FileReader(fake, 64);
  fake.setContent('abc\nXXX\nghi\n', 2000);
  assert.equal(reader.getFileChange(), FileChange.OVERWRITTEN);
});

test('fileReader: getFileChange reports OVERWRITTEN when the file shrinks', () => {
  const fake = new FakeRandomAccessFile('abc\ndef\nghi\n', 1000);
  const reader = new FileReader(fake, 64);
  fake.setContent('abc\n', 2000);
  assert.equal(reader.getFileChange(), FileChange.OVERWRITTEN);
});

test('fileReader: a same-size touch (mtime changed, content identical) is still UNCHANGED', () => {
  const fake = new FakeRandomAccessFile('abc\ndef\n', 1000);
  const reader = new FileReader(fake, 64);
  fake.setContent('abc\ndef\n', 2000); // same bytes, different mtime
  assert.equal(reader.getFileChange(), FileChange.UNCHANGED);
});

test('fileReader: a refill that finds the file changed underneath throws FileChangedError', () => {
  // A small buffer forces getNextLine() to reload its window partway through the file, which
  // is where change detection actually happens ("invoked on buffer refill" -- see
  // checkFileForChanges()); a change is only observable at the point a fresh read is attempted.
  const fake = new FakeRandomAccessFile('line1\nline2\nline3\n', 1000);
  const reader = new FileReader(fake, 8);
  assert.equal(reader.getNextLine()?.text, 'line1');
  fake.setContent('line1\nline2\nline3\nline4\n', 2000); // appended, same old tail
  let threw: unknown;
  try {
    reader.getNextLine();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof FileChangedError);
  assert.equal((threw as FileChangedError).change, FileChange.APPENDED);
});

test('fileReader: reading exactly up to the cached EOF returns null without a refill, even if the file grew', () => {
  // getFileSize() is cached at synchronize time (not a live stat), so a getNextLine() call that
  // never needs to touch fresh bytes beyond what's already cached/known does not by itself
  // detect an external append -- that requires an explicit getFileChange()/synchronize().
  const fake = new FakeRandomAccessFile('a'.repeat(60) + '\n', 1000);
  const reader = new FileReader(fake, 64); // buffer comfortably holds the whole initial file
  const first = reader.getNextLine();
  assert.equal(first?.text.length, 60);
  fake.setContent('a'.repeat(60) + '\nmore\n', 2000);
  assert.equal(reader.getNextLine(), null);
  assert.equal(reader.getFileChange(), FileChange.APPENDED); // detectable on demand, just not implicitly
});

test('fileReader: synchronize(APPENDED) lets reading continue seamlessly with the new content', () => {
  const fake = new FakeRandomAccessFile('one\ntwo\n', 1000);
  const reader = new FileReader(fake, 64);
  const lines1 = collectForward(reader);
  assert.deepEqual(lines1.map((l) => l.text), ['one', 'two']);
  fake.setContent('one\ntwo\nthree\n', 2000);
  reader.synchronize(FileChange.APPENDED);
  reader.seekTo(lines1[lines1.length - 1]!.endOffset);
  const more = reader.getNextLine();
  assert.equal(more?.text, 'three');
});

test('fileReader: synchronize(OVERWRITTEN) resets and lets reading resume from scratch', () => {
  const fake = new FakeRandomAccessFile('one\ntwo\n', 1000);
  const reader = new FileReader(fake, 64);
  collectForward(reader);
  fake.setContent('completely\ndifferent\ncontent\n', 2000);
  reader.synchronize(FileChange.OVERWRITTEN);
  assert.deepEqual(collectForward(reader).map((l) => l.text), ['completely', 'different', 'content']);
});

test('fileReader: getFileSize() stays at the last-synchronized value, not a live stat', () => {
  const fake = new FakeRandomAccessFile('one\ntwo\n', 1000);
  const reader = new FileReader(fake, 64);
  assert.equal(reader.getFileSize(), 8);
  fake.setContent('one\ntwo\nthree\n', 2000);
  assert.equal(reader.getFileSize(), 8); // unchanged until synchronize()
  reader.synchronize(FileChange.APPENDED);
  assert.equal(reader.getFileSize(), 14);
});

// ---- disk-based smoke test for NodeRandomAccessFile ------------------------------------

test('fileReader: works end-to-end over a real file via NodeRandomAccessFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileReader-test-'));
  const file = path.join(dir, 'sample.txt');
  try {
    const content = 'first line\r\nsecond line\n\nfourth line\n';
    fs.writeFileSync(file, content, 'latin1');

    const raf = new NodeRandomAccessFile(file);
    assert.equal(raf.getSize(), content.length);
    const reader = new FileReader(raf, 16);
    assert.deepEqual(collectForward(reader).map((l) => l.text), ['first line', 'second line', '', 'fourth line']);
    assert.deepEqual(collectBackward(reader).map((l) => l.text), [
      'fourth line',
      '',
      'second line',
      'first line',
    ]);
    reader.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
