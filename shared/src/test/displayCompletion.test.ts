import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedCompletion } from '../ned/nedCompletion';
import { displayCursorContext } from '../ned/displayString';

async function nedCache(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

/** Completion labels with the cursor positioned just before `")` on the given line. */
function completeInDisplay(cache: NedResourceCache, uri: string, lineIdx: number): string[] {
  const file = cache.getFile(uri)!;
  const lines = file.tree.rootNode.text.split('\n');
  const line = lines[lineIdx];
  const character = line.indexOf('")');
  assert.ok(character >= 0, `line ${lineIdx} has no \`")\`: ${line}`);
  return nedCompletion(cache, file, file.tree, { line: lineIdx, character }, line).map((i) => i.label);
}

const SUB = `simple SBase {
    gates:
        input in;
        output out;
}
`;

test('display: submodule @display offers submodule tags, not background/connection tags', async () => {
  const ned = SUB + `module M {
    submodules:
        a: SBase {
            @display("");
        }
}
`;
  const cache = await nedCache({ 'file:///d.ned': ned });
  const labels = completeInDisplay(cache, 'file:///d.ned', 8);
  for (const k of ['p', 'b', 'i', 'is', 'it', 'i2', 'r', 'q', 't', 'tt', 'g']) {
    assert.ok(labels.includes(k), `expected submodule tag ${k} in ${labels.join(',')}`);
  }
  for (const k of ['bgb', 'bgi', 'ls', 'm']) {
    assert.ok(!labels.includes(k), `unexpected ${k} in submodule context`);
  }
});

test('display: compound-module @display offers background tags plus submodule tags', async () => {
  const ned = `module M {
    parameters:
        @display("");
}
`;
  const cache = await nedCache({ 'file:///c.ned': ned });
  const labels = completeInDisplay(cache, 'file:///c.ned', 2);
  for (const k of ['bgb', 'bgi', 'bgg', 'bgtt', 'bgu', 'p', 'b', 'i', 't']) {
    assert.ok(labels.includes(k), `expected ${k} in compound context, got ${labels.join(',')}`);
  }
  for (const k of ['ls', 'm']) {
    assert.ok(!labels.includes(k), `unexpected connection tag ${k} in compound context`);
  }
});

test('display: connection @display offers only connection tags', async () => {
  const ned = SUB + `module M {
    submodules:
        a: SBase {}
        b: SBase {}
    connections:
        a.out --> { @display(""); } --> b.in;
}
`;
  const cache = await nedCache({ 'file:///conn.ned': ned });
  const labels = completeInDisplay(cache, 'file:///conn.ned', 10);
  assert.deepStrictEqual([...labels].sort(), ['ls', 'm', 't', 'tt']);
});

test('display: argument value enums (shape, icon size, text pos, line style, bg mode)', async () => {
  const mk = (content: string) =>
    SUB + `module M {
    submodules:
        a: SBase {
            @display("${content}");
        }
}
`;
  const cache = await nedCache({
    'file:///shape.ned': mk('b=10,10,'),
    'file:///size.ned': mk('is='),
    'file:///pos.ned': mk('t=hi,'),
  });
  assert.deepStrictEqual(completeInDisplay(cache, 'file:///shape.ned', 8).sort(), ['oval', 'rect']);
  assert.deepStrictEqual(
    completeInDisplay(cache, 'file:///size.ned', 8).sort(),
    ['l', 'n', 's', 'vl', 'vs', 'xl', 'xs'].sort(),
  );
  assert.deepStrictEqual(completeInDisplay(cache, 'file:///pos.ned', 8).sort(), ['l', 'r', 't']);
});

test('display: connection arg enums (line style, routing) and color args', async () => {
  const mk = (content: string) =>
    SUB + `module M {
    submodules:
        a: SBase {}
        b: SBase {}
    connections:
        a.out --> { @display("${content}"); } --> b.in;
}
`;
  const cache = await nedCache({
    'file:///ls.ned': mk('ls=red,2,'),
    'file:///m.ned': mk('m='),
  });
  assert.deepStrictEqual(
    completeInDisplay(cache, 'file:///ls.ned', 10).sort(),
    ['dashed', 'dotted', 'solid'],
  );
  // routing mode enum present
  const routing = completeInDisplay(cache, 'file:///m.ned', 10);
  for (const v of ['a', 'm', 'n', 'e', 's', 'w']) assert.ok(routing.includes(v));
});

test('display: color-typed argument offers named colors', async () => {
  const ned = SUB + `module M {
    submodules:
        a: SBase {
            @display("i=device,");
        }
}
`;
  const cache = await nedCache({ 'file:///color.ned': ned });
  const labels = completeInDisplay(cache, 'file:///color.ned', 8);
  assert.ok(labels.includes('red') && labels.includes('blue') && labels.includes('black'));
});

test('display: bgi mode enum in compound context', async () => {
  const ned = `module M {
    parameters:
        @display("bgi=back,");
}
`;
  const cache = await nedCache({ 'file:///bgi.ned': ned });
  assert.deepStrictEqual(
    completeInDisplay(cache, 'file:///bgi.ned', 2).sort(),
    ['center', 'fix', 'stretch', 'tile'],
  );
});

test('displayCursorContext: distinguishes tag key vs argument index', () => {
  assert.deepStrictEqual(displayCursorContext(''), { typingKey: true, partial: '' });
  assert.deepStrictEqual(displayCursorContext('p=1,1;'), { typingKey: true, partial: '' });
  assert.deepStrictEqual(displayCursorContext('p=1,1;i'), { typingKey: true, partial: 'i' });
  assert.deepStrictEqual(displayCursorContext('b='), { typingKey: false, tagKey: 'b', argIndex: 0 });
  assert.deepStrictEqual(displayCursorContext('b=10,10,'), {
    typingKey: false,
    tagKey: 'b',
    argIndex: 2,
  });
  assert.deepStrictEqual(displayCursorContext('p=1,1;ls=red,'), {
    typingKey: false,
    tagKey: 'ls',
    argIndex: 1,
  });
});
