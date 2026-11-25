# /// script
# dependencies = ["playwright"]
# ///
import json, time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
  br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
  pg = br.new_page(viewport={"width": 1728, "height": 1117}, device_scale_factor=2)
  pg.goto("http://127.0.0.1:1443/?demo=big&n=20000")
  pg.wait_for_function("() => window.__radiant && window.__radiant.pipeline && window.__radiant.pipeline.layout && window.__radiant.pipeline.layout.boxes.size >= 19000", timeout=180000)
  time.sleep(1.5)
  for t in ['clean', 'soft-clay', 'lifted-arcs', 'rope', 'paper-quilling']:
    pg.evaluate("(t) => window.__radiant.c.setTheme(t)", t)
    pg.wait_for_function("(t) => window.__radiant.pipeline.theme.id === t", arg=t, timeout=120000)
    time.sleep(2.5)
    r = pg.evaluate("""async () => {
      const { c, renderer: r } = window.__radiant;
      c.zoomFit(false);
      for (let i = 0; i < 3; i++) { r.render(); await new Promise(res => setTimeout(res, 300)); }
      r.render();
      const full = r.mesh ? r.mesh.count / 3 : 0;
      return { zoom: c.camera.getState().zoom, drawnTriangles: r.stats.meshTriangles, fullTriangles: full, coarse: !!(r.mesh && r.mesh.coarse && r.mesh.coarse.ibo), lod: !!(r.mesh && r.mesh.lod),
        relief: r.mesh && r.mesh.relief ? r.mesh.relief.material : null, maxWidthPx: r.mesh && r.mesh.relief ? r.mesh.relief.maxWidth * c.camera.getState().zoom : null };
    }""")
    print(t, json.dumps(r), flush=True)
  br.close()
