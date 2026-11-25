# /// script
# dependencies = ["playwright"]
# ///
# D4 correctness: after a pan settles (shadow layer reused from the last moving frame), the resting frame must equal a
# frame whose shadow layer is redrawn from scratch. Dev server, Chrome and WebKit.
import json, time, sys
from playwright.sync_api import sync_playwright
JS = """async () => {
  const { c, renderer: r } = window.__radiant;
  const gl = r.gl;
  const read = () => { r.render(); const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const s0 = c.camera.getState();
  for (let i = 0; i < 12; i++) { c.camera.set({ cx: s0.cx + 40 * Math.sin(i), cy: s0.cy + 25 * Math.cos(i), zoom: s0.zoom * (1 + 0.05 * Math.sin(i)) }); await new Promise(res => requestAnimationFrame(res)); }
  c.camera.set(s0);
  await new Promise(res => requestAnimationFrame(res));
  await new Promise(res => setTimeout(res, 400));
  const hit = r.shadowLayer && r.shadowLayer.drawn ? 1 : 0;
  const a = read();
  if (r.shadowLayer) r.shadowLayer.drawn = null;
  const b = read();
  let diff = 0, max = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { diff++; if (d > max) max = d; } }
  return { cached: hit, diffBytes: diff, max, zoom: s0.zoom };
}"""
with sync_playwright() as p:
  for eng in ['chrome', 'webkit']:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"]) if eng == 'chrome' else p.webkit.launch()
    pg = br.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:1443/?demo=big&n=5000")
    pg.wait_for_function("() => window.__radiant && window.__radiant.pipeline && window.__radiant.pipeline.layout && window.__radiant.pipeline.layout.boxes.size >= 4900", timeout=180000)
    time.sleep(1.5)
    for t in ['soft-clay', 'lifted-arcs', 'rope', 'paper-quilling']:
      pg.evaluate("(t) => window.__radiant.c.setTheme(t)", t)
      pg.wait_for_function("(t) => window.__radiant.pipeline.theme.id === t", arg=t, timeout=120000)
      time.sleep(2)
      for z in [0.35, 1.0, 2.0]:
        pg.evaluate("(z) => { const { c } = window.__radiant; const b = [...window.__radiant.pipeline.layout.boxes.values()][40]; c.camera.set({ cx: b.x, cy: b.y, zoom: z }); }", z)
        time.sleep(0.8)
        print(eng, t, z, json.dumps(pg.evaluate(JS)), flush=True)
    br.close()
