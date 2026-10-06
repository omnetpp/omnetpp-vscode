import type { Tree, Node as SyntaxNode } from 'web-tree-sitter';
import { ResourceCacheBase } from '../model/resourceCacheBase';
import { NedTypeInfo } from './nedTypeInfo';
import {
  fileNamespace,
  filePackage,
  fileImports,
  innerTypes,
  isTypeNode,
  nameNode,
  topLevelTypes,
  typeKind,
} from './nedAst';

export interface NedFileInfo {
  uri: string;
  packageName: string;
  imports: string[];
  tree: Tree;
}

/** The built-in NED declarations (channels + channel interfaces), package "ned". */
export const BUILTIN_NED_TEXT = `package ned;
@namespace(omnetpp);

channel IdealChannel { @class(cIdealChannel); }
channel DelayChannel {
    @class(cDelayChannel);
    bool disabled = default(false);
    double delay = default(0s) @unit(s);
}
channel DatarateChannel {
    @class(cDatarateChannel);
    bool disabled = default(false);
    double delay = default(0s) @unit(s);
    double datarate = default(0bps) @unit(bps);
    double ber = default(0);
    double per = default(0);
}
moduleinterface IBidirectionalChannel { gates: inout a; inout b; }
moduleinterface IUnidirectionalChannel { gates: input i; output o; }
`;

export const BUILTIN_URI = 'omnetpp-builtin:ned';

/**
 * Project-wide index of NED types. Mirrors the C++ NedResourceCache
 * (src/nedxml/nedresourcecache.{h,cc}): stores types by fully-qualified name
 * and resolves unqualified names with the exact precedence (inner type → exact
 * import → same package → wildcard import), and fully-qualified names directly.
 *
 * File/type storage, tree ownership, and the generation contract live in
 * {@link ResourceCacheBase}.
 */
export class NedResourceCache extends ResourceCacheBase<NedFileInfo, NedTypeInfo> {
  /** Per-generation memo of lookupLikeCandidates (a full type-table scan otherwise,
   *  hit once per `like`-submodule per module instance during expansion). */
  private likeCandidatesMemo = new Map<string, NedTypeInfo[]>();
  private likeCandidatesMemoGen = -1;
  private packageNedFiles = new Map<string, NedFileInfo>();
  private packageNedFilesGen = -1;

  /**
   * Register/replace a file's NED types.
   * @param folderPackage package derived from folder structure, used when the
   *        file declares no `package` statement.
   */
  addFile(uri: string, tree: Tree, folderPackage = ''): void {
    const declared = filePackage(tree);
    const file: NedFileInfo = {
      uri,
      packageName: declared || folderPackage,
      imports: fileImports(tree),
      tree,
    };
    this.replaceFileEntry(file, () => {
      const registered: string[] = [];
      for (const t of topLevelTypes(tree)) {
        this.registerType(t, file, file.packageName, false, undefined, registered);
      }
      return registered;
    });
  }

  private registerType(
    node: SyntaxNode,
    file: NedFileInfo,
    enclosingFqOrPackage: string,
    isInner: boolean,
    enclosingFqName: string | undefined,
    registered: string[],
  ): void {
    const simple = nameNode(node)?.text;
    if (!simple) return;
    const fqName = enclosingFqOrPackage ? `${enclosingFqOrPackage}.${simple}` : simple;
    const info = new NedTypeInfo(
      this,
      fqName,
      simple,
      isInner ? (enclosingFqName ?? '') : file.packageName,
      typeKind(node),
      node,
      file,
      isInner,
      enclosingFqName,
    );
    this.registerTypeInfo(file.uri, fqName, info);
    registered.push(fqName);
    // inner types live directly under this (compound) type
    for (const inner of innerTypes(node)) {
      if (isTypeNode(inner))
        this.registerType(inner, file, fqName, true, fqName, registered);
    }
  }

  /**
   * The C++ namespace of the types in a file, as the kernel's
   * `NedTypeInfo::getCxxNamespace()` resolves it: the file's own `@namespace`,
   * else the one in the `package.ned` of its package or the nearest parent
   * package. Empty when none declares it.
   */
  cxxNamespace(file: NedFileInfo): string {
    const own = fileNamespace(file.tree);
    if (own) return own;
    if (this.packageNedFilesGen !== this.generation) {
      this.packageNedFiles.clear();
      for (const f of this.files.values())
        if (isPackageNedUri(f.uri)) this.packageNedFiles.set(f.packageName, f);
      this.packageNedFilesGen = this.generation;
    }
    let pkg = file.packageName;
    while (true) {
      const pf = this.packageNedFiles.get(pkg);
      const ns = pf && fileNamespace(pf.tree);
      if (ns) return ns;
      if (!pkg) return '';
      const dot = pkg.lastIndexOf('.');
      pkg = dot >= 0 ? pkg.slice(0, dot) : '';
    }
  }

