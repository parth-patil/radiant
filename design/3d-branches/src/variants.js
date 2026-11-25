import * as THREE from 'three';
import { TREE, layoutMap, buildPaths, smooth } from './map.js';
import { buildTubes, buildStrips, computeFrames } from './tube.js';
import { stage, rng, imgTex, makeBase, patch, withDepth, tubeMesh, mapLabels, finish, makeBloom, paperTex, ringsTex, blobTex, pillGeo, stadiumPath, leafGeometry, instanced } from './kit.js';

const hex = (c) => '#' + c.getHexString();
const shade = (c, k) => hex(c.clone().multiplyScalar(k));
const tint = (c, k) => c.clone().lerp(new THREE.Color(1, 1, 1), k);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const solid = (obj) => { obj.castShadow = true; obj.receiveShadow = true; return obj; };
const loopPath = (pts, r, color) => ({ pts, rad: pts.map(() => r), len: pts.map(() => 0), color });

// ---------------------------------------------------------------- 00 flat, for reference
export function flat() {
  const L = layoutMap(TREE, { leafGap: 0.62 });
  const paths = buildPaths(L, { radius: (n) => 0.05 * Math.pow(n.leaves, 0.45), rootRadius: 0.17, taperEnd: 0.9, z: () => 0 });
  const B = makeBase(L, { bg: '#fbfaf8', sun: 0, ambient: 0, envIntensity: 0 });
  const mesh = new THREE.Mesh(buildTubes(paths, { radial: 12, startCap: true }), patch(new THREE.MeshBasicMaterial({ vertexColors: true }), B.U, { key: 'flat' }));
  mesh.scale.z = 0.001; B.world.add(mesh);
  const plate = new THREE.Mesh(pillGeo(L.root.w + 0.1, 0.9, 0.002, 0), new THREE.MeshBasicMaterial({ color: '#2f3443' }));
  plate.position.z = 0.002; B.world.add(plate);
  B.labels = mapLabels(L, { dy: (n) => n.r + 0.07, z: () => 0, rootZ: 0, ink: (n) => (n.depth ? shade(n.color, 0.45) : '#ffffff') });
  return finish(B, { paths, tilt: [0, 0, 0.1, 0.14] });
}

// ---------------------------------------------------------------- 01 living bark
export function bark() {
  const L = layoutMap(TREE, { leafGap: 0.62 });
  const paths = buildPaths(L, { radius: (n) => 0.058 * Math.pow(n.leaves, 0.5), rootRadius: 0.22, taperEnd: 0.75 });
  const B = makeBase(L, { bg: '#ece5d6', sunPos: [-7, 9, 8], sun: 3.0, ambient: 1.0, envIntensity: 0.3, shadowRadius: 5 });
  B.ground(new THREE.MeshStandardMaterial({ map: paperTex('#efe8da', 9, 14), roughness: 1 }));
  const mat = new THREE.MeshStandardMaterial({ map: imgTex('barkDiff', { srgb: true }), normalMap: imgTex('barkNor'), roughnessMap: imgTex('barkRough'), normalScale: new THREE.Vector2(1.7, 1.7), vertexColors: true, roughness: 1 });
  const warm = new THREE.Color(1.42, 1.12, 0.86);
  const geo = buildTubes(paths, { radial: 18, vScale: 1.1, uRepeat: 2, color: () => warm, bump: (len, th) => 1 + 0.07 * Math.sin(len * 4.3 + th * 2) + 0.05 * Math.sin(len * 9.7 - th * 3 + 1.3) });
  B.world.add(tubeMesh(geo, mat, B.U, { key: 'bark' }));

  const rw = L.root.w / 2 + 0.3, rh = 0.82, th = 0.44;
  const side = new THREE.MeshStandardMaterial({ map: imgTex('barkDiff', { srgb: true, repeat: [7, 0.4] }), normalMap: imgTex('barkNor', { repeat: [7, 0.4] }), roughness: 1, color: new THREE.Color(1.4, 1.3, 1.2) });
  const top = new THREE.MeshStandardMaterial({ map: ringsTex(), roughness: 0.8 });
  const slab = solid(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, th, 72), [side, top, top]));
  slab.rotation.x = Math.PI / 2; slab.scale.set(rw, 1, rh); slab.position.z = th / 2;
  B.world.add(slab);

  const R = rng(7);
  const leaves = [], berries = [];
  for (const p of paths) {
    const n = p.node;
    const ang = (i) => { const a = p.pts[Math.max(0, i - 1)], b = p.pts[Math.min(p.pts.length - 1, i + 1)]; return Math.atan2(b.y - a.y, b.x - a.x); };
    const addLeaf = (i, sd, spread, scale) => {
      const a = ang(i), q = p.pts[i], r = p.rad[i];
      leaves.push({ pos: V3(q.x - Math.sin(a) * sd * r * 0.7, q.y + Math.cos(a) * sd * r * 0.7, q.z + r * 0.5), euler: new THREE.Euler((R() - 0.5) * 0.9, -0.15 - R() * 0.4, a + sd * spread, 'ZYX'), scale, len: p.len[i], color: new THREE.Color().setHSL(0.23 + R() * 0.1, 0.5 + R() * 0.2, 0.25 + R() * 0.17) });
    };
    if (n.depth >= 2) for (let j = 0; j < 3; j++) addLeaf(Math.floor(p.nb * (0.3 + 0.6 * R())), j % 2 ? 1 : -1, 0.7 + R() * 0.5, 0.8 + R() * 0.5);
    if (n.depth === 1) for (let j = 0; j < 2; j++) addLeaf(Math.floor(p.nb * (0.55 + 0.4 * R())), j % 2 ? 1 : -1, 0.8 + R() * 0.4, 1 + R() * 0.4);
    if (!n.children.length) {
      const i = p.pts.length - 1, e = p.pts[i];
      for (let j = 0; j < 5; j++) addLeaf(i, j % 2 ? 1 : -1, 0.15 + R() * 0.9, 0.9 + R() * 0.6);
      for (let j = 0; j < 2; j++) berries.push({ pos: V3(e.x + n.side * (0.06 + R() * 0.1), e.y + (R() - 0.5) * 0.18, 0.06), scale: 0.8 + R() * 0.5, len: p.len[i], color: n.color });
    }
  }
  B.world.add(instanced(leafGeometry(0.3, 0.085), new THREE.MeshStandardMaterial({ roughness: 0.55, side: THREE.DoubleSide }), leaves, B.U));
  B.world.add(instanced(new THREE.SphereGeometry(0.055, 14, 10), new THREE.MeshStandardMaterial({ roughness: 0.25 }), berries, B.U));
  B.labels = mapLabels(L, { dy: (n) => n.r * 1.1 + 0.06, rootZ: th, ink: (n) => (n.depth ? '#3a2917' : '#3a2410') });
  return finish(B, { paths, tilt: [-0.14, 0, 0.1, 0.14] });
}

