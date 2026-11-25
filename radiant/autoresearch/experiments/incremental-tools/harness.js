
async ([n, themeId, steps, seed0, mode, kinds]) => {
  const R = window.__radiant, c = R.c;
  const M = await import('/src/lib/core/model/index.ts');
  const P = await import('/src/lib/ui/pipeline.ts');
  const T = await import('/src/lib/render/text.ts');
  const LT = await import('/src/lib/ui/layout-transport.ts');
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => { let q = 0; for (let i = 0; i < 4000 && q < 3; i++) { await raf(); q = (!c.frameWorkPending && R.renderer.idle) ? q + 1 : 0; } };
  c.loadSynthetic(n); await settle();
  if (themeId !== 'clean') { c.setTheme(themeId); await settle(); }
  let theme = JSON.parse(JSON.stringify(c.theme));
  const otherTheme = JSON.parse(JSON.stringify(M.getTheme(themeId === 'clean' ? 'rope' : 'clean')));
  const doc = M.cloneDoc(JSON.parse(JSON.stringify(c.doc)));
  doc.layoutPlacements = undefined;
  c.loadSynthetic(20); await settle();
  // ---- timers on the pipeline's own methods
  const stage = {};
  const wrap = (name) => { const o = P.Pipeline.prototype[name]; P.Pipeline.prototype[name] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { stage[name] = (stage[name] || 0) + performance.now() - t; } }; };
  for (const k of ['computeSizes', 'branchSpecs', 'fullScene', 'relayout', 'computeWork', 'placePictureBoxes']) wrap(k);
  let editing = null, prepareScene = true;
  const mk = (d, placements, anchor = null) => ({ doc: d, theme, anchor, placements, imageInfo: new Map(), failedImages: new Set(), artPending: new Map(), showGeneratedArtwork: true, prepareScene, editing });
  const inc = new P.Pipeline(T.measureLabel);
  let res = inc.computeWork(mk(doc, undefined));
  let placements = res.placements;
  // ---- comparison
  const canon = (r, p) => ({
    boxes: [...r.layout.boxes.entries()], bounds: r.layout.bounds,
    placements: r.placements, specs: typeof r.layoutBranches === 'function' ? r.layoutBranches() : r.layoutBranches,
    // Without a prepared scene, computeWork returns the drawn branches of the last scene it did prepare (as before).
    drawn: prepareScene ? r.drawnBranches : null, curves: [...r.labelCurves.entries()],
    labels: r.baseScene && r.baseScene.labels, rects: r.baseScene && r.baseScene.rects, images: r.baseScene && r.baseScene.images,
    ink: r.baseScene && r.baseScene.ink, surface: r.baseScene && r.baseScene.surface,
    nodeCount: r.nodeCount, imageNodes: [...r.imageNodes], pictureFrames: [...r.pictureFrames], pictureBoxes: [...r.pictureBoxes],
    visibleArt: [...r.visibleArt], unavailable: [...r.artworkUnavailable], missing: [...r.missingImages],
    mesh: r.mesh && { p: r.mesh.positions, c: r.mesh.colors, i: r.mesh.indices, rel: r.mesh.relief, spans: r.mesh.branchSpans },
    spatial: p.spatial.ids ? [...p.spatial.ids] : null,
  });
  const diff = (a, b, path, out) => {
    if (out.length > 5) return;
    if (a === b) return;
    if (typeof a === 'number' && typeof b === 'number') { if (Number.isNaN(a) && Number.isNaN(b)) return; out.push(path + ': ' + a + ' vs ' + b); return; }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { out.push(path + ': ' + JSON.stringify(a)?.slice(0, 80) + ' vs ' + JSON.stringify(b)?.slice(0, 80)); return; }
    if (ArrayBuffer.isView(a)) { if (!ArrayBuffer.isView(b) || a.length !== b.length) { out.push(path + ': len ' + a.length + ' vs ' + (b && b.length)); return; } for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) { out.push(path + '[' + i + ']: ' + a[i] + ' vs ' + b[i]); return; } return; }
    if (Array.isArray(a)) { if (!Array.isArray(b) || a.length !== b.length) { out.push(path + ': len ' + a.length + ' vs ' + (b && b.length)); return; } for (let i = 0; i < a.length && out.length < 6; i++) diff(a[i], b[i], path + '[' + i + ']', out); return; }
    if (a instanceof Map || a instanceof Set) { diff([...a], [...b], path, out); return; }
    const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
    const sa = new Set(ka);
    if (ka.length !== kb.length || kb.some(k => !sa.has(k))) { out.push(path + ': keys ' + ka.filter(k => !kb.includes(k)).slice(0, 5) + ' | ' + kb.filter(k => !sa.has(k)).slice(0, 5) + ' (' + ka.length + '/' + kb.length + ')'); return; }
    for (const k of ka) diff(a[k], b[k], path + '.' + k, out);
  };
  const orderDiff = (a, b) => { const x = Object.keys(a.nodes), y = Object.keys(b.nodes); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i; return -1; };
  // ---- edits
  let seed = seed0; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = () => Object.keys(doc.nodes);
  const pick = () => { const a = ids(); return a[Math.floor(rnd() * a.length)]; };
  const pickVisible = () => { const out = [...inc.layout.boxes.keys()]; return out[Math.floor(rnd() * out.length)]; };
  const depthOf = (id) => { let d = 0; for (let p = doc.nodes[id].parent; p !== null; p = doc.nodes[p].parent) d++; return d; };
  const undo = [], redo = [];
  const apply = (ops, track) => { const inv = M.applyOps(doc, ops, track); return inv; };
  const nodeAt = (depth, f) => { const all = []; const st = [...doc.roots].reverse().map(id => [id, 0]); while (st.length) { const [id, d] = st.pop(); if (d === depth) all.push(id); const k = doc.nodes[id].children; for (let i = k.length - 1; i >= 0; i--) st.push([k[i], d + 1]); } return all[Math.min(all.length - 1, Math.floor(f * all.length))]; };
  const subtreeNear = (k) => { const order = []; const st = [...doc.roots]; while (st.length) { const id = st.pop(); order.push(id); st.push(...doc.nodes[id].children); } const cnt = new Map(); for (let i = order.length - 1; i >= 0; i--) { let s = 0; for (const ch of doc.nodes[order[i]].children) s += 1 + cnt.get(ch); cnt.set(order[i], s); } let best = null; for (const id of order) if (!best || Math.abs(cnt.get(id) - k) < Math.abs(cnt.get(best) - k)) best = id; return best; };
  const benchParent = nodeAt(3, 0.5), benchFold = subtreeNear(300);
  const log = [], problems = [], times = [];
  let lastAdded = null;
  await new Promise(r => setTimeout(r, 400));
  const colors = ['#cc3311', '#117733', '#3355aa'];
  const PRESET = 'buzan-vivid';
  for (let s = 0; s < steps; s++) {
    let forceNoScene = false;
    let kind = kinds ? kinds[s % kinds.length] : ['add', 'text', 'text', 'type', 'delete', 'move', 'fold', 'style', 'width', 'shape', 'dup', 'sibling', 'undo', 'redo', 'mainadd', 'theme', 'offset', 'sticker', 'pin', 'side', 'reorder', 'layout', 'generated', 'collapseDeep', 'detach', 'rootpos', 'headfold', 'headtext', 'nodepreset', 'docpreset', 'sketch', 'arterror', 'ink'][Math.floor(rnd() * 33)];
    if (kind.startsWith('ns-')) { kind = kind.slice(3); forceNoScene = true; }
    let ops = null, anchor = null, themeChange = false;
    const id = pickVisible(); const nd = doc.nodes[id];
    try {
      let e = null;
      if (kind === 'add') e = M.addChild(doc, id, 'Added ' + s);
      else if (kind === 'benchadd') { e = M.addChild(doc, benchParent, 'New node ' + s); }
      else if (kind === 'benchtype') { const t = lastAdded && doc.nodes[lastAdded] ? lastAdded : benchParent; e = M.setText(doc, t, doc.nodes[t].text + 'x'); }
      else if (kind === 'benchfold') { e = M.toggleCollapsed(doc, [benchFold]); anchor = benchFold; }
      else if (kind === 'text') e = M.setText(doc, id, 'Renamed ' + s + ' ' + 'x'.repeat(Math.floor(rnd() * 30)));
      else if (kind === 'type') e = M.setText(doc, id, nd.text + 'q');
      else if (kind === 'delete' && nd.parent) e = M.deleteSubtree(doc, [id]);
      else if (kind === 'move' && nd.parent) { const to = pickVisible(); if (to !== id && !M.isAncestor(doc, id, to)) e = M.moveSubtree(doc, id, to, 0); }
      else if (kind === 'fold' && nd.children.length) { e = M.toggleCollapsed(doc, [id]); anchor = id; }
      else if (kind === 'collapseDeep') { const p = pick(); if (doc.nodes[p].children.length) { e = M.toggleCollapsed(doc, [p]); anchor = p; } }
      else if (kind === 'style') e = M.setStyle(doc, [id], { color: colors[Math.floor(rnd() * 3)] });
      else if (kind === 'width') e = M.setStyle(doc, [id], { branchWidth: 1 + Math.floor(rnd() * 8) });
      else if (kind === 'shape') e = M.setStyle(doc, [id], { shape: rnd() < .5 ? 'box' : 'pill' });
      else if (kind === 'dup' && nd.parent) e = M.duplicateSubtree(doc, id);
      else if (kind === 'sibling' && nd.parent) e = M.addSibling(doc, id);
      else if (kind === 'mainadd') e = M.addChild(doc, doc.roots[0], 'Main ' + s);
      else if (kind === 'offset' && nd.parent) e = M.setOffset(doc, id, { x: Math.round(rnd() * 60 - 30), y: Math.round(rnd() * 60 - 30) });
      else if (kind === 'side' && nd.parent && doc.nodes[nd.parent].parent === null) e = M.setSide(doc, id, rnd() < .5 ? 'left' : 'right');
      else if (kind === 'reorder' && nd.parent) e = M.reorder(doc, id, rnd() < .5 ? -1 : 1);
      else if (kind === 'sticker') ops = [{ t: 'set', id, patch: { sticker: nd.sticker ? undefined : '⭐' } }];
      else if (kind === 'pin' && nd.parent) ops = [{ t: 'set', id, patch: { pinnedPosition: nd.pinnedPosition ? undefined : { x: 100, y: 100 } } }];
      else if (kind === 'layout') ops = [{ t: 'set', id, patch: { branchLayout: nd.branchLayout ? undefined : (rnd() < .5 ? 'outline' : 'right') } }];
      else if (kind === 'generated') ops = [{ t: 'set', id, patch: { generatedStyle: nd.generatedStyle ? undefined : { request: 'x', palette: ['#aa0000', '#00aa00'], shape: 'pill' } } }];
      else if (kind === 'detach' && nd.parent && doc.roots.length < 4) e = M.detach(doc, id, { x: 3000 + Math.round(rnd() * 2000), y: Math.round(rnd() * 2000) });
      else if (kind === 'rootpos') { const r = doc.roots[Math.floor(rnd() * doc.roots.length)]; const info = doc.rootInfo[r]; ops = [{ t: 'setRoot', id: r, info: { ...info, position: { x: info.position.x + 40, y: info.position.y - 25 } } }]; }
      else if (kind === 'headfold') { const r = doc.roots[0]; const k = doc.nodes[r].children; const h = k[Math.floor(rnd() * k.length)]; if (h) { e = M.toggleCollapsed(doc, [h]); anchor = h; } }
      else if (kind === 'headtext') { const r = doc.roots[0]; const k = doc.nodes[r].children; const h = k[Math.floor(rnd() * k.length)]; if (h) e = M.setText(doc, h, doc.nodes[h].text + 'w'); }
      else if (kind === 'nodepreset') ops = [{ t: 'set', id, patch: { artStyleId: nd.artStyleId ? undefined : PRESET } }];
      else if (kind === 'docpreset') ops = [{ t: 'docMeta', patch: { artStyleId: doc.artStyleId ? undefined : PRESET } }];
      else if (kind === 'sketch') ops = [{ t: 'set', id, patch: { sketch: nd.sketch ? undefined : { placement: rnd() < .5 ? 'on' : 'beside', strokes: [{ color: '#223344', width: 2, points: [{ x: 1, y: 2, pressure: .5 }, { x: 30, y: 40, pressure: .7 }] }] } } }];
      else if (kind === 'arterror') ops = [{ t: 'set', id, patch: { svgArtError: nd.svgArtError ? undefined : 'failed' } }];
      else if (kind === 'ink') e = M.setStyle(doc, [id], { textColor: colors[Math.floor(rnd() * 3)] });
      else if (kind === 'theme') { const t = theme; theme = otherTheme === theme ? JSON.parse(JSON.stringify(M.getTheme(themeId))) : otherTheme; themeChange = true; }
      else if (kind === 'undo' && undo.length) { const u = undo.pop(); ops = u; }
      else if (kind === 'redo' && redo.length) { ops = redo.pop(); }
      if (e) { ops = e.tx.ops; if (kind === 'benchadd') lastAdded = e.focus; }
    } catch (err) { log.push(kind + ' threw ' + String(err).slice(0, 100)); }
    if (!ops && !themeChange) { s--; if (log.length > 200) break; continue; }
    const track = M.newTrack();
    if (ops) {
      try {
        const inv = apply(ops, track);
        if (kind === 'undo') redo.push(inv); else { undo.push(inv); if (kind !== 'redo') redo.length = 0; }
      } catch (err) { log.push(kind + ' apply threw ' + String(err).slice(0, 100)); continue; }
    }
    editing = mode === 'check' && rnd() < 0.2 ? pickVisible() : null;
    prepareScene = !forceNoScene && (mode !== 'check' || rnd() >= 0.1);
    for (const k in stage) delete stage[k];
    const t0 = performance.now();
    const before = placements;
    res = inc.computeWork(mk(doc, before, anchor), track.touched);
    const ms = performance.now() - t0;
    let packMs = 0, splitMs = 0;
    if (mode === 'time') {
      const tp = performance.now();
      const wire = LT.packLayoutResult({ ...res, mesh: res.mesh }, []);
      packMs = performance.now() - tp;
      const ts = performance.now();
      const sp = LT.splitLayoutPayload(wire); let parts = 0; while (sp.next()) parts++;
      splitMs = performance.now() - ts;
    }
    times.push({ kind, ms, packMs, splitMs, geo: inc.lastGeometryMs, mesh: inc.lastBranchMeshMs, rebuilt: inc.lastBranchesRebuilt, ...Object.fromEntries(Object.entries(stage).map(([k, v]) => [k, +v.toFixed(2)])) });
    placements = res.placements;
    if (mode === 'check') {
      const fresh = new P.Pipeline(T.measureLabel);
      const fdoc = M.cloneDoc(JSON.parse(JSON.stringify(doc)));
      const fr = fresh.computeWork(mk(fdoc, before && JSON.parse(JSON.stringify(before)), anchor));
      const out = [];
      diff(canon(res, inc), canon(fr, fresh), '', out);
      // The wire the worker sends: the same text, whether its records were stringified now or in an earlier pass.
      const wa = LT.packLayoutResult({ ...res }, []), wb = LT.packLayoutResult({ ...fr }, []);
      const text = (w) => w && ('json' in w ? w.json : 'value:' + JSON.stringify(w.value));
      for (const k of ['placements', 'layoutBranches']) if (text(wa[k]) !== text(wb[k])) out.push('wire ' + k + ' differs');
      if (prepareScene && wa.drawnBranches !== wb.drawnBranches && text(wa.drawnBranches) !== text(wb.drawnBranches)) out.push('wire drawnBranches differs');
      if (prepareScene && wa.baseScene) for (const k of ['labels', 'rects']) if (text(wa.baseScene[k]) !== text(wb.baseScene[k])) out.push('wire ' + k + ' differs');
      const od = orderDiff(res.placements, fr.placements);
      if (out.length) problems.push({ step: s, kind, out });
      if (od >= 0) log.push('step ' + s + ' ' + kind + ' placement key order differs at ' + od);
      if (problems.length > 4) break;
    }
  }
  return { n: Object.keys(doc.nodes).length, visible: inc.layout.boxes.size, problems, log: log.slice(0, 20), times };
}
