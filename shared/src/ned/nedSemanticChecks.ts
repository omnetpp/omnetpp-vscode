import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { nodeRange, firstChildOfType } from '../parser/treeUtils';
import { NedResourceCache } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { topmostCompoundFq } from './nedNavigation';
import {
  ConnEndpoint,
  ConnectionInfo,
  NedTypeKind,
  extendsNodes,
  implementsNodes,
  submoduleInfo,
  submoduleNodes,
  typenamePatternsOf,
} from './nedAst';

function err(node: SyntaxNode, message: string, code: string, severity = DiagnosticSeverity.Error): Diagnostic {
  return { range: nodeRange(node), severity, message, source: 'omnetpp', code };
}

function checkType(info: NedTypeInfo, cache: NedResourceCache, out: Diagnostic[]): void {
  const ctxEnclosing = info.isInnerType ? info.enclosingFqName : undefined;

  // extends
  for (const e of extendsNodes(info.node)) {
    const base = cache.lookupType(e.text, info.file, ctxEnclosing);
    if (!base) {
      out.push(err(e, `Unknown type '${e.text}'`, 'unknown-type'));
    }
  }

  // implements (like interfaces)
  const wantInterfaceKind: NedTypeKind =
    info.kind === 'channel' || info.kind === 'channelinterface'
      ? 'channelinterface'
      : 'moduleinterface';
  for (const i of implementsNodes(info.node)) {
    const iface = cache.lookupType(i.text, info.file, ctxEnclosing);
    if (!iface) {
      out.push(err(i, `Unknown interface '${i.text}'`, 'unknown-type'));
    } else if (iface.kind !== 'moduleinterface' && iface.kind !== 'channelinterface') {
      out.push(err(i, `'${i.text}' is not an interface`, 'not-an-interface'));
    } else if (iface.kind !== wantInterfaceKind) {
      out.push(err(i, `'${i.text}' is not a ${wantInterfaceKind}`, 'bad-interface'));
    }
  }

  // submodule types — resolved in the topmost compound's scope (so inner types
  // declared in the enclosing top-level module are visible)
  for (const s of submoduleNodes(info.node)) {
    const sub = submoduleInfo(s);
    const enclosing = topmostCompoundFq(cache, s, info.file.uri) ?? info.fqName;
    if (sub.isLike) {
      // resolve interface name
      const likeNode = childByType(s, 'like_type');
      const iface = sub.likeType ? cache.lookupType(sub.likeType, info.file, enclosing) : undefined;
      if (sub.likeType && likeNode && !iface) {
        out.push(err(likeNode, `Unknown interface '${sub.likeType}'`, 'unknown-type'));
      }
      // ambiguous inline type: `<"X">` / `<default("X")>` where an unqualified X is
      // implemented by more than one type (OMNeT++ rejects it as ambiguous).
      const inline = sub.likeFixedType ?? sub.likeDefaultType;
      if (inline && iface && !inline.includes('.')) {
        const cands = cache.lookupLikeCandidates(inline, iface);
        if (cands.length > 1) {
          const anchor = firstChildOfType(s, 'like_expr') ?? likeNode ?? s;
          out.push(err(anchor, ambiguousMsg(inline, sub.likeType!, cands), 'ambiguous-typename', DiagnosticSeverity.Warning));
        }
      }
    } else if (sub.type) {
      const typeNode = childByType(s, 'type');
      const t = cache.lookupType(sub.type, info.file, enclosing);
      if (!t && typeNode) {
        out.push(err(typeNode, `Unknown type '${sub.type}'`, 'unknown-type'));
      } else if (t && !t.isModuleType() && typeNode) {
        out.push(err(typeNode, `'${sub.type}' is not a module type`, 'not-a-module'));
      }
    }
  }

  // ambiguous `<sub>.typename = "X"` deep assignments targeting a direct `like`
  // submodule (nested/wildcard patterns are not resolved statically — see plan).
  for (const tp of typenamePatternsOf(info.node)) {
    if (!tp.typeName || tp.typeName.includes('.') || /[.*[\]]/.test(tp.prefixPattern)) continue;
    const target = info.getSubmodule(tp.prefixPattern);
    if (!target?.isLike || !target.likeType) continue;
    const iface = cache.lookupType(target.likeType, info.file, info.fqName);
    if (!iface) continue;
    const cands = cache.lookupLikeCandidates(tp.typeName, iface);
    if (cands.length > 1) {
      const anchor = firstChildOfType(tp.node, 'value') ?? tp.node;
      out.push(err(anchor, ambiguousMsg(tp.typeName, target.likeType, cands), 'ambiguous-typename', DiagnosticSeverity.Warning));
    }
  }

  checkConnections(info, cache, out);
}

/** Message for an ambiguous unqualified `like` type name. */
function ambiguousMsg(name: string, ifaceName: string, candidates: NedTypeInfo[]): string {
  return `Ambiguous typename '${name}': ${candidates.length} types implement '${ifaceName}' (${candidates.map((t) => t.fqName).join(', ')}). Use a fully qualified name to disambiguate.`;
}

function childByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)!.type === type) return node.namedChild(i);
  }
  return null;
}

