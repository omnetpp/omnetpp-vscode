// Deletes dist/ so that a build holds only what it produces: files that no
// build writes any more (renamed bundles, dropped assets) would otherwise end
// up in the .vsix and the npm package.
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
console.log('dist/ cleaned.');
