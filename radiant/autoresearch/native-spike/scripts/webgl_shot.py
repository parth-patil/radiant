# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
import json, sys, time
from playwright.sync_api import sync_playwright
out = sys.argv[1]
cams = json.load(open(sys.argv[2]))["bases"]["5000"]
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:1420/?demo=big&n=5000")
    pg.wait_for_function("() => window.__radiant?.renderer?.stats?.meshTriangles > 0 && window.__radiant.pipeline.nodeCount >= 5000", timeout=90000)
    for theme in ["clean", "rope"]:
        pg.evaluate(f"() => window.__radiant.c.setTheme('{theme}')")
        want = "null" if theme == "clean" else "'rope'"
        pg.wait_for_function(f"() => (window.__radiant.renderer.scene?.branches?.relief?.material ?? null) === {want}", timeout=60000)
        for sc in ["z035", "z1"]:
            c = cams[sc]
            pg.evaluate(f"() => window.__radiant.camera.set({{cx: {c['cx']}, cy: {c['cy']}, zoom: {c['zoom']}}})")
            time.sleep(1.5)
            canvas = pg.query_selector("canvas")
            canvas.screenshot(path=f"{out}/webgl-5000-{theme}-{sc}.png")
    b.close()
