import type { SyntaxNode } from 'web-tree-sitter';
import type { MsgFileInfo, MsgResourceCache } from './msgResourceCache';
import { MsgFieldInfo, msgExtendsNode, msgFieldInfo, msgFieldNodes } from './msgAst';

export type MsgKind = 'class' | 'struct' | 'message' | 'packet' | 'enum';

/** Runtime info for a MSG-defined type. */
export class MsgTypeInfo {
  constructor(
    public readonly cache: MsgResourceCache,
    public readonly fqName: string, // namespace::Simple (or Simple)
    public readonly simpleName: string,
    public readonly namespace: string,
    public readonly kind: MsgKind,
    public readonly node: SyntaxNode,
    public readonly file: MsgFileInfo,
  ) {}

  extendsName(): string | undefined {
    return msgExtendsNode(this.node)?.text;
  }

  superType(): MsgTypeInfo | undefined {
    const base = this.extendsName();
    return base ? this.cache.lookupType(base, this.namespace) : undefined;
  }

  localFields(): MsgFieldInfo[] {
    if (this.kind === 'enum') return [];
    return msgFieldNodes(this.node).map(msgFieldInfo);
  }

  /** Fields including inherited (base first). */
  fields(): MsgFieldInfo[] {
    const chain: MsgTypeInfo[] = [];
    let cur = this.superType();
    const seen = new Set<string>([this.fqName]);
    while (cur && !seen.has(cur.fqName)) {
      seen.add(cur.fqName);
      chain.unshift(cur);
      cur = cur.superType();
    }
    const out: MsgFieldInfo[] = [];
    for (const t of chain) out.push(...t.localFields());
    out.push(...this.localFields());
    return out;
  }
}
