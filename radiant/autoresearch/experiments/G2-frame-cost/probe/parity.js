(async () => {
  const R = window.__radiant;
  const T = await import('/src/lib/core/geometry/tessellate.ts');
  const B = await import('/src/lib/core/geometry/branch-instances.ts');
  const out = {};
  const tris = (P, I) => { const t = []; for (let k = 0; k < I.length; k += 3) { const v = [I[k], I[k+1], I[k+2]].map(i => [P[2*i], P[2*i+1]]); const area = (v[1][0]-v[0][0])*(v[2][1]-v[0][1]) - (v[1][1]-v[0][1])*(v[2][0]-v[0][0]); if (Math.abs(area) > 1e-9) t.push(v); } return t; };
  const stripTris = (S) => { const t = []; const pt = (i) => [S[i], S[i+1]]; for (let k = 0; k + 7 < S.length; k += 4) { for (const [a,b,c] of [[k,k+2,k+4],[k+2,k+6,k+4]]) { const v = [pt(a),pt(b),pt(c)]; const area = (v[1][0]-v[0][0])*(v[2][1]-v[0][1]) - (v[1][1]-v[0][1])*(v[2][0]-v[0][0]); if (Math.abs(area) > 1e-9) t.push(v); } } return t; };
  const key = (v) => v.map(p => p[0].toFixed(1)+','+p[1].toFixed(1)).sort().join(';');
  for (const theme of ['clean','midnight','daylight','studio','lagoon','ink','sorbet','citrus','boardroom']) {
    R.c.loadSynthetic(800, theme);
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) { await new Promise(r => setTimeout(r, 150)); const s = R.pipeline.layoutBranches; if (s && s.length > 700 && R.c.theme?.id === theme) break; }
    const specs = R.pipeline.layoutBranches;
    let maxErr = 0, triMismatch = 0, checked = 0, skipped = 0, worst = null, feats = {roundCaps:0, tipDot:0, fade:0, bend:0, straight:0};
    for (const s of specs) {
      if (!B.gpuBranch(s)) { skipped++; continue; }
      checked++;
      if (s.roundCaps) feats.roundCaps++; if (s.tipDot) feats.tipDot++; if (s.fade) feats.fade++; if (s.underlineBend) feats.bend++;
      const cpu = T.tessellateBranches([s], { zoom: 4 });
      const ins = B.buildBranchInstances([s], 4);
      const a = tris(cpu.positions, cpu.indices), b = stripTris(B.instanceStrip(ins.instances.records, 0));
      if (a.length !== b.length) { triMismatch++; if (!worst) worst = { to: s.to, cpu: a.length, gpu: b.length }; continue; }
      for (let i = 0; i < a.length; i++) {
        // match each cpu triangle vertex to the nearest vertex of the gpu triangle
        for (const p of a[i]) { let best = Infinity; for (const q of b[i]) best = Math.min(best, Math.hypot(p[0]-q[0], p[1]-q[1])); if (best > maxErr) { maxErr = best; } }
      }
      const cb = cpu.branchSpans.bounds, ib = ins.branchSpans.bounds;
      if (ib[0] > cb[0] + 1e-6 || ib[1] > cb[1] + 1e-6 || ib[2] < cb[2] - 1e-6 || ib[3] < cb[3] - 1e-6) out.boundsViolation = (out.boundsViolation||0) + 1;
    }
    out[theme] = { branches: specs.length, checked, skipped, triMismatch, maxErr, worst, feats };
  }
  return out;
})()