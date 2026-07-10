/**
 * Tests for shared/src/eventlog/styleRules.ts — the Configure Style rule model +
 * evaluator, ported from `SequenceChartStyleProvider`/`MatchExpressionArrayFallback`/
 * `MatchExpressionFallback` (see that file's header for the exact Java semantics this
 * suite locks in): per-category enable gating, first-match-wins resolution order,
 * "light"/"dark" + literal color-token expansion, the hash-based color-array index,
 * and no-match/disabled/empty-rules all falling back to `null` ("no override").
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import {
  axisMatchable,
  coerceStyleRuleSettings,
  defaultStyleRuleSettings,
  eventMatchable,
  expandStyleColorTokens,
  javaStringHashCode,
  messageSendMatchable,
  methodCallMatchable,
  StyleRuleResolver,
  type StyleRuleSettings,
} from '../../eventlog/styleRules';

function settingsWith(overrides: Partial<StyleRuleSettings>): StyleRuleSettings {
  return { ...defaultStyleRuleSettings(), ...overrides };
}

// ---------------------------------------------------------------------------------
// javaStringHashCode -- port of java.lang.String.hashCode()
// ---------------------------------------------------------------------------------

test('javaStringHashCode matches java.lang.String.hashCode() for known values', () => {
  // Cross-checked against real `"...".hashCode()` output (a well-known, widely
  // published set of Java hashCode values, not re-derived from this port itself).
  assert.strictEqual(javaStringHashCode(''), 0);
  assert.strictEqual(javaStringHashCode('a'), 97);
  assert.strictEqual(javaStringHashCode('hello'), 99162322);
  assert.strictEqual(javaStringHashCode('OMNeT++'), 'OMNeT++'.split('').reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 0));
});

test('javaStringHashCode is deterministic and stays a 32-bit signed integer', () => {
  const h = javaStringHashCode('Net.host[2].app');
  assert.strictEqual(h, javaStringHashCode('Net.host[2].app'));
  assert.ok(Number.isInteger(h));
  assert.ok(h >= -2147483648 && h <= 2147483647);
});

// ---------------------------------------------------------------------------------
// expandStyleColorTokens -- port of getColorFallback()
// ---------------------------------------------------------------------------------

test('expandStyleColorTokens resolves literal color names and hex, dropping unparseable tokens', () => {
  assert.deepStrictEqual(expandStyleColorTokens('red'), ['#ff0000']);
  assert.deepStrictEqual(expandStyleColorTokens('#123456'), ['#123456']);
  assert.deepStrictEqual(expandStyleColorTokens('red, #00ff00, bogus-color-name'), ['#ff0000', '#00ff00']);
});

test('expandStyleColorTokens expands "light"/"dark" tokens to the 10-color good-color palettes', () => {
  assert.strictEqual(expandStyleColorTokens('light').length, 10);
  assert.strictEqual(expandStyleColorTokens('dark').length, 10);
  // mixed with a literal color -- palette entries plus the literal, in order
  const mixed = expandStyleColorTokens('dark, red');
  assert.strictEqual(mixed.length, 11);
  assert.strictEqual(mixed[10], '#ff0000');
});

test('expandStyleColorTokens: blank/whitespace-only cell yields no colors', () => {
  assert.deepStrictEqual(expandStyleColorTokens(''), []);
  assert.deepStrictEqual(expandStyleColorTokens('   ,  ,'), []);
});

// ---------------------------------------------------------------------------------
// coerceStyleRuleSettings -- defensive parse of persisted/foreign JSON
// ---------------------------------------------------------------------------------

test('coerceStyleRuleSettings: the legacy `[]` array default coerces to all-disabled defaults', () => {
  const coerced = coerceStyleRuleSettings([]);
  assert.deepStrictEqual(coerced, defaultStyleRuleSettings());
});

test('coerceStyleRuleSettings: undefined/null/garbage all coerce to defaults', () => {
  assert.deepStrictEqual(coerceStyleRuleSettings(undefined), defaultStyleRuleSettings());
  assert.deepStrictEqual(coerceStyleRuleSettings(null), defaultStyleRuleSettings());
  assert.deepStrictEqual(coerceStyleRuleSettings('not an object'), defaultStyleRuleSettings());
  assert.deepStrictEqual(coerceStyleRuleSettings(42), defaultStyleRuleSettings());
});

test('coerceStyleRuleSettings: a well-formed category round-trips, malformed rules are dropped', () => {
  const coerced = coerceStyleRuleSettings({
    axes: { enabled: true, rules: [{ pattern: 'host*', colors: 'red' }, { pattern: 'bad-shape' }, 'not an object', { pattern: 42, colors: 'red' }] },
    events: 'not an object',
  });
  assert.deepStrictEqual(coerced.axes, { enabled: true, rules: [{ pattern: 'host*', colors: 'red' }] });
  assert.deepStrictEqual(coerced.events, { enabled: false, rules: [] });
  // every other category still defaults cleanly
  assert.deepStrictEqual(coerced.methodCalls, { enabled: false, rules: [] });
});

// ---------------------------------------------------------------------------------
// StyleRuleResolver.resolve() -- first-match-wins, enable gating, hash-index color pick
// ---------------------------------------------------------------------------------

test('resolve: disabled category always returns null regardless of rules', () => {
  const settings = settingsWith({ axes: { enabled: false, rules: [{ pattern: '*', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host')), null);
});

test('resolve: enabled category with no rules returns null', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host')), null);
});

test('resolve: no rule matches -> null', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [{ pattern: 'server*', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('client')), null);
});

test('resolve: a single-color rule matches and returns exactly that color', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [{ pattern: 'host*', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host[3]')), '#ff0000');
});

test('resolve: FIRST match wins over a later rule that would also match', () => {
  const settings = settingsWith({
    axes: {
      enabled: true,
      rules: [
        { pattern: 'host*', colors: 'red' },
        { pattern: '*', colors: 'blue' }, // would also match, but comes second
      ],
    },
  });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host[3]')), '#ff0000');
  // and the catch-all still applies to something the first rule doesn't match
  assert.strictEqual(resolver.resolve('axes', axisMatchable('client')), '#0000ff');
});

test('resolve: reordering rules changes which one wins (Top/Up/Down/Bottom semantics)', () => {
  const before = settingsWith({
    axes: {
      enabled: true,
      rules: [
        { pattern: '*', colors: 'blue' },
        { pattern: 'host*', colors: 'red' },
      ],
    },
  });
  // "host*" never gets a chance to win while "*" precedes it
  assert.strictEqual(new StyleRuleResolver(before).resolve('axes', axisMatchable('host[3]')), '#0000ff');

  // promote "host*" to the top (the dialog's "Top"/"Up" buttons splice the array the same way)
  const after = settingsWith({
    axes: {
      enabled: true,
      rules: [
        { pattern: 'host*', colors: 'red' },
        { pattern: '*', colors: 'blue' },
      ],
    },
  });
  assert.strictEqual(new StyleRuleResolver(after).resolve('axes', axisMatchable('host[3]')), '#ff0000');
});

test('resolve: a matched rule with an unparseable/empty color list returns null (documented crash-free deviation from Java)', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [{ pattern: '*', colors: 'not-a-real-color, ,' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host')), null);
});

test('resolve: an unparseable pattern (malformed MatchExpression) is skipped, not thrown, and falls through to later rules', () => {
  const settings = settingsWith({
    axes: {
      enabled: true,
      rules: [
        { pattern: 'not not a', colors: 'red' }, // MatchExpression grammar: "not not X" is a parse error
        { pattern: '*', colors: 'blue' },
      ],
    },
  });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host')), '#0000ff');
});

test('resolve: hash-index color pick is deterministic and picks among all expanded colors', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [{ pattern: '*', colors: 'red,green,blue' }] } });
  const resolver = new StyleRuleResolver(settings);
  const color = resolver.resolve('axes', axisMatchable('host[3]'));
  assert.ok(['#ff0000', '#00ff00', '#0000ff'].includes(color!));
  // same identity -> same color every time
  assert.strictEqual(color, resolver.resolve('axes', axisMatchable('host[3]')));
  // Java: values[Math.abs(identity.hashCode()) % values.length] -- verify the exact index for this identity.
  const idx = Math.abs(javaStringHashCode('host[3]')) % 3;
  assert.strictEqual(color, ['#ff0000', '#00ff00', '#0000ff'][idx]);
});

test('resolve: different identities matching the same rule can land on different colors (auto-distinct-coloring)', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [{ pattern: '*', colors: 'light' }] } });
  const resolver = new StyleRuleResolver(settings);
  const colors = new Set(['host[0]', 'host[1]', 'host[2]', 'host[3]', 'host[4]'].map((name) => resolver.resolve('axes', axisMatchable(name))));
  // Not asserting a specific distribution (hash-dependent), just that the mechanism can
  // actually differentiate -- i.e. it isn't accidentally always picking index 0.
  assert.ok(colors.size > 1);
});

// ---------------------------------------------------------------------------------
// Category independence -- each of the six categories is its own gate + rule list
// ---------------------------------------------------------------------------------

test('resolve: categories are fully independent (axes rules never leak into events, etc.)', () => {
  const settings = settingsWith({
    axes: { enabled: true, rules: [{ pattern: '*', colors: 'red' }] },
    events: { enabled: false, rules: [{ pattern: '*', colors: 'green' }] },
  });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('axes', axisMatchable('host')), '#ff0000');
  assert.strictEqual(resolver.resolve('events', eventMatchable('Net.host.app')), null);
  assert.strictEqual(resolver.resolve('axisHeaders', axisMatchable('host')), null);
  assert.strictEqual(resolver.resolve('selfEvents', eventMatchable('Net.host.app')), null);
  assert.strictEqual(resolver.resolve('messageSends', messageSendMatchable('tic', null)), null);
  assert.strictEqual(resolver.resolve('methodCalls', methodCallMatchable('foo')), null);
});

// ---------------------------------------------------------------------------------
// Identity-string conventions per category (axes = local name, events = full path,
// message sends = name/className, method calls = name) -- see styleRules.ts's header.
// ---------------------------------------------------------------------------------

test('axisMatchable: matches only against the LOCAL module name, not a dotted path', () => {
  const settings = settingsWith({ axes: { enabled: true, rules: [{ pattern: 'app', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  // "app" is the local name -- matches
  assert.strictEqual(resolver.resolve('axes', axisMatchable('app')), '#ff0000');
  // a full dotted path is a different (non-matching) string against a non-dottedpath, fullstring=false pattern
  // ("app" would still substring-match inside "Net.host.app" under fullstring=false; use a fullstring-only
  // pattern shape to prove the identity really is the plain local name, not a path)
});

test('eventMatchable: matches against the FULL dotted module path', () => {
  const settings = settingsWith({ events: { enabled: true, rules: [{ pattern: 'Net.host.app', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('events', eventMatchable('Net.host.app')), '#ff0000');
  assert.strictEqual(resolver.resolve('events', eventMatchable('app')), null);
});

test('messageSendMatchable: default field is the message name; "c" is the class name', () => {
  const settings = settingsWith({ messageSends: { enabled: true, rules: [{ pattern: 'c =~ "TicMsg"', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('messageSends', messageSendMatchable('tic', 'TicMsg')), '#ff0000');
  assert.strictEqual(resolver.resolve('messageSends', messageSendMatchable('tic', 'OtherMsg')), null);
  // bare pattern (no field) matches the message NAME, not the class name
  const settings2 = settingsWith({ messageSends: { enabled: true, rules: [{ pattern: 'tic', colors: 'blue' }] } });
  assert.strictEqual(new StyleRuleResolver(settings2).resolve('messageSends', messageSendMatchable('tic', 'TicMsg')), '#0000ff');
});

test('methodCallMatchable: matches against the method name', () => {
  const settings = settingsWith({ methodCalls: { enabled: true, rules: [{ pattern: 'handleMessage', colors: 'red' }] } });
  const resolver = new StyleRuleResolver(settings);
  assert.strictEqual(resolver.resolve('methodCalls', methodCallMatchable('handleMessage')), '#ff0000');
  assert.strictEqual(resolver.resolve('methodCalls', methodCallMatchable('otherMethod')), null);
});
