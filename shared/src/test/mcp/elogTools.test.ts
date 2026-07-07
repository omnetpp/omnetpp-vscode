import { test, describe } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { RandomAccessFile, RandomAccessFileProvider } from '../../fs/randomAccess';
import { ELOG_TOOLS, handleElogTool, type ElogToolContext } from '../../mcp/elogTools';

// ---- a tiny in-memory RandomAccessFileProvider fake -------------------------------
//
// Models a real filesystem closely enough for these tests: getMtimeMs()/getSize()/
// readAt() always reflect the *current* state of the record (even through an already-
// open handle -- exactly like fs.fstatSync on a still-open fd sees a live mtime), so
// `touch()` can simulate an external write without needing to close/reopen anything,
// and openRandomAccess() throws for a path with no registered record (like ENOENT).

interface FakeFileRecord {
  data: Uint8Array;
  mtimeMs: number;
}

function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

class FakeRandomAccessFile implements RandomAccessFile {
  constructor(
    readonly path: string,
    private readonly record: FakeFileRecord,
  ) {}
  getSize(): number {
    return this.record.data.length;
  }
  getMtimeMs(): number {
    return this.record.mtimeMs;
  }
  readAt(buffer: Uint8Array, fileOffset: number): number {
    if (fileOffset >= this.record.data.length) return 0;
    const n = Math.min(buffer.length, this.record.data.length - fileOffset);
    buffer.set(this.record.data.subarray(fileOffset, fileOffset + n));
    return n;
  }
  close(): void {}
}

class FakeRandomAccessFileProvider implements RandomAccessFileProvider {
  private records = new Map<string, FakeFileRecord>();
  readonly openCounts = new Map<string, number>();

  setFile(path: string, data: Uint8Array | string, mtimeMs = 1_000_000): void {
    this.records.set(path, { data: typeof data === 'string' ? encodeLatin1(data) : data, mtimeMs });
  }
  touch(path: string, mtimeMs: number): void {
    const record = this.records.get(path);
    if (record === undefined) throw new Error(`FakeRandomAccessFileProvider.touch: no such file: ${path}`);
    record.mtimeMs = mtimeMs;
  }
  openRandomAccess(path: string): RandomAccessFile {
    const record = this.records.get(path);
    if (record === undefined) throw new Error(`ENOENT: no such fake file: ${path}`);
    this.openCounts.set(path, (this.openCounts.get(path) ?? 0) + 1);
    return new FakeRandomAccessFile(path, record);
  }
}

function makeCtx(provider: FakeRandomAccessFileProvider): ElogToolContext {
  return { fileProvider: provider, resolvePath: (p) => p };
}

function call(ctx: ElogToolContext, name: string, args: Record<string, any> = {}): any {
  return handleElogTool(name, args, ctx);
}

const fixturesDir = join(__dirname, '..', 'fixtures', 'elog');
const SAMPLE_PATH = '/fake/Fifo1.elog';
const sampleBytes = fs.readFileSync(join(fixturesDir, 'sample', 'Fifo1-#0.elog'));
const emptyBytes = fs.readFileSync(join(fixturesDir, 'simple', 'empty.elog'));

const ONE_EVENT_TEXT = `SB ov 1026 ev 2 rid Test-0-20110331-14:47:49-4992

E # 0 t 0 m 1 ce -1 msg -1
MC id 1 c cCompoundModule t TestNet n TestNet cm 1
MC id 2 c Test t Test pid 1 n test
MMB sm 1 tm 2 m initialize(0)
MME
ME id 2
ME id 1

SE e 0 c 9 m "The user has finished the simulation at event #0, t=0."
`;

describe('ELOG_TOOLS registry', () => {
  test('lists every tool name with a description and schema', () => {
    const names = ELOG_TOOLS.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      'elog_filter_summary',
      'elog_find_text',
      'elog_get_event',
      'elog_get_events',
      'elog_get_module_tree',
      'elog_info',
      'elog_trace',
    ]);
    for (const tool of ELOG_TOOLS) {
      assert.ok(tool.description.length > 0);
      assert.strictEqual(tool.inputSchema.type, 'object');
    }
  });

  test('handleElogTool throws on an unknown tool name', () => {
    const ctx = makeCtx(new FakeRandomAccessFileProvider());
    assert.throws(() => call(ctx, 'elog_nonexistent'), /unknown tool/);
  });
});

