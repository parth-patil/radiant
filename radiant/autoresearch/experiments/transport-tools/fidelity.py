# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Round-trip a real layout result through packLayoutResult/unpackLayoutResult on the dev server; compare to a structured clone."""
import sys, json
from playwright.sync_api import sync_playwright
JS = r"""
async ([n, theme]) => {
  const R = window.__radiant;
  const raf = () => new Promise(r => requestAnimationFrame(r));
  R.c.loadSynthetic(n); for (let i = 0; i < 60; i++) await raf();
  if (theme !== 'clean') { R.c.setTheme(theme); for (let i = 0; i < 60; i++) await raf(); }
  const T = await import('/src/lib/ui/layout-transport.ts');
  const { Pipeline } = await import('/src/lib/ui/pipeline.ts');
  const { measureLabel } = await import('/src/lib/render/text.ts');
  const p = R.pipeline;
  const work = p.work(R.c.doc, R.c.theme, null, { selection: new Set(), focus: null, editing: null, hover: null });
  const pipe = new Pipeline(measureLabel);
  const res = pipe.computeWork(structuredClone(work));
  const ref = structuredClone({ ...res, spatial: null, mesh: null });
  const transfer = [];
  const wire = T.packLayoutResult({ ...res, mesh: T.shipMesh(res.mesh, transfer) }, transfer);
  const kinds = { placements: 'json' in wire.placements, specs: 'json' in wire.layoutBranches, drawn: wire.drawnBranches, labels: 'json' in wire.baseScene.labels, rects: 'json' in wire.baseScene.rects };
  const back = T.unpackLayoutResult(structuredClone({ ...wire, spatial: null }));
  const J = JSON.stringify;
  const deep = (a, b, path = '') => {
    if (Object.is(a, b)) return null;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return path + ': ' + String(a) + ' vs ' + String(b);
    if (a instanceof Map) { if (!(b instanceof Map) || a.size !== b.size) return path + ' map size'; const ka = [...a.keys()], kb = [...b.keys()]; for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return path + ' map order'; const d = deep(a.get(ka[i]), b.get(kb[i]), path + '.' + ka[i]); if (d) return d; } return null; }
    const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
    if (ka.join() !== kb.join()) return path + ' keys ' + ka.join() + ' | ' + kb.join();
    for (const k of ka) { const d = deep(a[k], b[k], path + '.' + k); if (d) return d; }
    return null;
  };
  return {
    kinds, specs: res.layoutBranches.length, sameDrawn: back.drawnBranches === back.layoutBranches, refDrawnSame: res.drawnBranches === res.layoutBranches,
    boxes: deep(ref.layout, back.layout), placements: deep(ref.placements, back.placements), placementsJson: J(ref.placements) === J(back.placements),
    specs_diff: deep(ref.layoutBranches, back.layoutBranches), labels: deep(ref.baseScene.labels, back.baseScene.labels), rects: deep(ref.baseScene.rects, back.baseScene.rects),
    rest: deep({ ...ref, layout: 0, placements: 0, layoutBranches: 0, drawnBranches: 0, baseScene: { ...ref.baseScene, labels: 0, rects: 0, branches: 0 } },
               { ...back, spatial: null, mesh: null, layout: 0, placements: 0, layoutBranches: 0, drawnBranches: 0, baseScene: { ...back.baseScene, labels: 0, rects: 0, branches: 0 } })
  };
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    for n in [int(x) for x in sys.argv[1].split(",")]:
        for theme in sys.argv[2].split(","):
            pg = br.new_page(viewport={"width": 1400, "height": 900})
            errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto("http://127.0.0.1:1433/"); pg.wait_for_function("() => window.__radiant", timeout=60000)
            print(n, theme, json.dumps(pg.evaluate(JS, [n, theme])), errs[:2], flush=True)
            pg.close()
    br.close()
