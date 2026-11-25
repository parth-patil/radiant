# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright==1.65.2"]
# ///
"""Radiant rendering benchmark: fixed scenarios on production builds, one score per engine (lower is better).

  uv run autoresearch/bench/measure.py --tree . --label base --out /path/base.json
  uv run autoresearch/bench/measure.py --tree A --tree2 B --label exp --out /path/exp.json   (A/B, interleaved)

See README.md in this folder for the scenarios, the metrics, the score and the noise rule.
"""
from __future__ import annotations

import argparse
import json
import math
import platform
import sys
import time
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep __pycache__ out of the repository
import common
from common import geomean, log, log_sd, median

# ============================================================================== fixed scenario definition
# Change these only together with the README, and never between two runs you want to compare.
SIZES = [5000, 20000, 50000]
QUICK_SIZES = [5000, 50000]
# Theme switches happen in this order after loading in 'clean'; rebuild_ms[theme] is the switch INTO that theme.
THEMES = ["soft-clay", "lifted-arcs", "rope", "paper-quilling", "clean"]
QUICK_THEMES = ["rope", "clean"]
DIMENSIONAL = {"soft-clay", "lifted-arcs", "rope", "paper-quilling"}
ZOOMS = ["fit", 0.35, 1.0]
STREAM_THEMES = ["clean", "rope"]
PAN_WARM, PAN_FRAMES = 10, 45
EDIT_REPEATS, FOLD_REPEATS, FOLD_NEAR = 3, 2, 300


def tag(n: int) -> str:
    return f"{n // 1000}k"


def headline(sizes: list[int], themes: list[str], gpu: bool) -> dict[str, list[str]]:
    """THE list of headline metrics, by category. score = geometric mean of the rebuild, interaction and frame
    sub-scores; each sub-score is the geometric mean of its metrics (all in ms, lower is better).
    'dimensional' (rebuild and frame metrics of the four dimensional themes) is reported, not part of the score."""
    s, t = [tag(n) for n in sizes], themes
    dims = [x for x in t if x in DIMENSIONAL]
    gpu_m = ["pan_gpu_mean"] if gpu else []
    return {
        "rebuild": [f"load_ms@{a}" for a in s] + [f"rebuild_ms@{a}/{b}" for a in s for b in t],
        "interaction": [f"edit_ms@{a}" for a in s] + [f"fold_ms@{a}" for a in s],
        "frame": [f"{m}@{a}/{b}" for a in s for b in t for m in ["pan_cpu_mean", "pan_cpu_p95", *gpu_m]],
        "dimensional": [f"{m}@{a}/{b}" for a in s for b in dims for m in ["rebuild_ms", "pan_cpu_mean", *gpu_m]],
    }


SCORED = ["rebuild", "interaction", "frame"]


def scores(values: dict[str, float | None], spec: dict[str, list[str]]) -> dict[str, float | None]:
    out = {cat: geomean([values.get(k) for k in keys]) for cat, keys in spec.items()}
    out["score"] = geomean([out[c] for c in SCORED]) if all(out.get(c) for c in SCORED) else None
    out["missing"] = sorted(k for keys in spec.values() for k in keys if values.get(k) is None)
    return out


# ============================================================================== one size on one build

