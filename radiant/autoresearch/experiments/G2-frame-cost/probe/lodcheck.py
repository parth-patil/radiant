# /// script
# dependencies = ["playwright==1.65.2", "pillow", "numpy"]
# ///
import asyncio, io, json, numpy as np
from PIL import Image
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome', args=['--use-angle=metal', '--enable-gpu'])
        ctx = await b.new_context(viewport={'width': 1728, 'height': 1117}, device_scale_factor=2, reduced_motion='reduce')
        page = await ctx.new_page()
        await page.goto('http://127.0.0.1:1444/')
        await page.wait_for_function('window.__radiant && window.__radiant.c')
        await page.evaluate("window.__radiant.c.loadSynthetic(5000, 'clean')")
        await page.wait_for_timeout(4000)
        await page.evaluate("window.__radiant.c.zoomFit(false)")
        await page.wait_for_timeout(1500)
        z = await page.evaluate("window.__radiant.camera.getState().zoom")
        a = np.asarray(Image.open(io.BytesIO(await page.screenshot())).convert('RGB')).astype(int)
        await page.evaluate("(() => { const r = window.__radiant.renderer; const f = r.visibleChunks; r.visibleChunks = function (m, bo, l) { return f.call(this, m, bo, false); }; r.requestFrame(); })()")
        await page.wait_for_timeout(1500)
        bb = np.asarray(Image.open(io.BytesIO(await page.screenshot())).convert('RGB')).astype(int)
        d = np.abs(a - bb).max(axis=2)
        ys, xs = np.nonzero(d > 8)
        print(json.dumps({'zoom': z, 'over': int(len(ys)), 'pct': 100 * len(ys) / d.size, 'max': int(d.max()), 'x': [int(xs.min()), int(xs.max())] if len(xs) else None}))
        await b.close()
asyncio.run(main())
