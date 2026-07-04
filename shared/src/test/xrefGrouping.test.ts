import { describe, expect, test } from 'bun:test';
import { edgeKindLabel, groupEdges, refDisplayName } from '../xref/xrefGrouping';
import { nedTypeSym, iniSectionSym } from '../xref/symbolId';
import type { XrefEdge } from '../xref/xrefModel';

const loc = (uri: string) => ({ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });

function edge(kind: XrefEdge['kind'], fromFq: string, srcUri: string): XrefEdge {
  return {
    kind,
    from: nedTypeSym(fromFq),
    to: nedTypeSym('pkg.Target'),
    src: loc(srcUri),
    rawTarget: 'Target',
    originUri: srcUri,
  };
}

describe('xrefGrouping', () => {
  test('edgeKindLabel maps kinds to the human-readable relation', () => {
    expect(edgeKindLabel('extends')).toBe('Extended by');
    expect(edgeKindLabel('submodule-type')).toBe('Instantiated by');
    expect(edgeKindLabel('ned-class')).toBe('Backing class for');
  });

  test('refDisplayName shortens symbols per language', () => {
    expect(refDisplayName(nedTypeSym('a.b.Node'))).toBe('Node');
    expect(refDisplayName(iniSectionSym('file:///x/omnetpp.ini', 'Config Foo'))).toBe('Config Foo');
  });

  test('groupEdges buckets by kind in display order with labels', () => {
    const groups = groupEdges([
      edge('submodule-type', 'a.NetA', 'file:///a/NetA.ned'),
      edge('extends', 'a.Sub', 'file:///a/Sub.ned'),
      edge('submodule-type', 'a.NetB', 'file:///a/NetB.ned'),
    ]);
    // 'extends' precedes 'submodule-type' in the display order
    expect(groups.map((g) => g.label)).toEqual(['Extended by', 'Instantiated by']);
    expect(groups[1].items.map((i) => i.label)).toEqual(['NetA', 'NetB']);
    expect(groups[0].items[0].description).toBe('Sub.ned');
  });
});
