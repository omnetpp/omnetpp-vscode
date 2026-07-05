import { test } from 'bun:test';
import assert from 'node:assert';
import { NAMED_COLORS, colorNames, parseColor } from '../graphics/colors';

// ---- NAMED_COLORS spot checks (values transcribed from ColorFactory.java) --

test('colors: named-color table spot checks against ColorFactory.java RGB values', () => {
  assert.equal(NAMED_COLORS['grey82'], '#d1d1d1');   // new RGB(209,209,209)
  assert.equal(NAMED_COLORS['black'], '#000000');    // new RGB(0,0,0)
  assert.equal(NAMED_COLORS['white'], '#ffffff');    // new RGB(255,255,255)
  assert.equal(NAMED_COLORS['red'], '#ff0000');      // new RGB(255,0,0)
  assert.equal(NAMED_COLORS['gold'], '#ffd700');     // new RGB(255,215,0)
  assert.equal(NAMED_COLORS['deepskyblue'], '#00bfff'); // new RGB(0,191,255)
  assert.equal(NAMED_COLORS['lightblue4'], '#68838b');  // new RGB(104,131,139)
  assert.equal(NAMED_COLORS['grey0'], '#000000');    // new RGB(0,0,0)
  assert.equal(NAMED_COLORS['grey100'], '#ffffff');  // new RGB(255,255,255)
  assert.equal(NAMED_COLORS['azure1'], '#f0ffff');   // new RGB(240,255,255)
  assert.equal(NAMED_COLORS['azure4'], '#838b8b');   // new RGB(131,139,139)
  assert.equal(NAMED_COLORS['navy'], '#000080');     // new RGB(0,0,128)
});

test('colors: NAMED_COLORS has exactly 540 entries (full ColorFactory.java palette)', () => {
  assert.equal(colorNames().length, 540);
  assert.equal(Object.keys(NAMED_COLORS).length, 540);
});

test('colors: the Java source only registers "grey", not "gray" — no invented aliases', () => {
  // ColorFactory.java has darkGrey/lightGrey/slateGrey/dimGrey/darkSlateGrey/lightSlateGrey,
  // but no American "gray" spelling at all, so NAMED_COLORS must not invent one either.
  assert.equal(NAMED_COLORS['darkgrey'], '#a9a9a9');
  assert.equal(NAMED_COLORS['darkgray'], undefined);
  assert.equal(NAMED_COLORS['gray'], undefined);
  assert.equal(parseColor('darkgray'), undefined);
});

// ---- parseColor: #RRGGBB ----------------------------------------------------

test('colors: parseColor normalizes #RRGGBB case and passes through valid hex', () => {
  assert.equal(parseColor('#FF00aa'), '#ff00aa');
  assert.equal(parseColor('#000000'), '#000000');
  assert.equal(parseColor('#ABCDEF'), '#abcdef');
});

test('colors: parseColor rejects malformed hex (wrong length, no short form)', () => {
  assert.equal(parseColor('#12345'), undefined);   // 5 hex digits, too short
  assert.equal(parseColor('#1234567'), undefined); // 7 hex digits, too long
  assert.equal(parseColor('#fff'), undefined);     // 3-digit short form not accepted
  assert.equal(parseColor('#gggggg'), undefined);  // not valid hex digits
});

// ---- parseColor: @HHSSBB (HSB-encoded) --------------------------------------
// Expected values computed by hand from java.awt.Color.HSBtoRGB's exact
// floor/case-based algorithm (verified again independently with a small
// Python re-implementation of the same formula):
//
//   @ff0080: HH=0xff=255, SS=0x00=0, BB=0x80=128
//     hue=358.59deg, saturation=0, brightness=128/256=0.5
//     saturation==0 -> r=g=b=trunc(0.5*255+0.5)=trunc(128.0)=128=0x80 -> #808080
//
//   @804080: HH=0x80=128, SS=0x40=64, BB=0x80=128
//     hue=128/256*360=180deg, saturation=64/256=0.25, brightness=128/256=0.5
//     h=(180/360)*6=3.0, f=0.0
//     p=0.5*(1-0.25)=0.375, q=0.5*(1-0.25*0)=0.5, t=0.5*(1-0.25*1)=0.375
//     case 3: r=p=trunc(0.375*255+0.5)=96=0x60, g=q=trunc(0.5*255+0.5)=128=0x80,
//             b=brightness=trunc(0.5*255+0.5)=128=0x80 -> #608080

test('colors: parseColor converts @HHSSBB (saturation 0, grayscale) to exact RGB', () => {
  assert.equal(parseColor('@ff0080'), '#808080');
});

test('colors: parseColor converts @HHSSBB (hue sector 3) to exact RGB', () => {
  assert.equal(parseColor('@804080'), '#608080');
});

// ---- parseColor: named lookup case-insensitivity ----------------------------

test('colors: parseColor named lookup is case-insensitive', () => {
  assert.equal(parseColor('RED'), '#ff0000');
  assert.equal(parseColor('Red'), '#ff0000');
  assert.equal(parseColor('red'), '#ff0000');
  assert.equal(parseColor('GREY82'), '#d1d1d1');
});

// ---- parseColor: invalid/empty inputs ---------------------------------------

test('colors: parseColor returns undefined for empty, antivalue, and unknown input', () => {
  assert.equal(parseColor(''), undefined);
  assert.equal(parseColor('-'), undefined);
  assert.equal(parseColor('nosuchcolor'), undefined);
  assert.equal(parseColor('#12345'), undefined);
});
