import { describe, expect, test } from 'bun:test';
import { parseIni } from '../ini/iniDocument';
import {
  extendsLabelAt,
  iniEntryAt,
  isWildcardSegment,
  keySegmentPrefixAt,
  leafSegment,
} from '../ini/iniKeySegments';

const INI = `[General]
network = Net
**.host[*].app.count = 3

[Config Foo]
extends = Base, Other
`;

const doc = parseIni(INI, 'file:///t/omnetpp.ini');

describe('iniKeySegments', () => {
  test('iniEntryAt finds the entry spanning a key or value position', () => {
    const onKey = iniEntryAt(doc, { line: 2, character: 3 });
    expect(onKey?.entry.key).toBe('**.host[*].app.count');
    const onValue = iniEntryAt(doc, { line: 1, character: 11 });
    expect(onValue?.entry.key).toBe('network');
    expect(iniEntryAt(doc, { line: 4, character: 0 })).toBeUndefined();
  });

  test('leafSegment returns the last dotted segment', () => {
    expect(leafSegment('**.app.typename')).toBe('typename');
    expect(leafSegment('network')).toBe('network');
  });

  test('keySegmentPrefixAt maps a cursor to its segment and prefix', () => {
    const entry = iniEntryAt(doc, { line: 2, character: 0 })!.entry;
    const keyStart = entry.keyRange.start.character;
    // cursor on "host[*]" (segment 2 of **.host[*].app.count)
    const seg = keySegmentPrefixAt(entry, { line: 2, character: keyStart + 4 });
    expect(seg).toEqual({ prefix: '**.host[*]', segment: 'host[*]', isLast: false });
    // cursor on the leaf "count"
    const leaf = keySegmentPrefixAt(entry, { line: 2, character: keyStart + entry.key.length });
    expect(leaf?.segment).toBe('count');
    expect(leaf?.isLast).toBe(true);
    // off the key line
    expect(keySegmentPrefixAt(entry, { line: 3, character: 0 })).toBeUndefined();
  });

  test('isWildcardSegment ignores the [index] part', () => {
    expect(isWildcardSegment('**')).toBe(true);
    expect(isWildcardSegment('host?')).toBe(true);
    expect(isWildcardSegment('host[*]')).toBe(false);
    expect(isWildcardSegment('app')).toBe(false);
  });

  test('extendsLabelAt picks the comma-separated label under the cursor', () => {
    const entry = doc.sections
      .flatMap((s) => s.entries)
      .find((e) => e.key === 'extends')!;
    const vStart = entry.valueRange.start.character;
    expect(extendsLabelAt(entry, { line: 5, character: vStart + 1 })).toBe('Base');
    expect(extendsLabelAt(entry, { line: 5, character: vStart + entry.value.length })).toBe('Other');
    expect(extendsLabelAt(entry, { line: 0, character: 0 })).toBeUndefined();
  });
});