// ---------------------------------------------------------------- 02 bonsai (true 3D)
function layout3D(tree) {
  let id = 0;
  const nodes = [];
  const make = (src, parent, depth) => {
    const n = { id: id++, t: src.t, depth, parent, children: [], branch: -1 };
    nodes.push(n);
    for (const c of src.c || []) n.children.push(make(c, n, depth + 1));
    n.leaves = n.children.length ? n.children.reduce((a, c) => a + c.leaves, 0) : 1;
    return n;
  };
  const root = make(tree, null, 0);
  const FOLIAGE = ['#4f9a3a', '#9dbb3c', '#e3ab22', '#dd6b2a', '#c43d36', '#2f8f72'];
  root.children.forEach((c, i) => { const mark = (n) => { n.branch = i; n.color = new THREE.Color(FOLIAGE[i % 6]); n.children.forEach(mark); }; mark(c); });
  root.color = new THREE.Color('#ffffff');
  const rOf = (n) => 0.042 * Math.sqrt(n.leaves);
  const paths = [];
  const base = 0.7;
  const tc = new THREE.CatmullRomCurve3([V3(0, base, 0), V3(0.12, base + 0.9, 0.06), V3(-0.1, base + 1.8, -0.06), V3(0.07, base + 2.6, 0.08), V3(0, base + 3.3, 0)]);
  const TN = 44;
  const tp = tc.getPoints(TN);
  const trad = [], tlen = [];
  for (let i = 0; i <= TN; i++) { const u = i / TN; trad.push(0.4 - 0.26 * u + 0.22 * Math.exp(-u * 9)); tlen.push(i ? tlen[i - 1] + tp[i].distanceTo(tp[i - 1]) : 0); }
  paths.push({ node: root, pts: tp, rad: trad, len: tlen, color: root.color });
  root.end = tp[TN]; root.dir = V3(0, 1, 0); root.len1 = 0;
  const grow = (n, start, pdir, dir, len, rs, len0) => {
    const end = start.clone().addScaledVector(pdir, len * 0.22).addScaledVector(dir, len * 0.78);
    const p1 = start.clone().addScaledVector(pdir, len * 0.3), p2 = end.clone().addScaledVector(dir, -len * 0.35);
    const curve = new THREE.CubicBezierCurve3(start, p1, p2, end);
    const N = 22, pts = curve.getPoints(N), rad = [], ln = [];
    const re = rOf(n);
    for (let i = 0; i <= N; i++) { rad.push(rs + (re - rs) * smooth(i / N / 0.6)); ln.push(i ? ln[i - 1] + pts[i].distanceTo(pts[i - 1]) : len0); }
    n.end = end; n.dir = dir; n.len1 = ln[N];
    paths.push({ node: n, pts, rad, len: ln, color: root.color });
    const kc = n.children.length;
    if (!kc) return;
    const a = V3(0, 1, 0).cross(dir);
    if (a.lengthSq() < 1e-4) a.set(1, 0, 0);
    a.normalize();
    const spread = kc === 1 ? 0.3 : 0.66;
    n.children.forEach((c, j) => {
      const ax = a.clone().applyAxisAngle(dir, n.id * 1.7 + j * Math.PI * 2 / kc);
      const d = dir.clone().applyAxisAngle(ax, spread);
      d.y += 0.28; d.normalize();
      grow(c, end, dir, d, Math.max(0.9, len * 0.64), re, n.len1);
    });
  };
  const k = root.children.length;
  root.children.forEach((c, i) => {
    const u = 0.42 + 0.58 * (i / (k - 1));
    const idx = Math.round(u * TN);
    const az = i * 2.39996 + 0.5, el = (16 + 36 * (i / (k - 1))) * Math.PI / 180;
    grow(c, tp[idx], tc.getTangent(u), V3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)), 2.25 - 0.13 * i, Math.min(trad[idx] * 0.72, rOf(c) * 1.8), tlen[idx]);
  });
  return { root, nodes, paths };
}

