// Browser-safe entry point for the NED preview webview bundle. It exposes
// ONLY the display-string instance model and the pure graphics math — none of
// the parser/index machinery — so an esbuild browser bundle of this subpath
// stays small and free of web-tree-sitter/Node dependencies. (shared/out is
// CJS, which esbuild cannot tree-shake; hence the curated entry instead of
// the main barrel.) The PreviewScene DTO types come type-only from
// '@omnetpp/shared/protocol'.
export {
  DisplayString,
  Prop,
  ANTIVALUE,
  EMPTY_DEFAULTS,
  VARIABLE_DEFAULTS,
  parseDisplayString,
  displayStringFromChain,
  enumNameFor,
  type DisplayProp,
  type DisplayPropName,
  type DimensionF,
  type PointF,
} from './ned/displayStringModel';
export { NAMED_COLORS, parseColor, colorNames } from './graphics/colors';
export { LcgRandom, BasicSpringEmbedderLayout, type SpringEmbedderOptions } from './graphics/springEmbedder';
export { arrowcoords, type Pt, type Rect, type RoutingConstraint, type RoutingDir } from './graphics/arrowcoords';
