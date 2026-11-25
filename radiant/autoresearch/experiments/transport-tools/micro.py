# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Clone cost of each part of an adopted layout result vs prototype codecs. Usage: micro.py DIST engine sizes themes"""
import sys, json
sys.path.insert(0, "/Users/parth/projects/general/mind_maps/radiant/autoresearch/bench")
import common
from pathlib import Path
from playwright.sync_api import sync_playwright
CODEC = (Path(__file__).parent / "codec-proto.js").read_text()
JS = r"""
async ([n, theme]) => {
  const b = window.__radiantBench, R = window.__radiant, C = window.__codec;
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 4000 && q < 3; i++) { await raf(); q = b.idle() ? q + 1 : 0; } };
  b.loadSynthetic(n); await settle();
  if (theme !== 'clean') { b.setTheme(theme); await settle(); }
  const p = R.pipeline;
  const scene = p.baseScene;
  const parts = { boxes: p.layout.boxes, placements: p.placements, specs: p.layoutBranches, labels: scene.labels, rects: scene.rects, spatialIds: p.spatial.ids ?? null };
  const med = (f, k = 5) => { const xs = []; for (let i = 0; i < k; i++) { const t = performance.now(); f(); xs.push(performance.now() - t); } xs.sort((a, b) => a - b); return +xs[k >> 1].toFixed(2); };
  const out = { n: p.nodeCount };
  for (const [k, v] of Object.entries(parts)) { if (v == null) continue; out[k + '_clone'] = med(() => structuredClone(v)); }
  out.all_clone = med(() => structuredClone(parts));
  let e;
  out.boxes_enc = med(() => { e = C.encodeBoxes(parts.boxes); });
  out.boxes_clone_enc = med(() => structuredClone(e));
  out.boxes_dec = med(() => C.decodeBoxes(e));
  for (const k of ['specs', 'labels', 'rects']) {
    let g;
    out[k + '_enc'] = med(() => { g = C.encode(parts[k]); }, 3);
    const { transfer, ...msg } = g;
    out[k + '_clone_enc'] = med(() => structuredClone(msg), 3);
    out[k + '_dec'] = med(() => C.decode(g), 3);
    const d = C.decode(g);
    out[k + '_same'] = JSON.stringify(d) === JSON.stringify(parts[k]);
    out[k + '_shapes'] = g.shapes.length;
  }
  for (const k of ['specs', 'placements', 'labels']) {
    let s;
    out[k + '_json_enc'] = med(() => { s = JSON.stringify(parts[k]); }, 3);
    out[k + '_json_mb'] = +(s.length / 1048576).toFixed(1);
    out[k + '_json_clone'] = med(() => structuredClone(s), 3);
    out[k + '_json_dec'] = med(() => JSON.parse(s), 3);
  }
  { let g; out.placements_enc = med(() => { g = C.encode(Object.values(parts.placements.nodes)); }, 3); out.placements_dec = med(() => C.decode(g), 3); out.placements_shapes = g.shapes.length; }
  return out;
}
"""
dist = Path(sys.argv[1]); eng = sys.argv[2]; sizes = [int(s) for s in sys.argv[3].split(",")]; themes = sys.argv[4].split(",")
with sync_playwright() as p, common.serve(dist) as url:
    br = common.launch(p, eng)
    for n in sizes:
        for theme in themes:
            ctx = br.new_context(viewport=common.VIEWPORT, device_scale_factor=2, reduced_motion="reduce")
            ctx.add_init_script(CODEC)
            pg = ctx.new_page(); pg.goto(url + "/"); pg.wait_for_function("() => window.__radiantBench && window.__radiant")
            print(eng, n, theme, json.dumps(pg.evaluate(JS, [n, theme])), flush=True)
            ctx.close()
    br.close()
