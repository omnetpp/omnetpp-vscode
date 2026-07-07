/**
 * dialogs.ts — in-webview goto-event / goto-simulation-time / find-text dialogs
 * (phase U4's decision record: "in-webview dialogs" rather than native VS Code input
 * boxes, so the Sequence Chart can validate/preview against its own already-loaded
 * state without a native-UI round trip; `client/src/eventlog/eventLogDialogs.ts`'s
 * native boxes remain as a fallback when no chart webview is attached/focused — see
 * that file's header).
 *
 * Pure validation/parsing (unit-tested, DOM-free): `validateGotoEventInput()`,
 * `parseGotoSimTimeExpr()` (port of `GotoSimulationTimeDialog.getSimulationTime()`/
 * `isValid()`, `omnetpp-dev/ui/org.omnetpp.common/.../GotoSimulationTimeDialog.java`,
 * read in full). DOM prompt UI below is not unit-tested (same convention as
 * `interactions.ts`/`canvasStack.ts`/`contextMenu.ts`).
 *
 * DEVIATION (documented): Java's expression evaluator is
 * `org.omnetpp.common.engine.Expression` -- a full NED-style arithmetic expression
 * language (`+`/`-`/`*`/`/`, parens, function calls...). Porting that general
 * evaluator is out of this phase's scope (it belongs with the rest of the NED
 * expression/value infrastructure, not the eventlog UI). This port instead accepts a
 * single numeric literal with an OPTIONAL time-unit suffix (`s`, `ms`, `us`/`µs`,
 * `ns`, `ps`, `min`, `h`, `d`) -- covering the overwhelmingly common "Go to Simulation
 * Time" input shapes ("1.5", "1.5s", "+100ms", "-2min") while honestly not supporting
 * arbitrary arithmetic expressions. The `+`/`-` relative-positioning semantics and the
 * two validation error messages are ported exactly.
 */

import {
  addDecimalStrings,
  compareDecimalStrings,
  isNegativeDecimal,
  multiplyDecimalStringByInt,
  scaleDecimalStringByPow10,
} from './decimalTime';

// ---------------------------------------------------------------------------------
// Go to Event -- pure validation
// ---------------------------------------------------------------------------------

export interface GotoEventValidationRange {
  firstEventNumber: number;
  lastEventNumber: number;
}

/** `null` = valid; otherwise the error message to show. */
export function validateGotoEventInput(raw: string, range: GotoEventValidationRange): string | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 'Enter a non-negative integer event number';
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return 'Event number is too large';
  if (n < range.firstEventNumber || n > range.lastEventNumber) return `Event number must be between #${range.firstEventNumber} and #${range.lastEventNumber}`;
  return null;
}

// ---------------------------------------------------------------------------------
// Go to Simulation Time -- port of GotoSimulationTimeDialog (see this file's header)
// ---------------------------------------------------------------------------------

const TIME_LITERAL_RE = /^([+-]?\d+(?:\.\d+)?)\s*(s|ms|us|µs|ns|ps|min|h|d)?$/;
const UNIT_POW10: Record<string, number> = { s: 0, ms: -3, us: -6, 'µs': -6, ns: -9, ps: -12 };
const UNIT_MULT: Record<string, number> = { min: 60, h: 3600, d: 86400 };

function parseTimeLiteral(expr: string): string | null {
  const m = TIME_LITERAL_RE.exec(expr.trim());
  if (!m) return null;
  const [, numberPart, unit] = m;
  if (!unit || unit in UNIT_POW10) return scaleDecimalStringByPow10(numberPart, unit ? UNIT_POW10[unit] : 0);
  return multiplyDecimalStringByInt(numberPart, UNIT_MULT[unit]);
}

export interface GotoSimTimeParseResult {
  ok: boolean;
  /** The resolved absolute decimal simulation-time string (only set when `ok`). */
  value?: string;
  /** Error message (only set when `!ok`), matching `GotoSimulationTimeDialog.isValid()`'s three cases exactly. */
  error?: string;
}

/**
 * Port of `GotoSimulationTimeDialog.getSimulationTime(BigDecimal, String)` +
 * `isValid()` combined into one call. `baseSimulationTime`: Java feeds
 * `sequenceChart.getSimulationTimeForViewportCoordinate(0)` (the simtime at the LEFT
 * EDGE of the visible chart) as the relative-positioning base -- callers should pass
 * the same. `lastSimulationTime`: `null` if unknown (skips the "beyond the end" check).
 */
