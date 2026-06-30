import type { Position } from '../model/location';

/** Where a resolved doc cross-reference points: a file and the symbol's position. */
export interface DocRefTarget {
  uri: string;
  pos: Position;
}

/** Resolves a (possibly qualified) type name appearing in a doc comment. */
export type DocRefResolver = (name: string) => DocRefTarget | undefined;

/**
 * OMNeT++ NED/MSG doc comments mark cross-references to other types with a
 * leading tilde (`~OtherType`, qualified `~pkg.Type` or `~ns::Type`). Render
 * each ref that `resolve` can locate as a markdown link to its declaration —
 * VS Code's `file://…#L<line>,<col>` form opens the file at the symbol. The
 * tilde is markup, so it never appears in the rendered text; refs that don't
 * resolve degrade to the bare name.
 */
export function linkifyDocRefs(doc: string, resolve: DocRefResolver): string {
  return doc.replace(
    /~([A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*)/g,
    (_whole, name: string) => {
      const t = resolve(name);
      if (!t) return name;
      return `[${name}](${t.uri}#L${t.pos.line + 1},${t.pos.character + 1})`;
    },
  );
}
