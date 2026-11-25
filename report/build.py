#!/usr/bin/env python3
"""Assemble the single-file report from report/src.

Usage: python3 report/build.py
Writes: <project>/radiant-mind-map-blueprint.html (complete document, opens straight from disk)
        report/dist/blueprint-fragment.html (same content without the document wrapper)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
PAGES = SRC / "pages"

# Page order. Each fragment is one <section class="page" id="p-<name>" data-g="<group>" data-title="…">.
ORDER = [
    "overview",
    "history", "buzan",
    "science", "community", "practice",
    "mindnode", "desktop-tools", "ai-tools",
    "vision", "features", "ai-engine", "art-subtrees", "engine", "quality",
    "stack", "zig", "other-stacks", "codex",
    "roadmap", "sources",
]


def main() -> int:
    head = (SRC / "head.html").read_text()
    top = (SRC / "body_top.html").read_text()
    bottom = (SRC / "body_bottom.html").read_text()
    parts, missing, problems = [], [], []
    for name in ORDER:
        f = PAGES / f"{name}.html"
        if not f.exists():
            missing.append(name)
            continue
        html = f.read_text().strip()
        if not re.match(rf'<section class="page" id="p-{re.escape(name)}"', html):
            problems.append(f"{name}: must start with <section class=\"page\" id=\"p-{name}\" …>")
        if html.count("<section") != html.count("</section>"):
            problems.append(f"{name}: unbalanced <section> tags")
        if re.search(r"<script|<style|<link|<iframe|\son\w+=", html, re.I):
            problems.append(f"{name}: contains script/style/link/iframe or inline event handler")
        # every page but the first starts hidden, so the first paint shows one page
        if parts:
            html = html.replace('<section class="page"', '<section class="page" hidden', 1)
        parts.append(html)
    body = top + "\n" + "\n\n".join(parts) + "\n" + bottom
    fragment = head + "\n" + body
    full = (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
        + head + "</head>\n<body>\n" + body + "</body>\n</html>\n"
    )
    out = ROOT.parent / "radiant-mind-map-blueprint.html"
    out.write_text(full)
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "blueprint-fragment.html").write_text(fragment)
    print(f"wrote {out} ({len(full)/1024:.0f} KB), {len(parts)} pages")
    if missing:
        print("missing pages:", ", ".join(missing))
    for p in problems:
        print("PROBLEM:", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
