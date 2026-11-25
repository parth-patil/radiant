import { tessellateBranches } from '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/gpu/g5/radiant/src/lib/core/geometry/tessellate.ts';
import * as B from '/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/gpu/g5/radiant/src/lib/core/geometry/branch-instances.ts';
import { readFileSync } from 'fs';
const specsBy = JSON.parse(readFileSync('/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/gpu/specs.json', 'utf8'));
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const shadowColor = { r: 0.05, g: 0.08, b: 0.1, a: 0.3 };
const out: any = {};
const area = (a: number[]) => (a[2]-a[0])*(a[5]-a[1]) - (a[3]-a[1])*(a[4]-a[0]);
for (const material of ['clay', 'rope'] as const) {
  for (const theme of ['clean', 'studio', 'hand-drawn', 'boardroom']) {
    const res: any = { n: 0, verts: 0, unmatched: 0, attrBad: 0, shadowBad: 0, twistBad: 0, rgbaBad: 0, triCount: 0, maxAreaRel: 0, worst: [] };
    for (const s0 of specsBy[theme]) {
      const s: any = { ...s0 };
      if (material === 'rope') {
        s.w0 = s.w1 = 2 + rnd() * 12; if (s.underlineTo) s.underlineWidth = s.w1;
        s.twist = rnd() * 20;
        if (rnd() < 0.3) s.whip = { x: s.p0.x, y: s.p0.y, dx: 1, dy: 0, width: s.w0 };
      }
      if (rnd() < 0.3) s.dim = 0.5;
      if (rnd() < 0.3) s.roundCaps = rnd() < 0.5 ? 'start' : 'both';
      if (!B.gpuBranch(s)) continue;
      res.n++;
      const relief = { material, shadowColor };
      const cpu: any = tessellateBranches([s], { zoom: 4, relief });
      const ins = B.buildBranchInstances([s], 4, relief);
      const vs = B.instanceVertices(ins.instances!.records, 0, ins.instances!.words);
      // triangles of the strip vs cpu
      const st: number[][] = [];
      for (let k = 0; k + 3 < vs.length; k += 2) for (const [a, b, c] of [[k, k + 1, k + 2], [k + 1, k + 3, k + 2]]) { const v = [vs[a].x, vs[a].y, vs[b].x, vs[b].y, vs[c].x, vs[c].y]; if (Math.abs(area(v)) > 1e-9) st.push(v); }
      const P = cpu.positions, I = cpu.indices; let ct = 0, A1 = 0, A2 = 0;
      for (let k = 0; k < I.length; k += 3) { const v = [P[2*I[k]], P[2*I[k]+1], P[2*I[k+1]], P[2*I[k+1]+1], P[2*I[k+2]], P[2*I[k+2]+1]]; if (Math.abs(area(v)) > 1e-9) { ct++; A1 += Math.abs(area(v)); } }
      for (const v of st) A2 += Math.abs(area(v));
      if (ct !== st.length) res.triCount++;
      res.maxAreaRel = Math.max(res.maxAreaRel, Math.abs(A1 - A2) / A1);
      const rel = cpu.relief;
      for (let v = 0; v < P.length / 2; v++) {
        res.verts++;
        let best: any = null, bd = 1e9;
        for (const w of vs) { const d = Math.hypot(w.x - P[2*v], w.y - P[2*v+1]); if (d < bd) { bd = d; best = w; } }
        if (bd > 2e-3) { res.unmatched++; continue; }
        // several of mine may share the position (breaks); accept any that matches
        const cands = vs.filter(w => Math.hypot(w.x - P[2*v], w.y - P[2*v+1]) < 2e-3);
        const want = [rel.attribs[4*v], rel.attribs[4*v+1], rel.attribs[4*v+2], rel.attribs[4*v+3]];
        const okAttr = cands.some(w => [w.nx, w.ny, w.k, w.across].every((x, i) => Math.abs(Math.trunc(x * 127) - want[i]) <= 1));
        if (!okAttr) { res.attrBad++; if (res.worst.length < 3) res.worst.push({ to: s.to, want, got: cands.map(w => [w.nx, w.ny, w.k, w.across].map(x => Math.trunc(x * 127))) }); }
        if (rel.shadow) { const okS = cands.some(w => Math.abs(Math.trunc(w.sx * 128) - rel.shadow[2*v]) <= 1 && Math.abs(Math.trunc(w.sy * 128) - rel.shadow[2*v+1]) <= 1); if (!okS) res.shadowBad++; }
        if (rel.twist) { const okT = cands.some(w => Math.abs(w.twist - rel.twist[v]) < 1e-3); if (!okT) res.twistBad++; }
        const okC = cands.some(w => [0, 8, 16, 24].every(sh => Math.abs(((w.rgba >>> sh) & 255) - ((rel.rgba[v] >>> sh) & 255)) <= 1));
        if (!okC) res.rgbaBad++;
      }
    }
    out[material + '/' + theme] = res;
  }
}
console.log(JSON.stringify(out));
