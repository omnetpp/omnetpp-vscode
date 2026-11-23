import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGINS, withDependencies } from '../agents/plugin';

test('withDependencies always includes the base plugin and keeps install order', () => {
  assert.deepStrictEqual(withDependencies([]), ['omnetpp']);
  assert.deepStrictEqual(withDependencies(['omnetpp-dev']), ['omnetpp', 'omnetpp-dev']);
  assert.deepStrictEqual(withDependencies(['simu5g']), ['omnetpp', 'omnetpp-dev', 'inet', 'simu5g']);
  assert.deepStrictEqual(withDependencies(['inet', 'no-such-plugin']), ['omnetpp', 'omnetpp-dev', 'inet']);
});

test('every plugin comes after the plugins it depends on', () => {
  const seen = new Set<string>();
  for (const p of PLUGINS) {
    for (const d of p.dependencies) assert.ok(seen.has(d), `${p.name} before its dependency ${d}`);
    seen.add(p.name);
  }
});

// The marketplace is the source of truth; set AGENT_PLUGINS_DIR to a checkout of
// github.com/omnetpp/agent-plugins to check that this copy has not drifted from it.
test.skipIf(!process.env.AGENT_PLUGINS_DIR)('PLUGINS matches plugins.json of the marketplace', () => {
  const file = join(process.env.AGENT_PLUGINS_DIR as string, 'plugins.json');
  const { plugins } = JSON.parse(readFileSync(file, 'utf8')) as { plugins: { name: string; dependencies: string[] }[] };
  assert.deepStrictEqual(
    PLUGINS.map((p) => ({ name: p.name, dependencies: p.dependencies })),
    plugins.map((p) => ({ name: p.name, dependencies: p.dependencies })),
  );
});