export function bonsai() {
  const T = layout3D(TREE);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e7ece8');
  scene.fog = new THREE.Fog('#e7ece8', 20, 44);
  scene.environment = stage.env; scene.environmentIntensity = 0.4;
  const camera = new THREE.PerspectiveCamera(30, stage.w / stage.h, 1, 200);
  const fit = () => { camera.aspect = stage.w / stage.h; camera.position.set(0, 4.8, 16.2); camera.lookAt(0, 3.95, 0); camera.updateProjectionMatrix(); };
  fit();
  const world = new THREE.Group();
  scene.add(world);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b09c, 1.0));
  const sun = new THREE.DirectionalLight(0xfff3df, 2.8);
  sun.position.set(6, 13, 7); sun.target.position.set(0, 3, 0); sun.castShadow = true;
  const sc = sun.shadow.camera; sc.left = -7; sc.right = 7; sc.top = 7; sc.bottom = -7; sc.near = 1; sc.far = 40;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 5; sun.shadow.blurSamples = 14; sun.shadow.bias = -0.0004;
  scene.add(sun); scene.add(sun.target);
  const U = { uGrow: { value: 0 }, uTime: { value: 0 } };
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: '#e3dfd2', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const pot = solid(new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.15, 0.7, 56), new THREE.MeshPhysicalMaterial({ color: '#26485a', roughness: 0.35, clearcoat: 0.8 })));
  pot.position.y = 0.35; world.add(pot);
  const rim = solid(new THREE.Mesh(new THREE.TorusGeometry(1.52, 0.07, 10, 64), pot.material));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.7; world.add(rim);
  const soil = new THREE.Mesh(new THREE.CircleGeometry(1.48, 48), new THREE.MeshStandardMaterial({ color: '#33251b', roughness: 1 }));
  soil.rotation.x = -Math.PI / 2; soil.position.y = 0.705; soil.receiveShadow = true; world.add(soil);

  const mat = new THREE.MeshStandardMaterial({ map: imgTex('barkDiff', { srgb: true }), normalMap: imgTex('barkNor'), roughnessMap: imgTex('barkRough'), normalScale: new THREE.Vector2(1.6, 1.6), vertexColors: true, roughness: 1 });
  const warm = new THREE.Color(1.45, 1.32, 1.2);
  const geo = buildTubes(T.paths, { radial: 16, vScale: 0.9, uRepeat: 2, up: V3(1, 0, 0), color: () => warm, bump: (len, th) => 1 + 0.06 * Math.sin(len * 4.3 + th * 2) + 0.05 * Math.sin(len * 9.7 - th * 3 + 1.3) });
  world.add(tubeMesh(geo, mat, U, { key: 'bark3' }));

  const R = rng(3);
  const leaves = [];
  for (const n of T.nodes) {
    if (!n.depth) continue;
    const tip = !n.children.length;
    const cnt = tip ? 34 : 8, rad = tip ? 0.5 : 0.26;
    let made = 0;
    while (made < cnt) {
      const d = V3(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1);
      if (d.lengthSq() > 1) continue;
      made++;
      leaves.push({ pos: n.end.clone().addScaledVector(n.dir, tip ? 0.2 : 0).addScaledVector(d, rad), euler: new THREE.Euler(R() * 6.28, R() * 6.28, R() * 6.28), scale: 0.8 + R() * 0.7, len: n.len1 - 0.3 + R() * 0.5, color: n.color.clone().offsetHSL((R() - 0.5) * 0.05, (R() - 0.5) * 0.15, (R() - 0.5) * 0.16) });
    }
  }
  world.add(instanced(leafGeometry(0.36, 0.12), new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }), leaves, U));

  const labels = T.nodes.map((n) => ({
    text: n.t, depth: n.depth, color: n.depth ? shade(n.color, 0.45) : '#ffffff', len: n.depth ? n.len1 - 0.2 : 0, valign: 'middle',
    pos: n.depth ? n.end.clone().addScaledVector(n.dir, n.children.length ? 0.12 : 0.5).add(V3(0, 0.18, 0)) : V3(0, 0.36, 0)
  }));
  let spin = 0.5, last = -1, vel = 0;
  const B = { scene, camera, world, U, items: [], labels, fit };
  return finish(B, {
    paths: T.paths, tilt: [0, 0, 0, 0], labelScale: 0.9, growTime: 4.2, declutter: true,
    update: (t, ptr, e, inst, focus) => { const dt = last < 0 ? 0 : Math.min(0.05, t - last); last = t; vel *= 0.92; const turning = focus && !ptr.down; spin += (turning ? dt * 0.16 : 0) + vel; world.rotation.set(0, spin, 0); return turning || ptr.down || Math.abs(vel) > 1e-4; },
    drag: (dx) => { vel = dx * 0.006; spin += dx * 0.006; },
    labelFade: (depth) => Math.max(0, Math.min(1, (17.4 - depth) / 1.6))
  });
}

