import * as THREE from 'three';

// World units: 1 unit is PPU CSS pixels of label text at scale 1.
export const PPU = 64;
export const FONT = '"Avenir Next", "Segoe UI", system-ui, -apple-system, sans-serif';
export const FONT_SIZE = [24, 18, 15.5, 14];
export const FONT_WEIGHT = [700, 600, 500, 500];
export const PALETTE = ['#2f7df6', '#12a87b', '#f29d1d', '#e5484d', '#8b5cf6', '#0aa3b5'];

export const TREE = { t: 'Launch Radiant 2.0', c: [
  { t: 'Research', c: [
    { t: 'Interviews', c: [{ t: '12 customers' }, { t: 'Top 5 pains' }] },
    { t: 'Competitors', c: [{ t: 'Feature grid' }, { t: 'Pricing pages' }] },
    { t: 'Market size' }] },
  { t: 'Product', c: [
    { t: 'Must-haves', c: [{ t: 'Offline first' }, { t: 'Fast canvas' }, { t: 'AI subtree' }] },
    { t: 'Nice to have' },
    { t: 'Cut list' }] },
  { t: 'Launch', c: [
    { t: 'Beta wave', c: [{ t: '50 testers' }, { t: 'Feedback loop' }] },
    { t: 'Press kit' },
    { t: 'Launch day' }] },
  { t: 'Team', c: [
    { t: 'Design' },
    { t: 'Engineering', c: [{ t: 'Renderer' }, { t: 'Sync' }] },
    { t: 'Support' }] },
  { t: 'Money', c: [
    { t: 'Pricing', c: [{ t: 'Free tier' }, { t: 'Pro at $8' }] },
    { t: 'Runway' },
    { t: 'Forecast' }] },
  { t: 'Risks', c: [
    { t: 'Scope creep' },
    { t: 'Performance', c: [{ t: '10k nodes' }, { t: 'Old GPUs' }] },
    { t: 'Churn' }] }
] };

let mctx = null;
const wcache = new Map();
export function labelWidth(text, depth) {
  const d = Math.min(depth, 3);
  const key = d + '|' + text;
  if (!wcache.has(key)) {
    mctx = mctx || document.createElement('canvas').getContext('2d');
    mctx.font = FONT_WEIGHT[d] + ' ' + FONT_SIZE[d] + 'px ' + FONT;
    wcache.set(key, mctx.measureText(text).width / PPU);
  }
  return wcache.get(key);
}

export const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** A two-sided horizontal mind-map layout. Each node gets in/out points; its label spans in..out. */
export function layoutMap(tree, opt) {
  const o = Object.assign({ leafGap: 0.6, hGap: [1.3, 1.1, 1.0, 0.9], pad: 0.16, mainGap: 0.28, rootPad: 0.5 }, opt || {});
  let id = 0;
  const nodes = [];
  const make = (src, parent, depth) => {
    const n = { id: id++, t: src.t, depth, parent, children: [], side: 1, branch: -1, color: new THREE.Color('#353b4d'), r: 0, len0: 0, len1: 0, len2: 0 };
    n.w = labelWidth(src.t, depth) + (depth === 0 ? o.rootPad : o.pad);
    nodes.push(n);
    for (const c of src.c || []) n.children.push(make(c, n, depth + 1));
    n.leaves = n.children.length ? n.children.reduce((a, c) => a + c.leaves, 0) : 1;
    return n;
  };
  const root = make(tree, null, 0);
  const half = Math.ceil(root.children.length / 2);
  const mark = (n, side, branch) => { n.side = side; n.branch = branch; n.color = new THREE.Color(PALETTE[branch % PALETTE.length]); n.children.forEach((c) => mark(c, side, branch)); };
  root.children.forEach((c, i) => mark(c, i < half ? 1 : -1, i));
  const height = (n) => { const kids = n.children.reduce((a, c) => a + height(c), 0); n.kh = kids; n.h = Math.max(o.leafGap, kids) + (n.depth === 1 ? o.mainGap : 0); return n.h; };
  root.children.forEach(height);
  root.x = 0; root.y = 0; root.in = [-root.w / 2, 0]; root.out = [root.w / 2, 0];
  root.outs = { '1': [root.w / 2, 0], '-1': [-root.w / 2, 0] };
  const place = (n, xin, top) => {
    const s = n.side;
    n.y = top - n.h / 2; n.in = [xin, n.y]; n.out = [xin + s * n.w, n.y]; n.x = xin + s * n.w / 2;
    let t = n.y + n.kh / 2;
    const cx = n.out[0] + s * o.hGap[Math.min(n.depth, o.hGap.length - 1)];
    for (const c of n.children) { place(c, cx, t); t -= c.h; }
  };
  for (const s of [1, -1]) {
    const list = root.children.filter((c) => c.side === s);
    let t = list.reduce((a, c) => a + c.h, 0) / 2;
    for (const c of list) { place(c, root.outs[s][0] + s * o.hGap[0], t); t -= c.h; }
  }
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const n of nodes) { x0 = Math.min(x0, n.in[0], n.out[0]); x1 = Math.max(x1, n.in[0], n.out[0]); y0 = Math.min(y0, n.y - 0.25); y1 = Math.max(y1, n.y + 0.5); }
  x0 -= 0.35; x1 += 0.35; y0 -= 0.25; y1 += 0.25;
  const bounds = { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  return { root, nodes, bounds, o };
}

