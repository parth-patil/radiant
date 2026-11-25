import * as THREE from 'three';

/** Parallel-transport frames along a polyline. For a curve in the XY plane with up = +Z, N stays +Z. */
export function computeFrames(pts, up) {
  const n = pts.length;
  const T = [], N = [], B = [];
  for (let i = 0; i < n; i++) T.push(new THREE.Vector3().subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]).normalize());
  const nrm = (up || new THREE.Vector3(0, 0, 1)).clone();
  nrm.addScaledVector(T[0], -nrm.dot(T[0]));
  if (nrm.lengthSq() < 1e-6) { nrm.set(1, 0, 0); nrm.addScaledVector(T[0], -nrm.dot(T[0])); }
  nrm.normalize();
  const axis = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      axis.crossVectors(T[i - 1], T[i]);
      const s = axis.length();
      if (s > 1e-7) { axis.multiplyScalar(1 / s); nrm.applyAxisAngle(axis, Math.atan2(s, T[i - 1].dot(T[i]))); }
      nrm.addScaledVector(T[i], -nrm.dot(T[i])).normalize();
    }
    N.push(nrm.clone());
    B.push(new THREE.Vector3().crossVectors(T[i], nrm).normalize());
  }
  return { T, N, B };
}

/**
 * Round tubes with a radius per point, hemispherical caps, and the attributes the growth shader needs:
 * aLen (distance from the root) and aCenter (the centre of the ring the vertex belongs to).
 */