export function parseGotoSimTimeExpr(rawInput: string, baseSimulationTime: string, lastSimulationTime: string | null): GotoSimTimeParseResult {
  let expr = rawInput.trim();
  let relative = false;
  if (expr.startsWith('+')) {
    relative = true;
    expr = expr.slice(1).trim();
  } else if (expr.startsWith('-')) {
    relative = true; // leading '-' stays part of expr, per Java -- see this file's header
  }
  if (expr.length === 0) return { ok: false, error: 'Error in expression' };

  const parsed = parseTimeLiteral(expr);
  if (parsed === null) return { ok: false, error: 'Error in expression' };

  const value = relative ? addDecimalStrings(baseSimulationTime, parsed) : parsed;
  if (isNegativeDecimal(value)) return { ok: false, error: `The resulting simulation time is negative: ${value}` };
  if (lastSimulationTime !== null && compareDecimalStrings(value, lastSimulationTime) > 0) return { ok: false, error: `The resulting simulation time is beyond the end: ${value}` };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------
// Find Text -- state carried between "Find Text..." and "Find Next"
// ---------------------------------------------------------------------------------

export interface FindTextState {
  search: string;
  caseSensitive: boolean;
  backward: boolean;
}

export const DEFAULT_FIND_TEXT_STATE: FindTextState = { search: '', caseSensitive: false, backward: false };

// ---------------------------------------------------------------------------------
// DOM prompt UI (not unit-tested -- see this file's header)
// ---------------------------------------------------------------------------------

/**
 * Phase U8 (ADDITIVE): the overlay/panel/Esc-to-close shell alone, for dialogs whose
 * body is NOT a flat field list (`openPrompt()` below stays the field-list
 * convenience) — the Select Modules module tree and the Manual Axis Ordering reorder
 * list build their own body DOM into `panel`.
 */
export function openDialogShell(title: string): { panel: HTMLElement; close: () => void } {
  const { panel, close } = buildOverlay();
  const titleEl = document.createElement('div');
  titleEl.className = 'elog-dialog-title';
  titleEl.textContent = title;
  panel.appendChild(titleEl);
  return { panel, close };
}

function buildOverlay(): { overlay: HTMLElement; panel: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'elog-dialog-overlay';
  const panel = document.createElement('div');
  panel.className = 'elog-dialog';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const close = (): void => overlay.remove();
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
  return { overlay, panel, close };
}

interface PromptField {
  label: string;
  type?: 'text' | 'checkbox';
  initialValue?: string;
  initialChecked?: boolean;
}

/** Builds a small labeled-input dialog with a title, one or more fields, a validation/error line, and OK/Cancel (Enter/Esc). `validate` runs on every input change; `onSubmit` only fires when it returns `null`. Returns the mounted input elements in field order (text fields as `HTMLInputElement[type=text]`, checkboxes as `HTMLInputElement[type=checkbox]`) so a caller with multiple fields (find-text) can read them all in `validate`/`onSubmit`. */
function openPrompt(title: string, fields: PromptField[], validate: (values: string[], checked: boolean[]) => string | null, onSubmit: (values: string[], checked: boolean[]) => void): void {
  const { panel, close } = buildOverlay();
  const titleEl = document.createElement('div');
  titleEl.className = 'elog-dialog-title';
  titleEl.textContent = title;
  panel.appendChild(titleEl);

  const textInputs: HTMLInputElement[] = [];
  const checkInputs: HTMLInputElement[] = [];
  const rowsByField: HTMLInputElement[] = [];

  for (const field of fields) {
    const row = document.createElement('div');
    row.className = 'elog-dialog-row';
    const labelEl = document.createElement('label');
    labelEl.textContent = field.label;
    const input = document.createElement('input');
    input.type = field.type ?? 'text';
    if (input.type === 'checkbox') {
      input.checked = !!field.initialChecked;
      checkInputs.push(input);
      row.appendChild(input);
      row.appendChild(labelEl);
    } else {
      input.value = field.initialValue ?? '';
      textInputs.push(input);
      row.appendChild(labelEl);
      row.appendChild(input);
    }
    rowsByField.push(input);
    panel.appendChild(row);
  }

  const errorEl = document.createElement('div');
  errorEl.className = 'elog-dialog-error';
  panel.appendChild(errorEl);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'elog-dialog-buttons';
  const okButton = document.createElement('button');
  okButton.textContent = 'OK';
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  buttonsRow.appendChild(cancelButton);
  buttonsRow.appendChild(okButton);
  panel.appendChild(buttonsRow);

  const currentValues = (): { values: string[]; checked: boolean[] } => ({ values: textInputs.map((i) => i.value), checked: checkInputs.map((i) => i.checked) });

  const revalidate = (): void => {
    const { values, checked } = currentValues();
    const error = validate(values, checked);
    errorEl.textContent = error ?? '';
    okButton.disabled = error !== null;
  };

  const submit = (): void => {
    const { values, checked } = currentValues();
    if (validate(values, checked) !== null) return;
    onSubmit(values, checked);
    close();
  };

  for (const input of rowsByField) {
    input.addEventListener('input', revalidate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }
  okButton.addEventListener('click', submit);
  cancelButton.addEventListener('click', close);

  revalidate();
  textInputs[0]?.focus();
  textInputs[0]?.select();
}

export function openGotoEventDialog(range: GotoEventValidationRange, onSubmit: (eventNumber: number) => void): void {
  openPrompt(
    'Go to Event',
    [{ label: 'Event number:', initialValue: '' }],
    ([raw]) => validateGotoEventInput(raw, range),
    ([raw]) => onSubmit(Number(raw.trim())),
  );
}

export function openGotoSimTimeDialog(baseSimulationTime: string, lastSimulationTime: string | null, onSubmit: (simulationTime: string) => void): void {
  openPrompt(
    'Go to Simulation Time',
    [{ label: 'Simulation time (± for relative, units accepted):', initialValue: '' }],
    ([raw]) => parseGotoSimTimeExpr(raw, baseSimulationTime, lastSimulationTime).error ?? null,
    ([raw]) => {
      const result = parseGotoSimTimeExpr(raw, baseSimulationTime, lastSimulationTime);
      if (result.ok && result.value !== undefined) onSubmit(result.value);
    },
  );
}

export function openFindTextDialog(initial: FindTextState, onSubmit: (state: FindTextState) => void): void {
  openPrompt(
    'Find Text',
    [
      { label: 'Find:', initialValue: initial.search },
      { label: 'Case sensitive', type: 'checkbox', initialChecked: initial.caseSensitive },
      { label: 'Search backward', type: 'checkbox', initialChecked: initial.backward },
    ],
    ([search]) => (search.trim().length === 0 ? 'Enter text to search for' : null),
    ([search], [caseSensitive, backward]) => onSubmit({ search, caseSensitive, backward }),
  );
}