def run_size(browser, url: str, n: int, themes: list[str], quick: bool) -> tuple[dict, dict, list[str]]:
    m: dict[str, float | None] = {}
    diag: dict = {}
    problems: list[str] = []
    a = tag(n)
    context, page, env, errors = common.open_page(browser, url)
    diag["env"] = env

    def ev(expr: str, arg=None, what: str = ""):
        try:
            return page.evaluate(expr, arg)
        except Exception as e:  # keep going: a missing metric is reported, not fatal
            problems.append(f"{a} {what}: {str(e).splitlines()[0][:300]}")
            return None

    try:
        r = ev("([n, t]) => window.__benchRun.load(n, t)", [n, "clean"], "load")
        if r:
            m[f"load_ms@{a}"] = r["settledMs"]
            diag[f"load@{a}"] = r
            if r.get("nodes") != n:
                problems.append(f"{a}: laid out {r.get('nodes')} nodes, expected {n}")
        diag["shape"] = ev("() => window.__benchRun.shape()", None, "shape")
        m[f"heap_mb@{a}"] = ev("() => window.__benchRun.heapMB()", None, "heap")
        for theme in themes:
            r = ev("(t) => window.__benchRun.rebuild(t)", theme, f"rebuild {theme}")
            if r:
                m[f"rebuild_ms@{a}/{theme}"] = r["settledMs"]
                m[f"gpu_buffer_mb@{a}/{theme}"] = r["gpuBufferMB"]
                diag[f"rebuild@{a}/{theme}"] = r
            cpu, p95s, gpu_all = [], [], []
            for z in ZOOMS:
                p = ev("([z, w, c]) => window.__benchRun.pan(z, { warm: w, count: c })", [z, PAN_WARM, PAN_FRAMES],
                       f"pan {theme} {z}")
                if not p:
                    continue
                zt = "fit" if z == "fit" else f"z{z}"
                cpu += p["script"]
                gpu_all += p["gpu"]
                m[f"pan_cpu_mean@{a}/{theme}/{zt}"] = p["scriptMean"]
                m[f"pan_gpu_mean@{a}/{theme}/{zt}"] = p["gpuMean"]
                diag[f"pan@{a}/{theme}/{zt}"] = {k: v for k, v in p.items() if k not in ("script", "items", "gpu", "intervals")}
                if z != "fit" and (p["itemsMedian"] or 0) < 20:
                    problems.append(f"{a} {theme} zoom {z}: camera shows only {p['itemsMedian']} items; not over the map?")
                if p["framesDrawn"] < p["framesExpected"]:
                    problems.append(f"{a} {theme} zoom {z}: drew {p['framesDrawn']} of {p['framesExpected']} frames")
            if cpu:
                cpu.sort()
                m[f"pan_cpu_mean@{a}/{theme}"] = sum(cpu) / len(cpu)
                m[f"pan_cpu_p95@{a}/{theme}"] = cpu[min(len(cpu) - 1, math.ceil(0.95 * len(cpu)) - 1)]
            m[f"pan_gpu_mean@{a}/{theme}"] = sum(gpu_all) / len(gpu_all) if gpu_all else None
        r = ev("(k) => window.__benchRun.edit(k)", EDIT_REPEATS, "edit")
        if r:
            m[f"edit_ms@{a}"] = median([x["settledMs"] for x in r])
            diag[f"edit@{a}"] = r
        r = ev("([k, near]) => window.__benchRun.fold(k, near)", [FOLD_REPEATS, FOLD_NEAR], "fold")
        if r:
            m[f"fold_ms@{a}"] = median([x["totalMs"] for x in r])
            diag[f"fold@{a}"] = r
        page.emulate_media(reduced_motion="no-preference")  # the stream runs with the app's animations on
        for theme in (STREAM_THEMES if not quick else ["clean"]):
            if theme != "clean":
                ev("(t) => window.__radiantBench.setTheme(t)", theme, "theme")
                ev("() => window.__benchRun.untilIdle()", None, "idle")
            r = ev("() => window.__benchRun.stream()", None, f"stream {theme}")
            if r:
                m[f"stream_block_max_ms@{a}/{theme}"] = r["blockMaxMs"]
                m[f"stream_block_total_ms@{a}/{theme}"] = r["blockTotalMs"]
                m[f"stream_worst_gap_ms@{a}/{theme}"] = r["worstGapMs"]
                m[f"stream_missed_frames@{a}/{theme}"] = r["over25"]
                m[f"stream_over33@{a}/{theme}"] = r["over33"]
                m[f"stream_longtask_max_ms@{a}/{theme}"] = r["longtaskMax"]
                diag[f"stream@{a}/{theme}"] = r
                if r["addedNodes"] != 20:
                    problems.append(f"{a} stream {theme}: added {r['addedNodes']} nodes, expected 20")
        if errors:
            problems += [f"{a} page error: {e[:300]}" for e in errors]
    finally:
        context.close()
    return m, diag, problems


def warm_up(browser, url: str) -> None:
    """One short discarded pass per build and engine: the first page in a fresh browser is reliably slower."""
    context, page, env, errors = common.open_page(browser, url)
    try:
        page.evaluate("""async () => { const r = window.__benchRun; await r.load(5000, 'clean'); await r.rebuild('rope');
            await r.pan('fit', { warm: 5, count: 20 }); await r.pan(1, { warm: 5, count: 20 }); }""")
    finally:
        context.close()


