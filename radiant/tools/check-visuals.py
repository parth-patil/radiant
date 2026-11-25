# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Compare normal Radiant canvas captures in WKWebView. Start `bun run dev` first."""

import argparse
import json
from pathlib import Path
import platform
import subprocess
import tempfile
from urllib.parse import urlparse

from PIL import Image, ImageChops

TOOLS = Path(__file__).resolve().parent
BASELINE = TOOLS.parent / "requirements" / "visual-baselines"
SCENES = ["mindmap-tapered", "right-organic", "left-line", "down-rounded", "radial-angular"]
# Everyday themes (THM-34): compared once the owner has reviewed and recorded their baselines.
SCENES += ["theme-daylight", "theme-studio", "theme-sorbet", "theme-citrus", "theme-lagoon", "theme-boardroom"]
# Ignore small colour round-off. Check both whole-frame and local error so a narrow
# branch can fail even when most of the canvas is empty and unchanged.
CHANNEL_LIMIT = 18
FRAME_LIMIT = 0.001
TILE_LIMIT = 0.03
TILE = 96


def capture(url, output, fault="none"):
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "swift", TOOLS / "visual-webview.swift", url, TOOLS / "visual-fixture.js", output, fault, "30"
    ], check=True)
    environment = output / "environment.json"
    metadata = json.loads(environment.read_text())
    metadata["architecture"] = platform.machine()
    environment.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    return metadata


def compare(reference_path, actual_path, diff_path):
    with Image.open(reference_path) as reference, Image.open(actual_path) as actual:
        if reference.size != actual.size:
            return False, f"different dimensions, expected {reference.size}, got {actual.size}"
        diff = ImageChops.difference(reference.convert("RGB"), actual.convert("RGB"))
        red, green, blue = diff.split()
        max_channel = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        mask = max_channel.point(lambda value: 255 if value > CHANNEL_LIMIT else 0)
        width, height = mask.size
        changed = mask.histogram()[255]
        frame_ratio = changed / (width * height)
        max_tile = 0
        for top in range(0, height, TILE):
            for left in range(0, width, TILE):
                tile = mask.crop((left, top, min(left + TILE, width), min(top + TILE, height)))
                max_tile = max(max_tile, tile.histogram()[255] / (tile.width * tile.height))
        passed = frame_ratio <= FRAME_LIMIT and max_tile <= TILE_LIMIT
        if not passed:
            visual = Image.blend(actual.convert("RGB"), Image.new("RGB", actual.size, "white"), 0.6)
            visual.paste((232, 28, 94), mask=mask)
            visual.save(diff_path)
        return passed, f"frame {frame_ratio:.4%}, worst {TILE}px tile {max_tile:.4%}"


def compare_scenes(output, expected_failure=False):
    failures = []
    scenes = ["mindmap-tapered"] if expected_failure else SCENES
    for scene in scenes:
        name = scene + ".png"
        if not (BASELINE / name).exists():
            print(f"NEW  {scene}: no baseline yet; review the capture in {output} before recording it")
            continue
        passed, message = compare(BASELINE / name, output / name, output / (scene + "-diff.png"))
        print(f"{'PASS' if passed else 'DIFF'} {scene}: {message}")
        if not passed:
            failures.append(scene)
    return failures == ["mindmap-tapered"] if expected_failure else not failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:1420/")
    parser.add_argument("--output", type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--record", action="store_true", help="Capture candidates without overwriting reference images")
    modes.add_argument("--fault-check", action="store_true", help="Also require deliberate branch colour and shape changes to fail")
    args = parser.parse_args()
    url = urlparse(args.url)
    if platform.system() != "Darwin" or url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("Use a macOS graphical session and a local Radiant development URL")
    output = (args.output or Path(tempfile.mkdtemp(prefix="radiant-visual-"))).resolve()
    if output == BASELINE.resolve() or output.is_relative_to(BASELINE.resolve()):
        parser.error("Capture into a candidate directory for review")
    print("Captures:", output, flush=True)
    metadata = capture(args.url, output)
    if args.record:
        return 0
    baseline_metadata = json.loads((BASELINE / "environment.json").read_text())
    if metadata != baseline_metadata:
        print(f"Recorded environment: {baseline_metadata}")
        print(f"Current environment:  {metadata}")
    clean = compare_scenes(output)
    if not args.fault_check:
        return 0 if clean else 1
    success = clean
    for fault in ("colour", "shape"):
        print(f"Checking a deliberate branch {fault} change")
        mutant = output / fault
        capture(args.url, mutant, fault)
        if not compare_scenes(mutant, expected_failure=True):
            print(f"The deliberate {fault} change passed the comparison")
            success = False
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
