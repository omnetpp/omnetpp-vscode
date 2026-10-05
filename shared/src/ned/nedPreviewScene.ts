import type { Range } from '../model/location';
import { NedResourceCache } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { ConnectionInfo, NedTypeKind, SubmoduleInfo, nameNode } from './nedAst';
import { Prop, displayStringFromChain, displayStringLiteralOf } from './displayStringModel';
import { firstChildOfType, nodeRange } from '../parser/treeUtils';

export { displayStringFromChain };

/**
 * The serializable scene model of the graphical NED preview: everything the
 * webview needs to draw a type the way the Eclipse IDE's graphical editor
 * does. Geometry (layout, routing) is intentionally NOT computed here — it
 * needs real icon pixel sizes, so it happens in the webview. Display strings
 * are shipped as fallback *chains* (nearest-first raw values); the webview
 * rebuilds the same `DisplayString` resolution the IDE uses via
 * {@link displayStringFromChain}.
 */

export interface PreviewSubmodule {
  name: string;
  /** The `[size]` expression text for vector submodules (label: `name[size]`). */
  vectorSize?: string;
  /** Simple name of the supertype this submodule is inherited from, if any. */
  inheritedFrom?: string;
  isLike: boolean;
  /** The declared type / `like` interface name, as written (for tooltips). */
  typeName?: string;
  /** The resolved concrete type (through `like` + typename patterns), if any. */
  resolvedTypeFqName?: string;
  /** Display-string fallback chain: own `@display` first, then the resolved
   *  type's chain (supertype order), missing entries skipped. */
  displayChain: string[];
  declUri: string;
  declRange: Range;
  typeUri?: string;
  typeRange?: Range;
}

export interface PreviewConnection {
  /** Source submodule name; undefined ⇒ the compound module's own gate. */
  srcModule?: string;
  srcGate: string;
  /** Destination submodule name; undefined ⇒ the compound module's own gate. */
  destModule?: string;
  destGate: string;
  bidirectional: boolean;
  /** Enclosing `for` loop specs (`i=0..n-1`); non-empty ⇒ the `⦀` midpoint marker. */
  loops: string[];
  /** `if` condition expressions; non-empty ⇒ the `?` midpoint marker. */
  conditions: string[];
  /** Simple name of the supertype this connection is inherited from, if any. */
  inheritedFrom?: string;
  /** The channel type name, as written (for tooltips), if any. */
  channelTypeName?: string;
  /** Chain: connection's own `@display`, then the channel type's chain. */
  displayChain: string[];
  declUri: string;
  declRange: Range;
}

/** An icon referenced by the scene (`i`, `i2` or `bgi` after resolution). */
export interface PreviewIcon {
  id: string;
  /** File-variant suffix from the `is` tag (`vs`/`s`/`l`/`vl`), if any. */
  sizeSuffix?: string;
}

export interface PreviewScene {
  kind: NedTypeKind;
  fqName: string;
  simpleName: string;
  isNetwork: boolean;
  typeUri: string;
  typeRange?: Range;
  /** The type's own display chain (background props for compound diagrams,
   *  icon/shape props for the non-compound "card" rendering). */
  displayChain: string[];
  /** Diagram content — present for compound/network types only. */
  submodules?: PreviewSubmodule[];
  connections?: PreviewConnection[];
  /** All icon ids referenced anywhere in the scene (for URI prefetching). */
  icons: PreviewIcon[];
}

/** Map the `is` tag's canonical enum name to the icon file-variant suffix. */
const SIZE_SUFFIX: Record<string, string> = {
  'very small': 'vs', small: 's', large: 'l', 'very large': 'vl',
};

/** The type's own display chain: its `@display` and its ancestors', nearest first. */
function typeDisplayChain(type: NedTypeInfo | undefined): string[] {
  const chain: string[] = [];
  for (const t of type ? [type, ...type.ancestors()] : []) {
    const value = displayStringLiteralOf(t.node);
    if (value !== undefined) chain.push(value);
  }
  return chain;
}

/**
 * Resolve a submodule's concrete type the way OMNeT++ does for the type-level
 * (editor) view: a plain type reference directly; a `like` slot through the
 * precedence fixed `<"X">` bracket → non-default `<sub>.typename` pattern
 * (last/most-derived wins) → default pattern (first wins) → `<default("X")>`
 * bracket. INI typename bindings don't exist at the type level.
 */
export function resolveSubmoduleType(
  cache: NedResourceCache,
  focus: NedTypeInfo,
  declOwner: NedTypeInfo,
  sub: SubmoduleInfo,
): NedTypeInfo | undefined {
  if (!sub.isLike) {
    return sub.type ? cache.lookupType(sub.type, declOwner.file, declOwner.fqName) : undefined;
  }
  const iface = sub.likeType ? cache.lookupType(sub.likeType, declOwner.file, declOwner.fqName) : undefined;

  const matches = (prefixPattern: string): boolean => {
    const base = prefixPattern.replace(/\[[^\]]*\]/g, '');
    return base === sub.name; // only direct (non-deep) patterns apply at this level
  };
  let name: string | undefined = sub.likeFixedType;
  if (name === undefined) {
    for (const p of focus.typenamePatterns()) {
      if (!p.isDefault && p.typeName && matches(p.prefixPattern)) name = p.typeName;
    }
  }
  if (name === undefined) {
    name = focus.typenamePatterns().find((p) => p.isDefault && p.typeName && matches(p.prefixPattern))?.typeName;
  }
  if (name === undefined) name = sub.likeDefaultType;
  if (name === undefined) return iface;
  return cache.lookupLikeType(name, iface) ?? cache.lookupType(name, declOwner.file, declOwner.fqName) ?? iface;
}