# ============================================================================== comparison rule

FLOOR = 0.03  # smallest change ever called real (3 %)


def verdict(a: list[float], b: list[float]) -> tuple[str, float | None]:
    """'faster'/'slower' (B relative to A) only when the round values do not overlap AND the change of medians is
    larger than twice the pooled round-to-round spread (sd of ln values) and at least FLOOR; otherwise '~'.
    With one round there is no spread: changes over 10 % are marked '?faster'/'?slower' (unverified)."""
    a = [x for x in a if x is not None and x > 0]
    b = [x for x in b if x is not None and x > 0]
    if not a or not b:
        return "n/a", None
    ratio = median(b) / median(a)
    d = math.log(ratio)
    if len(a) < 2 or len(b) < 2:
        return ("?faster" if d < -math.log(1.1) else "?slower" if d > math.log(1.1) else "~"), ratio
    sa, sb = log_sd(a) or 0.0, log_sd(b) or 0.0
    pooled = math.sqrt((sa * sa + sb * sb) / 2)
    separated = max(b) < min(a) or min(b) > max(a)
    if separated and abs(d) > max(2 * pooled, math.log(1 + FLOOR)):
        return ("faster" if d < 0 else "slower"), ratio
    return "~", ratio


def spread(values: list[float]) -> float | None:
    v = [x for x in values if x is not None]
    if len(v) < 2 or not median(v):
        return None
    return (max(v) - min(v)) / median(v)


# ============================================================================== main

def fmt(x, digits=1):
    if x is None:
        return "-"
    if isinstance(x, float):
        return f"{x:.{digits}f}" if abs(x) < 1000 else f"{x:.0f}"
    return str(x)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tree", required=True, type=Path, help="radiant directory of a checkout (build A)")
    ap.add_argument("--tree2", type=Path, help="radiant directory of a second checkout (build B)")
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--quick", action="store_true", help="5k and 50k nodes, clean and rope, one round")
    ap.add_argument("--engines", default="chrome", help="comma list: chrome,webkit")
    ap.add_argument("--rebuild", action="store_true", help="ignore the build cache")
    args = ap.parse_args()
    if args.quick and "--rounds" not in sys.argv:
        args.rounds = 1
    sizes = QUICK_SIZES if args.quick else SIZES
    themes = QUICK_THEMES if args.quick else THEMES
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    trees = {"A": args.tree}
    if args.tree2:
        trees["B"] = args.tree2

    from playwright.sync_api import sync_playwright

    started = time.monotonic()
    with common.exclusive_lock(f"measure.py {args.label}"):
        locked = time.monotonic()
        dists, builds = {}, {}
        for key, tree in trees.items():
            dists[key], builds[key] = common.build(tree, force=args.rebuild)
        built = time.monotonic()
        result = {"label": args.label, "mode": "quick" if args.quick else "full", "rounds": args.rounds,
                  "sizes": sizes, "themes": themes, "zooms": [str(z) for z in ZOOMS], "builds": builds,
                  "machine": {"platform": platform.platform(), "python": platform.python_version()},
                  "started": time.strftime("%Y-%m-%d %H:%M:%S"), "engines": {}}
        with common.serve(dists["A"]) as url_a, common.serve(dists.get("B", dists["A"])) as url_b, \
                sync_playwright() as p:
            urls = {"A": url_a, "B": url_b}
            browsers = {e: common.launch(p, e) for e in engines}
            data = {e: {k: {"rounds": [], "diag": [], "problems": []} for k in trees} for e in engines}
            for engine in engines:  # warm-up, discarded: first page of each build in each engine
                for key in trees:
                    warm_up(browsers[engine], urls[key])
            step = 0
            for rnd in range(args.rounds):
                for engine in engines:
                    t0 = time.monotonic()
                    values = {k: {} for k in trees}
                    diags = {k: {} for k in trees}
                    problems = {k: [] for k in trees}
                    # Interleave at the size level, alternating which build goes first (A B, B A, A B ...), so the
                    # two halves of every pair are measured within a minute of each other.
                    for n in sizes:
                        order = list(trees) if step % 2 == 0 else list(reversed(trees))
                        step += 1
                        for key in order:
                            m, d, pr = run_size(browsers[engine], urls[key], n, themes, args.quick)
                            values[key].update(m)
                            diags[key][tag(n)] = d
                            problems[key] += pr
                    for key in trees:
                        data[engine][key]["rounds"].append(values[key])
                        data[engine][key]["diag"].append(diags[key])
                        data[engine][key]["problems"] += [f"round {rnd + 1}: {x}" for x in problems[key]]
                    n_problems = sum(len(p) for p in problems.values())
                    log(f"[round {rnd + 1}/{args.rounds}] {engine}: {time.monotonic() - t0:.0f} s"
                        + (f", {n_problems} problems" if n_problems else ""))
            for b in browsers.values():
                b.close()
        for engine in engines:
            gpu = any((d[tag(sizes[0])].get("env") or {}).get("gpuTimer") for d in data[engine]["A"]["diag"])
            spec = headline(sizes, themes, gpu)
            out = {"headline": spec, "gpu_timer": gpu, "trees": {}}
            for key in trees:
                rounds = data[engine][key]["rounds"]
                names = sorted({k for r in rounds for k in r})
                med = {k: median([r.get(k) for r in rounds]) for k in names}
                per_round = [scores(r, spec) for r in rounds]
                out["trees"][key] = {
                    "medians": med,
                    "spread": {k: spread([r.get(k) for r in rounds]) for k in names},
                    "scores": scores(med, spec),
                    "round_scores": per_round,
                    "rounds": rounds,
                    "diag": data[engine][key]["diag"],
                    "problems": data[engine][key]["problems"],
                }
            result["engines"][engine] = out
        result["seconds"] = {"lock_wait": round(locked - started, 1), "build": round(built - locked, 1),
                             "total": round(time.monotonic() - started, 1)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1))
    report(result, trees)
    print(f"\nwrote {args.out}  ({result['seconds']})")


