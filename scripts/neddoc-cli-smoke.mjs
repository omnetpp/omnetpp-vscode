// Drives the bundled CLI documentation generator (dist/opp_neddoc.js) against
// a throwaway project and asserts: pages/assets are produced, type references
// resolve to links, tables contain the expected rows, options and exit codes
// behave. Run after `bun run dev:build`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'opp_neddoc.js');

const proj = mkdtempSync(join(tmpdir(), 'opp-neddoc-'));
mkdirSync(join(proj, 'src'));
writeFileSync(
  join(proj, 'src', 'demo.ned'),
  `package demo;
// The base node; see ~Sink.
//
// @author Testy
simple Node
{
    parameters:
        double rate @unit(bps) = default(100bps); // transmission rate
    gates:
        inout g[];
}
// Terminal node.
simple Sink extends Node { }
network Net
{
    submodules:
        n: Node;
        s: Sink;
    connections:
        n.g++ <--> s.g++;
}
`,
);
writeFileSync(
  join(proj, 'src', 'demo.msg'),
  `namespace demo;
// A demo packet.
packet DemoPkt { int seq; }
`,
);

function run(args, cwd = proj) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
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
function read(...parts) {
  return readFileSync(join(...parts), 'utf8');
}

try {
  // 1) default html run into <proj>/doc/neddoc
  const html = run([proj]);
  assert(html.code === 0, `expected exit 0, got ${html.code}: ${html.err}`);
  const out = join(proj, 'doc', 'neddoc');
  for (const f of ['index.html', 'packages.html', 'namespaces.html', 'assets/style.css', 'assets/neddoc.js']) {
    assert(existsSync(join(out, f)), `missing ${f}`);
  }
  const nodePage = read(out, 'types', 'demo.Node.html');
  assert(nodePage.includes('<a href="demo.Sink.html">Sink</a>'), '~Sink should link to the Sink page');
  assert(nodePage.includes('id="param-rate"'), 'parameters table row anchor missing');
  assert(nodePage.includes('transmission rate'), 'parameter description missing');
  assert(nodePage.includes('<b>Author:</b>'), '@author formatting missing');
  assert(nodePage.includes('<td>100bps</td>'), 'default value should be unwrapped in the table');
  const netPage = read(out, 'types', 'demo.Net.html');
  assert(/Unassigned submodule parameters/.test(netPage), 'unassigned parameters section missing');
  assert(existsSync(join(out, 'types', 'msg-demo--DemoPkt.html')), 'msg type page missing');
  // diagrams: type figure + usage/inheritance graphs, inlined into pages
  assert(existsSync(join(out, 'images', 'demo.Net-type.svg')), 'type figure svg missing');
  assert(existsSync(join(out, 'images', 'demo.Node-inheritance.svg')), 'inheritance svg missing');
  assert(netPage.includes('<div class="diagram"><svg'), 'inline diagram missing from page');
  const inhSvg = read(out, 'images', 'demo.Node-inheritance.svg');
  assert(inhSvg.includes('href="../types/demo.Sink.html"'), 'diagram node link missing');
  // Eclipse-style tag files for cross-project linking
  const nedtags = read(out, 'nedtags.xml');
  assert(nedtags.includes('<name>demo.Node</name>'), 'nedtags.xml entry missing');
  assert(nedtags.includes('<filename>types/demo.Node.html</filename>'), 'nedtags.xml filename wrong');
  const msgtags = read(out, 'msgtags.xml');
  assert(msgtags.includes('<name>DemoPkt</name>'), 'msgtags.xml entry missing');
  console.log('html run: OK');

  // 2) explicit -o, --title, --no-message-definitions
  const out2 = join(proj, 'docs2');
  const r2 = run(['-o', out2, '--title=Demo Docs', '--no-message-definitions', proj]);
  assert(r2.code === 0, `expected exit 0, got ${r2.code}: ${r2.err}`);
  assert(read(out2, 'index.html').includes('Demo Docs'), 'custom title missing');
  assert(!existsSync(join(out2, 'types', 'msg-demo--DemoPkt.html')), 'msg pages should be disabled');
  console.log('options run: OK');

  // 3) exclusions: -x src excludes everything -> pages exist but no type pages
  const out3 = join(proj, 'docs3');
  const r3 = run(['-o', out3, '-x', 'src', proj]);
  assert(r3.code === 0, `expected exit 0, got ${r3.code}: ${r3.err}`);
  assert(!existsSync(join(out3, 'types', 'demo.Node.html')), '-x should exclude the src dir');
  console.log('exclusion run: OK');

  // 4) markdown format
  const outMd = join(proj, 'docs-md');
  const rMd = run(['-o', outMd, '--format=markdown', proj]);
  assert(rMd.code === 0, `markdown run failed: ${rMd.err}`);
  assert(existsSync(join(outMd, 'SUMMARY.md')), 'SUMMARY.md missing');
  const mdNode = read(outMd, 'types', 'demo.Node.md');
  assert(mdNode.includes('[Sink](demo.Sink.md)'), 'md ~ref link missing');
  assert(mdNode.includes('| Name | Type | Default value | Description |'), 'md parameters table missing');
  console.log('markdown run: OK');

  // 5) rst format
  const outRst = join(proj, 'docs-rst');
  const rRst = run(['-o', outRst, '--format=rst', proj]);
  assert(rRst.code === 0, `rst run failed: ${rRst.err}`);
  const rstIndex = read(outRst, 'index.rst');
  assert(rstIndex.includes('.. toctree::'), 'rst toctree missing');
  const rstNode = read(outRst, 'types', 'demo.Node.rst');
  assert(rstNode.includes(':ref:`Sink <neddoc-demo-sink>`'), 'rst :ref: link missing');
  assert(rstNode.includes('.. list-table::'), 'rst list-table missing');
  console.log('rst run: OK');

  // 6) legacy-html format (Eclipse-compatible output)
  const outLegacy = join(proj, 'docs-legacy');
  const rLegacy = run(['-o', outLegacy, '--format=legacy-html', proj]);
  assert(rLegacy.code === 0, `legacy-html run failed: ${rLegacy.err}`);
  assert(existsSync(join(outLegacy, 'demo.Node.html')), 'legacy flat type page missing');
  assert(existsSync(join(outLegacy, 'demo-DemoPkt.html')), 'legacy msg page naming wrong');
  assert(existsSync(join(outLegacy, 'navtreedata.js')), 'navtreedata.js missing');
  assert(existsSync(join(outLegacy, 'jquery.js')), 'legacy template assets missing');
  const legacyNode = read(outLegacy, 'demo.Node.html');
  assert(legacyNode.includes('mdl-layout'), 'material template chrome missing');
  assert(legacyNode.includes('<h3 class="subtitle">Parameters</h3>'), 'legacy table heading missing');
  console.log('legacy-html run: OK');

  // 7) usage/runtime errors exit 2
  assert(run(['--format=bogus', proj]).code === 2, 'invalid --format should exit 2');
  assert(run(['--no-such-option', proj]).code === 2, 'unknown option should exit 2');
  assert(run([join(proj, 'nonexistent-dir')]).code === 2, 'missing project dir should exit 2');
  console.log('exit codes: OK');

  console.log('NEDDOC CLI SMOKE PASSED');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('NEDDOC CLI SMOKE ERROR:', e.message);
  cleanup();
  process.exit(1);
}
