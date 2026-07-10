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

// Mirrors lsp MarkupContent (vscode-languageserver-types), the rich-text shape
// `documentation` can carry alongside the plain-string form.
export interface MarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}

export interface CompletionItem {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  documentation?: string | MarkupContent;
  insertText?: string;
  insertTextFormat?: InsertTextFormat;
  sortText?: string;
  /**
   * Opaque payload round-tripped through the LSP `completionItem/resolve`
   * request (mirrors lsp `CompletionItem.data`): a cheap tag set at
   * `textDocument/completion` time, read back by the server's
   * `onCompletionResolve` handler to lazily compute something expensive (e.g.
   * an icon preview) only for the single item the user is highlighting.
   */
  data?: unknown;
}
