// The .cc → .h → .ned counterpart ring, shared by the server (which fills a
// CounterpartResult) and the client (which steps to the next member). Kept
// self-contained — no imports with runtime code — so the client can bundle it
// through '@omnetpp/shared/protocol' without the semantic core.

import type { Range } from '../model/location';

export type CounterpartKind = 'cc' | 'h' | 'ned';

export interface CounterpartTarget {
  uri: string;
  /** Where to put the cursor; absent for a same-basename fallback. */
  range?: Range;
  /** The C++ class or NED type the target stands for, or the file name for a fallback. */
  label: string;
}

export interface CounterpartResult {
  /** The kind of the requested file, or null when it is not a .cc/.h/.ned file. */
  kind: CounterpartKind | null;
  cc: CounterpartTarget[];
  h: CounterpartTarget[];
  ned: CounterpartTarget[];
}

export const COUNTERPART_RING: readonly CounterpartKind[] = ['cc', 'h', 'ned'];

export const COUNTERPART_EXTENSIONS: Readonly<Record<CounterpartKind, readonly string[]>> = {
  cc: ['.cc', '.cpp', '.cxx'],
  h: ['.h', '.hpp', '.hh', '.hxx'],
  ned: ['.ned'],
};

/** The ring member of a file. opp_msgc output (`*_m.cc`/`*_m.h`) belongs to a `.msg`, not to this ring. */
export function counterpartKind(uri: string): CounterpartKind | null {
  const lower = uri.toLowerCase();
  if (/_m\.[a-z]+$/.test(lower)) return null;
  for (const k of COUNTERPART_RING) if (COUNTERPART_EXTENSIONS[k].some((e) => lower.endsWith(e))) return k;
  return null;
}

/** The first non-empty ring member after the requested file's own kind. */
export function nextCounterpart(
  r: CounterpartResult,
): { kind: CounterpartKind; targets: CounterpartTarget[] } | null {
  if (!r.kind) return null;
  const i = COUNTERPART_RING.indexOf(r.kind);
  for (let s = 1; s < COUNTERPART_RING.length; s++) {
    const k = COUNTERPART_RING[(i + s) % COUNTERPART_RING.length];
    if (r[k].length) return { kind: k, targets: r[k] };
  }
  return null;
}
