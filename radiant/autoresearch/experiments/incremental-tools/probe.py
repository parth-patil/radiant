# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Transport probe: per-operation breakdown of message cost between the layout worker and the main thread.
Usage: uv run probe.py --tree A [--tree2 B] --out out.json [--engines chrome,webkit] [--rounds 2] [--sizes 5000,50000] [--themes clean,rope]
"""
import argparse, json, statistics, sys, time
from pathlib import Path
sys.path.insert(0, "/Users/parth/projects/general/mind_maps/radiant/autoresearch/bench")
import common  # noqa
from playwright.sync_api import sync_playwright

INIT = (Path(__file__).parent / "probe-init.js").read_text()  # copied from transport-tools

PAGE = r"""
async ([n, theme, adds, folds, journal]) => {
  const b = window.__radiantBench;
  if (journal) {
    // The desktop host's per-edit journal path (docCommit), which the browser host does not have.
    const c = window.__radiant.c;
    c.host.docCommit = async () => true;
    c.editor.setCommitBarrier((change) => c.journalChange(change), () => {});
  }
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async (fn) => {
    const t0 = performance.now();
    let last = t0;
    const off = b.onFrame(f => { last = f.t; });
    fn();
    let quiet = 0;
    for (let i = 0; i < 2000 && quiet < 2; i++) { await raf(); quiet = b.idle() ? quiet + 1 : 0; }
    off();
    return { t0, ms: last - t0 };
  };
  const tp = window.__tp;
  const window_ = (t0, t1) => {
    const inW = (e) => e.at >= t0 - 0.01 && e.at <= t1 + 50;
    const main = tp.main.filter(inW), worker = tp.worker.filter(inW), post = tp.post.filter(inW);
    const sum = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
    const compute = worker.filter(e => e.kind === 'work' || (e.kind === 'part' && e.post > 0 && e.handler > 5));
    return {
      main_post_ms: sum(post, 'ms'), main_posts: post.length,
      main_deser_ms: sum(main, 'deser'), main_handler_ms: sum(main, 'handler'), main_msgs: main.length,
      main_max_task_ms: Math.max(0, ...main.map(e => e.deser + e.handler)),
      worker_deser_ms: sum(worker, 'deser'), worker_handler_ms: sum(worker, 'handler'), worker_post_ms: sum(worker, 'post'),
      worker_msgs: worker.length,
      worker_max_post_ms: Math.max(0, ...worker.map(e => e.post)),
      delivery_ms: (() => { let s = 0; for (const m of main) { if (!/^(result|header)$/.test(m.kind)) continue; const w = worker.find(x => x.seq === m.seq && x.posts && x.p1); if (w) s += m.abs1 - w.p1; } return s; })(),
    };
  };
  const run = async (label, fn) => {
    const r = await settle(fn);
    const d = b.diagnostics();
    return { op: label, ms: r.ms, ...window_(r.t0, performance.now()), adopt_ms: d.adoptMs ?? null, layout_ms: d.layoutMs, geometry_ms: d.geometryMs, mesh_ms: d.branchMeshMs, source: d.layoutSource };
  };
  const out = [];
  out.push(await run('load', () => b.loadSynthetic(n)));
  if (theme !== 'clean') out.push(await run('theme', () => b.setTheme(theme)));
  await raf(); await raf();
  const parent = b.nodeAtDepth(3, 0.5);
  for (let i = 0; i < adds; i++) out.push(await run('add', () => b.addChild(parent, 'New node ' + i)));
  const fold = b.nodeWithSubtreeNear(300);
  for (let i = 0; i < folds; i++) {
    out.push(await run('fold', () => b.toggleFold(fold.id)));
    out.push(await run('unfold', () => b.toggleFold(fold.id)));
  }
  out.push(await run('retheme', () => b.setTheme(theme === 'clean' ? 'rope' : 'clean')));
  let heap = null;
  try { if (window.gc) { gc(); gc(); } heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null; } catch {}
  return { ops: out, heap_mb: heap, nodes: b.nodeCount() };
}
"""

WORKER_PROBE = (Path(__file__).parent / "probe-worker.js").read_text()

def instrument(dist, info):
    """Copy the build and prepend the worker probe to the layout worker bundle (an IIFE, so it runs first)."""
    import shutil
    out = Path(__file__).parent / "probe-dist" / info["key"]
    if not out.exists():
        shutil.copytree(dist, out)
        for f in (out / "_app/immutable/workers").glob("layout.worker-*.js"):
            f.write_text(WORKER_PROBE + f.read_text())
    return out, info

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", required=True); ap.add_argument("--tree2")
    ap.add_argument("--out", required=True)
    ap.add_argument("--engines", default="chrome")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--sizes", default="5000,50000")
    ap.add_argument("--themes", default="clean,rope")
    ap.add_argument("--adds", type=int, default=4)
    ap.add_argument("--folds", type=int, default=1)
    ap.add_argument("--nolock", action="store_true")
    ap.add_argument("--journal", action="store_true")
    a = ap.parse_args()
    trees = [Path(a.tree)] + ([Path(a.tree2)] if a.tree2 else [])
    builds = [instrument(*common.build(t)) for t in trees]
    results = {"trees": [str(t) for t in trees], "builds": [i for _, i in builds], "runs": []}
    import contextlib
    lock = contextlib.nullcontext() if a.nolock else common.exclusive_lock("transport probe")
    with lock, sync_playwright() as p, contextlib.ExitStack() as stack:
        urls = [stack.enter_context(common.serve(d)) for d, _ in builds]
        for engine in a.engines.split(","):
            browser = common.launch(p, engine)
            for r in range(a.rounds):
                for size in [int(s) for s in a.sizes.split(",")]:
                    for theme in a.themes.split(","):
                        order = list(range(len(trees)))
                        if (r + size // 1000 + len(theme)) % 2: order.reverse()
                        for bi in order:
                            ctx = browser.new_context(viewport=common.VIEWPORT, device_scale_factor=common.SCALE, reduced_motion="reduce")
                            ctx.add_init_script(INIT)
                            page = ctx.new_page()
                            errs = []
                            page.on("pageerror", lambda e: errs.append(str(e)))
                            page.goto(urls[bi] + "/", wait_until="load")
                            page.wait_for_function("() => window.__radiantBench", timeout=30000)
                            t = time.time()
                            res = page.evaluate(PAGE, [size, theme, a.adds, a.folds, a.journal])
                            ctx.close()
                            rec = {"engine": engine, "round": r, "build": bi, "size": size, "theme": theme, **res, "errors": errs}
                            results["runs"].append(rec)
                            adds = [o for o in res["ops"] if o["op"] == "add"]
                            md = lambda k: (lambda xs: round(statistics.median(xs), 1) if xs else None)([o[k] for o in adds if o.get(k) is not None])
                            common.log(f"{engine} r{r} {'AB'[bi]} {size} {theme}: add ms {md('ms')} wser {md('worker_post_ms')} mdeser {md('main_deser_ms')} mpost {md('main_post_ms')} wdeser {md('worker_deser_ms')} adopt {md('adopt_ms')} maxtask {md('main_max_task_ms')} msgs {md('main_msgs')} heap {res['heap_mb'] and round(res['heap_mb'],1)} errs {len(errs)} ({time.time()-t:.0f}s)")
            browser.close()
    Path(a.out).write_text(json.dumps(results, indent=1))
    summarize(results)

def summarize(results):
    rows = {}
    for run in results["runs"]:
        for o in run["ops"]:
            key = (run["engine"], run["size"], run["theme"], o["op"])
            rows.setdefault(key, {}).setdefault(run["build"], []).append(o)
    keys = ["ms", "layout_ms", "geometry_ms", "mesh_ms", "delivery_ms", "main_post_ms", "worker_deser_ms", "worker_handler_ms", "worker_post_ms", "main_deser_ms", "main_handler_ms", "main_max_task_ms", "adopt_ms", "main_msgs"]
    for key, byb in sorted(rows.items()):
        line = [f"{key[0]:6} {key[1]:6} {key[2]:6} {key[3]:7}"]
        for k in keys:
            vals = []
            for bi in sorted(byb):
                xs = [o[k] for o in byb[bi] if o.get(k) is not None]
                vals.append(f"{statistics.median(xs):.1f}" if xs else "-")
            line.append(f"{k.replace('_ms','')}={'/'.join(vals)}")
        print(" ".join(line))

if __name__ == "__main__":
    main()
