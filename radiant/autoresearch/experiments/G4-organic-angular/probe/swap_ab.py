# /// script
# dependencies = ["playwright==1.65.2", "pillow", "numpy"]
# ///
"""Same page, same document and camera: frame drawn from GPU-expanded branches vs the CPU mesh of the same specs."""
import asyncio, io, json, os, argparse
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright
async def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--url', default='http://127.0.0.1:1444/'); ap.add_argument('--themes'); ap.add_argument('--n', type=int, default=300)
    ap.add_argument('--views', default='fit,z2,z0.5'); ap.add_argument('--out'); ap.add_argument('--engine', default='chrome')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); res = {}
    async with async_playwright() as p:
        b = await (p.webkit.launch() if a.engine == 'webkit' else p.chromium.launch(channel='chrome', args=['--use-angle=metal', '--enable-gpu']))
        for theme in a.themes.split(','):
            ctx = await b.new_context(viewport={'width': 1728, 'height': 1117}, device_scale_factor=2, reduced_motion='reduce')
            page = await ctx.new_page(); await page.goto(a.url)
            await page.wait_for_function('window.__radiant && window.__radiant.c')
            await page.evaluate(f"window.__radiant.c.loadSynthetic({a.n}, '{theme}')")
            await asyncio.sleep(3 if a.n < 2000 else 8)
            for view in a.views.split(','):
                if view == 'fit': await page.evaluate("window.__radiant.c.zoomFit(false)")
                else: await page.evaluate(f"(() => {{ const R = window.__radiant; const b = [...R.pipeline.canvasLayout.boxes.values()]; const k = b[Math.min(b.length - 1, 3)]; R.camera.set({{cx: k.x, cy: k.y, zoom: {float(view[1:])}}}); }})()")
                await asyncio.sleep(1.2)
                gpu = await page.evaluate("(() => { const r = window.__radiant.renderer; return { inst: !!r.scene.branches?.instances, tris: r.stats.meshTriangles }; })()")
                A = np.asarray(Image.open(io.BytesIO(await page.screenshot())).convert('RGB')).astype(int)
                await page.evaluate("""(async () => { const R = window.__radiant; const T = await import('/src/lib/core/geometry/tessellate.ts');
                  const r = R.renderer; const sc = r.scene; window.__gpuScene = sc;
                  const relief = sc.branches.relief ? { material: sc.branches.relief.material, shadowColor: sc.branches.relief.shadowColor } : undefined;
                  r.setScene({ ...sc, branches: T.tessellateBranches(R.pipeline.layoutBranches, { zoom: 4, relief }) }); })()""")
                await asyncio.sleep(1.2)
                B = np.asarray(Image.open(io.BytesIO(await page.screenshot())).convert('RGB')).astype(int)
                await page.evaluate("(() => { window.__radiant.renderer.setScene(window.__gpuScene); })()")
                d = np.abs(A - B).max(axis=2); ys, xs = np.nonzero(d > 8)
                key = f'{theme}-{a.n}-{view}'
                res[key] = {'over': int(len(ys)), 'pct': round(100 * len(ys) / d.size, 4), 'any': int((d > 0).sum()), 'max': int(d.max()), **gpu,
                            'bbox': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(ys) else None}
                Image.fromarray(A.astype('uint8')).save(f'{a.out}/{key}-gpu.png'); Image.fromarray(B.astype('uint8')).save(f'{a.out}/{key}-cpu.png')
                m = np.zeros_like(A); m[..., 0] = (d > 8) * 255; m[..., 1] = ((d > 0) & (d <= 8)) * 255
                Image.fromarray((A * 0.3 + m * 0.7).clip(0, 255).astype('uint8')).save(f'{a.out}/{key}-diff.png')
                print(key, json.dumps(res[key]), flush=True)
            await ctx.close()
        await b.close()
    json.dump(res, open(f'{a.out}/swap.json', 'w'), indent=1)
asyncio.run(main())