// ---------------------------------------------------------------- 03 soft clay
export function clay() {
  const L = layoutMap(TREE, { leafGap: 0.7, pad: 0.36, rootPad: 0.8, hGap: [1.25, 1.05, 0.95, 0.9] });
  const paths = buildPaths(L, { radius: (n) => 0.075 * Math.pow(n.leaves, 0.36), rootRadius: 0.19, taperEnd: 0.85 });
  const B = makeBase(L, { bg: '#f3ede6', sunPos: [-6, 8, 10], sun: 2.5, ambient: 1.05, envIntensity: 0.35, shadowRadius: 7, floor: 0xe6d5c5 });
  B.ground(new THREE.MeshStandardMaterial({ color: '#f6f0e9', roughness: 1 }));
  const geo = buildTubes(paths, { radial: 18, bump: (len, th) => 1 + 0.045 * Math.sin(len * 6.1 + th) + 0.03 * Math.sin(len * 13.0 - 2 * th) });
  B.world.add(tubeMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }), B.U, { key: 'clay' }));
  for (const n of L.nodes) {
    const root = n.depth === 0;
    const thick = root ? 0.5 : 2 * n.r + 0.1, h = root ? 1.0 : (n.depth === 1 ? 0.54 : 0.48);
    const m = solid(new THREE.Mesh(pillGeo(n.w, h, thick, 0.06), new THREE.MeshStandardMaterial({ color: root ? new THREE.Color('#2f3443') : tint(n.color, 0.62), roughness: 0.8 })));
    m.position.set(n.x, n.y, 0);
    B.world.add(root ? m : B.item(m, n.len1 + n.w * 0.3));
    B.labels.push({ text: n.t, depth: n.depth, color: root ? '#ffffff' : shade(n.color, 0.36), pos: V3(n.x, n.y, thick), valign: 'middle', len: n.len1 + n.w * 0.3 });
  }
  return finish(B, { paths, tilt: [-0.16, 0, 0.11, 0.16] });
}

// ---------------------------------------------------------------- 04 liquid glass
export function glass() {
  const L = layoutMap(TREE, { leafGap: 0.62 });
  const paths = buildPaths(L, { radius: (n) => 0.085 * Math.pow(n.leaves, 0.34), rootRadius: 0.2, taperEnd: 0.8 });
  const B = makeBase(L, { bg: '#1c2534', sunPos: [-5, 9, 11], sun: 1.6, ambient: 0.55, envIntensity: 0.9, shadowRadius: 6, sky: 0xcfe0ff, floor: 0x1a2230 });
  B.ground(new THREE.MeshStandardMaterial({ color: '#18202e', roughness: 0.75 }));
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, thickness: 0.35, ior: 1.42, roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.5 });
  const shell = new THREE.Mesh(buildTubes(paths, { radial: 22 }), glassMat);
  B.world.add(shell);
  const FLOW = [
    'float f = fract(vLen * 0.9 - uTime * 0.45);',
    'float bub = smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(0.05, 0.24, f));',
    'outgoingLight = outgoingLight * 0.85 + diffuseColor.rgb * 0.3 + vec3(bub) * 0.45;'
  ].join('\n');
  B.world.add(tubeMesh(buildTubes(paths, { radial: 14, radiusScale: 0.64 }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3 }), B.U, { key: 'liquid', frag: FLOW }));
  const cap = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, Math.max(0.2, L.root.w - 0.4), 10, 28), glassMat);
  cap.rotation.z = Math.PI / 2; cap.position.z = 0.5; B.world.add(cap);
  const ink = solid(new THREE.Mesh(new THREE.CapsuleGeometry(0.34, Math.max(0.2, L.root.w - 0.4), 10, 24), new THREE.MeshStandardMaterial({ color: '#eef2f8', roughness: 0.3, emissive: '#8a94a8', emissiveIntensity: 0.5 })));
  ink.rotation.z = Math.PI / 2; ink.position.z = 0.5; B.world.add(ink);
  B.labels = mapLabels(L, { dy: (n) => n.r + 0.07, rootZ: 1.0, ink: (n) => (n.depth ? hex(tint(n.color, 0.62)) : '#1d2536') });
  return finish(B, { paths, tilt: [-0.12, 0, 0.13, 0.2], animated: true });
}

