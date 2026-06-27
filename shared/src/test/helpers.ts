import { join, resolve } from 'node:path';
import { ParserService } from '../index';

const repoRoot = resolve(__dirname, '..', '..', '..');
const wasmDir = join(repoRoot, 'resources', 'wasm');
const runtimeWasmDir = join(repoRoot, 'node_modules', 'web-tree-sitter');

let cached: Promise<ParserService> | undefined;

export function getParsers(): Promise<ParserService> {
  if (!cached) {
    cached = ParserService.create({
      runtimeWasmDir,
      nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
      msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
    });
  }
  return cached;
}
