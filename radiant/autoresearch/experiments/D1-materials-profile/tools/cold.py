# /// script
# dependencies = ["playwright"]
# ///
# Cold build sequence (fresh page per run), modules interleaved: cold.py <modA,modB,...> <n> <themes> <engine> <runs> <out>
import json, sys, subprocess, time, socket
from playwright.sync_api import sync_playwright
mods, n, themes, engine, runs, out = sys.argv[1].split(','), sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6]
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench/serve.py', str(port), '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench', 'isolate'])
time.sleep(0.8)
res = []
try:
  with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--js-flags=--expose-gc"]) if engine == 'chrome' else p.webkit.launch()
    for r in range(runs):
      for m in (mods if r % 2 == 0 else mods[::-1]):
        ctx = br.new_context(); pg = ctx.new_page()
        pg.goto(f"http://127.0.0.1:{port}/cold.html?n={n}&themes={themes}&a={m}")
        pg.wait_for_function("() => window.__result", timeout=600000, polling=200)
        x = pg.evaluate("() => window.__result")
        res.append({'mod': m, 'run': r, 'engine': engine, 'rows': x})
        print(m, r, ' | '.join(f"{y['theme']} {y['mesh']:.0f}+{y['pack']:.0f}" for y in x), flush=True)
        ctx.close()
    br.close()
finally:
  srv.kill()
json.dump(res, open(out, 'w'), indent=1)
