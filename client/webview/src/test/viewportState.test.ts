import { test } from 'bun:test';
import assert from 'node:assert';
import {
  contentHeight,
  contentWidth,
  createViewportState,
  gotoBeginAt,
  gotoEndAt,
  panBy,
  panTo,
  resize,
  revealAt,
  scrollVerticalTo,
  visibleTcRange,
  zoomAt,
  zoomAtCenter,
  zoomToFit,
  GUTTER_LEFT_WIDTH,
  GUTTER_TOP_HEIGHT,
} from '../eventlog/chart/viewportState';

function sized(width = 800, height = 600) {
  return resize(createViewportState(), width, height);
}

test('contentWidth/contentHeight subtract the gutters', () => {
  const v = sized(800, 600);
  assert.strictEqual(contentWidth(v), 800 - GUTTER_LEFT_WIDTH);
  assert.strictEqual(contentHeight(v), 600 - GUTTER_TOP_HEIGHT);
});

test('visibleTcRange reflects leftTc and pixelsPerTc', () => {
  const v = { ...sized(800, 600), leftTc: 10, pixelsPerTc: 2 };
  const range = visibleTcRange(v);
  assert.strictEqual(range.leftTc, 10);
  assert.strictEqual(range.rightTc, 10 + contentWidth(v) / 2);
});

// ---------------------------------------------------------------------------------
// followEnd semantics -- ported exactly from SequenceChart.java (see viewportState.ts's header)
// ---------------------------------------------------------------------------------

test('followEnd starts false', () => {
  assert.strictEqual(createViewportState().followEnd, false);
});

test('gotoEndAt sets followEnd = true', () => {
  const v = gotoEndAt(sized(), 1000);
  assert.strictEqual(v.followEnd, true);
});

test('panBy (drag/wheel/arrow-key pan) clears followEnd', () => {
  const afterEnd = gotoEndAt(sized(), 1000);
  assert.strictEqual(afterEnd.followEnd, true);
  const afterPan = panBy(afterEnd, 5);
  assert.strictEqual(afterPan.followEnd, false);
});

test('panTo (scrollbar drag/click) clears followEnd', () => {
  const afterEnd = gotoEndAt(sized(), 1000);
  const afterScroll = panTo(afterEnd, 42);
  assert.strictEqual(afterScroll.followEnd, false);
});

test('revealAt (goto/reveal, incl. the one gotoEndAt internally performs) clears followEnd', () => {
  const afterEnd = gotoEndAt(sized(), 1000);
  const afterReveal = revealAt(afterEnd, 500);
  assert.strictEqual(afterReveal.followEnd, false);
});

test('gotoBeginAt (Home) clears followEnd', () => {
  const afterEnd = gotoEndAt(sized(), 1000);
  const afterBegin = gotoBeginAt(afterEnd, 0);
  assert.strictEqual(afterBegin.followEnd, false);
});

test('zoom (zoomAt/zoomAtCenter) preserves followEnd in both directions -- Java never touches it in zoomBy()', () => {
  const following = gotoEndAt(sized(), 1000);
  assert.strictEqual(zoomAtCenter(following, 1.5).followEnd, true);
  assert.strictEqual(zoomAt(following, 100, 1.5).followEnd, true);

  const notFollowing = sized();
  assert.strictEqual(zoomAtCenter(notFollowing, 1.5).followEnd, false);
});

test('scrollVerticalTo (vertical axis scroll) does not touch followEnd (orthogonal to horizontal-only flag)', () => {
  const following = gotoEndAt(sized(), 1000);
  const scrolled = scrollVerticalTo(following, 50, 1000);
  assert.strictEqual(scrolled.followEnd, true);
});

// ---------------------------------------------------------------------------------
// zoom keeps the anchor tc stable
// ---------------------------------------------------------------------------------

test('zoomAt keeps the anchor content-x position mapped to the same tc after rescaling', () => {
  const v = { ...sized(800, 600), leftTc: 0, pixelsPerTc: 10 };
  const anchorX = 200;
  const anchorTcBefore = v.leftTc + anchorX / v.pixelsPerTc;
  const zoomed = zoomAt(v, anchorX, 2);
  const anchorTcAfter = zoomed.leftTc + anchorX / zoomed.pixelsPerTc;
  assert.ok(Math.abs(anchorTcAfter - anchorTcBefore) < 1e-9);
  assert.strictEqual(zoomed.pixelsPerTc, 20);
});

test('zoomAtCenter keeps the content-area center tc stable (matches Java zoomIn/zoomOut, which always anchor at viewport center)', () => {
  const v = { ...sized(800, 600), leftTc: 100, pixelsPerTc: 5 };
  const centerTcBefore = v.leftTc + contentWidth(v) / 2 / v.pixelsPerTc;
  const zoomed = zoomAtCenter(v, 1.5);
  const centerTcAfter = zoomed.leftTc + contentWidth(zoomed) / 2 / zoomed.pixelsPerTc;
  assert.ok(Math.abs(centerTcAfter - centerTcBefore) < 1e-9);
});

test('gotoEndAt places endTc at the right edge of the content area', () => {
  const v = sized(800, 600);
  const endTc = 12345;
  const afterEnd = gotoEndAt(v, endTc);
  const range = visibleTcRange(afterEnd);
  assert.ok(Math.abs(range.rightTc - endTc) < 1e-9);
});

test('scrollVerticalTo clamps to [0, maxScroll]', () => {
  const v = sized();
  assert.strictEqual(scrollVerticalTo(v, -50, 100).vscroll, 0);
  assert.strictEqual(scrollVerticalTo(v, 500, 100).vscroll, 100);
  assert.strictEqual(scrollVerticalTo(v, 50, 100).vscroll, 50);
});

// ---------------------------------------------------------------------------------
// zoomToFit -- U4's "double-click a message dependency -> zoom to its span" /
// "Zoom to Fit" context-menu action
// ---------------------------------------------------------------------------------

test('zoomToFit: the requested [beginTc, endTc] span (plus padding) exactly fills the content width', () => {
  const v = sized(800, 600);
  const fitted = zoomToFit(v, 1000, 2000, 0.1);
  const range = visibleTcRange(fitted);
  assert.ok(Math.abs(range.leftTc - (1000 - 100)) < 1e-6, 'left edge is beginTc minus the 10% padding');
  assert.ok(Math.abs(range.rightTc - (2000 + 100)) < 1e-6, 'right edge is endTc plus the 10% padding');
});

test('zoomToFit: clears followEnd (an explicit navigation)', () => {
  const v = { ...sized(800, 600), followEnd: true };
  assert.strictEqual(zoomToFit(v, 0, 1000).followEnd, false);
});

test('zoomToFit: a zero-width span (beginTc === endTc) re-centers without changing scale', () => {
  const v = sized(800, 600);
  const fitted = zoomToFit(v, 500, 500);
  assert.strictEqual(fitted.pixelsPerTc, v.pixelsPerTc);
  const range = visibleTcRange(fitted);
  assert.ok(range.leftTc < 500 && range.rightTc > 500, '500 lands inside the (re-centered) visible range');
});
