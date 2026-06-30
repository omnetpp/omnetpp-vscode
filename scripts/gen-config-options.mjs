// Generates resources/config/opp-config-options.json by parsing the
// Register_*ConfigOption[U] macros in an OMNeT++ source tree. Deterministic and
// reproducible (no need to run opp_run). Usage:
//   bun scripts/gen-config-options.mjs [omnetppSrcDir]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(process.argv[2] ?? '/home/rhornig/w/omnetpp-dev');

const TYPE_MAP = {
  CFG_BOOL: 'bool',
  CFG_INT: 'int',
  CFG_DOUBLE: 'double',
  CFG_STRING: 'string',
  CFG_FILENAME: 'filename',
  CFG_FILENAMES: 'filenames',
  CFG_PATH: 'path',
  CFG_CUSTOM: 'custom',
};

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walkFiles(p);
    else if (/\.(cc|cpp|h|hpp)$/.test(name)) yield p;
  }
}

// Parse a C argument list starting right after the '('. Returns array of raw arg
// strings, splitting on top-level commas and respecting string literals/parens.
function parseArgs(text, start) {
  const args = [];
  let depth = 1;
  let cur = '';
  let i = start;
  let inStr = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === '\\') {
        cur += text[++i];
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        args.push(cur.trim());
        return { args, end: i + 1 };
      }
      cur += c;
    } else if (c === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  return { args, end: i };
}

// Decode a C string-literal arg (possibly adjacent-concatenated), or null for nullptr.
function decodeStr(arg) {
  if (arg === 'nullptr' || arg === 'NULL' || arg === '0') return null;
  let out = '';
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m;
  let matched = false;
  while ((m = re.exec(arg))) {
    matched = true;
    out += m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return matched ? out : arg;
}

const MACRO_RE = /Register_(Global|PerRun|PerObject)ConfigOption(U?)\s*\(/g;
const options = new Map();

for (const file of walkFiles(srcDir)) {
  const text = readFileSync(file, 'utf8');
  MACRO_RE.lastIndex = 0;
  let m;
  while ((m = MACRO_RE.exec(text))) {
    const scopeWord = m[1];
    const hasUnit = m[2] === 'U';
    const { args, end } = parseArgs(text, MACRO_RE.lastIndex);
    MACRO_RE.lastIndex = end;
    const isPerObject = scopeWord === 'PerObject';
    let idx = 1; // args[0] is the CFGID symbol
    const name = decodeStr(args[idx++]);
    if (!name) continue;
    let objectKind;
    if (isPerObject) objectKind = args[idx++];
    let type, unit;
    if (hasUnit) {
      unit = decodeStr(args[idx++]);
      type = 'double';
    } else {
      type = TYPE_MAP[args[idx++]] ?? 'custom';
    }
    const def = decodeStr(args[idx++]);
    const description = decodeStr(args[idx++]) ?? '';
    const scope = isPerObject ? 'per-object' : scopeWord === 'Global' ? 'global' : 'per-run';
    options.set(name, {
      name,
      type,
      ...(unit ? { unit } : {}),
      default: def,
      scope,
      ...(objectKind ? { objectKind: objectKind.replace(/^KIND_/, '') } : {}),
      description,
    });
  }
}

const sorted = [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = {
  generatedFrom: srcDir,
  optionCount: sorted.length,
  options: sorted,
};

const outDir = join(root, 'resources', 'config');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'opp-config-options.json');
writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${sorted.length} config options to ${outFile}`);
