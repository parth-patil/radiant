(async () => {
  const R = window.__radiant;
  const T = await import('/src/lib/core/geometry/tessellate.ts');
  const U = await import('/src/lib/core/geometry/underline.ts');
  const out = {};
  for (const [n, theme] of [[5000,'clean'],[50000,'clean'],[5000,'buzan']]) {
    R.c.loadSynthetic(n, theme);
    const t0 = performance.now();
    while (performance.now() - t0 < 60000) {
      await new Promise(r => setTimeout(r, 200));
      const specs = R.pipeline.layoutBranches;
      if (R.pipeline.nodeCount >= n * 0.9 && specs && specs.length > n * 0.9 && R.c.theme?.id === theme) break;
    }
    const specs = R.pipeline.layoutBranches;
    const hist = {}; let tot = 0, max = 0, verts = 0, flags = {roundCaps:0, tipDot:0, fade:0, bend:0, ul:0, startTangent:0}, styles = {}, flows = {};
    const ul = {};
    for (const s of specs) {
      const m = T.tessellateBranches([s], { zoom: 4 });
      const st = s.underlineTo ? U.underlineSteps(s) : 0;
      const k = (m.indices.length - 12 - 6 * st) / 6;
      hist[k] = (hist[k] || 0) + 1; tot += k; max = Math.max(max, k); verts += m.positions.length / 2;
      if (s.roundCaps) flags.roundCaps++; if (s.tipDot) flags.tipDot++; if (s.fade) flags.fade++; if (s.underlineBend) flags.bend++; if (s.underlineTo) flags.ul++; if (s.startTangent) flags.startTangent++;
      styles[s.style] = (styles[s.style]||0)+1; flows[s.flow]=(flows[s.flow]||0)+1; ul[st]=(ul[st]||0)+1;
    }
    out[n+'/'+theme] = { count: specs.length, mean: tot / specs.length, max, verts, hist, flags, styles, flows, ul };
  }
  return out;
})()