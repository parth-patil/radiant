# /// script
# dependencies = ["playwright"]
# ///
import json, sys, time
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
SIZES = [int(x) for x in sys.argv[2].split(',')]
THEMES = sys.argv[3].split(',')
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    for n in SIZES:
        pg.goto(f"http://127.0.0.1:1443/?demo=big&n={n}")
        pg.wait_for_function("() => window.__radiant && window.__radiant.pipeline && window.__radiant.pipeline.layout && window.__radiant.pipeline.layout.boxes.size >= %d * 0.99" % n, timeout=180000)
        time.sleep(1.0)
        for t in THEMES:
            pg.evaluate("(t) => window.__radiant.c.setTheme(t)", t)
            pg.wait_for_function("(t) => window.__radiant.pipeline.theme.id === t", arg=t, timeout=120000)
            time.sleep(2.5)
            info = pg.evaluate("""() => {
              const P = window.__radiant.pipeline;
              return JSON.stringify({ themeId: P.theme.id, relief: P.meshOptions() ?? null, specs: P.branchSpecs() });
            }""")
            open(f"{OUT}/specs-{n}-{t}.json", "w").write(info)
            d = json.loads(info)
            print(n, d['themeId'], d['relief'] and d['relief']['material'], len(d['specs']), len(info)//1024, 'KiB', flush=True)
    b.close()