describe('elog_info', () => {
  test('summarizes the sample fixture', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const info = call(ctx, 'elog_info', { file: SAMPLE_PATH });
    assert.strictEqual(info.isEmpty, false);
    assert.strictEqual(info.runId, 'Fifo1-0-20211218-16:50:48-61888');
    assert.strictEqual(info.omnetppVersion, 1536);
    assert.strictEqual(info.eventlogVersion, 2);
    assert.strictEqual(info.firstEventNumber, 0);
    assert.strictEqual(info.lastEventNumber, 32);
    assert.strictEqual(info.firstSimulationTime, '0');
    assert.strictEqual(info.simulationEnded, true);
    assert.strictEqual(info.simulationEndedWithError, false);
    assert.match(info.simulationEndMessage, /Simulation time limit reached/);
    assert.strictEqual(info.moduleCount, 4); // SingleQueue, source, fifo, sink
    assert.ok(info.approximateNumberOfEvents >= 1);
  });

  test('reports isEmpty for an empty file', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(emptyBytes));
    const ctx = makeCtx(provider);
    const info = call(ctx, 'elog_info', { file: SAMPLE_PATH });
    assert.strictEqual(info.isEmpty, true);
    assert.strictEqual(info.firstEventNumber, null);
    assert.strictEqual(info.moduleCount, 0);
  });

  test('throws for a missing "file" argument', () => {
    const ctx = makeCtx(new FakeRandomAccessFileProvider());
    assert.throws(() => call(ctx, 'elog_info', {}), /"file"/);
  });

  test('throws for a nonexistent file', () => {
    const ctx = makeCtx(new FakeRandomAccessFileProvider());
    assert.throws(() => call(ctx, 'elog_info', { file: '/no/such/file.elog' }), /cannot open elog file/);
  });
});

describe('elog_get_module_tree', () => {
  test('builds the SingleQueue module tree', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const { tree, truncated } = call(ctx, 'elog_get_module_tree', { file: SAMPLE_PATH });
    assert.strictEqual(truncated, false);
    assert.strictEqual(tree.fullName, 'SingleQueue');
    assert.strictEqual(tree.compound, true);
    assert.deepStrictEqual(
      tree.children.map((c: any) => c.fullName),
      ['source', 'fifo', 'sink'],
    );
  });

  test('caps depth and reports truncated', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const { tree, truncated } = call(ctx, 'elog_get_module_tree', { file: SAMPLE_PATH, maxDepth: 0 });
    assert.strictEqual(truncated, true);
    assert.strictEqual(tree.children.length, 0);
  });
});

describe('elog_get_event', () => {
  test('returns full detail by eventNumber, including cause and message name', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const ev1 = call(ctx, 'elog_get_event', { file: SAMPLE_PATH, eventNumber: 1 });
    assert.strictEqual(ev1.found, true);
    assert.strictEqual(ev1.eventNumber, 1);
    assert.strictEqual(ev1.simulationTime, '0');
    assert.strictEqual(ev1.causeEventNumber, 0);
    assert.strictEqual(ev1.messageName, 'sendMessageEvent');
    assert.ok(ev1.entries.length > 0);
    assert.strictEqual(ev1.entries[0].className, 'EventEntry');
    assert.ok(ev1.consequenceEventNumbers.includes(2));

    const ev2 = call(ctx, 'elog_get_event', { file: SAMPLE_PATH, eventNumber: 2 });
    assert.strictEqual(ev2.causeEventNumber, 1);
  });

  test('returns full detail by exact simtime', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const ev = call(ctx, 'elog_get_event', { file: SAMPLE_PATH, simtime: '0.159174900913' });
    assert.strictEqual(ev.found, true);
    assert.strictEqual(ev.eventNumber, 5);
  });

  test('returns found:false for a nonexistent event number', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const ev = call(ctx, 'elog_get_event', { file: SAMPLE_PATH, eventNumber: 99999 });
    assert.strictEqual(ev.found, false);
  });

  test('throws when neither eventNumber nor simtime is given', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    assert.throws(() => call(ctx, 'elog_get_event', { file: SAMPLE_PATH }), /eventNumber.*simtime/);
  });
});

describe('elog_get_events', () => {
  test('returns a capped, contiguous range of summaries', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const { rows, truncated } = call(ctx, 'elog_get_events', { file: SAMPLE_PATH, fromEventNumber: 0, maxCount: 3 });
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(truncated, true);
    assert.deepStrictEqual(
      rows.map((r: any) => r.eventNumber),
      [0, 1, 2],
    );
    assert.strictEqual(rows[1].messageName, 'sendMessageEvent');
  });

  test('respects toEventNumber and does not report truncation when the range ends naturally', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const { rows, truncated } = call(ctx, 'elog_get_events', { file: SAMPLE_PATH, fromEventNumber: 0, toEventNumber: 1, maxCount: 50 });
    assert.deepStrictEqual(
      rows.map((r: any) => r.eventNumber),
      [0, 1],
    );
    assert.strictEqual(truncated, false);
  });
});

describe('elog_find_text', () => {
  test('finds the first match from the start of the file', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const result = call(ctx, 'elog_find_text', { file: SAMPLE_PATH, text: 'job' });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.eventNumber, 1);
    assert.strictEqual(result.entryIndex, 1);
    assert.match(result.line, /job/);
  });

  test('resumes forward search from a given event, skipping earlier matches', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const result = call(ctx, 'elog_find_text', { file: SAMPLE_PATH, text: 'job', fromEventNumber: 2 });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.eventNumber, 3);
  });

  test('case-sensitive search does not match differently-cased text', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const result = call(ctx, 'elog_find_text', { file: SAMPLE_PATH, text: 'JOB', caseSensitive: true });
    assert.strictEqual(result.found, false);
  });
});