function bezierPoints(S, E, s, n) {
  const dx = Math.abs(E[0] - S[0]) * 0.5;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const x = u * u * u * S[0] + 3 * u * u * t * (S[0] + s * dx) + 3 * u * t * t * (E[0] - s * dx) + t * t * t * E[0];
    const y = u * u * u * S[1] + 3 * u * u * t * S[1] + 3 * u * t * t * E[1] + t * t * t * E[1];
    out.push([x, y]);
  }
  return out;
}

function linePoints(out, a, b, step) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const m = Math.max(1, Math.ceil(d / step));
  for (let i = 1; i <= m; i++) out.push([lerp(a[0], b[0], i / m), lerp(a[1], b[1], i / m)]);
}

/** Right-angle route with rounded elbows; returns the points and the fitting positions. */
function orthoPoints(S, E, s, o) {
  const out = [[S[0], S[1]]];
  const joints = [];
  const gap = Math.abs(E[0] - S[0]);
  const mx = S[0] + s * gap * 0.5;
  const dy = E[1] - S[1];
  const sg = Math.sign(dy);
  const rho = Math.min(o.elbow, Math.abs(dy) / 2, gap / 2 - 0.05);
  if (Math.abs(dy) < 0.03 || rho < 0.02) { linePoints(out, S, E, o.step); return { pts: out, joints }; }
  const a1 = [mx - s * rho, S[1]];
  linePoints(out, S, a1, o.step);
  joints.push({ p: a1, d: 'x' });
  for (let i = 1; i <= 8; i++) { const a = i / 8 * Math.PI / 2; out.push([a1[0] + s * rho * Math.sin(a), S[1] + sg * rho * (1 - Math.cos(a))]); }
  const v1 = [mx, S[1] + sg * rho], v2 = [mx, E[1] - sg * rho];
  joints.push({ p: v1, d: 'y' });
  if (Math.abs(v2[1] - v1[1]) > 1e-4) linePoints(out, v1, v2, o.step);
  joints.push({ p: v2, d: 'y' });
  for (let i = 1; i <= 8; i++) { const a = i / 8 * Math.PI / 2; out.push([mx + s * rho * (1 - Math.cos(a)), v2[1] + sg * rho * Math.sin(a)]); }
  const a2 = [mx + s * rho, E[1]];
  joints.push({ p: a2, d: 'x' });
  linePoints(out, a2, E, o.step);
  return { pts: out, joints };
}

/** One path per non-root node: the connector from its parent, then the run under its label. */
export function buildPaths(L, opt) {
  const o = Object.assign({ radius: (n) => 0.05 * Math.pow(n.leaves, 0.42), rootRadius: 0.17, z: (n, r) => r, style: 'bezier', taperEnd: 0.6, samples: 28, underline: true, elbow: 0.2, step: 0.12 }, opt || {});
  const paths = [];
  L.root.r = o.rootRadius; L.root.len2 = 0;
  const visit = (n) => {
    for (const c of n.children) {
      const s = c.side;
      const S = n.depth === 0 ? L.root.outs[String(s)] : n.out;
      const E = c.in;
      const rs = n.depth === 0 ? o.rootRadius : n.r;
      const re = o.radius(c);
      c.r = re;
      let pl, joints = [];
      if (o.style === 'ortho') { const r = orthoPoints(S, E, s, o); pl = r.pts; joints = r.joints; } else pl = bezierPoints(S, E, s, o.samples);
      let clen = 0;
      for (let i = 1; i < pl.length; i++) clen += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
      const pts = [], rad = [], len = [], tb = [];
      const len0 = n.depth === 0 ? 0 : n.len2;
      let acc = 0;
      for (let i = 0; i < pl.length; i++) {
        if (i) acc += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
        const u = clen > 0 ? acc / clen : 1;
        const r = lerp(rs, re, smooth(u / o.taperEnd));
        pts.push(new THREE.Vector3(pl[i][0], pl[i][1], o.z(c, r, u)));
        rad.push(r); len.push(len0 + acc); tb.push(u);
      }
      c.len0 = len0; c.len1 = len0 + acc; c.len2 = c.len1 + c.w; c.clen = clen;
      if (o.underline) {
        const m = Math.max(2, Math.ceil(c.w / o.step));
        for (let k = 1; k <= m; k++) {
          pts.push(new THREE.Vector3(E[0] + s * c.w * k / m, E[1], o.z(c, re, 1)));
          rad.push(re); len.push(c.len1 + c.w * k / m); tb.push(1 + k / m);
        }
      }
      paths.push({ node: c, pts, rad, len, tb, color: c.color, S, E, side: s, joints, nb: pl.length });
      visit(c);
    }
  };
  visit(L.root);
  return paths;
}
