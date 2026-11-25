# /// script
# dependencies = ["playwright"]
# ///
"""GPU time per render pass (sequential EXT_disjoint_timer_query_webgl2 queries around renderer methods) while panning.
usage: gpupass.py <tree> <sizes> <themes> <zooms> <rounds> <out.json>"""
import json, sys
sys.path.insert(0, '/Users/parth/projects/general/mind_maps/radiant/autoresearch/bench')
import common
from pathlib import Path
from playwright.sync_api import sync_playwright
tree, sizes, themes, zooms, rounds, out = sys.argv[1:7]
sizes = [int(s) for s in sizes.split(',')]; themes = themes.split(','); zooms = zooms.split(','); rounds = int(rounds)
INSTALL = """() => {
  const r = window.__radiant.renderer, gl = r.gl;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const P = Object.getPrototypeOf(r);
  const pending = []; const sums = {}; window.__passes = sums;
  const collect = () => {
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { pending.length = 0; return; }
    while (pending.length && gl.getQueryParameter(pending[0][1], gl.QUERY_RESULT_AVAILABLE)) {
      const [name, q] = pending.shift();
      (sums[name] ??= []).push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };
  let active = false;
  const wrap = (name, label) => {
    const f = P[name];
    r[name] = function (...a) {
      if (active || !window.__timing) return f.apply(this, a);
      const lab = typeof label === 'function' ? label.call(this, a) : label;
      if (!lab) return f.apply(this, a);
      active = true;
      const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      try { return f.apply(this, a); } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push([lab, q]); active = false; }
    };
  };
  wrap('drawShadowLayer', 'shadowLayer');
  wrap('compositeShadowLayer', 'composite');
  wrap('drawMesh', function (a) { return a[0] && a[0] === this.mesh ? 'mesh' : null; });
  wrap('drawPlaced', function (a) { return a[0] === this.progShadow ? 'rectShadows' : 'rects'; });
  wrap('drawRects', 'rects');
  wrap('drawShadows', 'rectShadows');
  wrap('drawLabels', 'labels');
  const render = r.render;
  r.render = function () { collect(); if (!window.__timing) return render.call(this); active = false;
    const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); active = true;
    // whole frame measured separately on alternate frames to avoid nesting
    if (window.__whole) { try { return render.call(this); } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(['frame', q]); active = false; } }
    gl.endQuery(ext.TIME_ELAPSED_EXT); gl.deleteQuery(q); active = false; return render.call(this); };
  window.__collect = collect;
}"""
res = []
with common.exclusive_lock('materials gpupass probe'), sync_playwright() as p:
  dist, info = common.build(Path(tree))
  srv = common.serve(dist); url = srv.__enter__()
  br = common.launch(p, 'chrome')
  for rnd in range(rounds):
    for n in sizes:
      ctx, pg, env, errors = common.open_page(br, url)
      pg.evaluate("(n) => window.__benchRun.load(n, 'clean')", n)
      pg.evaluate(INSTALL)
      for t in themes:
        pg.evaluate("(t) => window.__benchRun.rebuild(t)", t)
        for z in zooms:
          zs = 'fit' if z == 'fit' else float(z)
          row = {'round': rnd, 'n': n, 'theme': t, 'zoom': z}
          for whole in (False, True):
            pg.evaluate("(w) => { for (const k in window.__passes) delete window.__passes[k]; window.__whole = w; window.__timing = true; }", whole)
            r = pg.evaluate("(z) => window.__benchRun.pan(z, { gpu: false })", zs)
            pg.evaluate("() => new Promise(r => setTimeout(r, 200))")
            sums = pg.evaluate("() => { window.__collect(); window.__timing = false; return window.__passes; }")
            for k, v in sums.items():
              v = v[len(v) // 5:] if len(v) > 10 else v
              row[k] = round(sorted(v)[len(v) // 2], 3) if v else None
            row['cpu' if not whole else 'cpu_whole'] = round(r['scriptMean'], 3)
          res.append(row); print(json.dumps(row), flush=True)
      ctx.close()
  br.close()
  srv.__exit__(None, None, None)
json.dump({'info': info, 'rows': res}, open(out, 'w'), indent=1)
