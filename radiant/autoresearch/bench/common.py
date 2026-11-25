"""Shared pieces of the Radiant benchmark: lock, production build cache, static server, browsers, statistics.

Imported by measure.py and visual.py (the script directory is on sys.path when uv runs them).
"""
from __future__ import annotations

import contextlib
import fcntl
import functools
import hashlib
import http.server
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRATCH = Path("/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar")
LOCK_PATH = SCRATCH / "bench.lock"
BUILD_CACHE = SCRATCH / "bench-builds"
KEEP_BUILDS = 16
BENCH_FLAG = {"VITE_RADIANT_BENCH": "1"}
VIEWPORT = {"width": 1728, "height": 1117}
SCALE = 2
# Paths (relative to the radiant directory) left out of the build snapshot and of its cache key.
SKIP_NAMES = {"node_modules", ".svelte-kit", "build", ".git", "target", ".DS_Store", "autoresearch", "docs",
              "requirements", "__pycache__"}
BENCH_JS = (HERE / "bench.js").read_text()


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


@contextlib.contextmanager
def exclusive_lock(what: str):
    """Hold an exclusive fcntl lock for the whole measurement so two runs never overlap."""
    SCRATCH.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.seek(0)
            log(f"waiting for the benchmark lock ({LOCK_PATH}); held by: {handle.read().strip() or 'unknown'}")
            fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid {os.getpid()} {what} since {time.strftime('%H:%M:%S')}\n")
        handle.flush()
        try:
            yield
        finally:
            handle.seek(0)
            handle.truncate()
            fcntl.flock(handle, fcntl.LOCK_UN)


def _snapshot_files(tree: Path) -> list[Path]:
    """The files a front-end build can depend on. Of src-tauri only tauri.conf.json is read (by vite.config.js);
    the rest (Rust sources, generated schemas, the Quick Look bundle) changes with native builds and is left out."""
    files = []
    for root, dirs, names in os.walk(tree):
        rel_root = Path(root).relative_to(tree)
        dirs[:] = sorted(d for d in dirs if d not in SKIP_NAMES and not d.startswith(".")
                         and not (rel_root == Path(".") and d == "src-tauri"))
        for name in sorted(names):
            if name in SKIP_NAMES or name.startswith("vite.config.js.timestamp"):
                continue
            files.append(Path(root, name).relative_to(tree))
    if (tree / "src-tauri" / "tauri.conf.json").exists():
        files.append(Path("src-tauri/tauri.conf.json"))
    return files


def _git(tree: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return ""


def tree_info(tree: Path) -> dict:
    return {"path": str(tree), "commit": _git(tree, "rev-parse", "--short", "HEAD"),
            "dirty_files": len([l for l in _git(tree, "status", "--porcelain", ".").splitlines() if l.strip()])}


def build(tree: Path, force: bool = False) -> tuple[Path, dict]:
    """Production build of a radiant checkout with the benchmark hooks, cached by the content of its sources.

    The sources are copied to a scratch directory and built there (node_modules is linked from the tree), so the
    checkout's own build/ and .svelte-kit/ are never touched; a dev server running on the tree is not disturbed.
    """
    tree = tree.resolve()
    if not (tree / "package.json").exists():
        raise SystemExit(f"{tree} is not a radiant directory (no package.json)")
    if not (tree / "node_modules").exists():
        log(f"[build] {tree}: node_modules missing, running bun install --frozen-lockfile")
        subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=tree, check=True)
    files = _snapshot_files(tree)
    digest = hashlib.sha256()
    digest.update(json.dumps(BENCH_FLAG, sort_keys=True).encode())
    for rel in files:
        digest.update(str(rel).encode() + b"\0")
        digest.update((tree / rel).read_bytes())
        digest.update(b"\0")
    key = digest.hexdigest()[:16]
    out = BUILD_CACHE / key
    dist = out / "dist"
    info = {"key": key, "files": len(files), **tree_info(tree)}
    if (dist / "index.html").exists() and not force:
        info["cached"] = True
        os.utime(out)
        return dist, info
    shutil.rmtree(out, ignore_errors=True)
    work = out / "src"
    work.mkdir(parents=True)
    for rel in files:
        target = work / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(tree / rel, target, follow_symlinks=True)
    (work / "node_modules").symlink_to(tree / "node_modules")
    started = time.monotonic()
    log(f"[build] {tree} -> {key} (bun run build, VITE_RADIANT_BENCH=1)")
    proc = subprocess.run(["bun", "run", "build"], cwd=work, env={**os.environ, **BENCH_FLAG},
                          capture_output=True, text=True)
    if proc.returncode != 0 or not (work / "build" / "index.html").exists():
        tail = (proc.stdout + proc.stderr)[-4000:]
        raise SystemExit(f"production build failed for {tree}:\n{tail}")
    (work / "build").rename(dist)
    shutil.rmtree(work, ignore_errors=True)
    info["cached"] = False
    info["build_s"] = round(time.monotonic() - started, 1)
    (out / "info.json").write_text(json.dumps(info, indent=2))
    _prune_cache()
    return dist, info


def _prune_cache() -> None:
    entries = sorted((p for p in BUILD_CACHE.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in entries[KEEP_BUILDS:]:
        shutil.rmtree(old, ignore_errors=True)


class _Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                      ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2"}

    def log_message(self, *args):  # quiet
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if getattr(self.server, "isolate", False):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if not path.exists() or (path.is_dir() and not (path / "index.html").exists()):
            self.path = "/index.html"  # SPA fallback, as the Tauri shell does
        return super().send_head()


@contextlib.contextmanager
def serve(dist: Path, isolate: bool = True):
    """Serve a built app on a free local port; yields the base URL.

    isolate sends COOP/COEP so the page is cross-origin isolated: that is what gives performance.now() a usable
    resolution (Chrome 5 us instead of 100 us, WebKit 20 us instead of 1 ms). It also exposes SharedArrayBuffer,
    which the shipping app only has if the Tauri shell sends the same headers.
    """
    handler = functools.partial(_Handler, directory=str(dist))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.isolate = isolate
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def launch(p, engine: str):
    if engine == "chrome":
        return p.chromium.launch(channel="chrome", args=[
            "--use-angle=metal", "--enable-gpu", "--enable-precise-memory-info", "--js-flags=--expose-gc",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
    if engine == "webkit":
        return p.webkit.launch()
    raise SystemExit(f"unknown engine {engine!r} (chrome, webkit)")


def open_page(browser, url: str, reduced_motion: str = "reduce", color_scheme: str = "light"):
    context = browser.new_context(viewport=VIEWPORT, device_scale_factor=SCALE, reduced_motion=reduced_motion,
                                  color_scheme=color_scheme)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url + "/", wait_until="load")
    page.evaluate(BENCH_JS)
    env = page.evaluate("() => window.__benchRun.ready()")
    return context, page, env, errors


# ------------------------------------------------------------------------------------------------ statistics

def median(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    m = len(v) // 2
    return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2


def geomean(values):
    v = [x for x in values if x is not None and x > 0]
    return math.exp(sum(math.log(x) for x in v) / len(v)) if v else None


def log_sd(values):
    v = [math.log(x) for x in values if x is not None and x > 0]
    if len(v) < 2:
        return None
    m = sum(v) / len(v)
    return math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
