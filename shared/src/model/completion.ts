// Mirrors lsp CompletionItemKind numeric values (subset).
export enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  Struct = 22,
  EnumMember = 20,
}

// Mirrors lsp InsertTextFormat.
export enum InsertTextFormat {
  PlainText = 1,
  Snippet = 2,
}

export interface CompletionItem {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: InsertTextFormat;
  sortText?: string;
}