/**
 * The resolved type that owns an endpoint's gates: the compound itself for a
 * parent-gate endpoint, or the submodule's concrete type. Returns undefined when
 * the owner is opaque (unknown submodule, `like` submodule, or unresolved type) —
 * in which case the endpoint is intentionally not validated.
 */
function endpointOwner(
  info: NedTypeInfo,
  cache: NedResourceCache,
  ep: ConnEndpoint,
): NedTypeInfo | undefined {
  if (!ep.module) return info; // the compound's own gate
  const sub = info.getSubmodule(ep.module);
  if (!sub || sub.isLike || !sub.type) return undefined;
  const enclosing = topmostCompoundFq(cache, ep.node, info.file.uri) ?? info.fqName;
  return cache.lookupType(sub.type, info.file, enclosing);
}

/** Whether a gate of the given direction may act in `role` at this endpoint. */
function gateRoleOk(gateType: string | undefined, role: 'source' | 'dest', isParent: boolean): boolean {
  if (!gateType || gateType === 'inout') return true; // unknown / bidirectional: don't flag
  // submodule: output is a source, input is a sink. parent gate: inverted.
  const sourceDir = isParent ? 'input' : 'output';
  const destDir = isParent ? 'output' : 'input';
  return role === 'source' ? gateType === sourceDir : gateType === destDir;
}

function checkEndpoint(
  info: NedTypeInfo,
  cache: NedResourceCache,
  ep: ConnEndpoint,
  role: 'source' | 'dest',
  out: Diagnostic[],
): void {
  const owner = endpointOwner(info, cache, ep);
  if (!owner) return; // opaque endpoint — conservatively unchecked
  const gate = owner.gates().get(ep.gate);
  const at = ep.gateNameNode ?? ep.node;
  if (!gate) {
    out.push(err(at, `Unknown gate '${ep.gate}' on '${owner.fqName}'`, 'unknown-gate'));
    return;
  }
  if ((ep.gateIndex !== undefined || ep.gatePlusplus) && !gate.isVector) {
    out.push(err(at, `Gate '${ep.gate}' is not a vector gate`, 'gate-index-on-scalar'));
  }
  // `$i`/`$o` selectors already pick a direction; skip those for direction checks
  if (!ep.subgate && !gateRoleOk(gate.type, role, !ep.module)) {
    out.push(
      err(at, `Gate '${ep.gate}' (${gate.type}) cannot be used as a connection ${role}`, 'gate-direction-mismatch'),
    );
  }
}

function checkConnections(info: NedTypeInfo, cache: NedResourceCache, out: Diagnostic[]): void {
  if (info.kind !== 'compound' && info.kind !== 'network') return;
  for (const conn of info.localConnections()) {
    checkChannel(info, cache, conn, out);
    // direction roles: `-->` src→dest, `<--` is dest←src; skip `<-->`
    if (conn.direction === '-->') {
      checkEndpoint(info, cache, conn.src, 'source', out);
      checkEndpoint(info, cache, conn.dest, 'dest', out);
    } else if (conn.direction === '<--') {
      checkEndpoint(info, cache, conn.src, 'dest', out);
      checkEndpoint(info, cache, conn.dest, 'source', out);
    } else {
      // bidirectional: only validate gate existence / vectorness, not direction
      checkEndpointExistence(info, cache, conn.src, out);
      checkEndpointExistence(info, cache, conn.dest, out);
    }
  }
}

function checkEndpointExistence(
  info: NedTypeInfo,
  cache: NedResourceCache,
  ep: ConnEndpoint,
  out: Diagnostic[],
): void {
  const owner = endpointOwner(info, cache, ep);
  if (!owner) return;
  const gate = owner.gates().get(ep.gate);
  const at = ep.gateNameNode ?? ep.node;
  if (!gate) {
    out.push(err(at, `Unknown gate '${ep.gate}' on '${owner.fqName}'`, 'unknown-gate'));
  } else if ((ep.gateIndex !== undefined || ep.gatePlusplus) && !gate.isVector) {
    out.push(err(at, `Gate '${ep.gate}' is not a vector gate`, 'gate-index-on-scalar'));
  }
}

function checkChannel(
  info: NedTypeInfo,
  cache: NedResourceCache,
  conn: ConnectionInfo,
  out: Diagnostic[],
): void {
  const ch = conn.channel;
  if (!ch || !ch.typeName || !ch.typeNode) return;
  // skip `like`-typed channels (concrete type chosen at runtime)
  if (firstChildOfType(conn.node, 'like_type')) return;
  const enclosing = topmostCompoundFq(cache, conn.node, info.file.uri) ?? info.fqName;
  const t = cache.lookupType(ch.typeName, info.file, enclosing);
  if (!t) {
    out.push(err(ch.typeNode, `Unknown channel type '${ch.typeName}'`, 'unknown-channel-type'));
  } else if (t.kind !== 'channel' && t.kind !== 'channelinterface') {
    out.push(err(ch.typeNode, `'${ch.typeName}' is not a channel type`, 'not-a-channel'));
  }
}

/** Cross-file NED semantic diagnostics for the types defined in `uri`. */
export function nedSemanticDiagnostics(cache: NedResourceCache, uri: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const info of cache.typesInFile(uri)) {
    checkType(info, cache, out);
  }
  return out;
}