describe('elog_trace', () => {
  test('finds consequences transitively', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const { events, found } = call(ctx, 'elog_trace', { file: SAMPLE_PATH, eventNumber: 1, causes: false, consequences: true });
    assert.strictEqual(found, true);
    const byNumber = new Map(events.map((e: any) => [e.eventNumber, e.relation]));
    assert.strictEqual(byNumber.get(1), 'traced');
    assert.strictEqual(byNumber.get(2), 'consequence');
    assert.strictEqual(byNumber.get(5), 'consequence');
    assert.ok(![...byNumber.values()].includes('cause'));
  });

  test('finds causes', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const { events } = call(ctx, 'elog_trace', { file: SAMPLE_PATH, eventNumber: 2, causes: true, consequences: false });
    const byNumber = new Map(events.map((e: any) => [e.eventNumber, e.relation]));
    assert.strictEqual(byNumber.get(2), 'traced');
    assert.strictEqual(byNumber.get(1), 'cause');
    assert.ok(![...byNumber.values()].includes('consequence'));
  });

  test('returns found:false for a nonexistent event', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const result = call(ctx, 'elog_trace', { file: SAMPLE_PATH, eventNumber: 99999 });
    assert.strictEqual(result.found, false);
  });
});

describe('elog_filter_summary', () => {
  test('filters by module id', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const result = call(ctx, 'elog_filter_summary', {
      file: SAMPLE_PATH,
      filterParams: { enableModuleFilter: true, moduleIds: [3] },
      sampleSize: 5,
    });
    assert.strictEqual(result.isEmpty, false);
    assert.strictEqual(result.firstMatchingEventNumber, 2);
    for (const s of result.sample) assert.strictEqual(s.moduleId, 3);
  });

  test('empty filter params matches everything (same first/last as elog_info)', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    const info = call(ctx, 'elog_info', { file: SAMPLE_PATH });
    const result = call(ctx, 'elog_filter_summary', { file: SAMPLE_PATH, filterParams: {} });
    assert.strictEqual(result.firstMatchingEventNumber, info.firstEventNumber);
    assert.strictEqual(result.lastMatchingEventNumber, info.lastEventNumber);
  });
});

describe('engine LRU cache', () => {
  test('evicts the least-recently-used engine once more than 4 files are open, reopening it fresh on next access', () => {
    const provider = new FakeRandomAccessFileProvider();
    const paths = ['/fake/a.elog', '/fake/b.elog', '/fake/c.elog', '/fake/d.elog', '/fake/e.elog'];
    for (const p of paths) provider.setFile(p, ONE_EVENT_TEXT);
    const ctx = makeCtx(provider);

    for (const p of paths) call(ctx, 'elog_info', { file: p });
    for (const p of paths) assert.strictEqual(provider.openCounts.get(p), 1);

    // 'a' was the least-recently-used entry once the 5th file was opened (cache cap 4)
    // -- accessing it again must reopen (a fresh RandomAccessFile), not reuse a stale one.
    call(ctx, 'elog_info', { file: '/fake/a.elog' });
    assert.strictEqual(provider.openCounts.get('/fake/a.elog'), 2);

    // the most recently used entries are untouched by the eviction
    assert.strictEqual(provider.openCounts.get('/fake/d.elog'), 1);
    assert.strictEqual(provider.openCounts.get('/fake/e.elog'), 1);
  });

  test('does not reopen an unchanged, still-cached file', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, new Uint8Array(sampleBytes));
    const ctx = makeCtx(provider);
    call(ctx, 'elog_info', { file: SAMPLE_PATH });
    call(ctx, 'elog_info', { file: SAMPLE_PATH });
    call(ctx, 'elog_info', { file: SAMPLE_PATH });
    assert.strictEqual(provider.openCounts.get(SAMPLE_PATH), 1);
  });

  test('reopens once the file mtime changes (simulating an external write)', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, ONE_EVENT_TEXT, 1_000);
    const ctx = makeCtx(provider);
    call(ctx, 'elog_info', { file: SAMPLE_PATH });
    assert.strictEqual(provider.openCounts.get(SAMPLE_PATH), 1);

    provider.touch(SAMPLE_PATH, 2_000);
    call(ctx, 'elog_info', { file: SAMPLE_PATH });
    assert.strictEqual(provider.openCounts.get(SAMPLE_PATH), 2);
  });

  test('separate ElogToolContext instances do not share a cache', () => {
    const provider = new FakeRandomAccessFileProvider();
    provider.setFile(SAMPLE_PATH, ONE_EVENT_TEXT);
    const ctxA = makeCtx(provider);
    const ctxB = makeCtx(provider);
    call(ctxA, 'elog_info', { file: SAMPLE_PATH });
    call(ctxB, 'elog_info', { file: SAMPLE_PATH });
    assert.strictEqual(provider.openCounts.get(SAMPLE_PATH), 2);
  });
});
