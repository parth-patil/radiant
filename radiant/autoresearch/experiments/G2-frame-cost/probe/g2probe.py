# /// script
# dependencies = ["playwright==1.65.2"]
# ///
"""G2 probe: frame cost (GPU timer in Chrome, readPixels-synchronised wall time in both engines), rebuild diagnostics and
memory of two production builds (VITE_RADIANT_BENCH=1), interleaved A B / B A per round and size."""
import sys, json, asyncio, argparse, threading, os, functools, statistics
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright

class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a): pass
    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path):
            self.path = '/index.html'
        return super().send_head()
H.extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript'}

def serve(d):
    s = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(H, directory=d))
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return 'http://127.0.0.1:%d/' % s.server_address[1]

PAGE = open(os.path.join(os.path.dirname(__file__), 'g2page.js')).read()

async def run(browser, url, n, frames, theme):
    ctx = await browser.new_context(viewport={'width': 1728, 'height': 1117}, device_scale_factor=2, reduced_motion='reduce', bypass_csp=True)
    page = await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)[:300]))
    await page.goto(url)
    for _ in range(600):
        if await page.evaluate('() => !!(window.__radiantBench && window.__radiant)'):
            break
        await asyncio.sleep(0.1)
    res = await page.evaluate(PAGE, {'n': n, 'frames': frames, 'theme': theme})
    res['errors'] = errs
    await ctx.close()
    return res

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--a', required=True); ap.add_argument('--b', required=True)
    ap.add_argument('--engine', default='chrome'); ap.add_argument('--sizes', default='5000,20000,50000')
    ap.add_argument('--rounds', type=int, default=3); ap.add_argument('--frames', type=int, default=60)
    ap.add_argument('--theme', default='clean'); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    urls = {'A': serve(a.a), 'B': serve(a.b)}
    out = {'args': vars(a), 'runs': []}
    async with async_playwright() as p:
        b = await (p.webkit.launch() if a.engine == 'webkit' else p.chromium.launch(channel='chrome', args=['--use-angle=metal', '--enable-gpu', '--enable-precise-memory-info']))
        for r in range(a.rounds):
            for i, n in enumerate(int(x) for x in a.sizes.split(',')):
                order = ['A', 'B'] if (r + i) % 2 == 0 else ['B', 'A']
                for which in order:
                    res = await run(b, urls[which], n, a.frames, a.theme)
                    res.update({'build': which, 'round': r, 'n': n})
                    out['runs'].append(res)
                    print(which, r, n, json.dumps({k: res[k] for k in ('summary',)})[:600], file=sys.stderr, flush=True)
                    json.dump(out, open(a.out, 'w'), indent=1)
        await b.close()
    json.dump(out, open(a.out, 'w'), indent=1)

asyncio.run(main())