  /** Direct subtypes: types that directly extend or implement `fqName`. */
  directSubtypesOf(fqName: string): NedTypeInfo[] {
    const out: NedTypeInfo[] = [];
    for (const t of this.types.values()) {
      if (t.fqName === fqName) continue;
      if (t.directSupertypes().some((s) => s.fqName === fqName)) out.push(t);
    }
    return out;
  }

  /** All transitive subtypes of a type (types having `fqName` among ancestors). */
  subtypesOf(fqName: string): NedTypeInfo[] {
    const out: NedTypeInfo[] = [];
    for (const t of this.types.values()) {
      if (t.fqName === fqName) continue;
      if (t.ancestors().some((a) => a.fqName === fqName)) out.push(t);
    }
    return out;
  }

  /**
   * Resolve a NED type name in a lookup context, following NED precedence.
   * @param enclosingFqName fq-name of the enclosing (topmost) compound module,
   *        for unqualified inner-type resolution.
   */
  lookupType(
    name: string,
    file: NedFileInfo,
    enclosingFqName?: string,
  ): NedTypeInfo | undefined {
    if (name.includes('.')) {
      // fully-qualified
      return this.types.get(name);
    }

    // (a) inner type
    if (enclosingFqName) {
      const inner = this.types.get(`${enclosingFqName}.${name}`);
      if (inner) return inner;
    }

    // (b) exactly imported type
    const dotName = '.' + name;
    for (const imp of file.imports) {
      if (this.types.has(imp) && (imp.endsWith(dotName) || imp === name)) {
        return this.types.get(imp);
      }
    }

    // (c) same package
    const samePkg = file.packageName ? `${file.packageName}.${name}` : name;
    const sp = this.types.get(samePkg);
    if (sp) return sp;

    // (d) wildcard import
    for (const imp of file.imports) {
      if (!imp.includes('*')) continue;
      const re = importToRegex(imp);
      for (const [qn, info] of this.types) {
        if ((qn.endsWith(dotName) || qn === name) && re.test(qn)) return info;
      }
    }
    return undefined;
  }

  /**
   * All types that could satisfy `<name> like <iface>`, matching OMNeT++'s
   * `findTypeWithInterface`: a fully-qualified name yields the single named type iff
   * it implements the interface; an unqualified (simple) name yields every loaded type
   * (inner types included) whose simple name matches and which implements the interface
   * (transitively). Callers pick the winner (exactly one) or report ambiguity (>1).
   */
  lookupLikeCandidates(name: string, iface: NedTypeInfo | undefined): NedTypeInfo[] {
    if (this.likeCandidatesMemoGen !== this.generation) {
      this.likeCandidatesMemo.clear();
      this.likeCandidatesMemoGen = this.generation;
    }
    const memoKey = `${name}|${iface?.fqName ?? ''}`;
    const cached = this.likeCandidatesMemo.get(memoKey);
    if (cached) return cached;
    const implementsIface = (t: NedTypeInfo) =>
      !iface || t.allInterfaces().some((i) => i.fqName === iface.fqName);
    let candidates: NedTypeInfo[];
    if (name.includes('.')) {
      const t = this.types.get(name);
      candidates = t && implementsIface(t) ? [t] : [];
    } else {
      candidates = [];
      for (const t of this.types.values()) {
        if (t.simpleName !== name) continue;
        if (implementsIface(t)) candidates.push(t);
      }
    }
    this.likeCandidatesMemo.set(memoKey, candidates);
    return candidates;
  }

  /**
   * Resolve a `like` interface implementation to its single unambiguous concrete type:
   * the sole {@link lookupLikeCandidates} match, or `undefined` when there are none or
   * several (ambiguous — callers may surface a diagnostic).
   */
  lookupLikeType(name: string, iface: NedTypeInfo | undefined): NedTypeInfo | undefined {
    const candidates = this.lookupLikeCandidates(name, iface);
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}

export function isPackageNedUri(uri: string): boolean {
  return uri === 'package.ned' || uri.endsWith('/package.ned');
}

/**
 * Convert a NED import spec with wildcards to an anchored RegExp.
 * Ported from: ui/org.omnetpp.ned.model/src/org/omnetpp/ned/model/ex/NedElementUtilEx.java,
 * `importToRegex` (identical transform: `.` → `\.`, `**` → `.*`, `*` → `[^.]*`).
 */
export function importToRegex(spec: string): RegExp {
  let out = '';
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '.') out += '\\.';
    else if (c === '*' && spec[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') out += '[^.]*';
    else if (/[a-zA-Z0-9_]/.test(c)) out += c;
    else out += '\\' + c;
  }
  return new RegExp('^' + out + '$');
}
