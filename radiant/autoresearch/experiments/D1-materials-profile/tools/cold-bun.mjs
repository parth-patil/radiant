// Cold sequence like the benchmark: one build per theme in order, fresh process. bun cold-bun.mjs <module> <n> <themes>
const [mod, n, themes] = process.argv.slice(2);
const M = await import(mod);
const datas = {};
for (const theme of themes.split(',')) datas[theme] = JSON.parse(await Bun.file(import.meta.dir + '/data/specs-' + n + '-' + theme + '.json').text());
const cache = new M.BranchMeshCache();
const row = [];
for (const theme of themes.split(',')) {
  const { relief, specs } = datas[theme];
  Bun.gc(true);
  let t = performance.now();
  const mesh = cache.build(specs, relief || undefined);
  const a = performance.now() - t;
  t = performance.now();
  M.packVertices(mesh);
  const b = performance.now() - t;
  row.push(theme + ' ' + a.toFixed(0) + '+' + b.toFixed(0));
}
console.log(row.join(' | '));
