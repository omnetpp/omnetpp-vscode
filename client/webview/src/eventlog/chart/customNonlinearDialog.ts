/**
 * customNonlinearDialog.ts -- the "Custom nonlinear..." Timeline Mode dialog, port of
 * `CustomNonlinearOptionsDialog` (`SequenceChartContributor.java:2487-2617`, read in
 * full): two live SWT `Scale` sliders -- "minimum" (the relative minimum-to-maximum
 * timeline-coordinate-delta ratio, `SequenceChartFacade.nonLinearMinimumTimelineCoordinateDelta`)
 * and "focus" (a simulation-time point, `nonLinearFocus`) -- each firing on every drag
 * tick (SWT's `widgetSelected` fires continuously while dragging a `Scale`, not just on
 * release), so the caller can redraw the chart live.
 *
 * DIVISION OF RESPONSIBILITY (matches `reorderDialog.ts`/`selectModulesDialog.ts`):
 * this module is pure DOM + callbacks, no engine/RPC/business state -- the "what to do
 * with a slider tick" (apply live, debounce) and "what was in effect before the dialog
 * opened" (for Cancel/Escape/outside-click to revert to) both live in the caller
 * (`chartMain.ts`'s `showCustomNonlinearOptionsDialog()`).
 *
 * The slider<->value mappings are exact ports of Java's own scale/unscale pairs
 * (`getNonLinearMinimumTimelineCoordinateDeltaScale()`/`getNonLinearMinimumTimelineCoordinateDelta()`
 * and `getNonLinearFocusScale()`/`getNonLinearFocus()`) -- kept as standalone, exported,
 * pure functions (unlike the DOM-building code below, which follows this file's own
 * header convention of "DOM prompt UI is not unit-tested", same as `dialogs.ts`).
 */

import { openDialogShell } from '../common/dialogs';
import { formatTickTime } from './ticks';

/** Matches Java's `Scale` widgets: `setMinimum(0)`/`setMaximum(1000)`. */
export const CUSTOM_NONLINEAR_SLIDER_MIN = 0;
export const CUSTOM_NONLINEAR_SLIDER_MAX = 1000;

function clampSliderValue(value: number): number {
  return Math.min(CUSTOM_NONLINEAR_SLIDER_MAX, Math.max(CUSTOM_NONLINEAR_SLIDER_MIN, Math.round(value)));
}

/** Port of `getNonLinearMinimumTimelineCoordinateDelta()`: linear, slider 0..1000 -> value 0..1. */
export function minDeltaFromSliderValue(sliderValue: number): number {
  return sliderValue / 1000;
}

/** Port of `getNonLinearMinimumTimelineCoordinateDeltaScale()`: linear, value 0..1 -> slider 0..1000 (clamped -- a value outside [0,1], while legal at the engine level, has no slider position; the dialog only ever originates values from this same round trip anyway). */
export function sliderValueFromMinDelta(minDelta: number): number {
  return clampSliderValue(1000 * minDelta);
}

/** Port of `getNonLinearFocus()`: logarithmic, slider 0..1000 -> value 1e-18..1e7 seconds. */
export function focusFromSliderValue(sliderValue: number): number {
  return Math.pow(10, sliderValue / 40 - 18);
}

/** Port of `getNonLinearFocusScale()`: logarithmic inverse, clamped to the slider's representable range (`focus <= 0` -- not producible by this dialog, but defensively floored to the slider minimum rather than passing `-Infinity`/`NaN` to `Math.round`). */
export function sliderValueFromFocus(focus: number): number {
  if (!(focus > 0)) return CUSTOM_NONLINEAR_SLIDER_MIN;
  return clampSliderValue((Math.log10(focus) + 18) * 40);
}

export interface CustomNonlinearOptionsValues {
  nonLinearFocus: number;
  nonLinearMinimumTimelineCoordinateDelta: number;
}

