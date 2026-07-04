import { TextEdit, FormatOptions, formatDocumentEdits } from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';

export function computeFormatting(parsed: ParsedDocument, opts: FormatOptions): TextEdit[] {
  if (parsed.language !== 'ned' && parsed.language !== 'msg') return [];
  return formatDocumentEdits(parsed.text, parsed.tree, opts);
}