/** Collect the icons an element's resolved display refers to. */
function collectIcons(chain: string[], icons: Map<string, PreviewIcon>, background: boolean): void {
  const ds = displayStringFromChain(chain);
  const sizeName = ds.getAsEnum(Prop.IMAGE_SIZE);
  const sizeSuffix = sizeName ? SIZE_SUFFIX[sizeName] : undefined;
  const add = (id: string, suffix?: string): void => {
    if (id) icons.set(`${id}|${suffix ?? ''}`, { id, sizeSuffix: suffix });
  };
  if (background) {
    add(ds.getAsString(Prop.MODULE_IMAGE));
  } else {
    add(ds.getAsString(Prop.IMAGE), sizeSuffix);
    add(ds.getAsString(Prop.IMAGE2));
  }
}

/** The text of a submodule's `[size]` vector specifier, without brackets. */
function vectorSizeText(sub: SubmoduleInfo): string | undefined {
  if (!sub.isVector) return undefined;
  const vector = firstChildOfType(sub.node, 'vector');
  return vector ? vector.text.replace(/^\[|\]$/g, '').trim() : '';
}

/** Build the preview scene for a NED type (diagram for compound, card otherwise). */
export function buildPreviewScene(cache: NedResourceCache, type: NedTypeInfo): PreviewScene {
  const icons = new Map<string, PreviewIcon>();
  const displayChain = typeDisplayChain(type);
  const nn = nameNode(type.node);

  const scene: PreviewScene = {
    kind: type.kind,
    fqName: type.fqName,
    simpleName: type.simpleName,
    isNetwork: type.isNetworkType(),
    typeUri: type.file.uri,
    typeRange: nn ? nodeRange(nn) : undefined,
    displayChain,
    icons: [],
  };

  const isCompound = type.kind === 'compound' || type.kind === 'network';
  if (!isCompound) {
    // non-compound "card": the type's own icon/shape
    collectIcons(displayChain, icons, false);
    scene.icons = [...icons.values()];
    return scene;
  }

  collectIcons(displayChain, icons, true); // bgi

  // submodules (inherited + local, base-first like the IDE's merged view)
  const submodules: PreviewSubmodule[] = [];
  for (const [name, sub] of type.submodules()) {
    const decl = type.submoduleDecl(name);
    const declOwner = decl?.owner ?? type;
    const resolved = resolveSubmoduleType(cache, type, declOwner, sub);
    const chain: string[] = [];
    const own = displayStringLiteralOf(sub.node);
    if (own !== undefined) chain.push(own);
    chain.push(...typeDisplayChain(resolved));
    collectIcons(chain, icons, false);

    const typeNameNode = resolved ? nameNode(resolved.node) : undefined;
    const declName = nameNode(sub.node) ?? sub.node;
    submodules.push({
      name,
      vectorSize: vectorSizeText(sub),
      inheritedFrom: declOwner !== type ? declOwner.simpleName : undefined,
      isLike: sub.isLike,
      typeName: sub.isLike ? sub.likeType : sub.type,
      resolvedTypeFqName: resolved?.fqName,
      displayChain: chain,
      declUri: declOwner.file.uri,
      declRange: nodeRange(declName),
      typeUri: resolved?.file.uri,
      typeRange: resolved && typeNameNode ? nodeRange(typeNameNode) : undefined,
    });
  }

  // connections (inherited + local, base-first), with per-owner declaration info
  const connections: PreviewConnection[] = [];
  const owners = [...[...type.ancestors()].reverse(), type];
  for (const owner of owners) {
    for (const conn of owner.localConnections()) {
      connections.push(buildConnection(cache, type, owner, conn, icons));
    }
  }

  scene.submodules = submodules;
  scene.connections = connections;
  scene.icons = [...icons.values()];
  return scene;
}

function buildConnection(
  cache: NedResourceCache,
  focus: NedTypeInfo,
  owner: NedTypeInfo,
  conn: ConnectionInfo,
  icons: Map<string, PreviewIcon>,
): PreviewConnection {
  const channelType = conn.channel?.typeName
    ? cache.lookupType(conn.channel.typeName, owner.file, owner.fqName)
    : undefined;
  const chain: string[] = [];
  const own = displayStringLiteralOf(conn.node);
  if (own !== undefined) chain.push(own);
  chain.push(...typeDisplayChain(channelType));

  return {
    srcModule: conn.src.module,
    srcGate: conn.src.gate,
    destModule: conn.dest.module,
    destGate: conn.dest.gate,
    bidirectional: conn.direction === '<-->',
    loops: conn.loops.map((l) => `${l.paramName}=${l.from}..${l.to}`),
    conditions: conn.conditions,
    inheritedFrom: owner !== focus ? owner.simpleName : undefined,
    channelTypeName: conn.channel?.typeName,
    displayChain: chain,
    declUri: owner.file.uri,
    declRange: nodeRange(conn.node),
  };
}

// re-exported so the (future) fq-name-based preview request can share the logic
export function previewSceneByFq(cache: NedResourceCache, fqName: string): PreviewScene | undefined {
  const type = cache.getType(fqName);
  return type ? buildPreviewScene(cache, type) : undefined;
}
