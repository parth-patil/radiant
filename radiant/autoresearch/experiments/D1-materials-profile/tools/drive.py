# /// script
# dependencies = ["playwright"]
# ///
import json, sys, subprocess, time, socket, os
PAGE = os.environ.get('PAGE', 'kb.html')
from playwright.sync_api import sync_playwright
a, b, sizes, themes, out, rounds = sys.argv[1], sys.argv[2], sys.argv[3].split(','), sys.argv[4].split(','), sys.argv[5], int(sys.argv[6])
ops = sys.argv[7] if len(sys.argv) > 7 else ''
engines = (sys.argv[8] if len(sys.argv) > 8 else 'chrome,webkit').split(',')
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench/serve.py', str(port), '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench', 'isolate'])
time.sleep(0.8)
res = []
try:
  with sync_playwright() as p:
    for eng in engines:
        br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--js-flags=--expose-gc"]) if eng == 'chrome' else p.webkit.launch()
        for r in range(rounds):
            for n in sizes:
                for t in themes:
                    ctx = br.new_context(); pg = ctx.new_page()
                    pg.goto(f"http://127.0.0.1:{port}/{PAGE}?n={n}&theme={t}&a={a}&b={b}" + (f"&ops={ops}" if ops else ''))
                    pg.wait_for_function("() => window.__result", timeout=900000, polling=500)
                    x = pg.evaluate("() => window.__result"); x.update({'engine': eng, 'round': r}); res.append(x)
                    summ = {k: v['ratio'] if isinstance(v, dict) and 'ratio' in v else v for k, v in x.items() if k not in ('engine',)}
                    print(eng, r, n, t, json.dumps(x), flush=True)
                    ctx.close()
        br.close()
finally:
    srv.kill()
json.dump(res, open(out, 'w'), indent=1)
