# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""T3 check: random edits through the editor on the dev server; after each, the laid-out nodes and label texts must
match the main document; at the end a forced whole-document resync must give identical boxes."""
import sys, json
from playwright.sync_api import sync_playwright
JS = r"""
async ([n, theme, steps, seed0]) => {
  const R = window.__radiant, c = R.c;
  const stats = { full: 0, edits: 0, streamed: 0, resync: 0 };
  if (!Worker.prototype.__wrapped) { const post = Worker.prototype.postMessage; Worker.prototype.postMessage = function (m, t) { if (m && m.work) { if (m.work.doc) stats.full++; else stats.edits++; } if (m && m.header) stats.streamed++; return post.call(this, m, t); }; Worker.prototype.__wrapped = true;
    const d = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage'); Object.defineProperty(Worker.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) { d.set.call(this, fn && ((ev) => { if (ev.data && ev.data.resync) stats.resync++; return fn(ev); })); } }); }
  const M = await import('/src/lib/core/model/index.ts');
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 3000 && q < 3; i++) { await raf(); q = (!c.frameWorkPending && R.renderer.idle) ? q + 1 : 0; } };
  c.loadSynthetic(n); await settle();
  if (theme !== 'clean') { c.setTheme(theme); await settle(); }
  let seed = seed0; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pickId = () => { const ids = Object.keys(c.doc.nodes); return ids[Math.floor(rnd() * ids.length)]; };
  const visible = () => { const out = new Set(); const st = [...c.doc.roots]; while (st.length) { const id = st.pop(); out.add(id); const nd = c.doc.nodes[id]; if (!nd.collapsed) st.push(...nd.children); } return out; };
  const problems = []; const log = [];
  const check = (label) => {
    const vis = visible(); const boxes = R.pipeline.layout.boxes;
    if (boxes.size !== vis.size) problems.push(label + ': boxes ' + boxes.size + ' visible ' + vis.size);
    for (const id of boxes.keys()) if (!vis.has(id)) { problems.push(label + ': stray box ' + id); break; }
    const scene = R.pipeline.baseScene;
    if (scene) for (const l of scene.labels) { const nd = c.doc.nodes[l.id]; if (!l.foldBadge && nd && !l.text.includes(nd.text.slice(0, 5)) && nd.text) { problems.push(label + ': label "' + l.text + '" vs "' + nd.text + '"'); break; } }
  };
  const ops = ['add', 'text', 'text', 'delete', 'move', 'fold', 'style', 'dup', 'sibling', 'undo', 'redo', 'type'];
  for (let s = 0; s < steps; s++) {
    const op = ops[Math.floor(rnd() * ops.length)];
    let e = null; const id = pickId(); const nd = c.doc.nodes[id];
    try {
      if (op === 'add') e = M.addChild(c.doc, id, 'Added ' + s);
      else if (op === 'text') e = M.setText(c.doc, id, 'Renamed ' + s + ' ' + 'x'.repeat(Math.floor(rnd() * 20)));
      else if (op === 'delete' && nd.parent) e = M.deleteSubtree(c.doc, [id]);
      else if (op === 'move' && nd.parent) { const to = pickId(); if (!M.isAncestor(c.doc, id, to) && to !== id) e = M.moveSubtree(c.doc, id, to); }
      else if (op === 'fold' && nd.children.length) e = M.toggleCollapsed(c.doc, id);
      else if (op === 'style') e = M.setStyle(c.doc, [id], { color: rnd() < .5 ? '#cc3311' : '#117733' });
      else if (op === 'dup' && nd.parent) e = M.duplicateSubtree(c.doc, id);
      else if (op === 'sibling' && nd.parent) e = M.addSibling(c.doc, id);
      else if (op === 'undo') { c.editor.undo(); }
      else if (op === 'redo') { c.editor.redo(); }
      else if (op === 'type') { for (let k = 0; k < 5; k++) { const t = M.setText(c.doc, id, (nd.text || '') + 'abcde'.slice(0, k + 1)); if (t) c.editor.apply(t.tx); } }
      if (e && e.tx) c.editor.apply(e.tx);
    } catch (err) { log.push(op + ' threw ' + String(err).slice(0, 80)); }
    if (rnd() < 0.7) await settle();
    else await raf();
    if (s % 1 === 0) { await settle(); check('step ' + s + ' ' + op); }
  }
  await settle();
  const snap = () => JSON.stringify({ boxes: [...R.pipeline.layout.boxes], placements: R.pipeline.placements, specs: R.pipeline.drawnBranches, labels: R.pipeline.baseScene && R.pipeline.baseScene.labels, rects: R.pipeline.baseScene && R.pipeline.baseScene.rects });
  const full0 = snap();
  const before = new Map([...R.pipeline.layout.boxes].map(([k, b]) => [k, [b.x, b.y, b.w, b.h].join(',')]));
  const replicaState = c.workerDoc ? 'replica' : 'none';
  c.workerDoc = null; c.refreshLayout(); await settle();
  const after = R.pipeline.layout.boxes; let diff = 0;
  for (const [k, b] of after) if (before.get(k) !== [b.x, b.y, b.w, b.h].join(',')) diff++;
  const full1 = snap(); let firstDiff = -1; for (let i = 0; i < Math.max(full0.length, full1.length); i++) if (full0[i] !== full1[i]) { firstDiff = i; break; }
  const exact = full0 === full1; const around = firstDiff >= 0 ? [full0.slice(Math.max(0, firstDiff - 150), firstDiff + 80), full1.slice(Math.max(0, firstDiff - 150), firstDiff + 80)] : null;
  return { stats, problems: problems.slice(0, 10), nproblems: problems.length, log: log.slice(0, 5), replicaState, nodes: Object.keys(c.doc.nodes).length, boxes: after.size, resyncDiff: diff, exact, around, snapLen: full0.length, beforeSize: before.size, source: R.pipeline.lastLayoutSource };
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu"])
    for n in [int(x) for x in sys.argv[1].split(",")]:
        for theme in sys.argv[2].split(","):
            for seed in [int(x) for x in sys.argv[3].split(",")]:
                pg = br.new_page(viewport={"width": 1400, "height": 900})
                errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
                pg.goto(sys.argv[5] if len(sys.argv) > 5 else "http://127.0.0.1:1441/"); pg.wait_for_function("() => window.__radiant", timeout=60000)
                print(n, theme, seed, json.dumps(pg.evaluate(JS, [n, theme, int(sys.argv[4]) if len(sys.argv) > 4 else 40, seed])), errs[:2], flush=True)
                pg.close()
    br.close()
