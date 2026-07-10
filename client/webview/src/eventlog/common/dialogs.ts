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
 *
 * `onDismiss`, if given, fires when the shell is closed via one of its own two
 * "abandon" paths -- Escape or a mousedown on the overlay outside the panel -- but
 * NOT when the caller calls the returned `close()` itself (e.g. from an explicit
 * OK/Cancel button handler, which has already run its own logic). Every existing
 * caller (Select Modules, Manual Axis Ordering, Export to SVG) omits it, since none
 * of them apply anything before OK; the Custom Nonlinear dialog (U-phase gap-closure)
 * is the first with a LIVE preview (every slider tick redraws the chart before OK is
 * pressed), so for it Escape/outside-click must be treated as Cancel too -- otherwise
 * dismissing the dialog that way would silently leave the just-previewed values in
 * effect instead of reverting them.
 */
export function openDialogShell(title: string, onDismiss?: () => void): { panel: HTMLElement; close: () => void } {
  const { panel, close } = buildOverlay(onDismiss);
  const titleEl = document.createElement('div');
  titleEl.className = 'elog-dialog-title';
  titleEl.textContent = title;
  panel.appendChild(titleEl);
  return { panel, close };
}

function buildOverlay(onDismiss?: () => void): { overlay: HTMLElement; panel: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'elog-dialog-overlay';
  const panel = document.createElement('div');
  panel.className = 'elog-dialog';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  // `close` is called from EVERY dismissal path (OK, Cancel, outside-click, Escape) --
  // it must unregister `onKey` itself, not just the Escape branch, or a `close()` from
  // OK/Cancel leaves `onKey` listening on `document` forever (a leak on every dialog
  // open, and worse than a leak for a caller with an `onDismiss`: a LATER, unrelated
  // Escape press anywhere in the webview would fire the stale listener and re-invoke
  // `onDismiss` -- e.g. the Custom Nonlinear dialog would silently revert settings the
  // user already committed via OK, minutes after this dialog closed).
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      onDismiss?.();
      close();
    }
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onDismiss?.();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  return { overlay, panel, close };
}

interface PromptField {
  label: string;
  type?: 'text' | 'checkbox' | 'textarea';
  initialValue?: string;
  initialChecked?: boolean;
  /** `'textarea'` only -- visible row count (`<textarea rows>`, a DOM property, not a CSS style -- CSP-exempt). Defaults to 6. */
  rows?: number;
}

/** Builds a small labeled-input dialog with a title, one or more fields, a validation/error line, and OK/Cancel (Enter/Esc). `validate` runs on every input change; `onSubmit` only fires when it returns `null`. Returns the mounted input elements in field order (text/textarea fields as `(HTMLInputElement|HTMLTextAreaElement)[]`, checkboxes as `HTMLInputElement[type=checkbox]`) so a caller with multiple fields (find-text) can read them all in `validate`/`onSubmit`. `Enter` submits from a `'text'` field; `'textarea'` fields need multi-line input, so only Ctrl/Cmd+Enter submits from those (plain Enter inserts a newline). `removeButton`, if given, adds a destructive-styled button pinned to the FAR left of the row (`.elog-dialog-button-remove`'s own `margin-right: auto` pushes Cancel/OK to the right edge, unchanged from today) that calls `onClick()` then closes -- unlike OK, it bypasses `validate()` entirely (removing doesn't need the fields to be in a valid state). */
function openPrompt(title: string, fields: PromptField[], validate: (values: string[], checked: boolean[]) => string | null, onSubmit: (values: string[], checked: boolean[]) => void, removeButton?: { label: string; onClick: () => void }): void {
  const { panel, close } = buildOverlay();
  const titleEl = document.createElement('div');
  titleEl.className = 'elog-dialog-title';
  titleEl.textContent = title;
  panel.appendChild(titleEl);

  const textInputs: (HTMLInputElement | HTMLTextAreaElement)[] = [];
  const checkInputs: HTMLInputElement[] = [];
  const rowsByField: (HTMLInputElement | HTMLTextAreaElement)[] = [];

  for (const field of fields) {
    const row = document.createElement('div');
    row.className = 'elog-dialog-row';
    const labelEl = document.createElement('label');
    labelEl.textContent = field.label;
    if (field.type === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.rows = field.rows ?? 6;
      textarea.value = field.initialValue ?? '';
      textInputs.push(textarea);
      rowsByField.push(textarea);
      row.classList.add('elog-dialog-row-textarea');
      row.appendChild(labelEl);
      row.appendChild(textarea);
      panel.appendChild(row);
      continue;
    }
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
  if (removeButton) {
    const removeButtonEl = document.createElement('button');
    removeButtonEl.className = 'elog-dialog-button-remove';
    removeButtonEl.textContent = removeButton.label;
    removeButtonEl.addEventListener('click', () => {
      removeButton.onClick();
      close();
    });
    buttonsRow.appendChild(removeButtonEl);
  }
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
    const isTextarea = input instanceof HTMLTextAreaElement;
    input.addEventListener('keydown', (e) => {
      // A textarea needs plain Enter to insert a newline -- only Ctrl/Cmd+Enter submits
      // from one; every other field type submits on plain Enter, unchanged.
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' && (!isTextarea || ke.ctrlKey || ke.metaKey)) submit();
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

/**
 * "Bookmark Info" note editing -- opened by a note box's double-click or its context
 * menu's "Edit Bookmark...". Renames the bookmark and/or replaces its markdown notes;
 * Ctrl/Cmd+Enter submits from the notes textarea (plain Enter inserts a newline, per
 * `openPrompt()`'s textarea handling above). `onRemove` deletes the bookmark entirely --
 * unlike OK, no confirmation prompt here (this dialog IS the confirmation step, same as
 * every other destructive action in this port that's reached via an explicit menu item).
 */
export function openEditBookmarkDialog(label: string, note: string, onSubmit: (label: string, note: string) => void, onRemove: () => void): void {
  openPrompt(
    'Edit Bookmark',
    [
      { label: 'Name:', initialValue: label },
      { label: 'Notes (Markdown):', type: 'textarea', initialValue: note },
    ],
    ([name]) => (name.trim().length === 0 ? 'Enter a bookmark name' : null),
    ([name, notes]) => onSubmit(name.trim(), notes),
    { label: 'Remove', onClick: onRemove },
  );
}
