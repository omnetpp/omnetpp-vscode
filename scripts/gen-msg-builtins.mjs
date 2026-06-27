// Extracts built-in MSG/sim type names from an OMNeT++ sim_std.msg into
// resources/config/msg-builtin-types.json. Usage:
//   node scripts/gen-msg-builtins.mjs [omnetppSrcDir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(process.argv[2] ?? '/home/rhornig/w/omnetpp-dev');
const msgFile = join(srcDir, 'src', 'sim', 'sim_std.msg');

const text = readFileSync(msgFile, 'utf8');
const names = new Set();
const re = /^\s*(?:class|struct|message|packet|enum)\s+(?:noncobject\s+)?([A-Za-z_][\w:]*)/gm;
let m;
while ((m = re.exec(text))) {
  // skip qualified inner names like cComponent::SignalListenerList
  const name = m[1];
  names.add(name.includes('::') ? name : name);
}
// common typedefs/primitives often used and not declared as class
for (const t of ['simtime_t', 'msgid_t', 'txid_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'size_t', 'intval_t', 'uintval_t']) {
  names.add(t);
}

const sorted = [...names].sort();
const outDir = join(root, 'resources', 'config');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'msg-builtin-types.json');
writeFileSync(outFile, JSON.stringify({ generatedFrom: msgFile, types: sorted }, null, 2) + '\n');
console.log(`Wrote ${sorted.length} builtin MSG type names to ${outFile}`);
