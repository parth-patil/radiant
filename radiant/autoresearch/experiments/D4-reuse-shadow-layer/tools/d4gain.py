# /// script
# dependencies = ["playwright"]
# ///
# GPU ms of frames at rest with the shadow layer reused (D4) or forced to redraw (as before D4), same page, alternated.
import json, time
from playwright.sync_api import sync_playwright
JS = """async (force) => {
  const { renderer: r } = window.__radiant; const gl = r.gl;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const qs = [], out = [];
  for (let i = 0; i < 40; i++) {
    if (force && r.shadowLayer) r.shadowLayer.drawn = null;
    const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); r.render(); gl.endQuery(ext.TIME_ELAPSED_EXT); qs.push(q);
    await new Promise(res => requestAnimationFrame(res));
  }
  await new Promise(res => setTimeout(res, 300));
  for (const q of qs) if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
  out.sort((a, b) => a - b); return out.length ? out[out.length >> 1] : null;
}"""
with sync_playwright() as p:
  br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
  pg = br.new_page(viewport={"width": 1728, "height": 1117}, device_scale_factor=2)
  pg.goto("http://127.0.0.1:1443/?demo=big&n=20000")
  pg.wait_for_function("() => window.__radiant && window.__radiant.pipeline && window.__radiant.pipeline.layout && window.__radiant.pipeline.layout.boxes.size >= 19000", timeout=180000)
  time.sleep(1.5)
  for t in ['soft-clay', 'lifted-arcs', 'rope', 'paper-quilling']:
    pg.evaluate("(t) => window.__radiant.c.setTheme(t)", t)
    pg.wait_for_function("(t) => window.__radiant.pipeline.theme.id === t", arg=t, timeout=120000)
    time.sleep(2.5)
    for z in [0.35, 1.0]:
      pg.evaluate("(z) => { const { c } = window.__radiant; const b = [...window.__radiant.pipeline.layout.boxes.values()][2000]; c.camera.set({ cx: b.x, cy: b.y, zoom: z }); }", z)
      time.sleep(1.5)
      res = {'reuse': [], 'redraw': []}
      for k in range(3):
        for f in ((False, True) if k % 2 == 0 else (True, False)):
          res['redraw' if f else 'reuse'].append(round(pg.evaluate(JS, f), 3))
      print(t, z, json.dumps(res), flush=True)
  br.close()
