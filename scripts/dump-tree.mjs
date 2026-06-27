// Dumps the named-node tree of a NED/MSG snippet for grammar exploration.
//   node scripts/dump-tree.mjs ned "simple Foo {}"
//   node scripts/dump-tree.mjs ned-file path/to/file.ned
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { ParserService } = require(join(root, 'shared', 'out', 'index.js'));

const mode = process.argv[2];
const arg = process.argv[3];
const grammar = mode.startsWith('msg') ? 'msg' : 'ned';
const text = mode.endsWith('-file') ? readFileSync(arg, 'utf8') : arg;

const wasmDir = join(root, 'resources', 'wasm');
const svc = await ParserService.create({
  runtimeWasmDir: join(root, 'node_modules', 'web-tree-sitter'),
  nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
  msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
});

const tree = svc.parse(grammar, text);

function dump(node, depth) {
  const indent = '  '.repeat(depth);
  const snippet = node.namedChildCount === 0 ? ` "${node.text.replace(/\n/g, '\\n').slice(0, 40)}"` : '';
  console.log(`${indent}${node.type}${snippet}`);
  for (let i = 0; i < node.namedChildCount; i++) dump(node.namedChild(i), depth + 1);
}
dump(tree.rootNode, 0);
