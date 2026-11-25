// Cold sequence under node (V8): node cold-node.mjs <module> <n> <themes>
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [mod, n, themes] = process.argv.slice(2);
const M = await import(mod);
const datas = {};
for (const theme of themes.split(',')) datas[theme] = JSON.parse(readFileSync(here + '/data/specs-' + n + '-' + theme + '.json', 'utf8'));
const cache = new M.BranchMeshCache();
const row = [];
for (const theme of themes.split(',')) {
  const { relief, specs } = datas[theme];
  globalThis.gc?.();
  let t = performance.now();
  const mesh = cache.build(specs, relief || undefined);
  const a = performance.now() - t;
  t = performance.now();
  M.packVertices(mesh);
  const b = performance.now() - t;
  row.push(theme + ' ' + a.toFixed(0) + '+' + b.toFixed(0));
}
console.log(row.join(' | '));
