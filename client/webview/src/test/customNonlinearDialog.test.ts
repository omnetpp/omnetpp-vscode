import { test } from 'bun:test';
import assert from 'node:assert';
import {
  CUSTOM_NONLINEAR_SLIDER_MAX,
  CUSTOM_NONLINEAR_SLIDER_MIN,
  focusFromSliderValue,
  minDeltaFromSliderValue,
  sliderValueFromFocus,
  sliderValueFromMinDelta,
} from '../eventlog/chart/customNonlinearDialog';

// ---------------------------------------------------------------------------------
// Minimum (relative min/max timeline-coordinate-delta ratio) -- linear 0..1000 <-> 0..1
// ---------------------------------------------------------------------------------

test('minDeltaFromSliderValue/sliderValueFromMinDelta: linear round trip over the whole slider range', () => {
  assert.equal(minDeltaFromSliderValue(CUSTOM_NONLINEAR_SLIDER_MIN), 0);
  assert.equal(minDeltaFromSliderValue(CUSTOM_NONLINEAR_SLIDER_MAX), 1);
  assert.equal(minDeltaFromSliderValue(500), 0.5);

  assert.equal(sliderValueFromMinDelta(0), CUSTOM_NONLINEAR_SLIDER_MIN);
  assert.equal(sliderValueFromMinDelta(1), CUSTOM_NONLINEAR_SLIDER_MAX);
  assert.equal(sliderValueFromMinDelta(0.1), 100); // the engine's own default (`SequenceChartFacade.nonLinearMinimumTimelineCoordinateDelta = 0.1`)

  for (const scale of [0, 1, 250, 999, 1000]) assert.equal(sliderValueFromMinDelta(minDeltaFromSliderValue(scale)), scale);
});

test('sliderValueFromMinDelta: clamps out-of-[0,1] values to the slider range instead of producing an out-of-bounds slider position', () => {
  assert.equal(sliderValueFromMinDelta(-1), CUSTOM_NONLINEAR_SLIDER_MIN);
  assert.equal(sliderValueFromMinDelta(5), CUSTOM_NONLINEAR_SLIDER_MAX);
});

// ---------------------------------------------------------------------------------
// Focus (a simulation-time point) -- logarithmic 0..1000 <-> 1e-18..1e7 seconds
// ---------------------------------------------------------------------------------

test('focusFromSliderValue/sliderValueFromFocus: matches the exact Java formulas at the slider endpoints and midpoint', () => {
  // Port of CustomNonlinearOptionsDialog.getNonLinearFocus()/getNonLinearFocusScale()
  // (SequenceChartContributor.java:2604-2610): pow(10, scale/40 - 18).
  assert.ok(Math.abs(focusFromSliderValue(CUSTOM_NONLINEAR_SLIDER_MIN) - 1e-18) < 1e-30);
  assert.ok(Math.abs(focusFromSliderValue(CUSTOM_NONLINEAR_SLIDER_MAX) - 1e7) / 1e7 < 1e-9);
  // scale=720 -> log10(focus) = 720/40 - 18 = 0 -> focus = 1 second.
  assert.ok(Math.abs(focusFromSliderValue(720) - 1) < 1e-9);
});

test('focusFromSliderValue/sliderValueFromFocus: round trip (within integer-slider rounding)', () => {
  for (const scale of [0, 1, 250, 500, 720, 999, 1000]) assert.equal(sliderValueFromFocus(focusFromSliderValue(scale)), scale);
});

test('sliderValueFromFocus: non-positive focus (never produced by this dialog, but the engine setter only requires >= 0) floors to the slider minimum rather than NaN/-Infinity', () => {
  assert.equal(sliderValueFromFocus(0), CUSTOM_NONLINEAR_SLIDER_MIN);
  assert.equal(sliderValueFromFocus(-5), CUSTOM_NONLINEAR_SLIDER_MIN);
});

test('sliderValueFromFocus: clamps focus values whose log10 maps outside [0,1000] instead of an out-of-bounds slider position', () => {
  assert.equal(sliderValueFromFocus(1e-30), CUSTOM_NONLINEAR_SLIDER_MIN);
  assert.equal(sliderValueFromFocus(1e30), CUSTOM_NONLINEAR_SLIDER_MAX);
});
