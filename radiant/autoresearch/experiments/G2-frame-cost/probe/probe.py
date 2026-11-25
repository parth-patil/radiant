# /// script
# dependencies = ["playwright==1.65.2"]
# ///
import sys, json, asyncio, argparse
from playwright.async_api import async_playwright

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:1444/')
    ap.add_argument('--js', required=True)
    ap.add_argument('--engine', default='chrome')
    ap.add_argument('--timeout', type=float, default=180)
    a = ap.parse_args()
    js = open(a.js).read()
    async with async_playwright() as p:
        if a.engine == 'webkit':
            b = await p.webkit.launch()
        else:
            b = await p.chromium.launch(channel='chrome', args=['--use-angle=metal', '--enable-gpu', '--enable-precise-memory-info'])
        ctx = await b.new_context(viewport={'width': 1728, 'height': 1117}, device_scale_factor=2, reduced_motion='reduce')
        page = await ctx.new_page()
        page.on('console', lambda m: print('[console]', m.text[:300], file=sys.stderr) if m.type in ('error','warning') else None)
        page.on('pageerror', lambda e: print('[pageerror]', str(e)[:500], file=sys.stderr))
        await page.goto(a.url)
        await page.wait_for_function('window.__radiant && window.__radiant.c', timeout=60000)
        res = await asyncio.wait_for(page.evaluate(js), a.timeout)
        print(json.dumps(res, indent=1))
        await b.close()

asyncio.run(main())