// ---------------------------------------------------------------- 05 neon
export function neon() {
  const L = layoutMap(TREE, { leafGap: 0.62 });
  const zc = 0.24;
  const paths = buildPaths(L, { radius: (n) => 0.032 * Math.pow(n.leaves, 0.3), rootRadius: 0.055, taperEnd: 0.5, z: () => zc });
  const B = makeBase(L, { bg: '#07070c', sun: 0, ambient: 0.1, envIntensity: 0.06, sky: 0x8090ff, floor: 0x101018 });
  B.ground(new THREE.MeshStandardMaterial({ color: '#15161f', roughness: 0.55, metalness: 0.25, bumpMap: blobTex(13, 500, 2, 7), bumpScale: 0.6 }));
  const PULSE = [
    'float ph = fract((uTime * 2.4 - vLen) / 7.5);',
    'float pulse = smoothstep(0.0, 0.03, ph) * (1.0 - smoothstep(0.03, 0.3, ph));',
    'outgoingLight = outgoingLight * (0.7 + 1.4 * pulse) + vec3(0.5) * pulse;'
  ].join('\n');
  const basic = () => new THREE.MeshBasicMaterial({ vertexColors: true });
  const tubes = tubeMesh(buildTubes(paths, { radial: 10, color: (p) => p.color.clone().multiplyScalar(2.3) }), basic(), B.U, { key: 'neon', frag: PULSE });
  tubes.castShadow = false; B.world.add(tubes);
  const ring = new THREE.Mesh(buildTubes([loopPath(stadiumPath(L.root.w + 0.1, 0.92, zc, 96), 0.04, new THREE.Color(1.25, 1.25, 1.5))], { radial: 10, cap: false }), basic());
  B.world.add(ring);
  for (const m of L.root.children) {
    let x = 0, y = 0, k = 0;
    const walk = (n) => { x += n.x; y += n.y; k++; n.children.forEach(walk); };
    walk(m);
    const pl = new THREE.PointLight(m.color, 9, 8, 1.7);
    pl.position.set(x / k, y / k, 0.9); B.world.add(pl);
  }
  B.labels = mapLabels(L, { dy: (n) => n.r + 0.08, z: () => zc, rootZ: zc, ink: (n) => (n.depth ? hex(tint(n.color, 0.6)) : '#ffffff') });
  const comp = makeBloom(B.scene, B.camera, 0.7, 0.5, 0.3);
  return finish(B, { paths, tilt: [-0.1, 0, 0.1, 0.16], animated: true, render: () => comp.render(), resize: () => comp.setSize(stage.w, stage.h) });
}

