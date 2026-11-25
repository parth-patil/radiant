# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Autosave still runs after an edit (browser host and the journal path); reports the save text and timing."""
import sys, json
from playwright.sync_api import sync_playwright
JS = r"""
async ([n, journal]) => {
  const R = window.__radiant, c = R.c;
  const M = await import('/src/lib/core/model/index.ts');
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 3000 && q < 3; i++) { await raf(); q = (!c.frameWorkPending && R.renderer.idle) ? q + 1 : 0; } };
  c.loadSynthetic(n); await settle();
  let commits = 0, autosaves = 0;
  if (journal) { c.host.docCommit = async () => { commits++; return true; }; c.editor.setCommitBarrier((ch) => c.journalChange(ch), () => {}); }
  const orig = c.host.docAutosave.bind(c.host); c.host.docAutosave = async (...a) => { autosaves++; return orig(...a); };
  const out = [];
  for (let i = 0; i < 3; i++) {
    const id = c.doc.roots[0];
    const e = M.addChild(c.doc, c.doc.nodes[id].children[0], 'T4 ' + i);
    const t0 = performance.now();
    c.editor.apply(e.tx);
    await settle();
    await new Promise(r => setTimeout(r, 400));
    out.push({ settled: +(performance.now() - t0).toFixed(1), saveText: c.saveText, dirty: c.dirty });
  }
  return { out, commits, autosaves };
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    for journal in [False, True]:
        pg = br.new_page(viewport={"width": 1400, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("http://127.0.0.1:1433/"); pg.wait_for_function("() => window.__radiant", timeout=60000)
        print("journal" if journal else "browser", json.dumps(pg.evaluate(JS, [int(sys.argv[1]), journal])), errs[:2], flush=True)
        pg.close()
    br.close()
