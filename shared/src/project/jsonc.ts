// VS Code's settings and recommendation files are JSONC: JSON plus comments and
// trailing commas. These are the only extensions handled here.

/** End index (exclusive) of the string literal that starts at `i`. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const j = stringEnd(text, i);
      out += text.slice(i, j);
      i = j;
    } else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += text[i++];
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  const closer = /\s*[}\]]/y;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const j = stringEnd(text, i);
      out += text.slice(i, j);
      i = j;
    } else if (text[i] === ',' && ((closer.lastIndex = i + 1), closer.test(text))) {
      i++;
    } else {
      out += text[i++];
    }
  }
  return out;
}

/** Return `text` as plain JSON: comments become spaces, trailing commas are dropped. */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

/** Parse JSONC. Throws a SyntaxError like `JSON.parse` on malformed input. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