// ---------------------------------------------------------------- 06 rope: one strand per leaf
export function rope() {
  const L = layoutMap(TREE, { leafGap: 0.62 });
  const rho = 0.04;
  const Rb = (k) => rho * (1.9 * Math.sqrt(Math.max(0, k - 1)) + 1);
  const paths = buildPaths(L, { radius: (n) => Rb(n.leaves), rootRadius: Rb(12), taperEnd: 0.5 });
  const B = makeBase(L, { bg: '#ece7df', sunPos: [-6, 9, 9], sun: 2.8, ambient: 0.9, envIntensity: 0.3, shadowRadius: 4 });
  B.ground(new THREE.MeshStandardMaterial({ map: paperTex('#eee9e1', 10, 16), roughness: 1 }));
  const byNode = new Map(paths.map((p) => [p.node, p]));
  const leavesOf = (n) => (n.children.length ? n.children.flatMap(leavesOf) : [n]);
  const R = rng(17);
  const strands = [], beads = [];
  L.nodes.filter((n) => n.depth > 0 && !n.children.length).forEach((leaf, li) => {
    const chain = [];
    for (let n = leaf; n.depth > 0; n = n.parent) chain.unshift(n);
    const C = [], LEN = [], OB = [], ON = [];
    chain.forEach((n, ci) => {
      const p = byNode.get(n), list = leavesOf(n), i = list.indexOf(leaf);
      const rr = i === 0 ? 0 : rho * 1.9 * Math.sqrt(i);
      for (let s = ci ? 1 : 0; s < p.pts.length; s++) {
        const a = i * 2.39996 + p.len[s] * 2.6 + n.branch;
        C.push(p.pts[s]); LEN.push(p.len[s]); OB.push(rr * Math.cos(a)); ON.push(rr * Math.sin(a));
      }
    });
    for (let pass = 0; pass < 2; pass++) for (const arr of [OB, ON]) {
      const src = arr.slice();
      for (let s = 0; s < arr.length; s++) { let sum = 0, cnt = 0; for (let d = -5; d <= 5; d++) { const q = s + d; if (q >= 0 && q < src.length) { sum += src[q]; cnt++; } } arr[s] = sum / cnt; }
    }
    const F = computeFrames(C);
    const pts = C.map((c, s) => c.clone().addScaledVector(F.B[s], OB[s]).addScaledVector(F.N[s], ON[s]));
    const col = leaf.color.clone().offsetHSL(((li % 3) - 1) * 0.02, 0, (R() - 0.5) * 0.16);
    strands.push({ pts, rad: pts.map(() => rho), len: LEN, color: col });
    const e = pts[pts.length - 1];
    beads.push({ pos: V3(e.x + leaf.side * 0.03, e.y, e.z), scale: 1, len: LEN[LEN.length - 1], color: leaf.color.clone().multiplyScalar(0.55) });
  });
  B.world.add(tubeMesh(buildTubes(strands, { radial: 7 }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }), B.U, { key: 'rope' }));
  B.world.add(instanced(new THREE.SphereGeometry(0.06, 14, 10), new THREE.MeshStandardMaterial({ roughness: 0.3 }), beads, B.U));
  const wrapMat = new THREE.MeshStandardMaterial({ color: '#f4eddc', roughness: 0.9 });
  for (const n of L.nodes) if (n.depth > 0 && n.children.length) {
    const r = Rb(n.leaves) + 0.014;
    const w = solid(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.16, 20), wrapMat));
    w.rotation.z = Math.PI / 2; w.position.set(n.out[0] - n.side * 0.1, n.y, Rb(n.leaves));
    B.world.add(B.item(w, n.len2 - 0.1));
  }
  const hub = solid(new THREE.Mesh(new THREE.CapsuleGeometry(0.42, Math.max(0.2, L.root.w - 0.5), 10, 28), new THREE.MeshStandardMaterial({ color: '#3a2f2a', roughness: 0.75 })));
  hub.rotation.z = Math.PI / 2; hub.position.z = 0.42; B.world.add(hub);
  B.labels = mapLabels(L, { dy: (n) => n.r + 0.08, rootZ: 0.84, ink: (n) => (n.depth ? shade(n.color, 0.4) : '#ffffff') });
  return finish(B, { paths, tilt: [-0.14, 0, 0.11, 0.16] });
}

// ---------------------------------------------------------------- 07 paper quilling
export function quill() {
  const L = layoutMap(TREE, { leafGap: 0.68 });
  const paths = buildPaths(L, { z: () => 0, radius: () => 0.05, rootRadius: 0.05, samples: 34 });
  const B = makeBase(L, { bg: '#f1ece4', margin: 1.1, sunPos: [-9, 5, 6.5], sun: 3.0, ambient: 0.95, envIntensity: 0.2, shadowRadius: 3 });
  B.ground(new THREE.MeshStandardMaterial({ map: paperTex('#f3eee6', 8, 16), roughness: 1 }));
  const R = rng(21);
  const strips = [];
  for (const p of paths) {
    const n = p.node;
    const k = Math.min(4, Math.ceil(Math.sqrt(n.leaves)));
    const F = computeFrames(p.pts);
    for (let j = 0; j < k; j++) {
      const off = (j - (k - 1) / 2) * 0.055;
      const pts = p.pts.map((q, i) => V3(q.x + F.B[i].x * off, q.y + F.B[i].y * off, 0));
      const len = p.len.slice();
      if (!n.children.length) {
        const R0 = 0.17, turns = 2.1, s = n.side;
        for (let i = 1; i <= 3; i++) { const q = pts[pts.length - 1].clone(); q.x += s * 0.08; len.push(len[len.length - 1] + 0.08); pts.push(q); }
        const e = pts[pts.length - 1];
        for (let i = 1; i <= 64; i++) {
          const u = i / 64, phi = -Math.PI / 2 + s * u * turns * Math.PI * 2, rr = R0 * (1 - 0.8 * u);
          const q = V3(e.x + rr * Math.cos(phi), e.y + R0 + rr * Math.sin(phi), 0);
          len.push(len[len.length - 1] + q.distanceTo(pts[pts.length - 1]));
          pts.push(q);
        }
      }
      strips.push({ pts, len, color: n.color.clone().offsetHSL(0, 0, (j - (k - 1) / 2) * 0.07 + (R() - 0.5) * 0.04), h: 0.3 + 0.05 * ((j + n.depth) % 3) });
    }
  }
  const rootCols = ['#2f3443', '#f29d1d', '#2f7df6'];
  rootCols.forEach((c, i) => { const pts = stadiumPath(L.root.w + 0.1 + i * 0.2, 0.92 + i * 0.2, 0, 110); strips.push({ pts, len: pts.map(() => 0), color: new THREE.Color(c), h: 0.38 - i * 0.07 }); });
  const mesh = tubeMesh(buildStrips(strips, { thick: 0.03, height: (p) => p.h, color: (p) => p.color }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), B.U, { key: 'quill' });
  B.world.add(mesh);
  B.labels = mapLabels(L, { dy: () => 0.3, z: () => 0, rootZ: 0, ink: (n) => (n.depth ? shade(n.color, 0.42) : '#2b2f3c') });
  return finish(B, { paths, tilt: [-0.52, 0, 0.12, 0.2] });
}

