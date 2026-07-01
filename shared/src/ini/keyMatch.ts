// Low-level OMNeT++ key/pattern matching, shared by the module-tree expander and
// the INI param resolver. Kept dependency-free so `moduleTree.ts` can use it without
// importing `iniParamResolution.ts` (which imports `moduleTree.ts`).

/** Collapse vector indices to [] for pattern comparison. */
export function normIndices(s: string): string {
  return s.replace(/\[[^\]]*\]/g, '[]');
}

/** Compile an ini key (OMNeT++ wildcard pattern) to an anchored RegExp. */
export function iniKeyToRegex(key: string): RegExp {
  const norm = normIndices(key);
  let out = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*' && norm[i + 1] === '*') { out += '.*'; i++; }
    else if (c === '*') out += '[^.]*';
    else if (c === '?') out += '[^.]';
    else if (c === '[' && norm[i + 1] === ']') { out += '\\[\\]'; i++; }
    else if (/[a-zA-Z0-9_]/.test(c)) out += c;
    else out += '\\' + c;
  }
  return new RegExp('^' + out + '$');
}
