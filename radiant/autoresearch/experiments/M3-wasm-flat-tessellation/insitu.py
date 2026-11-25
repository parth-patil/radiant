# /// script
# dependencies = ["playwright"]
# ///
# In-app probe: production bench builds A and B; per page load a 50k map, then switch rope -> clean N times and record
# the settled time of each switch to clean and the worker's diagnostics. Alternates builds, fresh context per page.
import json, sys, subprocess, time, socket, statistics, fcntl, os
# Take the benchmark's machine-wide lock like measure.py does, so this probe never runs beside a measurement.
_lock = open('/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/bench.lock', 'a+')
fcntl.flock(_lock, fcntl.LOCK_EX)
_lock.seek(0); _lock.truncate(); _lock.write(f"pid {os.getpid()} insitu.py (mesh track probe) since {time.strftime('%H:%M:%S')}\n"); _lock.flush()
from playwright.sync_api import sync_playwright
a, b, out, rounds, n, reps = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
engines = (sys.argv[7] if len(sys.argv) > 7 else 'chrome,webkit').split(',')
def port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
pa, pb = port(), port()
srv = [subprocess.Popen([sys.executable, '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/mesh/kbench/serve.py', str(pa), a, 'isolate']), subprocess.Popen([sys.executable, '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/mesh/kbench/serve.py', str(pb), b, 'isolate'])]
time.sleep(1)
SETTLE = """async (t) => { const B = window.__radiantBench; const g = B.layoutGeneration(); const t0 = performance.now(); B.setTheme(t);
  const frame = () => new Promise(r => requestAnimationFrame(r)); let ok = 0;
  while (ok < 2) { await frame(); ok = (B.layoutGeneration() > g && B.idle()) ? ok + 1 : 0; }
  const d = B.diagnostics(); return { ms: performance.now() - t0, mesh: d.branchMeshMs, layout: d.layoutMs, adopt: d.adoptMs }; }"""
res = []
try:
  with sync_playwright() as p:
    for eng in engines:
        br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"]) if eng == 'chrome' else p.webkit.launch()
        for r in range(rounds):
            for name, prt in ([('A', pa), ('B', pb)] if r % 2 == 0 else [('B', pb), ('A', pa)]):
                ctx = br.new_context(viewport={'width': 1400, 'height': 900}); pg = ctx.new_page()
                pg.goto(f"http://127.0.0.1:{prt}/")
                pg.wait_for_function("() => window.__radiantBench", timeout=60000)
                pg.evaluate("(n) => window.__radiantBench.loadSynthetic(n)", n)
                pg.wait_for_function("(n) => window.__radiantBench.nodeCount() >= n * 0.99 && window.__radiantBench.idle()", arg=n, timeout=180000)
                for k in range(reps):
                    pg.evaluate(SETTLE, 'rope')
                    x = pg.evaluate(SETTLE, 'clean'); x.update({'engine': eng, 'build': name, 'round': r, 'k': k}); res.append(x)
                ctx.close()
        br.close()
finally:
    for s in srv: s.kill()
json.dump(res, open(out, 'w'), indent=1)
for eng in engines:
    for name in ['A', 'B']:
        xs = [x for x in res if x['engine'] == eng and x['build'] == name]
        f = lambda m: (round(statistics.median([x[m] for x in xs]), 1), round(min(x[m] for x in xs), 1), round(max(x[m] for x in xs), 1))
        print(eng, name, len(xs), 'settled', f('ms'), 'mesh', f('mesh'), 'layout', f('layout'))