// ---------------------------------------------------------------- 08 kintsugi and 09 blind emboss
function relief(o) {
  const L = layoutMap(TREE, { leafGap: 0.62 });
  const paths = buildPaths(L, { radius: (n) => 0.062 * Math.pow(n.leaves, 0.42), rootRadius: 0.19, taperEnd: 0.8, z: () => 0 });
  const B = makeBase(L, o.base);
  B.ground(o.ground);
  const geo = buildTubes(paths, { radial: 16, startCap: true, bump: o.bump });
  const mesh = tubeMesh(geo, o.mat, B.U, { key: o.key });
  mesh.scale.z = o.squash; B.world.add(mesh);
  const ring = solid(new THREE.Mesh(buildTubes([loopPath(stadiumPath(L.root.w, 1.0, 0, 110), 0.085, new THREE.Color(1, 1, 1))], { radial: 14, cap: false }), o.mat));
  ring.scale.z = o.squash; B.world.add(ring);
  B.labels = mapLabels(L, { dy: (n) => n.r * 0.9 + 0.08, z: () => 0, rootZ: 0, ink: o.ink });
  return finish(B, { paths, tilt: o.tilt });
}

export function kintsugi() {
  return relief({
    key: 'gold', squash: 0.42, tilt: [-0.12, 0, 0.14, 0.24],
    base: { bg: '#0b1322', sunPos: [-6, 8, 9], sun: 1.1, ambient: 0.35, envIntensity: 0.6, sky: 0xdfe8ff, floor: 0x1a2030, shadowRadius: 4 },
    ground: new THREE.MeshStandardMaterial({ color: '#0d182c', roughness: 0.62, envMapIntensity: 0.12, bumpMap: blobTex(9, 240, 10, 34), bumpScale: 0.25 }),
    mat: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.0, 0.6, 0.16), metalness: 1, roughness: 0.34, bumpMap: blobTex(2, 800, 2, 6), bumpScale: 0.5, envMapIntensity: 1.7 }),
    bump: (len, th, r, p) => { const k = p.node ? p.node.branch : 0; return 1 + 0.2 * Math.sin(len * 2.7 + k) + 0.12 * Math.sin(len * 6.3 + k * 2.1); },
    ink: () => '#f3e7cc'
  });
}

export function emboss() {
  const paper = paperTex('#f6f4ef', 6, 18, false);
  return relief({
    key: 'emboss', squash: 0.5, tilt: [-0.1, 0, 0.12, 0.22],
    base: { bg: '#f1efea', sunPos: [-9, 7, 4.4], sun: 3.9, ambient: 1.3, envIntensity: 0.12, shadowRadius: 3 },
    ground: new THREE.MeshStandardMaterial({ map: paper, roughness: 1 }),
    mat: new THREE.MeshStandardMaterial({ color: '#f6f4ef', roughness: 1 }),
    bump: null,
    ink: (n) => (n.depth ? shade(n.color, 0.5) : '#4a4d55')
  });
}

