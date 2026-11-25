#!/usr/bin/env python3
"""Check the native saved large map round trip and first WebView render opportunity."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
from contextlib import contextmanager
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

TOOLS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("memory_gate", TOOLS / "check-memory.py")
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)
gate = memory.gate

FRAME_HOOK = """
    const fixtureWindow = window as Window & {
      __diskOpenPending?: boolean;
      __diskOpenFrame?: { draw: number; frame: number; layout: string; visibility: string };
    };
    if (!fixtureWindow.__diskOpenPending && this.filePath && this.pipeline.nodeCount === 5000
        && s.meshTriangles > 0 && this.pipeline.doc === this.doc) {
      fixtureWindow.__diskOpenPending = true;
      const draw = Date.now();
      const layout = this.pipeline.lastLayoutSource;
      // A second display callback witnesses a rendering opportunity after the submitted frame.
      requestAnimationFrame(() => {
        fixtureWindow.__diskOpenFrame = { draw, frame: Date.now(), layout, visibility: document.visibilityState };
        fixtureWindow.dispatchEvent(new Event('radiant-disk-open-frame'));
      });
    }
"""
FRAME_MARKER = "  private onFrame(s: RenderStats): void {\n"
LEGACY_LOAD = "      const json = await this.host.docLoad(path, true);"
EDITABLE_LOAD = """      const opened = await this.host.docOpen?.(path);
      const json = opened?.json ?? await this.host.docLoad(path, true);"""
LOAD_END = "      Object.assign(window, { __diskOpenRead: { start: startRead, end: Date.now() } });"



class OpenRun(memory.Run):
    def append(self, event):
        with self.changed:
            self.events.append(event)
            self.changed.notify_all()
            return {"mode": self.mode, "scenario": self.scenarios[0], "hashes": self.hashes}


def instrument(project):
    memory.instrument(project)
    ui = project / "src/lib/ui"
    shutil.copyfile(TOOLS / "desktop-memory-fixture.js", ui / "memory-fixture.js")
    shutil.copyfile(TOOLS / "desktop-open-fixture.js", ui / "crash-gate-fixture.js")
    adapter = project / "src/lib/host/tauri.ts"
    if "fixtureOpenSnapshot() {" not in adapter.read_text():
        line = "  fixtureContext() { return invoke('crash_gate_context'); }"
        gate.patch_file(adapter, line, line + "\n  fixtureOpenSnapshot() { return invoke('snapshot'); }")
    controller = ui / "controller.svelte.ts"
    if FRAME_HOOK not in controller.read_text():
        gate.patch_file(controller, FRAME_MARKER, FRAME_MARKER + FRAME_HOOK)
    contents = controller.read_text()
    if LOAD_END not in contents:
        load = EDITABLE_LOAD if EDITABLE_LOAD in contents else LEGACY_LOAD
        gate.patch_file(controller, load, "      const startRead = Date.now();\n" + load + "\n" + LOAD_END)


@contextmanager
def instrumented(project, preserve):
    if not preserve:
        instrument(project)
        yield
        return
    relative_files = ("src/lib/ui/controller.svelte.ts", "src/lib/host/tauri.ts",
                      "src/lib/ui/crash-gate-fixture.js", "src/lib/ui/memory-fixture.js",
                      "src/lib/ui/App.svelte", "src/lib/ui/debug.ts", ".crash-gate-instrumented")
    originals = {project / name: (project / name).read_bytes() if (project / name).is_file() else None
                 for name in relative_files}
    try:
        instrument(project)
        yield
    finally:
        for path, original in originals.items():
            if original is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(original)


def wait_frontend(frontend, port, token, log_name="disk-open-frontend.log"):
    limit = time.monotonic() + 120
    while frontend.poll() is None and time.monotonic() < limit:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/_gate-health", timeout=1) as reply:
                if reply.read() == token.encode():
                    return
        except OSError:
            pass
        time.sleep(.1)
    raise RuntimeError(f"Scratch frontend failed to start. See {log_name}.")


def verify_assets(path, directory, hashes):
    with sqlite3.connect(path) as connection:
        embedded = dict(connection.execute("SELECT hash, bytes FROM assets"))
    if set(embedded) != set(hashes) or len(embedded) != 300:
        raise RuntimeError("The native file did not contain all 300 pictures")
    for key, data in embedded.items():
        extracted = (directory / (key + ".png")).read_bytes()
        if extracted != data or hashlib.sha256(data).hexdigest() != key:
            raise RuntimeError(f"The reopened artwork changed: {key}")


def measure(work, project, port, runs, structure_only):
    # A fresh profile keeps previously measured assets out of the portable first-open case.
    scratch = Path(tempfile.mkdtemp(prefix="open-", dir=work))
    print("Artifacts:", scratch, flush=True)
    binary = work / "target/release/radiant"
    profile = scratch / "open-profile"
    seed_profile = scratch / "seed-profile"
    profile.mkdir()
    seed_profile.mkdir()
    large = {"path": str(profile / "large.radiant"), "nodes": 5000, "pictures": 300}
    hashes = memory.seed_rasters(seed_profile)
    seed = OpenRun("seed", seed_profile, [large], hashes)
    trials = {seed.id: seed}
    monitor = gate.event_server(trials)
    token = uuid.uuid4().hex
    with (scratch / "disk-open-frontend.log").open("w") as frontend_log, (scratch / "disk-open-native.log").open("w") as native_log:
        frontend = subprocess.Popen(["node", TOOLS / "desktop-crash-gate.mjs", project,
                                     str(port), str(monitor.server_port), token], cwd=project,
                                    stdout=frontend_log, stderr=subprocess.STDOUT)
        try:
            wait_frontend(frontend, port, token)
            process = memory.launch(binary, seed, native_log)
            try:
                expected = seed.expect("seeded", process)["expected"]
            finally:
                memory.stop(process)
            del trials[seed.id]
            opened = []
            for i in range(runs):
                trial = OpenRun("structure" if structure_only else "open", profile, [large])
                trials[trial.id] = trial
                repair = structure_only and runs >= 3 and i == runs - 1
                if repair:
                    (profile / "assets" / (hashes[0] + ".png")).write_bytes(b"interrupted cache extraction")
                process = memory.launch(binary, trial, native_log)
                try:
                    ready = trial.expect("ready", process)
                    request = profile / "memory-open.tmp"
                    request.write_text(json.dumps({"run": trial.id, "cycle": i, "path": large["path"], "visible": not structure_only}))
                    start = time.time_ns() / 1_000_000
                    request.replace(profile / "memory-open.json")
                    target = "structure" if structure_only else "presented"
                    try:
                        frame = trial.expect(target, process, timeout=25)
                    except RuntimeError as error:
                        raise RuntimeError(f"{error}; recent receipts: {trial.events}") from error
                    native = json.loads((profile / "memory-open-status.json").read_text())
                    if native["cycle"] != i or native["error"] or native["startedMs"] is None:
                        raise RuntimeError("The native window did not record the open command")
                    if frame["label"] == "main" or frame["structure"] != expected or frame["images"] != 300:
                        raise RuntimeError("The native reopen did not reproduce the saved structure")
                    if not structure_only and (frame["layout"] != "worker" or frame["visibility"] != "visible"
                            or frame["frame"] < frame["draw"] or frame["draw"] < start):
                        raise RuntimeError("The document frame was not a valid worker-backed sample")
                    sample = {"coldAssetCache": i == 0, "repairedAssetCache": repair,
                              "nativeToDiskReadMs": round(frame["read"]["start"] - native["startedMs"], 2),
                              "diskReadMs": frame["read"]["end"] - frame["read"]["start"],
                              "hostPid": process.pid, "mainWebContentPid": ready["webview"],
                              "mapWebContentPid": frame["webview"]}
                    if not structure_only:
                        capture = profile / f"{frame['label']}.tiff"
                        if frame["snapshot"] < frame["frame"] or capture.stat().st_size < 1024:
                            raise RuntimeError("WKWebView did not return a valid capture after the map frame")
                        sample.update(drawMs=round(frame["draw"] - start, 2),
                                      nextFrameMs=round(frame["frame"] - start, 2),
                                      nativeToNextFrameMs=round(frame["frame"] - native["startedMs"], 2),
                                      nativeToSnapshotMs=round(frame["snapshot"] - native["startedMs"], 2),
                                      snapshotFile=str(capture))
                    opened.append(sample)
                    print(json.dumps(sample), flush=True)
                    session = profile / "desktop-session.json"
                    until = time.monotonic() + 10
                    while large["path"] in json.loads(session.read_text())["windows"]:
                        if time.monotonic() > until:
                            raise RuntimeError("The native document window did not close")
                        time.sleep(.05)
                    if i == 0 or repair:
                        verify_assets(large["path"], profile / "assets", hashes)
                finally:
                    memory.stop(process)
                    del trials[trial.id]
            return scratch, expected, opened
        finally:
            memory.stop(frontend)
            monitor.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5294)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--prepared", type=Path)
    parser.add_argument("--structure-only", action="store_true", help="Check the round trip without timing presentation")
    args = parser.parse_args()
    if sys.platform != "darwin" or args.runs < 1:
        parser.error("Requires macOS and at least one run")
    if not args.structure_only:
        session = subprocess.check_output(["ioreg", "-n", "Root", "-d1"], text=True)
        if '"CGSSessionScreenIsLocked"=Yes' in session:
            parser.error("The macOS display is locked. Use --structure-only or run on an unlocked display.")
    work = (args.prepared or Path(tempfile.mkdtemp(prefix="radiant-open-"))).resolve()
    if args.prepared:
        metadata = json.loads((work / "memory-fixture.json").read_text())
        if args.port != metadata["port"]:
            parser.error("Use the prepared fixture port")
        project = work / "radiant"
    else:
        revision = subprocess.check_output(["git", "rev-parse", args.revision], cwd=gate.REPO, text=True).strip()
        project = memory.build(work, args.port, revision, visible_documents=not args.structure_only)
        metadata = json.loads((work / "memory-fixture.json").read_text())
    with instrumented(project, args.prepared):
        scratch, digest, opened = measure(work, project, args.port, args.runs, args.structure_only)
    result = {"revision": metadata["revision"], "macOS": platform.mac_ver()[0],
              "fixtureStructureHash": digest, "structuralMatch": True, "embeddedPicturesVerified": 300,
              "samples": opened}
    passed = True
    if not args.structure_only:
        times = [sample["nativeToNextFrameMs"] for sample in opened]
        result.update(budgetMs=500, medianMs=statistics.median(times), maxMs=max(times),
                      snapshotMaxMs=max(sample["nativeToSnapshotMs"] for sample in opened))
        passed = max(times) < 500
        print(f"Median {result['medianMs']:.2f} ms, max {result['maxMs']:.2f} ms (budget < 500 ms)")
    (scratch / "disk-open-report.json").write_text(json.dumps(result, indent=2) + "\n")
    return int(not passed)


if __name__ == "__main__":
    raise SystemExit(main())
