import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  MsgResourceCache,
  resolveNedClass,
  nedClassDefinition,
  findMsgUsagesInNed,
} from '../index';
import type { ParserService } from '../index';

async function build(nedFiles: Record<string, string>, msgFiles: Record<string, string>) {
  const svc: ParserService = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(nedFiles)) nedCache.addFile(uri, svc.parse('ned', text), '');
  const msgCache = new MsgResourceCache();
  for (const [uri, text] of Object.entries(msgFiles)) msgCache.addFile(uri, svc.parse('msg', text));
  return { svc, nedCache, msgCache };
}

const NED =
  'package p;\n@namespace(myns);\n' +
  'simple Sender {\n @class(SenderImpl);\n @signal[out](type=MyPacket);\n}\n' +
  'simple Bogus { @class(NoSuchClass); }\n';

const MSG = 'namespace myns;\nclass SenderImpl { }\npacket MyPacket { }\n';

test('resolveNedClass resolves @class/@signal tokens via the NED @namespace', async () => {
  const { nedCache, msgCache } = await build({ 'file:///p.ned': NED }, { 'file:///p.msg': MSG });
  const sender = nedCache.getType('p.Sender')!;
  assert.equal(resolveNedClass(msgCache, sender, 'SenderImpl')?.fqName, 'myns::SenderImpl');
  assert.equal(resolveNedClass(msgCache, sender, 'MyPacket')?.fqName, 'myns::MyPacket');
  assert.equal(resolveNedClass(msgCache, sender, 'NoSuch'), undefined);
});

test('nedClassDefinition jumps from @class to the MSG declaration', async () => {
  const { nedCache, msgCache } = await build({ 'file:///p.ned': NED }, { 'file:///p.msg': MSG });
  const file = nedCache.getFile('file:///p.ned')!;
  // position on the @class(SenderImpl) value (line 3: " @class(SenderImpl);")
  const def = nedClassDefinition(msgCache, nedCache, file, file.tree, { line: 3, character: 10 });
  assert.ok(def, 'should resolve a definition');
  assert.equal(def!.uri, 'file:///p.msg');
});

test('findMsgUsagesInNed returns NED sites that reference a MSG type', async () => {
  const { nedCache, msgCache } = await build({ 'file:///p.ned': NED }, { 'file:///p.msg': MSG });
  const uses = findMsgUsagesInNed(msgCache, nedCache, 'myns::MyPacket');
  assert.equal(uses.length, 1);
  assert.equal(uses[0].uri, 'file:///p.ned');
});

test('an unresolved @class (C++-only class) resolves to nothing without erroring', async () => {
  // @class names a registered C++ class, which is often hand-written C++ with no
  // .msg file. resolveNedClass simply returns undefined — there is no diagnostic.
  const { nedCache, msgCache } = await build({ 'file:///p.ned': NED }, { 'file:///p.msg': MSG });
  const bogus = nedCache.getType('p.Bogus')!;
  assert.equal(resolveNedClass(msgCache, bogus, 'NoSuchClass'), undefined);
});
