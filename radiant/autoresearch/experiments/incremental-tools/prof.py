# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""CPU profile (CDP, main thread) of the harness's timed edits. Usage: prof.py URL n theme steps kinds out.json"""
import sys, json, collections
from pathlib import Path
from playwright.sync_api import sync_playwright
JS = (Path(__file__).parent / "harness.js").read_text()
url, n, theme, steps, kinds, out = sys.argv[1:7]
# Split: run load part with 0 steps first? Simpler: profile the whole evaluate, then keep samples after a marker time.
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    pg = br.new_page(viewport={"width": 1400, "height": 900})
    pg.goto(url); pg.wait_for_function("() => window.__radiant", timeout=120000)
    cdp = pg.context.new_cdp_session(pg)
    cdp.send("Profiler.enable"); cdp.send("Profiler.setSamplingInterval", {"interval": 200})
    # wrap computeWork so profiling only covers edits: start profiler from the page via a binding
    pg.evaluate("""async () => { const P = await import('/src/lib/ui/pipeline.ts'); window.__marks = []; const o = P.Pipeline.prototype.computeWork; P.Pipeline.prototype.computeWork = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { window.__marks.push([t, performance.now()]); } }; }""")
    cdp.send("Profiler.start")
    r = pg.evaluate(JS, [int(n), theme, int(steps), 7, "time", kinds.split(",")])
    prof = cdp.send("Profiler.stop")["profile"]
    marks = pg.evaluate("() => window.__marks")
    origin = pg.evaluate("() => performance.timeOrigin")
    nodes = {nd["id"]: nd for nd in prof["nodes"]}
    # sample timestamps: startTime + cumulative deltas (microseconds, monotonic clock); align by the last mark ~ profile end
    t = prof["startTime"]; times = []
    for d in prof["timeDeltas"]: t += d; times.append(t)
    # Align: assume the first computeWork mark (cold) is the first big chunk; use relative offsets from profile start via performance.now at start
    Path(out).write_text(json.dumps({"profile": prof, "marks": marks, "times": r["times"]}))
    print("saved", len(prof["samples"]), "samples")
    br.close()
