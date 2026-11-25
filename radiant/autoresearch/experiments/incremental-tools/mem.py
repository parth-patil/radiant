# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
import sys, json
from playwright.sync_api import sync_playwright
JS = r"""
async ([n, theme]) => {
  const R = window.__radiant, c = R.c;
  const M = await import('/src/lib/core/model/index.ts');
  const P = await import('/src/lib/ui/pipeline.ts');
  const T = await import('/src/lib/render/text.ts');
  const LT = await import('/src/lib/ui/layout-transport.ts');
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 4000 && q < 3; i++) { await raf(); q = (!c.frameWorkPending && R.renderer.idle) ? q + 1 : 0; } };
  c.loadSynthetic(n); await settle();
  if (theme !== 'clean') { c.setTheme(theme); await settle(); }
  const th = JSON.parse(JSON.stringify(c.theme));
  const doc = M.cloneDoc(JSON.parse(JSON.stringify(c.doc))); doc.layoutPlacements = undefined;
  c.loadSynthetic(20); await settle();
  const mk = (placements) => ({ doc, theme: th, anchor: null, placements, imageInfo: new Map(), failedImages: new Set(), artPending: new Map(), showGeneratedArtwork: true, prepareScene: true, editing: null });
  const p = new P.Pipeline(T.measureLabel);
  let r = p.computeWork(mk(undefined));
  gc(); gc(); const h0 = performance.memory.usedJSHeapSize;
  const w = LT.packLayoutResult({ ...r }, []);
  const len = { placements: w.placements.json?.length, specs: w.layoutBranches.json?.length, labels: w.baseScene.labels.json?.length, rects: w.baseScene.rects.json?.length };
  gc(); gc(); const h1 = performance.memory.usedJSHeapSize;
  return { len, heldMB: (h1 - h0) / 1048576 };
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--enable-precise-memory-info", "--js-flags=--expose-gc"])
    pg = br.new_page(); pg.goto("http://127.0.0.1:1441/"); pg.wait_for_function("() => window.__radiant", timeout=120000)
    for theme in sys.argv[2].split(","):
        print(theme, json.dumps(pg.evaluate(JS, [int(sys.argv[1]), theme])))
    br.close()
