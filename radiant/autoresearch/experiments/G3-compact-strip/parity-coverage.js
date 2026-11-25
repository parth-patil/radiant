(async () => {
  const R = window.__radiant;
  const T = await import('/src/lib/core/geometry/tessellate.ts');
  const B = await import('/src/lib/core/geometry/branch-instances.ts');
  function coarsenSpan(ind, start, end, out, at) {
  let o = at, i = start;
  while (i < end) {
    const q = ind[i];
    let j = i, m = 0;
    while (j + 5 < end && ind[j] === q + 2 * m && ind[j + 1] === q + 2 * m + 1 && ind[j + 2] === q + 2 * m + 2 &&
      ind[j + 3] === q + 2 * m + 1 && ind[j + 4] === q + 2 * m + 3 && ind[j + 5] === q + 2 * m + 2) {
      j += 6;
      m++;
    }
    if (m >= 2) {
      for (let s = 0; s < m;) {
        const e = Math.min(m, s + 8), p = q + 2 * s, t = q + 2 * e;
        out[o++] = p; out[o++] = p + 1; out[o++] = t;
        out[o++] = p + 1; out[o++] = t + 1; out[o++] = t;
        s = e;
      }
      i = j;
      continue;
    }
    j = i;
    m = 0;
    while (j + 2 < end && ind[j] === q && ind[j + 1] === q + 1 + m && ind[j + 2] === q + 2 + m) {
      j += 3;
      m++;
    }
    if (m >= 4) {
      for (let s = 0; s < m;) {
        const e = Math.min(m, s + 2);
        out[o++] = q; out[o++] = q + 1 + s; out[o++] = q + 1 + e;
        s = e;
      }
      i = j;
      continue;
    }
    out[o++] = ind[i]; out[o++] = ind[i + 1]; out[o++] = ind[i + 2];
    i += 3;
  }
  return o;
}

  const area = (a) => (a[2]-a[0])*(a[5]-a[1]) - (a[3]-a[1])*(a[4]-a[0]);
  const cpuTris = (P, I) => { const t = []; for (let k = 0; k < I.length; k += 3) { const v = [P[2*I[k]], P[2*I[k]+1], P[2*I[k+1]], P[2*I[k+1]+1], P[2*I[k+2]], P[2*I[k+2]+1]]; if (Math.abs(area(v)) > 1e-9) t.push(v); } return t; };
  const stripTris = (S) => { const t = []; for (let k = 0; k + 7 < S.length; k += 4) for (const [a,b,c] of [[k,k+2,k+4],[k+2,k+6,k+4]]) { const v = [S[a],S[a+1],S[b],S[b+1],S[c],S[c+1]]; if (Math.abs(area(v)) > 1e-9) t.push(v); } return t; };
  const segDist = (px, py, ax, ay, bx, by) => { const dx = bx-ax, dy = by-ay; const l = dx*dx+dy*dy; let t = l ? ((px-ax)*dx+(py-ay)*dy)/l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px-ax-t*dx, py-ay-t*dy); };
  const inside = (tris, x, y) => { let near = false, hit = false; for (const v of tris) { const d1 = (v[2]-v[0])*(y-v[1]) - (v[3]-v[1])*(x-v[0]), d2 = (v[4]-v[2])*(y-v[3]) - (v[5]-v[3])*(x-v[2]), d3 = (v[0]-v[4])*(y-v[5]) - (v[1]-v[5])*(x-v[4]); const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0; if (!(neg && pos)) hit = true; if (Math.min(segDist(x,y,v[0],v[1],v[2],v[3]), segDist(x,y,v[2],v[3],v[4],v[5]), segDist(x,y,v[4],v[5],v[0],v[1])) < 2e-3) near = true; } return [hit, near]; };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = {};
  for (const theme of ['clean','daylight','studio','ink','lagoon','sorbet']) {
    R.c.loadSynthetic(300, theme);
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) { await new Promise(r => setTimeout(r, 150)); const s = R.pipeline.layoutBranches; if (s && s.length > 250 && R.c.theme?.id === theme) break; }
    const specs = R.pipeline.layoutBranches;
    const res = { checked: 0, joined: 0, mismatch: { full: 0, coarse: 0 }, maxAreaRel: { full: 0, coarse: 0 }, samples: 0, quads: { old: 0, now: 0 } };
    for (const s of specs) {
      if (!B.gpuBranch(s)) continue;
      res.checked++;
      const cpu = T.tessellateBranches([s], { zoom: 4 });
      const ins = B.buildBranchInstances([s], 4);
      if ((ins.instances.records[15] >>> 8) & B.JOINED) res.joined++;
      res.quads.now += B.stripQuads(ins.instances.records, 0, false);
      const coarseIdx = new Uint32Array(cpu.indices.length);
      const nc = coarsenSpan(cpu.indices, 0, cpu.indices.length, coarseIdx, 0);
      for (const [mode, ref, strip] of [['full', cpuTris(cpu.positions, cpu.indices), stripTris(B.instanceStrip(ins.instances.records, 0, false))], ['coarse', cpuTris(cpu.positions, coarseIdx.subarray(0, nc)), stripTris(B.instanceStrip(ins.instances.records, 0, true))]]) {
        const A1 = ref.reduce((a, v) => a + Math.abs(area(v)) / 2, 0), A2 = strip.reduce((a, v) => a + Math.abs(area(v)) / 2, 0);
        res.maxAreaRel[mode] = Math.max(res.maxAreaRel[mode], Math.abs(A1 - A2) / A1);
        const b = cpu.branchSpans.bounds;
        for (let k = 0; k < 300; k++) {
          // half the samples inside a random reference triangle's neighbourhood, half anywhere in the bounds
          let x, y;
          if (k & 1) { const v = ref[Math.floor(rnd() * ref.length)]; const u1 = rnd(), u2 = rnd(); x = v[0] + (v[2]-v[0])*u1 + (v[4]-v[0])*u2*(1-u1) + (rnd()-0.5); y = v[1] + (v[3]-v[1])*u1 + (v[5]-v[1])*u2*(1-u1) + (rnd()-0.5); }
          else { x = b[0] + rnd() * (b[2]-b[0]); y = b[1] + rnd() * (b[3]-b[1]); }
          const [h1, n1] = inside(ref, x, y), [h2, n2] = inside(strip, x, y);
          res.samples++;
          if (h1 !== h2 && !n1 && !n2) res.mismatch[mode]++;
        }
      }
    }
    out[theme] = res;
  }
  return out;
})()