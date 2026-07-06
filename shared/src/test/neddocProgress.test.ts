import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { generateNeddoc, createDiagramRenderer } from '../neddoc/generate';
import type { IconProvider } from '../graphics/diagramLayout';

const LIB = `package lib;
// One.
simple Node { gates: inout g[]; }
// Two.
simple Sink extends Node { }
network Net { submodules: n: Node; s: Sink; connections: n.g++ <--> s.g++; }
`;

const fakeIcons: IconProvider = {
  get: () => Promise.resolve({ href: 'icons/stub.png', width: 32, height: 20 }),
};

test('neddoc progress: overall percent is monotone, phased and ends at 100', async () => {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///lib.ned', svc.parse('ned', LIB), '');

  const reports: { step: string; done: number; total: number; percent: number }[] = [];
  await generateNeddoc(
    { nedCache },
    { format: 'html' },
    () => {},
    { report: (step, done, total, percent) => reports.push({ step, done, total, percent }) },
    createDiagramRenderer({ nedCache, icons: fakeIcons }),
  );

  assert.ok(reports.length > 5, `expected several reports, got ${reports.length}`);
  // monotone non-decreasing, within [0, 100], ends at exactly 100
  for (let i = 1; i < reports.length; i++)
    assert.ok(reports[i].percent >= reports[i - 1].percent, `regression at #${i}: ${JSON.stringify(reports.slice(i - 1, i + 1))}`);
  assert.ok(reports.every((r) => r.percent >= 0 && r.percent <= 100));
  assert.equal(reports[reports.length - 1].percent, 100);
  assert.equal(reports[reports.length - 1].step, 'Done');

  // extraction reports per-type ticks inside the 0-15% band
  const extracting = reports.filter((r) => r.step === 'Extracting types');
  assert.ok(extracting.length >= 3, 'per-type extraction ticks expected');
  assert.ok(extracting.every((r) => r.percent <= 15), JSON.stringify(extracting));

  // later phases report counts and stay above the extraction band
  const diagrams = reports.filter((r) => r.step === 'Rendering diagrams');
  const pages = reports.filter((r) => r.step === 'Writing pages');
  assert.ok(diagrams.length > 0 && pages.length > 0);
  assert.ok(diagrams[0].percent >= 15 && pages[0].percent >= diagrams[diagrams.length - 1].percent);
  assert.ok(pages.some((r) => r.total > 0 && r.done <= r.total));
});

test('neddoc progress: percent reaches 100 without a diagram renderer too', async () => {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///lib.ned', svc.parse('ned', LIB), '');
  const percents: number[] = [];
  await generateNeddoc({ nedCache }, { format: 'html' }, () => {}, {
    report: (_s, _d, _t, percent) => percents.push(percent),
  });
  assert.equal(percents[percents.length - 1], 100);
  for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1]);
});
