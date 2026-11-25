#!/usr/bin/env python3
"""Build an isolated release app and benchmark its saved reference maps on the current Mac display."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid

TOOLS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("open_gate", TOOLS / "check-disk-open.py")
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
memory, gate = disk.memory, disk.gate
SIZES = [("small", 200, 0), ("large", 5000, 300), ("stress", 50000, 0)]

# Take the first sample on the same controller callback used by the disk-open gate.
# Capture layout times before thumbnail arrivals can trigger another layout.
HOOK = """
    const fixture = window as Window & { __referencePending?: boolean; __referenceFrame?: unknown };
    if (!fixture.__referencePending && this.filePath && this.doc.id === 'rss-fixture-' + this.pipeline.nodeCount &&
        this.pipeline.doc === this.doc && s.meshTriangles > 0) {
      fixture.__referencePending = true;
      const timing = { layoutMs: this.pipeline.lastLayoutMs, geometryMs: this.pipeline.lastGeometryMs,
        meshMs: this.pipeline.lastBranchMeshMs, layoutSource: this.pipeline.lastLayoutSource };
      requestAnimationFrame(() => {
        if (document.visibilityState !== 'visible') return;
        fixture.__referenceFrame = { presentedAt: performance.timeOrigin + performance.now(), ...timing };
        window.dispatchEvent(new Event('reference-frame'));
      });
    }
