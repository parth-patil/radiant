// JSC kernel bench under bun: node kb-bun.mjs <module> <n> <themes> <reps>
const [mod, n, themes, reps] = process.argv.slice(2);
const M = await import(mod);
const out = {};
for (const theme of themes.split(',')) {
  const data = JSON.parse(await Bun.file(import.meta.dir + '/data/specs-' + n + '-' + theme + '.json').text());
  const relief = data.relief || undefined, specs = data.specs;
  const miss = [], pack = [];
  for (let r = 0; r < +reps + 2; r++) {
    Bun.gc(true);
    let t = performance.now();
    const mesh = new M.BranchMeshCache().build(specs, relief);
    const a = performance.now() - t;
    t = performance.now();
    M.packVertices(mesh);
    const b = performance.now() - t;
    if (r >= 2) { miss.push(a); pack.push(b); }
  }
  const med = (x) => [...x].sort((p, q) => p - q)[x.length >> 1];
  out[theme] = { miss: +med(miss).toFixed(1), missMin: +Math.min(...miss).toFixed(1), pack: +med(pack).toFixed(1) };
  console.log(theme, JSON.stringify(out[theme]));
}