/**
 * Opens the dialog seeded with `initial`. `onChange` fires on every slider tick
 * (minimum and focus alike) with the FULL current pair (matching Eclipse's `apply()`,
 * which always re-applies both fields together, not just the one that moved). `onCancel`
 * fires exactly once if the dialog is dismissed WITHOUT an explicit OK (Cancel button,
 * Escape, or an outside click -- see `openDialogShell()`'s `onDismiss` doc); OK never
 * calls it (Eclipse's `okPressed()` just calls `apply()` once more, redundant with the
 * live ticks already applied, then closes).
 */
export function openCustomNonlinearOptionsDialog(initial: CustomNonlinearOptionsValues, onChange: (values: CustomNonlinearOptionsValues) => void, onCancel: () => void): void {
  let cancelled = false;
  const cancelOnce = (): void => {
    if (cancelled) return;
    cancelled = true;
    onCancel();
  };

  const { panel, close } = openDialogShell('Custom nonlinear timeline mode', cancelOnce);

  const messageEl = document.createElement('div');
  messageEl.className = 'elog-dialog-row';
  messageEl.textContent = 'Please select appropriate nonlinearity factors';
  panel.appendChild(messageEl);

  let values: CustomNonlinearOptionsValues = { ...initial };

  const minimumLabel = document.createElement('div');
  minimumLabel.className = 'elog-dialog-row';
  panel.appendChild(minimumLabel);
  const minimumSlider = document.createElement('input');
  minimumSlider.type = 'range';
  minimumSlider.min = String(CUSTOM_NONLINEAR_SLIDER_MIN);
  minimumSlider.max = String(CUSTOM_NONLINEAR_SLIDER_MAX);
  minimumSlider.style.cssText = 'width:100%;';
  const minimumRow = document.createElement('div');
  minimumRow.className = 'elog-dialog-row';
  minimumRow.appendChild(minimumSlider);
  panel.appendChild(minimumRow);

  const focusLabel = document.createElement('div');
  focusLabel.className = 'elog-dialog-row';
  panel.appendChild(focusLabel);
  const focusSlider = document.createElement('input');
  focusSlider.type = 'range';
  focusSlider.min = String(CUSTOM_NONLINEAR_SLIDER_MIN);
  focusSlider.max = String(CUSTOM_NONLINEAR_SLIDER_MAX);
  focusSlider.style.cssText = 'width:100%;';
  const focusRow = document.createElement('div');
  focusRow.className = 'elog-dialog-row';
  focusRow.appendChild(focusSlider);
  panel.appendChild(focusRow);

  function updateMinimumLabel(): void {
    const percent = Number((100 * values.nonLinearMinimumTimelineCoordinateDelta).toPrecision(3));
    minimumLabel.textContent = `Relative minimum distance to maximum distance: ${percent}%`;
  }
  function updateFocusLabel(): void {
    focusLabel.textContent = `Nonlinear simulation time focus: ${formatTickTime(values.nonLinearFocus)}`;
  }

  minimumSlider.value = String(sliderValueFromMinDelta(values.nonLinearMinimumTimelineCoordinateDelta));
  focusSlider.value = String(sliderValueFromFocus(values.nonLinearFocus));
  updateMinimumLabel();
  updateFocusLabel();

  minimumSlider.addEventListener('input', () => {
    values = { ...values, nonLinearMinimumTimelineCoordinateDelta: minDeltaFromSliderValue(Number(minimumSlider.value)) };
    updateMinimumLabel();
    onChange(values);
  });
  focusSlider.addEventListener('input', () => {
    values = { ...values, nonLinearFocus: focusFromSliderValue(Number(focusSlider.value)) };
    updateFocusLabel();
    onChange(values);
  });

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'elog-dialog-buttons';
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  const okButton = document.createElement('button');
  okButton.textContent = 'OK';
  buttonsRow.appendChild(cancelButton);
  buttonsRow.appendChild(okButton);
  panel.appendChild(buttonsRow);

  okButton.addEventListener('click', close);
  cancelButton.addEventListener('click', () => {
    cancelOnce();
    close();
  });
}
