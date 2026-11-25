# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Smoke test of the fold animation (motion on) and of a theme switch: page errors, triangles per frame, frames drawn."""
import sys
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
  b.fit(); await settle();
  const fold = b.nodeWithSubtreeNear(300);
  const tris = [];
  const off = b.onFrame(() => tris.push(R.renderer.stats.meshTriangles));
  b.toggleFold(fold.id); await settle();
  b.toggleFold(fold.id); await settle();
  off();
  const parent = b.nodeAtDepth(3, 0.5);
  b.addChild(parent, 'x'); await settle();
  return { frames: tris.length, tris: tris.join(','), final: R.renderer.stats.meshTriangles };
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
                ctx = br.new_context(viewport=common.VIEWPORT, device_scale_factor=2, reduced_motion="no-preference")
                pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
                pg.goto(url + "/"); pg.wait_for_function("() => window.__radiantBench && window.__radiant")
                r = pg.evaluate(JS, [n, theme]); r["errors"] = errs; res.append(r); ctx.close()
        for name, r in zip("AB", res):
            print(f"{eng} {n} {theme} {name}: frames {r['frames']} final tris {r['final']} errors {r['errors'][:2]}")
            print(f"   tris/frame: {r['tris'][:300]}")
    br.close()
