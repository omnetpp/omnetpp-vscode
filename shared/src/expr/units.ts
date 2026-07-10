/**
 * Measurement-unit dimension table, ported from OMNeT++'s
 * common/unitconversion.cc. Two units are compatible iff they reduce to the
 * same base dimension. Unknown units are treated as compatible (we never flag
 * what we cannot recognize) to avoid false positives.
 */
const BASE: Record<string, string> = {};
function group(base: string, units: string[]): void {
  BASE[base] = base;
  for (const u of units) BASE[u] = base;
}

group('s', ['d', 'h', 'min', 's', 'ms', 'us', 'ns', 'ps', 'fs', 'as']);
group('bps', ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps']);
group('b', [
  'b', 'B', 'KiB', 'MiB', 'GiB', 'TiB', 'kB', 'MB', 'GB', 'TB',
  'Kib', 'Mib', 'Gib', 'Tib', 'kb', 'Mb', 'Gb', 'Tb',
]);
group('rad', ['rad', 'deg']);
group('m', ['m', 'dm', 'cm', 'mm', 'um', 'nm', 'km']);
group('W', ['W', 'mW', 'uW', 'nW', 'pW', 'fW', 'kW', 'MW', 'GW', 'dBW', 'dBm', 'dBmW']);
group('Hz', ['Hz', 'kHz', 'MHz', 'GHz', 'THz']);
group('kg', ['kg', 'g', 't']);
group('K', ['K']);
group('J', ['J', 'kJ', 'MJ', 'Ws', 'Wh', 'kWh', 'MWh']);
group('V', ['V', 'kV', 'mV', 'dBV', 'dBmV']);
group('A', ['A', 'mA', 'uA']);
group('Ohm', ['Ohm', 'mOhm', 'kOhm', 'MOhm']);
group('mps', ['mps', 'kmps', 'kmph']);
group('As', ['C', 'As', 'mAs', 'Ah', 'mAh']);
group('x', ['x']);

/** The base dimension of a unit, or undefined if the unit is not recognized. */
export function unitDimension(unit: string): string | undefined {
  return BASE[unit];
}

/**
 * All recognized unit-symbol names (base dimensions and their synonyms), for
 * `@unit(...)` value completion. Ported from Eclipse's `UnitConversion.getKnownUnits()`
 * (`NedCompletionHelper.proposedNedUnitTempl`).
 */
export function knownUnitNames(): string[] {
  return Object.keys(BASE);
}

/**
 * Whether two units are dimensionally compatible. Returns true when either unit
 * is unrecognized (conservative: never flag the unknown).
 */
export function unitsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const da = unitDimension(a);
  const db = unitDimension(b);
  if (da === undefined || db === undefined) return true;
  return da === db;
}
