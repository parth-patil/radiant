#!/usr/bin/env python3
"""Measure Radiant host and WKWebView RSS in an isolated macOS fixture."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import zlib

TOOLS = Path(__file__).resolve().parent
BUDGET = TOOLS.parent / "requirements" / "memory-budget.json"

# Match the interruption gate's native instrumentation and scratch-profile isolation.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("desktop_gate", TOOLS / "verify-desktop-crashes.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Run(gate.Trial):
    def __init__(self, mode, profile, scenarios, hashes=None):
        super().__init__(mode, profile / "memory-fixture.radiant", 0, profile)
        self.scenarios = scenarios
        self.hashes = hashes
        self.cycle = -1
        self.step = "idle"

    def advance(self, cycle, step):
        with self.changed:
            self.cycle = cycle
            self.step = step
            self.changed.notify_all()

    def append(self, event):
        with self.changed:
            if event["kind"] == "map-poll":
                self.changed.wait_for(lambda: self.step == event["step"], timeout=25)
            else:
                self.events.append(event)
                self.changed.notify_all()
            return {
                "mode": self.mode,
                "cycles": len(self.scenarios),
                "scenarios": self.scenarios if self.mode == "seed" else None,
                "hashes": self.hashes,
                "scenario": self.scenarios[self.cycle] if self.cycle >= 0 else None,
                "cycle": self.cycle, "step": self.step,
            }

    def expect(self, kind, process, cycle=None, timeout=115):
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                for event in self.events:
                    if event["host"] != process.pid:
                        raise RuntimeError("Fixture receipt did not come from the launched Tauri host")
                    if event["kind"] == "error":
                        raise RuntimeError(event["message"])
                    if event["kind"] == kind and (cycle is None or event.get("cycle") == cycle):
                        return event
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(f"Expected {kind} for cycle {cycle}; receipts: {self.events}")
                self.changed.wait(.1)


class Memory:
    def __init__(self, host, main):
        self.host = host
        self.main = main
        self.identities = {}
        self.register(host, webview=False)
        self.register(main)

    @staticmethod
    def read(pids):
        lines = subprocess.run(["ps", "-p", ",".join(map(str, pids)),
                                "-o", "pid=", "-o", "rss=", "-o", "lstart=", "-o", "comm="],
                               capture_output=True, text=True, check=False).stdout.splitlines()
        result = {}
        for line in lines:
            pid, rss, *start_and_exe = line.split(maxsplit=7)
            result[int(pid)] = (int(rss) / 1024, " ".join(start_and_exe[:5]), start_and_exe[5])
        return result

    def register(self, pid, webview=True):
        if not isinstance(pid, int) or pid < 2 or (webview and pid == self.host):
            raise RuntimeError(f"Invalid process identity {pid}")
        process = self.read([pid]).get(pid)
        if process is None or (webview and "WebKit.WebContent" not in process[2]):
            raise RuntimeError(f"PID {pid} was not this fixture's WebContent process")
        self.identities[pid] = process[1:]

    def sample(self, document=None):
        live = {pid: rss for pid, (rss, start, exe) in self.read(self.identities).items()
                if self.identities[pid] == (start, exe)}
        for pid in (self.host, self.main, document):
            if pid is not None and pid not in live:
                raise RuntimeError(f"Active fixture process {pid} disappeared")
        active = {self.host, self.main, document}
        retired = sum(rss for pid, rss in live.items() if pid not in active)
        return {
            "host": round(live[self.host], 2), "mainWebContent": round(live[self.main], 2),
            "mapWebContent": round(live.get(document, 0), 2),
            "retiredWebContent": round(retired, 2), "total": round(sum(live.values()), 2),
        }


def launch(binary, run, log):
    return subprocess.Popen([binary], env={**os.environ, "CODEX_BIN": "/usr/bin/false",
                            "RADIANT_GATE_TRIAL": run.id, "RADIANT_GATE_PROFILE": run.profile},
                            stdout=log, stderr=subprocess.STDOUT)


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def build(work, port, revision, *, visible_documents=False):
    project, identifier = gate.build(work, port, revision, release=True, scratch_assets=True,
                                     memory_driver=TOOLS / "desktop-memory-driver.rs", visible_documents=visible_documents)
    (work / "memory-fixture.json").write_text(json.dumps({
        "identifier": identifier, "port": port, "revision": revision
    }))
    return project


def instrument(project):
    gate.prepare_frontend(project)
    adapter = project / "src/lib/host/tauri.ts"
    shutil.copyfile(TOOLS / "desktop-memory-fixture.js", project / "src/lib/ui/crash-gate-fixture.js")
    if "fixtureCloseWindow() {" not in adapter.read_text():
        line = "  fixtureContext() { return invoke('crash_gate_context'); }"
        gate.patch_file(adapter, line, line + "\n  fixtureCloseWindow() { return getCurrentWindow().destroy(); }")


def seed_rasters(profile):
    """Deterministic 480×320 RGB survey thumbnails with distinct contours and colours."""
    width, height = 480, 320
    assets = profile / "assets"
    assets.mkdir(exist_ok=True)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    hashes = []
    for index in range(300):
        bands = []
        for y in range(height):
            sky = bytes((83 + (index + y) % 85, 133 + y % 79, 180 + index % 71))
            mountain = bytes((38 + index % 16, 67 + y % 19, 74 + index % 7))
            crest = 42 + index % 87
            span = min(200, max(0, y - crest))
            bands.append(b"\0" + sky * (240 - span) + mountain * (2 * span) + sky * (240 - span))
        image = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(b"".join(bands))) + chunk(b"IEND", b""))
        digest = hashlib.sha256(image).hexdigest()
        (assets / f"{digest}.png").write_bytes(image)
        hashes.append(digest)
    return hashes


def measure(work, port, repeats, settle, visible=False):
    binary = work / "target/release/radiant"
    profile = work / "rss-profile"
    profile.mkdir(exist_ok=True)
    scenarios = [{"name": name, "nodes": count, "pictures": pictures, "visible": visible,
                  "path": str(profile / f"{name}.radiant")}
                 for name, count, pictures in [("small", 200, 0), ("large", 5000, 300), ("stress", 50000, 0)]]
    trials = {}
    monitor = gate.event_server(trials)
    token = uuid.uuid4().hex
    project = work / "radiant"
    with (work / "frontend.log").open("w") as frontend_log, (work / "native.log").open("w") as native_log:
        frontend = subprocess.Popen(["node", TOOLS / "desktop-crash-gate.mjs", project,
                                     str(port), str(monitor.server_port), token], cwd=project,
                                    stdout=frontend_log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 120
            while frontend.poll() is None and time.monotonic() < deadline:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/_gate-health", timeout=1) as response:
                        if response.read() == token.encode():
                            break
                except OSError:
                    pass
                time.sleep(.1)
            else:
                raise RuntimeError(f"Scratch frontend startup failed. Read {work / 'frontend.log'}.")
            if not all(Path(run["path"]).is_file() for run in scenarios):
                seed = Run("seed", profile, scenarios, seed_rasters(profile))
                trials[seed.id] = seed
                process = launch(binary, seed, native_log)
                try:
                    seed.expect("seeded", process)
                finally:
                    stop(process)
                    del trials[seed.id]
            # Warm and repeat the large map before the stress case can grow host allocator caches.
            plan = Run("measure", profile, scenarios[:2] + [scenarios[1]] * repeats + scenarios[2:])
            trials[plan.id] = plan
            (profile / "memory-open-status.json").unlink(missing_ok=True)
            process = launch(binary, plan, native_log)
            try:
                ready = plan.expect("ready", process)
                memory = Memory(process.pid, ready["webview"])
                time.sleep(settle)
                baseline = memory.sample()
                rows = []
                for cycle, scenario in enumerate(plan.scenarios):
                    plan.advance(cycle, "open")
                    request = profile / "memory-open.tmp"
                    request.write_text(json.dumps({"run": plan.id, "cycle": cycle, "path": scenario["path"],
                                                   "visible": visible}))
                    request.replace(profile / "memory-open.json")
                    native_ready = profile / "memory-open-status.json"
                    deadline = time.monotonic() + 10
                    while True:
                        if native_ready.is_file():
                            status = json.loads(native_ready.read_text())
                            if status["cycle"] == cycle:
                                if status["error"]:
                                    raise RuntimeError(status["error"])
                                break
                        if time.monotonic() >= deadline:
                            raise RuntimeError("The native driver did not open the map window")
                        time.sleep(.05)
                    open_receipt = plan.expect("opened", process, cycle)
                    document = open_receipt["webview"]
                    memory.register(document)
                    time.sleep(settle)
                    opened = memory.sample(document)
                    plan.advance(cycle, "edit")
                    plan.expect("edited", process, cycle)
                    time.sleep(settle)
                    edited = memory.sample(document)
                    session = profile / "desktop-session.json"
                    if scenario["path"] not in json.loads(session.read_text())["windows"]:
                        raise RuntimeError("The native session did not register the opened fixture")
                    plan.advance(cycle, "close")
                    deadline = time.monotonic() + 40
                    while scenario["path"] in json.loads(session.read_text())["windows"]:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("The native session did not release the closed fixture")
                        time.sleep(.1)
                    time.sleep(settle)
                    closed = memory.sample()
                    row = {"cycle": cycle + 1, "map": scenario["name"], "hostPid": process.pid,
                           "mainWebContentPid": ready["webview"], "mapWebContentPid": document,
                           "nodes": open_receipt["nodeCount"], "pictures": open_receipt["pictureCount"],
                           "drawnPictures": open_receipt["drawnPictures"], "layout": open_receipt["layoutSource"],
                           "opened": opened, "edited": edited, "closed": closed}
                    rows.append(row)
                    print(json.dumps(row), flush=True)
                return baseline, rows
            finally:
                stop(process)
        finally:
            stop(frontend)
            monitor.shutdown()


def summarize(baseline, rows):
    phases = [phase for row in rows for phase in (row["opened"], row["edited"])]
    summary = {name: {key: max(row[phase][key] for row in rows if row["map"] == name
                               for phase in ("opened", "edited")) for key in phases[0]}
               for name in ("small", "large", "stress")}
    cycles = [row["closed"]["total"] for row in rows if row["map"] == "large"][1:]
    warm = statistics.median(cycles[:3])
    late = statistics.median(cycles[-3:])
    slope = statistics.linear_regression(range(len(cycles) - 2), cycles[2:]).slope
    return {"baseline": baseline, "peakByMap": summary, "repeatedCloseMiB": cycles,
            "peakCloseAboveBaselineMiB": round(max(cycles) - baseline["total"], 2),
            "lateAboveEarlyMiB": round(late - warm, 2),
            "closeSlopeMiBPerCycle": round(slope, 3)}


def enforce(summary):
    limits = json.loads(BUDGET.read_text())
    failures = []
    for name, cap in limits["peakTotalMiB"].items():
        if summary["peakByMap"][name]["total"] > cap:
            failures.append(f"{name} working set exceeded {cap} MiB")
    for key in ("peakCloseAboveBaselineMiB", "lateAboveEarlyMiB", "closeSlopeMiBPerCycle"):
        if summary[key] > limits[key]:
            failures.append(f"{key} exceeded {limits[key]}")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5293)
    parser.add_argument("--cycles", type=int, default=12, help="Additional large-map edit/close cycles")
    parser.add_argument("--settle", type=float, default=1.0, help="Seconds to wait before each sample")
    parser.add_argument("--prepared", type=Path, help="Reuse this tool's scratch build")
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--measure-only", action="store_true")
    parser.add_argument("--visible", action="store_true", help="Use visible document windows and the streamed worker path on the stress map")
    parser.add_argument("--report", type=Path, help="Also write the completed report to this path")
    args = parser.parse_args()
    if sys.platform != "darwin" or args.cycles < 6 or args.settle < 0.25:
        parser.error("Requires macOS, at least six cycles and a settling interval of at least 0.25 seconds")
    if args.visible and '"CGSSessionScreenIsLocked"=Yes' in subprocess.check_output(["ioreg", "-n", "Root", "-d1"], text=True):
        parser.error("Visible memory measurements require an unlocked Mac display")
    work = (args.prepared or Path(tempfile.mkdtemp(prefix="radiant-memory-"))).resolve()
    print("Artifacts:", work, flush=True)
    config = work / "memory-fixture.json"
    if args.prepared and not config.is_file():
        parser.error("--prepared must name an existing memory fixture workspace")
    if config.is_file():
        metadata = json.loads(config.read_text())
        if metadata["port"] != args.port:
            parser.error("Use the existing fixture port")
        project = work / "radiant"
    else:
        revision = subprocess.check_output(["git", "rev-parse", args.revision], cwd=gate.REPO, text=True).strip()
        project = build(work, args.port, revision, visible_documents=args.visible)
        metadata = json.loads(config.read_text())
    if not project.resolve().is_relative_to(work):
        parser.error("The fixture sources must be in the scratch directory")
    instrument(project)
    baseline, rows = measure(work, args.port, args.cycles, args.settle, args.visible)
    summary = summarize(baseline, rows)
    failures = [] if args.measure_only else enforce(summary)
    report = {**metadata, "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
              "macOS": platform.mac_ver()[0], "architecture": platform.machine(),
              "macHardware": subprocess.check_output(["sysctl", "-n", "hw.model"], text=True).strip(),
              "settleSeconds": args.settle, "visibleDocuments": args.visible,
              "summary": summary, "samples": rows, "failures": failures}
    (work / "memory-report.json").write_text(json.dumps(report, indent=2) + "\n")
    if args.report and args.report.resolve() != work / "memory-report.json":
        args.report.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(work / "memory-report.json", args.report)
    print(json.dumps(summary, indent=2))
    for failure in failures:
        print(failure, file=sys.stderr)
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