"""


def measure(work, revision, port, repeats, slowdown):
    project = memory.build(work, port, revision, visible_documents=True)
    memory.instrument(project)
    adapter = project / "src/lib/host/tauri.ts"
    marker = "  fixtureContext() { return invoke('crash_gate_context'); }"
    gate.patch_file(adapter, marker, marker + "\n  async fixtureMonitor() { "
                    "return (await import('@tauri-apps/api/window')).currentMonitor(); }")
    ui = project / "src/lib/ui"
    for source, target in [("desktop-memory-fixture.js", "desktop-memory-fixture.js"),
                           ("reference-pan.js", "reference-pan.js"),
                           ("desktop-performance-fixture.js", "crash-gate-fixture.js")]:
        shutil.copyfile(TOOLS / source, ui / target)
    gate.patch_file(ui / "controller.svelte.ts", disk.FRAME_MARKER, disk.FRAME_MARKER + HOOK)
    profile = work / "maps"
    profile.mkdir()
    scenarios = [dict(name=name, nodes=count, pictures=pictures, path=str(profile / (name + ".radiant")),
                      slowdownMs=slowdown) for name, count, pictures in SIZES]
    seed = memory.Run("seed", profile, scenarios, memory.seed_rasters(profile))
    trials = {seed.id: seed}
    monitor = gate.event_server(trials)
    binary = work / "target/release/radiant"
    token = uuid.uuid4().hex
    samples = []
    with (work / "frontend.log").open("w") as frontend_log, (work / "native.log").open("w") as native_log:
        frontend = subprocess.Popen(["node", TOOLS / "desktop-crash-gate.mjs", project, str(port),
                                     str(monitor.server_port), token], cwd=project,
                                    stdout=frontend_log, stderr=subprocess.STDOUT)
        try:
            disk.wait_frontend(frontend, port, token, "frontend.log")
            process = memory.launch(binary, seed, native_log)
            try:
                seed.expect("seeded", process)
            finally:
                memory.stop(process)
            run = memory.Run("measure", profile, scenarios * repeats)
            trials[run.id] = run
            process = memory.launch(binary, run, native_log)
            try:
                run.expect("ready", process)
                for cycle, scenario in enumerate(run.scenarios):
                    run.advance(cycle, "open")
                    request = profile / "request.tmp"
                    request.write_text(json.dumps(dict(run=run.id, cycle=cycle, path=scenario["path"], visible=True)))
                    request.replace(profile / "memory-open.json")
                    sample = run.expect("measured", process, cycle)["sample"]
                    status = json.loads((profile / "memory-open-status.json").read_text())
                    if status["cycle"] != cycle or status["error"]:
                        raise RuntimeError(f"Invalid native open receipt {status}")
                    sample["openMs"] = sample.pop("presentedAt") - status["startedMs"]
                    if sample["openMs"] <= 0:
                        raise RuntimeError("Invalid native open timing")
                    samples.append(sample)
                    print(f"{sample['name']:6} interval {sample['interval']['mean']:.2f} ms, "
                          f"script {sample['script']['mean']:.2f} ms, open {sample['openMs']:.1f} ms", flush=True)
                    deadline = time.monotonic() + 15
                    while scenario["path"] in json.loads((profile / "desktop-session.json").read_text())["windows"]:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Measured document did not close")
                        time.sleep(.05)
            finally:
                memory.stop(process)
        finally:
            memory.stop(frontend)
            monitor.shutdown()
    return samples


def hardware():
    return subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()


def context_key(samples):
    contexts = set()
    for sample in samples:
        display = sample["capture"]
        # Keep the physical monitor, window/backing size and high-refresh setting in the comparison key.
        contexts.add(tuple(display.get(k) for k in ("monitor", "monitorX", "monitorY", "displayHz", "highRefreshEnabled", "width",
                                                    "height", "dpr", "screenWidth", "screenHeight")))
    if len(contexts) != 1:
        raise RuntimeError("Display or window changed during the reference run")
    return list(contexts.pop())


def metrics(row):
    return dict(intervalMs=row["interval"]["mean"], scriptMs=row["script"]["mean"],
                openMs=row["openMs"], layoutMs=row["layoutMs"])


def assess(report, baseline=None):
    failures = []
    samples = report["samples"]
    hz = report["hz"]
    for name, nodes, pictures in SIZES:
        matching = [s for s in samples if s["name"] == name]
        if (not matching or len(matching) != report["repeats"]
                or any(s["nodes"] != nodes or s["pictures"] != pictures for s in matching)):
            return [f"{name}: missing or incorrect reference samples"]
    for row in samples:
        name = row["name"]
        # Calibrate on the unloaded view. A slow pan cannot select an easier display budget.
        if abs(1000 / row["refreshInterval"] - hz) > hz * .05:
            failures.append(f"{name}: observed refresh does not match {hz} Hz")
        budget = 16.7 if hz == 60 or name == "stress" else 8.4
        if row["interval"]["mean"] > budget:
            failures.append(f"{name}: mean frame interval exceeded {budget} ms")
        if row["missedDraws"] > 1:
            failures.append(f"{name}: missed {row['missedDraws']} requested draws")
        if name == "large":
            if row["script"]["mean"] > 4:
                failures.append("large: mean render script exceeded 4 ms")
            if row["openMs"] >= 500:
                failures.append("large: first rendering opportunity took 500 ms or more")
            if row["idleDraws"] != 0:
                failures.append("large: drew frames while idle")
            if row["layoutSource"] != "worker":
                failures.append("large: layout did not use a worker")
    large_layout = [s["layoutMs"] for s in samples if s["name"] == "large"]
    if statistics.median(large_layout) >= 50:
        failures.append("large: median worker layout reached or exceeded 50 ms")
    if baseline:
        if not baseline.get("passed") or baseline.get("context") != report["context"] or baseline.get("hz") != hz:
            failures.append("Baseline must be a passing run from the same hardware, display and viewport")
            return failures
        for name, _, _ in SIZES:
            reference = [metrics(s) for s in baseline["samples"] if s["name"] == name]
            current = [metrics(s) for s in samples if s["name"] == name]
            if len(reference) < 3:
                failures.append(name + ": baseline requires at least three repeats for variance")
                continue
            for metric in reference[0]:
                values = [r[metric] for r in reference]
                center = statistics.median(values)
                # ENG-24 proposes 10% for mean script time. For the other budgets allow
                # measured baseline variation in addition to the absolute limits above.
                tolerance = max(center * .10, 0 if metric == "scriptMs" else max(values) - min(values))
                if statistics.median(r[metric] for r in current) > center + tolerance:
                    failures.append(f"{name}: {metric} regressed from baseline {center:.3f} ms")
    return list(dict.fromkeys(failures))


def print_table(reports):
    print("\n| Mode | Map | Samples | Frame mean / p95 / p99 (ms) | Script mean / p95 / p99 (ms) | "
          "Median open (ms) | Median layout (ms) | Idle draws |")
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for report in reports:
        for name, _, _ in SIZES:
            rows = [s for s in report.get("samples", []) if s["name"] == name]
            if not rows:
                continue
            def summary(field):
                values = sorted(v for row in rows for v in row[field])
                return " / ".join(f"{n:.2f}" for n in (statistics.mean(values),
                                  values[math.ceil(.95 * len(values)) - 1],
                                  values[math.ceil(.99 * len(values)) - 1]))
            idle = max((r["idleDraws"] for r in rows if "idleDraws" in r), default="—")
            print(f"| {report['hz']} Hz | {name} | {len(rows)} | {summary('intervalSamples')} | "
                  f"{summary('scriptSamples')} | {statistics.median(r['openMs'] for r in rows):.1f} | "
                  f"{statistics.median(r['layoutMs'] for r in rows):.1f} | {idle} |")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", type=Path, nargs="+", help="Tabulate existing display reports and exit")
    parser.add_argument("--check-report", type=Path, help="Apply the gates to an archived measurement")
    parser.add_argument("--hz", type=int, choices=(60, 120), help="Expected visible refresh mode")
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--port", type=int, default=5295)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--slowdown-ms", type=float, default=0, help="Inject delay in the fixture renderer")
    args = parser.parse_args()
    if args.table:
        print_table([json.loads(p.read_text()) for p in args.table])
        return 0
    baseline = json.loads(args.baseline.read_text()) if args.baseline else None
    if args.check_report:
        report = json.loads(args.check_report.read_text())
        if not report.get("samples"):
            print("Report has no completed measurements", file=sys.stderr)
            return 1
        failures = assess(report, baseline)
        for reason in failures:
            print(reason, file=sys.stderr)
        return int(bool(failures))
    if not args.hz or not args.report:
        parser.error("A measurement needs --hz and --report")
    if sys.platform != "darwin" or args.runs < 1 or not math.isfinite(args.slowdown_ms) or args.slowdown_ms < 0:
        parser.error("Requires macOS, positive repeats and a finite nonnegative slowdown")
    if '"CGSSessionScreenIsLocked"=Yes' in subprocess.check_output(["ioreg", "-n", "Root", "-d1"], text=True):
        parser.error("Unlock the current Mac display to measure native frame cadence")
    revision = subprocess.check_output(["git", "rev-parse", "--verify", args.revision + "^{commit}"],
                                       cwd=gate.REPO, text=True).strip()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = dict(schema=1, date=datetime.now(timezone.utc).isoformat(), commit=revision, hz=args.hz,
                  repeats=args.runs, slowdownMs=args.slowdown_ms, passed=False)
    with tempfile.TemporaryDirectory(prefix="radiant-reference-") as directory:
        work = Path(directory).resolve()
        try:
            report["samples"] = measure(work, revision, args.port, args.runs, args.slowdown_ms)
            report["context"] = dict(protocol=1, shell="release-tauri-wkwebview", cpu=hardware(),
                                     macOS=platform.mac_ver()[0], display=context_key(report["samples"]))
            report["failures"] = assess(report, baseline)
            report["passed"] = not report["failures"]
        except Exception as error:
            report["failures"] = [str(error)]
            for name in ["frontend.log", "native.log", "build.log"]:
                if (work / name).exists():
                    shutil.copyfile(work / name, args.report.with_suffix("." + name))
        finally:
            args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print_table([report])
    for reason in report["failures"]:
        print(reason, file=sys.stderr)
    return int(not report["passed"])


if __name__ == "__main__":
    sys.exit(main())