// ---------------------------------------------------------------- 10 pipework
export function pipes() {
  const L = layoutMap(TREE, { leafGap: 0.64, hGap: [1.5, 1.25, 1.1, 1.0] });
  const RAD = [0.12, 0.12, 0.095, 0.075];
  const zc = 0.3;
  const paths = buildPaths(L, { style: 'ortho', radius: (n) => RAD[Math.min(3, n.depth)], rootRadius: RAD[0], taperEnd: 0.06, z: () => zc, elbow: 0.2 });
  const B = makeBase(L, { bg: '#d9dde1', sunPos: [-6, 9, 10], sun: 2.6, ambient: 0.85, envIntensity: 0.55, shadowRadius: 5, floor: 0xc5c9ce });
  B.ground(new THREE.MeshStandardMaterial({ map: paperTex('#dfe2e5', 9, 9, false), roughness: 0.95 }));
  B.world.add(tubeMesh(buildTubes(paths, { radial: 20 }), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12 }), B.U, { key: 'pipe' }));
  const collars = [];
  const brass = new THREE.Color('#c9a24b');
  const nearestLen = (p, x, y) => { let best = 0, bd = 1e9; for (let i = 0; i < p.pts.length; i++) { const d = Math.hypot(p.pts[i].x - x, p.pts[i].y - y); if (d < bd) { bd = d; best = i; } } return p.len[best]; };
  const collar = (p, x, y, d, r) => collars.push({ pos: V3(x, y, zc), euler: new THREE.Euler(0, 0, d === 'x' ? Math.PI / 2 : 0), scale3: V3(r * 1.34, 0.085, r * 1.34), len: nearestLen(p, x, y), color: brass });
  for (const p of paths) {
    const n = p.node, s = p.side;
    collar(p, p.S[0] + s * 0.09, p.S[1], 'x', n.r);
    for (const j of p.joints) collar(p, j.p[0], j.p[1], j.d, n.r);
    collar(p, n.out[0] - s * 0.02, n.y, 'x', n.r);
  }
  B.world.add(instanced(new THREE.CylinderGeometry(1, 1, 1, 20), new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.28 }), collars, B.U));
  const tank = solid(new THREE.Mesh(new THREE.CapsuleGeometry(0.5, Math.max(0.2, L.root.w - 0.45), 10, 28), new THREE.MeshPhysicalMaterial({ color: '#2b3140', roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.15 })));
  tank.rotation.z = Math.PI / 2; tank.position.z = 0.5; B.world.add(tank);
  for (const sx of [-1, 1]) {
    const band = solid(new THREE.Mesh(new THREE.TorusGeometry(0.505, 0.04, 10, 40), new THREE.MeshStandardMaterial({ color: brass, metalness: 1, roughness: 0.28 })));
    band.rotation.y = Math.PI / 2; band.position.set(sx * (L.root.w / 2 - 0.3), 0, 0.5); B.world.add(band);
  }
  B.labels = mapLabels(L, { dy: (n) => n.r + 0.08, z: () => zc, rootZ: 1.0, ink: (n) => (n.depth ? shade(n.color, 0.4) : '#ffffff') });
  return finish(B, { paths, tilt: [-0.12, 0, 0.12, 0.2] });
}

// ---------------------------------------------------------------- 11 lifted arcs
export function arcs() {
  const L = layoutMap(TREE, { leafGap: 0.72, pad: 0.4, rootPad: 0.8, hGap: [1.5, 1.25, 1.1, 1.0] });
  const H = [0, 1.05, 0.72, 0.5];
  const top = 0.07;
  const paths = buildPaths(L, { underline: false, radius: (n) => 0.03 * Math.pow(n.leaves, 0.28), rootRadius: 0.05, taperEnd: 0.5, samples: 36, z: (n, r, u) => top + 0.03 + H[Math.min(3, n.depth)] * Math.sin(Math.PI * Math.min(1, u)) });
  const B = makeBase(L, { bg: '#eceef2', margin: 1.06, sunPos: [-4, 10, 8], sun: 2.7, ambient: 0.95, envIntensity: 0.45, shadowRadius: 4 });
  B.ground(new THREE.MeshStandardMaterial({ map: paperTex('#eff1f4', 6, 16, false), roughness: 1 }));
  B.world.add(tubeMesh(buildTubes(paths, { radial: 12, startCap: true }), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.6 }), B.U, { key: 'arc' }));
  const plugs = [];
  for (const n of L.nodes) {
    const root = n.depth === 0;
    const h = root ? 0.96 : 0.5, t = root ? 0.14 : top;
    const m = solid(new THREE.Mesh(pillGeo(n.w, h, t, 0.02, root ? 0.3 : 0.14), new THREE.MeshStandardMaterial({ color: root ? '#2f3443' : '#ffffff', roughness: 0.6 })));
    m.position.set(n.x, n.y, 0);
    B.world.add(root ? m : B.item(m, n.len1));
    B.labels.push({ text: n.t, depth: n.depth, color: root ? '#ffffff' : shade(n.color, 0.42), pos: V3(n.x, n.y, t), valign: 'middle', len: n.len1 });
  }
  for (const p of paths) {
    plugs.push({ pos: V3(p.S[0], p.S[1], top + 0.03), scale: 1, len: p.len[0], color: p.color });
    plugs.push({ pos: V3(p.E[0], p.E[1], top + 0.03), scale: 1, len: p.node.len1, color: p.color });
  }
  B.world.add(instanced(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshStandardMaterial({ roughness: 0.35 }), plugs, B.U));
  return finish(B, { paths, tilt: [-0.5, 0, 0.14, 0.24] });
}
