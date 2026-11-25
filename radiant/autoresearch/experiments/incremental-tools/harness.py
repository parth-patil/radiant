# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Incremental-track harness: drives ui/pipeline.ts computeWork directly in a dev-server page (main thread).
mode=check: after every edit compare the persistent (incremental) pipeline with a fresh one (exact equality).
mode=time: stage timings per edit kind.
Usage: harness.py URL engine sizes themes steps seeds mode [kinds,comma]"""
import sys, json, statistics
from pathlib import Path
from playwright.sync_api import sync_playwright
JS = (Path(__file__).parent / "harness.js").read_text()
url, engine, sizes, themes, steps, seeds, mode = sys.argv[1:8]
kinds = sys.argv[8].split(",") if len(sys.argv) > 8 else None
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"]) if engine == "chrome" else p.webkit.launch()
    for n in [int(x) for x in sizes.split(",")]:
        for theme in themes.split(","):
            for seed in [int(x) for x in seeds.split(",")]:
                pg = br.new_page(viewport={"width": 1400, "height": 900})
                errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
                pg.goto(url); pg.wait_for_function("() => window.__radiant", timeout=120000)
                r = pg.evaluate(JS, [n, theme, int(steps), seed, mode, kinds])
                summary = {}
                for t in r["times"]:
                    summary.setdefault(t["kind"], []).append(t)
                med = {k: {f: round(statistics.median([x.get(f, 0) for x in v]), 1) for f in ["ms", "computeSizes", "geo", "branchSpecs", "mesh", "fullScene", "packMs", "splitMs", "rebuilt"]} | {"count": len(v)} for k, v in summary.items()}
                print(json.dumps({"engine": engine, "n": n, "theme": theme, "seed": seed, "nodes": r["n"], "visible": r["visible"], "problems": r["problems"], "log": r["log"], "errors": errs[:3], "median": med}), flush=True)
                pg.close()
    br.close()
