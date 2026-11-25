# /// script
# dependencies = ["playwright"]
# ///
"""GPU/CPU attribution of a pan frame by render pass, per theme, size and zoom (production bench build).
usage: gpuattr.py <radiant tree> <sizes> <themes> <zooms> <variants> <engine> <rounds> <out.json>"""
import json, sys, time
sys.path.insert(0, '/Users/parth/projects/general/mind_maps/radiant/autoresearch/bench')
import common
from pathlib import Path
from playwright.sync_api import sync_playwright
tree, sizes, themes, zooms, variants, engine, rounds, out = sys.argv[1:9]
sizes = [int(s) for s in sizes.split(',')]; themes = themes.split(','); zooms = zooms.split(','); variants = variants.split(',')
rounds = int(rounds)
PATCH = """(v) => {
  const r = window.__radiant.renderer;
  const P = Object.getPrototypeOf(r);
  for (const k of ['drawShadowLayer','drawMesh','drawPlaced','drawRects','drawShadows','drawLabels','compositeShadowLayer']) r[k] = P[k];
  if (v === 'noShadowLayer') r.drawShadowLayer = () => 0;
  if (v === 'noMesh') r.drawMesh = () => {};
  if (v === 'noRects') { r.drawPlaced = () => {}; r.drawRects = () => {}; r.drawShadows = () => {}; }
  if (v === 'noRectShadows') { const dp = P.drawPlaced; r.drawPlaced = function (p, ...a) { if (p === this.progShadow) return; return dp.call(this, p, ...a); }; r.drawShadows = () => {}; }
  if (v === 'noLabels') r.drawLabels = () => false;
  if (v === 'onlyMesh') { r.drawShadowLayer = () => 0; r.drawPlaced = () => {}; r.drawRects = () => {}; r.drawShadows = () => {}; r.drawLabels = () => false; }
}"""
dist, info = common.build(Path(tree))
res = []
with common.serve(dist) as url, sync_playwright() as p:
  br = common.launch(p, engine)
  for rnd in range(rounds):
    for n in sizes:
      ctx, pg, env, errors = common.open_page(br, url)
      pg.evaluate("(n) => window.__benchRun.load(n, 'clean')", n)
      for t in themes:
        rb = pg.evaluate("(t) => window.__benchRun.rebuild(t)", t)
        for z in zooms:
          zs = 'fit' if z == 'fit' else float(z)
          for v in variants:
            pg.evaluate(PATCH, v)
            r = pg.evaluate("(z) => window.__benchRun.pan(z)", zs)
            pg.evaluate(PATCH, 'all')
            row = {'round': rnd, 'n': n, 'theme': t, 'zoom': z, 'variant': v, 'gpu': r['gpuMean'], 'cpu': r['scriptMean'], 'items': r['itemsMedian'], 'z': r['zoom'], 'tri': None}
            res.append(row); print(json.dumps(row), flush=True)
      ctx.close()
  br.close()
json.dump({'info': info, 'rows': res}, open(out, 'w'), indent=1)
