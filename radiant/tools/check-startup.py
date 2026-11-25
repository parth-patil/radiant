#!/usr/bin/env python3
"""Measure process launch to a working blank canvas in a release macOS WebView.

Run python3 tools/check-startup.py from the project. The probe builds an isolated
app bundle and adds a local script to a scratch copy of the production frontend.
"""
import argparse
import json
import math
import os
from pathlib import Path
import plistlib
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[1]
TARGET = PROJECT / "src-tauri" / "target" / "startup-gate"
PROBE = """
const inspector = 'aside[aria-label="Inspector"]';
const receipt = text => window.__TAURI_INTERNALS__.invoke('text_write', { path: RECEIPT, text });
function until(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise(resolve => {
        const observer = new MutationObserver(() => {
            if (predicate()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
}
const timeout = setTimeout(() => receipt(JSON.stringify({
    blank: !!document.querySelector('.empty-hint'), title: document.title,
    buttons: [...document.querySelectorAll('header button')].map(b => b.title),
    visibility: document.visibilityState, canvas: !!document.querySelector('canvas'),
})), 8000);
await until(() => document.querySelector('.empty-hint') && document.querySelector('canvas'));
const button = document.querySelector('button[title*="hide the inspector"]');
const wasOpen = !!document.querySelector(inspector);
button.click();
await until(() => !!document.querySelector(inspector) !== wasOpen);
clearTimeout(timeout);
await receipt('interactive');
await window.__TAURI_INTERNALS__.invoke('plugin:window|destroy');
"""


def build(scratch, receipt):
    subprocess.run(["bun", "run", "build"], cwd=PROJECT, check=True)
    frontend = scratch / "frontend"
    shutil.copytree(PROJECT / "build", frontend)
    index = frontend / "index.html"
    index.write_text(index.read_text().replace("</body>", '<script type="module" src="/startup-probe.js"></script></body>'))
    (frontend / "startup-probe.js").write_text(PROBE.replace("RECEIPT", json.dumps(str(receipt))))
    config = scratch / "tauri.conf.json"
    config.write_text(json.dumps({
        "productName": "Radiant Startup Probe",
        "identifier": "app.radiant.benchmark.startup",
        "build": {"frontendDist": str(frontend), "beforeBuildCommand": ""},
        "bundle": {"fileAssociations": []},
    }))
    subprocess.run(["bun", "run", "tauri", "build", "--bundles", "app", "--config", str(config)],
                   cwd=PROJECT, env={**os.environ, "CARGO_TARGET_DIR": str(TARGET)}, check=True)
    contents = TARGET / "release/bundle/macos/Radiant Startup Probe.app/Contents"
    with (contents / "Info.plist").open("rb") as f:
        return contents / "MacOS" / plistlib.load(f)["CFBundleExecutable"]


def launch(binary, receipt):
    receipt.unlink(missing_ok=True)
    start = time.perf_counter()
    with subprocess.Popen([binary], stdout=subprocess.DEVNULL) as process:
        try:
            while not receipt.exists():
                if process.poll() is not None:
                    raise RuntimeError(f"Probe exited before accepting a click ({process.returncode})")
                if time.perf_counter() - start > 15:
                    raise RuntimeError("Timed out waiting for an interactive blank map")
                time.sleep(.001)
            elapsed = (time.perf_counter() - start) * 1000
            if receipt.read_text() != "interactive":
                raise RuntimeError("Window failed the interaction check: " + receipt.read_text())
            return elapsed
        finally:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=20)
    args = parser.parse_args()
    if sys.platform != "darwin" or args.runs < 1:
        parser.error("This gate requires a macOS graphical session and a positive run count.")
    with tempfile.TemporaryDirectory(prefix="radiant-startup-") as directory:
        scratch = Path(directory)
        receipt = scratch / "receipt"
        binary = build(scratch, receipt)
        warmup = launch(binary, receipt)
        times = []
        for i in range(args.runs):
            times.append(launch(binary, receipt))
            print(f"Launch {i+1}: {times[-1]:.1f} ms", flush=True)
        print(json.dumps({
            "scenario": "warm disk cache, fresh application process, blank map",
            "runs": len(times), "warmupMs": round(warmup, 1),
            "medianMs": round(statistics.median(times), 1),
            "p95Ms": round(sorted(times)[math.ceil(.95 * len(times)) - 1], 1),
            "maxMs": round(max(times), 1), "passed": max(times) < 1000,
        }), flush=True)
        return 0 if max(times) < 1000 else 1


if __name__ == "__main__":
    sys.exit(main())
