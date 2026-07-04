import { test } from 'bun:test';
import assert from 'node:assert';
import { scanCpp, isCppSourceFile } from '../cpp/cppScanner';

test('isCppSourceFile accepts C++ sources and rejects generated/other files', () => {
  for (const ok of ['Foo.cc', 'Foo.h', 'a.cpp', 'b.hpp', 'c.cxx', 'd.hh']) {
    assert.equal(isCppSourceFile(ok), true, ok);
  }
  for (const no of ['Foo_m.cc', 'Foo_m.h', 'Msg_m.cpp', 'x.ned', 'y.msg', 'z.ini', 'notes.txt']) {
    assert.equal(isCppSourceFile(no), false, no);
  }
});

test('Define_Module inside a namespace qualifies the class', () => {
  const src = `
namespace inet {
class Foo : public cSimpleModule {
  void initialize() override;
};
Define_Module(Foo);
}
`;
  const { classes } = scanCpp('file:///Foo.cc', src);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].qualifiedName, 'inet::Foo');
  assert.equal(classes[0].simpleName, 'Foo');
  assert.equal(classes[0].kind, 'module');
});

test('Define_Channel and explicitly-qualified Define_Module', () => {
  const src = `
Define_Channel(MyChannel);
namespace a { namespace b {
Define_Module(::top::Thing);
}}
`;
  const { classes } = scanCpp('file:///x.cc', src);
  const byName = Object.fromEntries(classes.map((c) => [c.qualifiedName, c.kind]));
  assert.equal(byName['MyChannel'], 'channel');
  assert.equal(byName['top::Thing'], 'module'); // leading :: stripped, kept as-written
});

test('Register_Class and Register_Abstract_Class are recognized registrations', () => {
  const src = `
namespace demo {
Register_Class(MyObject);
Register_Abstract_Class(AbstractBase);
Define_Module(Widget);
}
`;
  const { classes } = scanCpp('file:///r.cc', src);
  const byName = Object.fromEntries(classes.map((c) => [c.qualifiedName, { kind: c.kind, macro: c.macro }]));
  assert.deepEqual(byName['demo::MyObject'], { kind: 'class', macro: 'Register_Class' });
  assert.deepEqual(byName['demo::AbstractBase'], { kind: 'class', macro: 'Register_Abstract_Class' });
  assert.deepEqual(byName['demo::Widget'], { kind: 'module', macro: 'Define_Module' });
});

test('par/gate/getSubmodule accesses attributed to out-of-line method class', () => {
  const src = `
namespace inet {
void UdpApp::initialize(int stage) {
  numPackets = par("numPackets");
  cGate *g = gate("socketOut");
  auto *m = getSubmodule("sink");
}
}
`;
  const { accesses } = scanCpp('file:///UdpApp.cc', src);
  const got = accesses.map((a) => `${a.ownerClass}/${a.kind}/${a.name}`).sort();
  assert.deepEqual(got, [
    'inet::UdpApp/gate/socketOut',
    'inet::UdpApp/param/numPackets',
    'inet::UdpApp/submodule/sink',
  ]);
});

test('accesses inside an in-class method body use the class-body context', () => {
  const src = `
class Foo {
  void handleMessage(cMessage *msg) {
    if (par("verbose").boolValue()) {
      for (int i = 0; i < gateSize("in"); i++)
        this->gate("in", i)->deliver(msg);
    }
  }
};
`;
  const { accesses } = scanCpp('file:///Foo.h', src);
  const got = accesses.map((a) => `${a.ownerClass}/${a.kind}/${a.name}`).sort();
  assert.deepEqual(got, ['Foo/gate/in', 'Foo/gate/in', 'Foo/param/verbose']);
});

test('comments, strings and preprocessor lines do not produce false accesses', () => {
  const src = `
#define par(x) something
// par("commented") should be ignored
/* gate("blockcomment") ignored */
const char *s = "par(\\"instring\\")";
void Bar::f() { par("real"); }
`;
  const { accesses } = scanCpp('file:///Bar.cc', src);
  assert.equal(accesses.length, 1);
  assert.equal(accesses[0].name, 'real');
  assert.equal(accesses[0].ownerClass, 'Bar');
});

test('fully-qualified out-of-line definition keeps its namespace', () => {
  const src = `void inet::queueing::PacketQueue::initialize() { par("frameCapacity"); }`;
  const { accesses } = scanCpp('file:///q.cc', src);
  assert.equal(accesses.length, 1);
  assert.equal(accesses[0].ownerClass, 'inet::queueing::PacketQueue');
  assert.equal(accesses[0].name, 'frameCapacity');
});

test('non-literal par() arguments are (intentionally) not captured', () => {
  const src = `void X::f(){ par(parName.c_str()); par("kept"); }`;
  const { accesses } = scanCpp('file:///X.cc', src);
  assert.deepEqual(
    accesses.map((a) => a.name),
    ['kept'],
  );
});
