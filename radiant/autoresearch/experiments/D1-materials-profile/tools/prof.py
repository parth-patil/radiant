# /// script
# dependencies = ["playwright"]
# ///
# CDP CPU profile of BranchMeshCache.build (fresh) + packVertices in Chrome, per theme; self time by function.
import json, sys, subprocess, time, socket, collections
from playwright.sync_api import sync_playwright
mod, sizes, themes, out, reps = sys.argv[1], sys.argv[2].split(','), sys.argv[3].split(','), sys.argv[4], int(sys.argv[5])
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench/serve.py', str(port), '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench', 'isolate'])
time.sleep(0.8)
res = []
try:
  with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--js-flags=--expose-gc"])
    for n in sizes:
      for t in themes:
        pg = br.new_page()
        pg.goto(f"http://127.0.0.1:{port}/prof.html?n={n}&theme={t}&a={mod}")
        pg.wait_for_function("() => window.__ready", timeout=300000)
        pg.evaluate("() => window.__run(3)")
        cdp = pg.context.new_cdp_session(pg)
        cdp.send('Profiler.enable'); cdp.send('Profiler.setSamplingInterval', {'interval': 100}); cdp.send('Profiler.start')
        tm = pg.evaluate(f"() => window.__run({reps})")
        prof = cdp.send('Profiler.stop')['profile']
        nodes = {nd['id']: nd for nd in prof['nodes']}
        dt = collections.Counter()
        for sid, d in zip(prof['samples'], prof['timeDeltas']): dt[sid] += d
        by = collections.Counter()
        for nid, us in dt.items():
          cf = nodes[nid]['callFrame']; by[cf['functionName'] or '(anon)' + ':' + str(cf['lineNumber'])] += us
        tot = sum(by.values())
        top = [(k, round(v / 1000 / reps, 2), round(100 * v / tot, 1)) for k, v in by.most_common(18)]
        med = lambda xs: sorted(xs)[len(xs)//2]
        r = {'n': n, 'theme': t, 'miss_med': round(med(tm['miss']), 2), 'pack_med': round(med(tm['pack']), 2), 'top_per_rep_ms': top}
        print(json.dumps(r), flush=True); res.append(r)
        json.dump(prof, open(f"/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/materials/kbench/prof-{n}-{t}.cpuprofile", 'w'))
        pg.close()
    br.close()
finally:
    srv.kill()
json.dump(res, open(out, 'w'), indent=1)
