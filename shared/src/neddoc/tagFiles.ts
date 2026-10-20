/**
 * The machine-readable nedtags.xml / msgtags.xml tag files that the Eclipse
 * generator emits alongside the documentation (generateNedTagFile /
 * generateMsgTagFile): doxygen-tagfile-style listings of every documented
 * type and its page, used to cross-link documentation between projects.
 * Every compound stays kind="class" so doxygen-tagfile readers keep working;
 * the NED/MSG kind of the type (simple, compound, network, channel,
 * moduleinterface, channelinterface; message, packet, class, struct, enum)
 * is in the extra `typekind` attribute.
 */

import type { DocModel } from './docModel';
import type { NeddocRenderer } from './renderer';

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tagFile(entries: { name: string; filename: string; typeKind?: string }[]): string {
  const compounds = entries.map(
    (e) =>
      `  <compound kind="class"${e.typeKind ? ` typekind="${escapeXml(e.typeKind)}"` : ''}>\n` +
      `    <name>${escapeXml(e.name)}</name>\n` +
      `    <filename>${escapeXml(e.filename)}</filename>\n` +
      `  </compound>\n`,
  );
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<tagfile>\n${compounds.join('')}</tagfile>\n`;
}

/** nedtags.xml: every NED type under its qualified name (as in Eclipse; a
 *  default-package type appears under its simple name). */
export function nedTagFile(model: DocModel, renderer: NeddocRenderer): string {
  const entries = model.pages
    .filter((p) => p.ref.kind === 'nedtype')
    // NED page ids are the fq names (no :: mapping involved)
    .map((p) => ({ name: p.ref.id, filename: renderer.pagePath(p.ref), typeKind: p.typeKind }));
  return tagFile(entries);
}

/** msgtags.xml: every MSG type under its simple name (as in Eclipse). */
export function msgTagFile(model: DocModel, renderer: NeddocRenderer): string {
  const entries = model.pages
    .filter((p) => p.ref.kind === 'msgtype')
    .map((p) => ({ name: p.ref.title, filename: renderer.pagePath(p.ref), typeKind: p.typeKind }));
  return tagFile(entries);
}
