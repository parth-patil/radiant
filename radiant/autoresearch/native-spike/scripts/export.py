# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
"""Export what the Radiant WebGL renderer draws (branch mesh, rects, labels, camera) for native spikes."""
import base64, json, os, sys, time
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
SIZES = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [5000, 50000]
THEMES = sys.argv[3].split(",") if len(sys.argv) > 3 else ["clean", "rope"]
JS_INFO = """(theme) => {
  const { c, renderer, pipeline, camera } = window.__radiant;
  const s = renderer.scene, m = s.branches, g = m.gpuVertices, rel = m.relief;
  const sp = m.branchSpans;
  // dense centres for zoom 1 and 0.35 views: label with most neighbours in the view-sized window
  const L = s.labels;
  const pick = (zoom) => {
    const hw = 720 / zoom, hh = 450 / zoom;
    const cell = Math.max(hw, hh);
    const grid = new Map();
    const key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    for (const l of L) { const k = key(l.x, l.y); grid.set(k, (grid.get(k) || 0) + 1); }
    let best = null, bn = -1;
    for (let i = 0; i < L.length; i += Math.max(1, Math.floor(L.length / 2000))) {
      const l = L[i]; const gx = Math.floor(l.x / cell), gy = Math.floor(l.y / cell);
      let n = 0; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) n += grid.get((gx+dx)+','+(gy+dy)) || 0;
      if (n > bn) { bn = n; best = l; }
    }
    let cnt = 0; for (const l of L) if (Math.abs(l.x - best.x) < hw && Math.abs(l.y - best.y) < hh) cnt++;
    return { cx: best.x, cy: best.y, zoom, labelsInView: cnt };
  };
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < sp.ids.length; i++) { bx0 = Math.min(bx0, sp.bounds[4*i]); by0 = Math.min(by0, sp.bounds[4*i+1]); bx1 = Math.max(bx1, sp.bounds[4*i+2]); by1 = Math.max(by1, sp.bounds[4*i+3]); }
  for (const l of L) { bx0 = Math.min(bx0, l.x); bx1 = Math.max(bx1, l.x); by0 = Math.min(by0, l.y); by1 = Math.max(by1, l.y); }
  const fz = Math.min(1440 / (bx1 - bx0 + 80), 900 / (by1 - by0 + 80));
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => v === null ? undefined : v));
  return {
    theme, nodeCount: pipeline.nodeCount, view: [camera.width, camera.height], dpr: devicePixelRatio,
    background: s.background, surface: s.surface ?? null, grid: s.grid ?? null, raisedRects: !!s.raisedRects,
    mesh: { nv: m.positions.length / 2, ni: m.indices.length, bytes: g.buffer.byteLength, stride: g.buffer.byteLength / (m.positions.length / 2),
            ox: g.ox, oy: g.oy, wide: g.wide, spans: sp.ids.length,
            relief: rel ? { material: rel.material, maxWidth: rel.maxWidth, shadowReach: rel.shadowReach, shadowColor: rel.shadowColor, hasShadow: !!rel.shadow, hasTwist: !!rel.twist } : null },
    rects: strip(s.rects.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h, radius: r.radius, fill: r.fill, stroke: r.stroke, strokeWidth: r.strokeWidth, shadow: r.shadow, overBranches: r.overBranches, wobble: r.wobble }))),
    labels: strip(L.map(l => ({ text: l.text, x: l.x, y: l.y, fontSize: l.fontSize, fontFamily: l.fontFamily, bold: l.bold, italic: l.italic, color: l.color, maxWidth: l.maxWidth, align: l.align, alignWidth: l.alignWidth, overviewTitle: l.overviewTitle, opacity: l.opacity, curve: l.curve, extrusion: l.extrusion }))),
    images: s.images.length, overlay: s.overlay.length, animated: !!s.animatedBranches,
    cameras: { fit: { cx: (bx0 + bx1) / 2, cy: (by0 + by1) / 2, zoom: fz }, initial: camera.getState(), z035: pick(0.35), z1: pick(1.0) },
    bounds: [bx0, by0, bx1, by1],
    stats: renderer.stats, layoutMs: pipeline.lastLayoutMs, geometryMs: pipeline.lastGeometryMs
  };
}"""
JS_CHUNK = """([what, start, len]) => {
  const m = window.__radiant.renderer.scene.branches;
  const src = what === 'vtx' ? new Uint8Array(m.gpuVertices.buffer) : what === 'idx' ? new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength)
    : what === 'sb' ? new Uint8Array(m.branchSpans.bounds.buffer, m.branchSpans.bounds.byteOffset, m.branchSpans.bounds.byteLength)
    : new Uint8Array(m.branchSpans.ends.buffer, m.branchSpans.ends.byteOffset, m.branchSpans.ends.byteLength);
  if (start < 0) return src.length;
  const sub = src.subarray(start, Math.min(src.length, start + len));
  let s = ''; for (let i = 0; i < sub.length; i += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(i, i + 0x8000));
  return btoa(s);
}"""
def dump(pg, what, path):
    n = pg.evaluate(JS_CHUNK, [what, -1, 0])
    with open(path, "wb") as f:
        CH = 8 << 20
        for st in range(0, n, CH):
            f.write(base64.b64decode(pg.evaluate(JS_CHUNK, [what, st, CH])))
    return n
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    for n in SIZES:
        pg.goto(f"http://127.0.0.1:1420/?demo=big&n={n}")
        pg.wait_for_function(f"() => window.__radiant?.renderer?.stats?.meshTriangles > 0 && window.__radiant.pipeline.nodeCount >= {n}", timeout=180000)
        for theme in THEMES:
            pg.evaluate(f"() => window.__radiant.c.setTheme('{theme}')")
            want = "null" if theme == "clean" else f"'{theme}'"
            pg.wait_for_function(f"() => {{ const m = window.__radiant.renderer.scene?.branches; const r = m?.relief?.material ?? null; return ({want} === null ? r === null : r === {want}) && !!m.gpuVertices; }}", timeout=180000)
            time.sleep(2.0)
            d = os.path.join(OUT, f"{n}-{theme}")
            os.makedirs(d, exist_ok=True)
            info = pg.evaluate(JS_INFO, theme)
            sizes = {w: dump(pg, w, os.path.join(d, f"{w}.bin")) for w in ["vtx", "idx", "sb", "se"]}
            info["files"] = sizes
            with open(os.path.join(d, "scene.json"), "w") as f:
                json.dump(info, f)
            print(n, theme, json.dumps({k: info[k] for k in ["nodeCount", "mesh", "cameras", "bounds"]}), len(info["rects"]), len(info["labels"]), sizes, flush=True)
    b.close()
