# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
"""Run with uv run tools/check-performance.py against a running Radiant dev server."""
import argparse
import json
from pathlib import Path
import re
import sys
import subprocess
import time
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://127.0.0.1:1420")
parser.add_argument("--headed", action="store_true")
parser.add_argument("--native-memory", action="store_true", help="Run the macOS RSS gate after browser checks")
args = parser.parse_args()


def wait(page, condition, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if page.evaluate(condition):
            return
        time.sleep(.05)
    raise SystemExit("Application did not reach the expected benchmark state")


with sync_playwright() as runner:
    browser = runner.chromium.launch(channel="chrome", headless=not args.headed,
                                     args=["--use-angle=metal"] if sys.platform == "darwin" else [])
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(args.url + "/dev/render?autobench")
    wait(page, "() => window.__radiantBench?.length === 2", timeout=90)
    cold, warm = page.evaluate("() => window.__radiantBench")
    page.goto(args.url)
    wait(page, "() => window.__radiant?.c.ready")
    application = page.evaluate("""async () => {
        const { c, pipeline, renderer } = window.__radiant;
        if (!c.isBrowser) throw new Error('The performance gate requires the offline browser host');
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const until = async (predicate, timeout) => {
            const end = performance.now() + timeout;
            while (!predicate()) {
                if (performance.now() > end) throw new Error('Timed out waiting for a rendered scene');
                await frame();
            }
        };
        const start = performance.now();
        const first = renderer.stats.frames;
        c.loadSynthetic(5000);
        await until(() => pipeline.nodeCount === 5000 && renderer.stats.frames > first &&
            renderer.stats.meshTriangles > 0, 90000);
        const firstFrameMs = performance.now() - start;
        const layoutMs = pipeline.lastLayoutMs;
        const geometryMs = pipeline.lastGeometryMs;
        const layoutSource = pipeline.lastLayoutSource;

        const leaf = [...pipeline.layout.boxes.values()].find(box => !c.doc.nodes[box.id].children.length);
        c.select([leaf.id]);
        // Feed a deterministic provider stream into the app's actual Expand
        // command, transaction handling, worker layout and renderer.
        c.host.log = () => [
            { delay: 25, event: { kind: 'started', route: 'replay' } },
            ...Array.from({ length: 4 }, (_, i) => ({
                delay: 90,
                event: { kind: 'delta', text: JSON.stringify({ id: 'perf-' + i, parent: null, title: 'Streamed detail ' + i }) + '\\n' }
            })),
            { delay: 20, event: { kind: 'done' } }
        ];
        const background = [];
        const originalAdopt = pipeline.adoptWork.bind(pipeline);
        pipeline.adoptWork = (...args) => {
            background.push(args[2].lastLayoutMs);
            return originalAdopt(...args);
        };
        const intervals = [];
        const script = [];
        const origin = { cx: leaf.x, cy: leaf.y, zoom: Math.max(c.camera.zoom, 0.6) };
        let previous = await frame();
        let streamDoneMs = null;
        const turnStart = performance.now();
        await c.expandSelected();
        for (let i = 0; i < 90; i++) {
            c.camera.set({ cx: origin.cx + Math.sin(i / 14) * 500, cy: origin.cy,
                zoom: origin.zoom * (1 + 0.25 * Math.sin(i / 30)) });
            const stamp = await frame();
            script.push(renderer.stats.cpuMs);
            if (streamDoneMs === null && !c.run) streamDoneMs = stamp - turnStart;
            intervals.push(stamp - previous);
            previous = stamp;
        }
        await until(() => !c.run && !c.needLayout && pipeline.nodeCount === 5004, 5000);
        const percentile = (values, fraction) => values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
        return { firstFrameMs, layoutMs, geometryMs, layoutSource,
            streamedNodes: c.doc.nodes[leaf.id].children.length, streamDoneMs: streamDoneMs ?? performance.now() - turnStart,
            streamAndPanMs: performance.now() - turnStart, frameMaxMs: Math.max(...intervals),
            frameP95Ms: percentile(intervals, .95), scriptP95Ms: percentile(script, .95), backgroundLayoutMs: background };
    }""")
    browser.close()

match = re.search(r"CPU mean [\d.]+ ms, p95 ([\d.]+) ms", warm)
if not match:
    raise SystemExit("Benchmark returned no CPU measurement")
print(json.dumps({"cold": cold, "warm": warm, "application": application}, indent=2))
if application["layoutSource"] != "worker" or not application["backgroundLayoutMs"]:
    raise SystemExit("5,000-node layout or streamed edits did not run in a worker")
if application["streamedNodes"] != 4:
    raise SystemExit("The application did not commit all streamed edits")
if (float(match.group(1)) > 4 or application["scriptP95Ms"] > 4
        or application["geometryMs"] > 50 or application["firstFrameMs"] > 500):
    raise SystemExit("5,000-node budget exceeded (CPU, geometry or first frame)")


if args.native_memory:
    subprocess.run([sys.executable, Path(__file__).with_name("check-memory.py")], check=True)
