import {
  DocumentSymbol,
  FoldingRange,
  nedDocumentSymbols,
  iniDocumentSymbols,
  treeFoldingRanges,
  iniFoldingRanges,
  msgDocumentSymbols,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';

export function computeDocumentSymbols(parsed: ParsedDocument): DocumentSymbol[] {
  if (parsed.language === 'ned' && parsed.tree) return nedDocumentSymbols(parsed.tree);
  if (parsed.language === 'msg' && parsed.tree) return msgDocumentSymbols(parsed.tree);
  if (parsed.language === 'ini' && parsed.ini) return iniDocumentSymbols(parsed.ini);
  return [];
}

export function computeFoldingRanges(parsed: ParsedDocument): FoldingRange[] {
  if (parsed.tree) return treeFoldingRanges(parsed.tree);
  if (parsed.ini) return iniFoldingRanges(parsed.ini);
  return [];
}
