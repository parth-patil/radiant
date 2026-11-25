async ({ n, frames, theme }) => {
  const B = window.__radiantBench, R = window.__radiant;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const settle = async () => { let ok = 0; const t0 = performance.now(); while (ok < 3 && performance.now() - t0 < 120000) { await new Promise(r => requestAnimationFrame(r)); ok = B.idle() ? ok + 1 : 0; } };
  const t0 = performance.now();
  B.loadSynthetic(n, theme);
  await settle();
  const loadMs = performance.now() - t0;
  const diag = B.diagnostics();
  const mesh = R.pipeline.mesh;
  const recordBytes = mesh?.instances?.records?.byteLength ?? 0;
  const gpuBufferBytes = B.memory().gpuBufferBytes;
  // edit: add a child to the middle depth-3 node, timed to settled
  const parent = B.nodeAtDepth(3, 0.5);
  const e0 = performance.now();
  B.addChild(parent, 'probe');
  await settle();
  const editMs = performance.now() - e0;
  const editDiag = B.diagnostics();
  const gl = R.renderer.canvas.getContext('webgl2');
  const px = new Uint8Array(4);
  const positions = {};
  B.fit(); await settle();
  positions.fit = B.camera();
  const mid = B.nodeAtDepth(2, 0.5), box = B.box(mid);
  positions['z0.05'] = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 0.05 };
  positions['z0.35'] = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 0.35 };
  positions['z1'] = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 1 };
  positions['z4'] = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 4 };
  const timer = B.gpuTimer(true);
  const res = {};
  for (const [name, cam] of Object.entries(positions)) {
    B.setCamera(cam); await settle(); await sleep(200); await settle();
    // warm-up
    for (let i = 0; i < 10; i++) { R.renderer.setCamera({ cx: cam.cx + Math.sin(i) * 30 / cam.zoom, cy: cam.cy + Math.cos(i) * 30 / cam.zoom, zoom: cam.zoom }); R.renderer.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    B.gpuSamples();
    const wall = [], cpu = [];
    for (let i = 0; i < frames; i++) {
      R.renderer.setCamera({ cx: cam.cx + Math.sin(i * 0.3) * 30 / cam.zoom, cy: cam.cy + Math.cos(i * 0.3) * 30 / cam.zoom, zoom: cam.zoom });
      const s = performance.now();
      R.renderer.render();
      const c = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      wall.push(performance.now() - s); cpu.push(c - s);
      await new Promise(r => requestAnimationFrame(r));
    }
    await sleep(300);
    const gpu = B.gpuSamples();
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    res[name] = { wall: med(wall), cpu: med(cpu), gpu: med(gpu), gpuN: gpu.length, tris: R.renderer.stats.meshTriangles, draws: R.renderer.stats.drawCalls };
  }
  B.gpuTimer(false);
  return { timer, summary: { loadMs, editMs, branchMeshMs: diag.branchMeshMs, editBranchMeshMs: editDiag.branchMeshMs, adoptMs: diag.adoptMs, editAdoptMs: editDiag.adoptMs, recordBytes, gpuBufferBytes, frames: res } };
}