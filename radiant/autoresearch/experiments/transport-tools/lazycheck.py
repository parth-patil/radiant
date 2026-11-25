# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
import json
from playwright.sync_api import sync_playwright
JS = r"""
async () => {
  const R = window.__radiant, c = R.c;
  const M = await import('/src/lib/core/model/index.ts');
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 3000 && q < 3; i++) { await raf(); q = (!c.frameWorkPending && R.renderer.idle) ? q + 1 : 0; } };
  c.loadSynthetic(5000); await settle();
  const out = { afterLoad: typeof R.pipeline.layoutSource };
  const e = M.addChild(c.doc, c.doc.nodes[c.doc.roots[0]].children[0], 'lazy'); c.editor.apply(e.tx); await settle();
  out.afterAdd = typeof R.pipeline.layoutSource; out.placementsAfterAdd = typeof R.pipeline.placementSource; out.result = R.pipeline.placementsResult;
  const fold = Object.values(c.doc.nodes).find(n => n.children.length >= 2 && n.parent);
  c.toggleFoldOf(fold.id); await settle();
  out.afterFold = typeof R.pipeline.layoutSource; out.drawnLen = R.pipeline.drawnBranches.length; out.same = R.pipeline.drawnBranches === R.pipeline.layoutBranches;
  return out;
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    for motion in ["reduce", "no-preference"]:
        ctx = br.new_context(reduced_motion=motion); pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("http://127.0.0.1:1433/"); pg.wait_for_function("() => window.__radiant", timeout=60000)
        print(motion, json.dumps(pg.evaluate(JS)), errs[:2]); ctx.close()
    br.close()
