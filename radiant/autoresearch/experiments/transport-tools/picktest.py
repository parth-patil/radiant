# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Compare branch picking (pipeline.hitBranch) between two builds on fixed points; time the first pick."""
import sys, json
sys.path.insert(0, "/Users/parth/projects/general/mind_maps/radiant/autoresearch/bench")
import common
from pathlib import Path
from playwright.sync_api import sync_playwright
JS = r"""
async ([n, theme]) => {
  const b = window.__radiantBench, R = window.__radiant;
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 3000 && q < 3; i++) { await raf(); q = b.idle() ? q + 1 : 0; } };
  b.loadSynthetic(n); await settle();
  if (theme !== 'clean') { b.setTheme(theme); await settle(); }
  const p = R.pipeline;
  const ids = [...p.layout.boxes.keys()];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pts = [];
  for (let i = 0; i < 3000; i++) {
    const id = ids[Math.floor(rnd() * ids.length)];
    const node = R.c.doc.nodes[id]; if (!node.parent) continue;
    const a = p.layout.boxes.get(node.parent), c = p.layout.boxes.get(id);
    const t = rnd();
    pts.push({ x: a.x + (c.x - a.x) * t + (rnd() - .5) * 6, y: a.y + (c.y - a.y) * t + (rnd() - .5) * 6 });
  }
  const t0 = performance.now();
  const first = p.hitBranch(pts[0]);
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  const index = new Map(ids.map((id, i) => [id, i]));
  const hits = pts.map(q => { const h = p.hitBranch(q); return h ? index.get(h) : null; });
  const restMs = (performance.now() - t1) / pts.length;
  return { hits, firstMs, restMs, found: hits.filter(Boolean).length };
}
"""
trees = sys.argv[1:3]; n = int(sys.argv[3]); themes = sys.argv[4].split(","); eng = sys.argv[5] if len(sys.argv) > 5 else "chrome"
builds = [common.build(Path(t))[0] for t in trees]
with sync_playwright() as p:
    br = common.launch(p, eng)
    for theme in themes:
        res = []
        for d in builds:
            with common.serve(d) as url:
                ctx = br.new_context(viewport=common.VIEWPORT, device_scale_factor=2, reduced_motion="reduce")
                pg = ctx.new_page(); pg.goto(url + "/"); pg.wait_for_function("() => window.__radiantBench && window.__radiant")
                res.append(pg.evaluate(JS, [n, theme])); ctx.close()
        a, b = res
        diff = sum(1 for x, y in zip(a["hits"], b["hits"]) if x != y)
        print(f"{eng} {n} {theme}: points {len(a['hits'])} hits A {a['found']} B {b['found']} differing {diff}; first pick ms A {a['firstMs']:.2f} B {b['firstMs']:.2f}; later pick ms A {a['restMs']:.4f} B {b['restMs']:.4f}")
    br.close()