export function buildTubes(paths, opt) {
  const o = Object.assign({ radial: 14, cap: true, startCap: false, capSegs: 5, vScale: 1, uRepeat: 1, bump: null, color: null, up: null, radiusScale: 1 }, opt || {});
  const P = [], NO = [], UV = [], C = [], LEN = [], CEN = [], IDX = [];
  const R = o.radial;
  let base = 0;
  const radial = new THREE.Vector3(), pos = new THREE.Vector3(), nor = new THREE.Vector3();
  paths.forEach((p, pi) => {
    const { T, N, B } = computeFrames(p.pts, o.up);
    const n = p.pts.length;
    const rings = [];
    const add = (c, i, r, len) => rings.push({ c, T: T[i], N: N[i], B: B[i], r: r * o.radiusScale, len });
    if (o.startCap) for (let k = o.capSegs; k >= 1; k--) { const a = k / o.capSegs * Math.PI / 2; const r0 = p.rad[0] * o.radiusScale; add(p.pts[0].clone().addScaledVector(T[0], -r0 * Math.sin(a)), 0, Math.max(1e-4, p.rad[0] * Math.cos(a)), p.len[0]); }
    for (let i = 0; i < n; i++) add(p.pts[i], i, p.rad[i], p.len[i]);
    if (o.cap) for (let k = 1; k <= o.capSegs; k++) { const a = k / o.capSegs * Math.PI / 2; const r0 = p.rad[n - 1] * o.radiusScale; add(p.pts[n - 1].clone().addScaledVector(T[n - 1], r0 * Math.sin(a)), n - 1, Math.max(1e-4, p.rad[n - 1] * Math.cos(a)), p.len[n - 1] + r0 * Math.sin(a)); }
    const col = o.color ? o.color(p, pi) : p.color;
    const m = rings.length;
    for (let i = 0; i < m; i++) {
      const g = rings[i], a = rings[Math.max(i - 1, 0)], b = rings[Math.min(i + 1, m - 1)];
      const ds = Math.max(1e-5, a.c.distanceTo(b.c));
      const drds = Math.max(-8, Math.min(8, (b.r - a.r) / ds));
      for (let j = 0; j <= R; j++) {
        const th = j / R * Math.PI * 2;
        radial.copy(g.B).multiplyScalar(Math.cos(th)).addScaledVector(g.N, Math.sin(th));
        const rr = g.r * (o.bump ? o.bump(g.len, th, g.r, p) : 1);
        pos.copy(g.c).addScaledVector(radial, rr);
        nor.copy(radial).addScaledVector(g.T, -drds).normalize();
        P.push(pos.x, pos.y, pos.z); NO.push(nor.x, nor.y, nor.z);
        UV.push(j / R * o.uRepeat, g.len * o.vScale);
        C.push(col.r, col.g, col.b); LEN.push(g.len); CEN.push(g.c.x, g.c.y, g.c.z);
      }
    }
    for (let i = 0; i < m - 1; i++) for (let j = 0; j < R; j++) {
      const a = base + i * (R + 1) + j, b = a + 1, c = a + (R + 1), d = c + 1;
      IDX.push(a, c, b, b, c, d);
    }
    base += m * (R + 1);
  });
  // Make the winding agree with the stored normals, whatever the handedness of the frames.
  if (IDX.length) {
    let votes = 0;
    const A = new THREE.Vector3(), Bv = new THREE.Vector3(), Cv = new THREE.Vector3(), E1 = new THREE.Vector3(), E2 = new THREE.Vector3();
    for (let k = 0; k < IDX.length; k += Math.max(3, Math.floor(IDX.length / 300) * 3)) {
      const a = IDX[k] * 3, b = IDX[k + 1] * 3, c = IDX[k + 2] * 3;
      A.set(P[a], P[a + 1], P[a + 2]); Bv.set(P[b], P[b + 1], P[b + 2]); Cv.set(P[c], P[c + 1], P[c + 2]);
      E1.subVectors(Bv, A); E2.subVectors(Cv, A); E1.cross(E2);
      votes += Math.sign(E1.x * NO[a] + E1.y * NO[a + 1] + E1.z * NO[a + 2]);
    }
    if (votes < 0) for (let k = 0; k < IDX.length; k += 3) { const t = IDX[k + 1]; IDX[k + 1] = IDX[k + 2]; IDX[k + 2] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(NO, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aLen', new THREE.Float32BufferAttribute(LEN, 1));
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(CEN, 3));
  g.setIndex(IDX);
  g.computeBoundingSphere();
  return g;
}

/** Paper strips standing on their edge: each path becomes a thin wall from z0 up to z0 + height. */
export function buildStrips(paths, opt) {
  const o = Object.assign({ thick: 0.03, height: () => 0.3, z0: 0, color: null }, opt || {});
  const P = [], NO = [], C = [], LEN = [], CEN = [], IDX = [];
  let base = 0;
  const v = new THREE.Vector3();
  const put = (c, bOff, B, zUp, nx, ny, nz, col, len) => {
    v.copy(c).addScaledVector(B, bOff); v.z = c.z + zUp;
    P.push(v.x, v.y, v.z); NO.push(nx, ny, nz); C.push(col.r, col.g, col.b); LEN.push(len); CEN.push(c.x, c.y, c.z);
  };
  paths.forEach((p, pi) => {
    const { B } = computeFrames(p.pts, new THREE.Vector3(0, 0, 1));
    const h = o.height(p, pi), hb = o.thick / 2;
    const col = o.color ? o.color(p, pi) : p.color;
    const n = p.pts.length;
    for (let i = 0; i < n; i++) {
      const c = p.pts[i], b = B[i], len = p.len[i];
      put(c, hb, b, 0, b.x, b.y, 0, col, len); put(c, hb, b, h, b.x, b.y, 0, col, len);
      put(c, hb, b, h, 0, 0, 1, col, len); put(c, -hb, b, h, 0, 0, 1, col, len);
      put(c, -hb, b, h, -b.x, -b.y, 0, col, len); put(c, -hb, b, 0, -b.x, -b.y, 0, col, len);
    }
    for (let i = 0; i < n - 1; i++) for (let f = 0; f < 3; f++) {
      const a = base + i * 6 + f * 2, b = a + 1, c = a + 6, d = c + 1;
      IDX.push(a, c, b, b, c, d);
    }
    base += n * 6;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(NO, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aLen', new THREE.Float32BufferAttribute(LEN, 1));
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(CEN, 3));
  g.setIndex(IDX);
  g.computeBoundingSphere();
  return g;
}
