import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { parseDoxyTags, doxyUrlFor } from '../neddoc/doxytags';
import { extractDocModel } from '../neddoc/extract';
import { defaultNeddocOptions } from '../neddoc/options';

const TAGFILE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<tagfile>
  <compound kind="class">
    <name>demo::TxNode</name>
    <filename>classdemo_1_1TxNode.html</filename>
    <member kind="function"><name>handleMessage</name></member>
  </compound>
  <compound kind="class">
    <name>demo::FooPkt</name>
    <filename>classdemo_1_1FooPkt</filename>
  </compound>
  <compound kind="namespace">
    <name>demo</name>
    <filename>namespacedemo.html</filename>
  </compound>
  <compound kind="struct">
    <name>Bare</name>
    <filename>structBare.html</filename>
  </compound>
</tagfile>
`;

test('doxytags: parses class/struct compounds, skips namespaces', () => {
  const map = parseDoxyTags(TAGFILE);
  assert.equal(map.get('demo::TxNode'), 'classdemo_1_1TxNode.html');
  assert.equal(map.get('demo::FooPkt'), 'classdemo_1_1FooPkt.html'); // extension added
  assert.equal(map.get('Bare'), 'structBare.html');
  assert.equal(map.get('demo'), undefined);
});

test('doxytags: doxyUrlFor joins the prefix and tries candidates in order', () => {
  const map = parseDoxyTags(TAGFILE);
  assert.equal(doxyUrlFor(map, '../doxy', ['demo::TxNode', 'TxNode']), '../doxy/classdemo_1_1TxNode.html');
  assert.equal(doxyUrlFor(map, '../doxy/', ['Bare']), '../doxy/structBare.html');
  assert.equal(doxyUrlFor(map, '', ['Bare']), 'structBare.html');
  assert.equal(doxyUrlFor(map, '../doxy', ['NoSuch']), undefined);
});

test('doxytags: C++ definition links appear on simple-module and msg pages', async () => {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile(
    'file:///lib.ned',
    svc.parse(
      'ned',
      `package lib;
@namespace(demo);
simple Tx { @class(TxNode); }
simple NoCpp { }
network Net { submodules: t: Tx; }
`,
    ),
    '',
  );
  const msgCache = new MsgResourceCache();
  msgCache.addFile('file:///p.msg', svc.parse('msg', 'namespace demo;\npacket FooPkt { int seq; }\n'));

  const model = extractDocModel(
    { nedCache, msgCache },
    { ...defaultNeddocOptions(), doxytags: { xml: TAGFILE, urlPrefix: '../doxy' } },
  );
  const tx = model.pages.find((p) => p.ref.id === 'lib.Tx')!;
  const link = tx.sections.find(
    (s) => s.kind === 'para' && s.cells.some((c) => c.kind === 'exlink' && c.text === 'C++ definition'),
  );
  assert.ok(link, 'C++ definition link missing on the simple module page');
  assert.ok(JSON.stringify(link).includes('../doxy/classdemo_1_1TxNode.html'), JSON.stringify(link));

  // no link for classes absent from the tag file, none for networks
  const noCpp = model.pages.find((p) => p.ref.id === 'lib.NoCpp')!;
  assert.ok(!JSON.stringify(noCpp.sections).includes('C++ definition'));
  const net = model.pages.find((p) => p.ref.id === 'lib.Net')!;
  assert.ok(!JSON.stringify(net.sections).includes('C++ definition'));

  const pkt = model.pages.find((p) => p.ref.id === 'msg-demo--FooPkt')!;
  assert.ok(JSON.stringify(pkt.sections).includes('classdemo_1_1FooPkt.html'), 'msg C++ link missing');
});
