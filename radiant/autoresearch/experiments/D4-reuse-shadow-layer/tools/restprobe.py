# /// script
# dependencies = ["playwright"]
# ///
"""GPU and main-thread ms of frames drawn at rest (same camera, nothing changed), parent against candidate, interleaved.
usage: restprobe.py <treeA> <treeB> <sizes> <themes> <zooms> <rounds> <out.json>"""
import json, sys
sys.path.insert(0, '/Users/parth/projects/general/mind_maps/radiant/autoresearch/bench')
import common
from pathlib import Path
from playwright.sync_api import sync_playwright
ta, tb, sizes, themes, zooms, rounds, out = sys.argv[1:8]
sizes = [int(s) for s in sizes.split(',')]; themes = themes.split(','); zooms = zooms.split(','); rounds = int(rounds)
REST = """async (z) => {
  const b = window.__radiantBench, r = window.__radiant.renderer;
  if (z === 'fit') b.fit(); else { const id = b.nodeAtDepth(2, 0.5); const box = b.box(id); b.setCamera({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: +z }); }
  await window.__benchRun.untilIdle();
  await new Promise(res => setTimeout(res, 300));
  b.gpuTimer(true); b.gpuSamples();
  const draws = []; const off = b.onFrame(f => draws.push(f.drawMs));
  for (let i = 0; i < 40; i++) { r.render(); await new Promise(res => requestAnimationFrame(() => res())); }
  await new Promise(res => setTimeout(res, 200));
  off(); const gpu = b.gpuSamples(); b.gpuTimer(false);
  const med = (x) => { const s = [...x].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
  return { gpu: med(gpu.slice(5)), cpu: med(draws.slice(5)), n: gpu.length };
}"""
res = []
with common.exclusive_lock('materials rest probe'), sync_playwright() as p:
  builds = {k: common.build(Path(t)) for k, t in (('A', ta), ('B', tb))}
  servers = {k: common.serve(d) for k, (d, _) in builds.items()}
  urls = {k: s.__enter__() for k, s in servers.items()}
  br = common.launch(p, 'chrome')
  for rnd in range(rounds):
    for n in sizes:
      for k in (('A', 'B') if rnd % 2 == 0 else ('B', 'A')):
        ctx, pg, env, errors = common.open_page(br, urls[k])
        pg.evaluate("(n) => window.__benchRun.load(n, 'clean')", n)
        for t in themes:
          pg.evaluate("(t) => window.__benchRun.rebuild(t)", t)
          for z in zooms:
            r = pg.evaluate(REST, z)
            row = {'round': rnd, 'tree': k, 'n': n, 'theme': t, 'zoom': z, **r}
            res.append(row); print(json.dumps(row), flush=True)
        ctx.close()
  br.close()
  for s in servers.values(): s.__exit__(None, None, None)
json.dump({'builds': {k: v[1] for k, v in builds.items()}, 'rows': res}, open(out, 'w'), indent=1)
