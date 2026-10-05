// Submodule arrangement ("p" tag arrangement + "g" layout group).
// Port of CompoundModuleLayout.getArrangementOffset() and
// SubmoduleFigure.makeVectorArrangementParameters() from the OMNeT++ IDE
// (ui/org.omnetpp.figures).

import { DisplayString, Prop } from '../ned/displayStringModel';
import type { Pt } from './arrowcoords';

export type Arrangement = 'none' | 'exact' | 'row' | 'column' | 'matrix' | 'ring' | 'cring';

/** Arrangement parameters; NaN / -1 mean "not specified". */
export interface ArrangementSpec {
  arrangement: Arrangement;
  x: number;
  y: number;
  dx: number;
  dy: number;
  n: number;
}

/**
 * Spacing assumed between group/vector items when the arrangement does not specify one.
 * Fixed rather than derived from the shape size, because items of different sizes would
 * produce strange arrangements.
 */
export const DEFAULT_ARRANGEMENT_SPACING = 80;

const ARRANGEMENTS: readonly Arrangement[] = ['exact', 'row', 'column', 'matrix', 'ring', 'cring'];

function parseFloatPar(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}

function parseIntPar(value: string): number {
  return /^\s*[+-]?\d+\s*$/.test(value) ? parseInt(value, 10) : -1;
}

export function arrangementOf(ds: DisplayString): ArrangementSpec {
  const name = ds.getAsEnum(Prop.LAYOUT);
  const arrangement = ARRANGEMENTS.find((a) => a === name) ?? 'none';
  const par1 = ds.getAsString(Prop.LAYOUT_PAR1);
  const par2 = ds.getAsString(Prop.LAYOUT_PAR2);
  const par3 = ds.getAsString(Prop.LAYOUT_PAR3);
  const spec: ArrangementSpec = { arrangement, x: NaN, y: NaN, dx: NaN, dy: NaN, n: -1 };
  switch (arrangement) {
    case 'none':
      break;
    case 'exact':
      spec.x = parseFloatPar(par1);
      spec.y = parseFloatPar(par2);
      break;
    case 'row':
      spec.dx = parseFloatPar(par1);
      spec.n = parseIntPar(par2);
      spec.dy = parseFloatPar(par3);
      break;
    case 'column':
      spec.dy = parseFloatPar(par1);
      spec.n = parseIntPar(par2);
      spec.dx = parseFloatPar(par3);
      break;
    case 'matrix':
      spec.n = parseIntPar(par1);
      spec.dx = parseFloatPar(par2);
      spec.dy = parseFloatPar(par3);
      break;
    case 'ring':
    case 'cring':
      spec.dx = parseFloatPar(par1);
      spec.dy = parseFloatPar(par2);
      break;
  }
  return spec;
}

const fallback = (value: number, fallbackValue: number): number => (Number.isNaN(value) ? fallbackValue : value);

/**
 * The offset to add to a submodule's base location (the position in the "p" tag), given
 * its index within its layout group (or vector) of the given size.
 */
export function arrangementOffset(
  p: ArrangementSpec,
  index: number,
  size: number,
  spacing = DEFAULT_ARRANGEMENT_SPACING,
): Pt {
  switch (p.arrangement) {
    case 'none':
      return { x: 0, y: 0 };
    case 'exact':
      return { x: fallback(p.x, 0), y: fallback(p.y, 0) };
    case 'row': {
      const dx = fallback(p.dx, spacing);
      if (p.n > 0) return { x: (index % p.n) * dx, y: Math.floor(index / p.n) * fallback(p.dy, spacing) };
      return { x: index * dx, y: 0 };
    }
    case 'column': {
      const dy = fallback(p.dy, spacing);
      if (p.n > 0) return { x: Math.floor(index / p.n) * fallback(p.dx, spacing), y: (index % p.n) * dy };
      return { x: 0, y: index * dy };
    }
    case 'matrix': {
      const numCols = p.n > 0 ? p.n : 5; // Java: n=0 would divide by zero
      return {
        x: (index % numCols) * fallback(p.dx, spacing),
        y: Math.floor(index / numCols) * fallback(p.dy, spacing),
      };
    }
    case 'ring':
    case 'cring': {
      const rx = fallback(p.dx, Math.trunc((spacing * size) / (2 * Math.PI)));
      const ry = fallback(p.dy, rx);
      const alpha = size === 0 ? 0 : (index * 2 * Math.PI) / size;
      return p.arrangement === 'ring'
        ? { x: rx - rx * Math.sin(alpha), y: ry - ry * Math.cos(alpha) }
        : { x: -rx * Math.sin(alpha), y: -ry * Math.cos(alpha) };
    }
  }
}
