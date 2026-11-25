# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright==1.65.2", "pillow", "numpy"]
# ///
"""Correctness guard: capture fixed scenes from two production builds and diff them pixel by pixel.

  uv run autoresearch/bench/visual.py --tree A --tree2 B --out DIR [--engine chrome] [--threshold 8]

Writes DIR/<scene>/{A.png,B.png,diff.png} and DIR/visual.json; prints a table. A build compared with itself
should give 0 differing pixels (see README.md for what was measured).
"""
from __future__ import annotations

import argparse
import json
import time
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep __pycache__ out of the repository
import numpy as np
from PIL import Image

import common

THEMES = ["clean", "soft-clay", "lifted-arcs", "rope", "paper-quilling"]
DARK_THEMES = ["clean", "rope"]


def sample_map() -> dict:
    """A realistic 59-node map: short and long labels, a deep chain, wide and narrow branches, punctuation."""
    def n(text, *children):
        return {"text": text, "children": list(children)}
    chain = n("Deep chain level 6: the detail nobody reads until it matters")
    for depth in range(5, 0, -1):
        chain = n(f"Level {depth}", chain)
    return n("Launch plan for the spring release",
        n("Goals",
          n("Grow weekly active users by 25 % before June"),
          n("Retention"), n("NPS ≥ 45"),
          n("Ship the redesigned onboarding flow with progressive disclosure and fewer than five steps")),
        n("Audience",
          n("Students"), n("Researchers", n("Lab teams"), n("Independent")), n("Writers"), n("Designers"),
          n("Product managers who plan roadmaps in outlines and need to present them to leadership")),
        n("Channels",
          n("Blog"), n("Newsletter (12k)"), n("Podcast tour", n("Episode 1"), n("Episode 2"), n("Episode 3")),
          n("Conference talk: 'Thinking in branches'"), n("Social"), n("Partners")),
        n("Timeline",
          n("Q1", n("Beta"), n("Docs")), n("Q2", n("Launch week"), n("Press")), n("Q3"), chain),
        n("Risks",
          n("Performance on 50,000-node maps"), n("Pricing confusion"),
          n("Competitor ships first", n("Mitigation: focus on local-first and privacy")), n("Hiring"), n("Scope creep")),
        n("Budget",
          n("Ads $40k"), n("Events $25k"), n("Design contractor"), n("Tools"), n("Travel"), n("Contingency 10 %")),
        n("Open questions",
          n("Do we need a Windows build?"), n("Which import formats matter most: OPML, Markdown, FreeMind, XMind?"),
          n("Team plan"), n("Education discount"), n("Localisation"), n("Offline mode")),
    )


def count(node: dict) -> int:
    return 1 + sum(count(c) for c in node["children"])


def scenes() -> list[dict]:
    out = []
    for theme in THEMES:
        for view in ("fit", "zoom2"):
            out.append({"name": f"map60-{theme}-light-{view}", "map": "sample", "theme": theme, "dark": False, "view": view})
    for theme in DARK_THEMES:
        for view in ("fit", "zoom2"):
            out.append({"name": f"map60-{theme}-dark-{view}", "map": "sample", "theme": theme, "dark": True, "view": view})
    for theme in ("clean", "rope"):
        for view in ("fit", "z035"):
            out.append({"name": f"big5k-{theme}-{view}", "map": 5000, "theme": theme, "dark": False, "view": view})
    return out


VIEWS = {"fit": {"kind": "fit"}, "zoom2": {"kind": "node", "depth": 1, "fraction": 0, "zoom": 2},
         "z035": {"kind": "node", "depth": 2, "fraction": 0.5, "zoom": 0.35}}


def capture(browser, url: str, scene: dict, path: Path) -> dict:
    context, page, env, errors = common.open_page(browser, url, color_scheme="dark" if scene["dark"] else "light")
    try:
        if scene["dark"]:
            page.evaluate("() => window.__benchRun.setDark(true)")
        if scene["map"] == "sample":
            page.evaluate("([r, t]) => window.__benchRun.loadOutline('Launch plan', r, t)", [sample_map(), scene["theme"]])
        else:
            page.evaluate("([n, t]) => window.__benchRun.load(n, t)", [scene["map"], scene["theme"]])
        cam = page.evaluate("(v) => window.__benchRun.view(v)", VIEWS[scene["view"]])
        page.screenshot(path=str(path))
        return {"camera": cam, "errors": errors}
    finally:
        context.close()


def diff(a: Path, b: Path, out: Path, threshold: int) -> dict:
    A = np.asarray(Image.open(a).convert("RGB"), dtype=np.int16)
    B = np.asarray(Image.open(b).convert("RGB"), dtype=np.int16)
    if A.shape != B.shape:
        return {"share": 1.0, "max": 255, "note": f"size differs {A.shape} vs {B.shape}"}
    d = np.abs(A - B).max(axis=2)
    mask = d > threshold
    base = (A.mean(axis=2) * 0.3).astype(np.uint8)
    img = np.stack([base, base, base], axis=2)
    img[mask] = [255, 0, 0]
    faint = (d > 0) & ~mask
    img[faint] = [255, 200, 0]
    Image.fromarray(img).save(out)
    return {"share": float(mask.mean()), "max": int(d.max()), "any_share": float((d > 0).mean())}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tree", required=True, type=Path)
    ap.add_argument("--tree2", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--engine", default="chrome")
    ap.add_argument("--threshold", type=int, default=8, help="per-channel difference (0-255) that counts as differing")
    ap.add_argument("--only", help="substring filter on scene names")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    started = time.monotonic()
    rows = []
    with common.exclusive_lock("visual.py"):
        dist_a, info_a = common.build(args.tree)
        dist_b, info_b = common.build(args.tree2)
        with common.serve(dist_a) as url_a, common.serve(dist_b) as url_b, sync_playwright() as p:
            browser = common.launch(p, args.engine)
            for scene in scenes():
                if args.only and args.only not in scene["name"]:
                    continue
                folder = args.out / scene["name"]
                folder.mkdir(parents=True, exist_ok=True)
                meta_a = capture(browser, url_a, scene, folder / "A.png")
                meta_b = capture(browser, url_b, scene, folder / "B.png")
                result = diff(folder / "A.png", folder / "B.png", folder / "diff.png", args.threshold)
                rows.append({**scene, **result, "A": meta_a, "B": meta_b})
                print(f"{scene['name']:34} differ {result['share'] * 100:8.4f} %   max {result['max']:3d}   "
                      f"any {result.get('any_share', 0) * 100:7.3f} %", flush=True)
            browser.close()
    summary = {"builds": {"A": info_a, "B": info_b}, "engine": args.engine, "threshold": args.threshold,
               "sample_nodes": count(sample_map()), "scenes": rows, "seconds": round(time.monotonic() - started, 1)}
    (args.out / "visual.json").write_text(json.dumps(summary, indent=1))
    worst = max(rows, key=lambda r: r["share"]) if rows else None
    print(f"\n{len(rows)} scenes, worst {worst['name'] if worst else '-'} "
          f"{(worst['share'] * 100 if worst else 0):.4f} % over threshold {args.threshold}; "
          f"{summary['seconds']} s; wrote {args.out / 'visual.json'}")
    errors = [(r["name"], r["A"]["errors"] + r["B"]["errors"]) for r in rows if r["A"]["errors"] or r["B"]["errors"]]
    for name, e in errors:
        print(f"page errors in {name}: {e[:3]}")


if __name__ == "__main__":
    main()
