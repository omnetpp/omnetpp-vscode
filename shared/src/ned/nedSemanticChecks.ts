import type { SyntaxNode } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { nodeRange } from '../parser/treeUtils';
import { NedResourceCache } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { topmostCompoundFq } from './nedNavigation';
import {
  NedTypeKind,
  extendsNodes,
  implementsNodes,
  submoduleInfo,
  submoduleNodes,
} from './nedAst';

function err(node: SyntaxNode, message: string, code: string, severity = DiagnosticSeverity.Error): Diagnostic {
  return { range: nodeRange(node), severity, message, source: 'omnetpp', code };
}

// Which base kinds are compatible with a derived kind.
function baseKindOk(derived: NedTypeKind, base: NedTypeKind): boolean {
  const moduleKinds: NedTypeKind[] = ['simple', 'compound', 'network'];
  switch (derived) {
    case 'simple':
      return base === 'simple';
    case 'compound':
    case 'network':
      return base === 'compound' || base === 'network';
    case 'channel':
      return base === 'channel';
    case 'moduleinterface':
      return base === 'moduleinterface';
    case 'channelinterface':
      return base === 'channelinterface';
    default:
      return moduleKinds.includes(base);
  }
}

function checkType(info: NedTypeInfo, cache: NedResourceCache, out: Diagnostic[]): void {
  const ctxEnclosing = info.isInnerType ? info.enclosingFqName : undefined;

  // extends
  for (const e of extendsNodes(info.node)) {
    const base = cache.lookupType(e.text, info.file, ctxEnclosing);
    if (!base) {
      out.push(err(e, `Unknown type '${e.text}'`, 'unknown-type'));
    } else if (!baseKindOk(info.kind, base.kind)) {
      out.push(
        err(e, `A ${info.kind} cannot extend a ${base.kind} ('${e.text}')`, 'bad-extends'),
      );
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
      if (sub.likeType && likeNode) {
        const iface = cache.lookupType(sub.likeType, info.file, enclosing);
        if (!iface) out.push(err(likeNode, `Unknown interface '${sub.likeType}'`, 'unknown-type'));
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
}

function childByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)!.type === type) return node.namedChild(i);
  }
  return null;
}

/** Cross-file NED semantic diagnostics for the types defined in `uri`. */
export function nedSemanticDiagnostics(cache: NedResourceCache, uri: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const info of cache.typesInFile(uri)) {
    checkType(info, cache, out);
  }
  return out;
}
