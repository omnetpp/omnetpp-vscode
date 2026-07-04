// Plain location types (LSP-compatible shape) so the core does not depend on the
// vscode-languageserver types directly.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

/** Whether `pos` lies within `r` (inclusive at both ends). */
export function posInRange(pos: Position, r: Range): boolean {
  if (pos.line < r.start.line || pos.line > r.end.line) return false;
  if (pos.line === r.start.line && pos.character < r.start.character) return false;
  if (pos.line === r.end.line && pos.character > r.end.character) return false;
  return true;
}

export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
}
