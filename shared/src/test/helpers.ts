import { join, resolve } from 'node:path';
import { ParserService } from '../index';
import type { Position } from '../model/location';

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

/** Position of the first occurrence of `needle` (at its first char, or `offset` past it). */
export function posOf(text: string, needle: string, offset = 0): Position {
  const idx = text.indexOf(needle) + offset;
  const before = text.slice(0, idx);
  return { line: before.split('\n').length - 1, character: idx - (before.lastIndexOf('\n') + 1) };
}