def report(result: dict, trees: dict) -> None:
    for engine, out in result["engines"].items():
        spec = out["headline"]
        listed = [k for cat in ("rebuild", "interaction", "frame") for k in spec[cat]]
        extra = sorted(k for k in out["trees"]["A"]["medians"] if k.split("@")[0] in
                       ("heap_mb", "stream_block_max_ms", "stream_block_total_ms", "stream_worst_gap_ms",
                        "stream_missed_frames", "stream_over33", "stream_longtask_max_ms", "gpu_buffer_mb"))
        A = out["trees"]["A"]
        print(f"\n=== {engine}  ({result['mode']}, {result['rounds']} rounds, GPU timer: {out['gpu_timer']})")
        if "B" not in out["trees"]:
            print(f"{'metric':44} {'median':>9} {'spread':>7}")
            for k in listed + extra:
                sp = A["spread"].get(k)
                print(f"{k:44} {fmt(A['medians'].get(k), 2):>9} {('-' if sp is None else f'{sp * 100:.0f}%'):>7}")
            sc = A["scores"]
            rs = [r["score"] for r in A["round_scores"]]
            print(f"{'SCORE':44} {fmt(sc['score'], 2):>9} {('-' if spread(rs) is None else f'{spread(rs) * 100:.0f}%'):>7}")
            for c in ("rebuild", "interaction", "frame", "dimensional"):
                print(f"  {c:42} {fmt(sc[c], 2):>9}")
        else:
            B = out["trees"]["B"]
            print(f"{'metric':44} {'A':>9} {'B':>9} {'B/A':>6}  verdict")
            def row(name, a_vals, b_vals):
                v, ratio = verdict(a_vals, b_vals)
                print(f"{name:44} {fmt(median(a_vals), 2):>9} {fmt(median(b_vals), 2):>9} "
                      f"{('-' if ratio is None else f'{ratio:.3f}'):>6}  {v}")
            for k in listed + extra:
                row(k, [r.get(k) for r in A["rounds"]], [r.get(k) for r in B["rounds"]])
            for c in ("rebuild", "interaction", "frame", "dimensional", "score"):
                row(c.upper(), [r[c] for r in A["round_scores"]], [r[c] for r in B["round_scores"]])
        for key, t in out["trees"].items():
            if t["problems"]:
                print(f"problems ({key}):")
                for p in t["problems"][:20]:
                    print("  " + p)


if __name__ == "__main__":
    main()
