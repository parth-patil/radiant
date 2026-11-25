import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { smooth } from './map.js';

/** One WebGL context draws every card; each card copies the frame into its own 2D canvas. */
export const stage = { renderer: null, env: null, w: 1, h: 1, dpr: 1, images: {} };

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function loadImages(map) {
  return Promise.all(Object.keys(map).map((k) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { stage.images[k] = im; res(); };
    im.onerror = rej;
    im.src = map[k];
  })));
}

export function imgTex(name, o) {
  const t = new THREE.Texture(stage.images[name]);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (o && o.srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (o && o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function initStage(w, h) {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  stage.dpr = Math.min(2, window.devicePixelRatio || 1);
  stage.w = w; stage.h = h;
  r.setPixelRatio(stage.dpr);
  r.setSize(w, h, false);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.VSMShadowMap;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.0;
  stage.renderer = r;
  const pm = new THREE.PMREMGenerator(r);
  stage.env = pm.fromScene(new RoomEnvironment(), 0.03).texture;
  pm.dispose();
  return r;
}

export function fitCamera(camera, b, margin) {
  camera.aspect = stage.w / stage.h;
  const t = Math.tan(camera.fov * Math.PI / 360);
  const d = Math.max(b.h / 2 / t, b.w / 2 / (t * camera.aspect)) * margin;
  camera.position.set(b.cx, b.cy, d);
  camera.lookAt(b.cx, b.cy, 0);
  camera.updateProjectionMatrix();
}

export function makeBase(L, opt) {
  const o = Object.assign({ bg: '#ffffff', fov: 26, margin: 1.07, sun: 2.4, sunPos: [-7, 9, 12], sunColor: 0xffffff, ambient: 0.7, sky: 0xffffff, floor: 0xcfc8bb, envIntensity: 0.5, shadowRadius: 4, shadows: true }, opt || {});
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(o.bg);
  scene.environment = stage.env;
  scene.environmentIntensity = o.envIntensity;
  const camera = new THREE.PerspectiveCamera(o.fov, stage.w / stage.h, 1, 200);
  const world = new THREE.Group();
  scene.add(world);
  scene.add(new THREE.HemisphereLight(o.sky, o.floor, o.ambient));
  let sun = null;
  if (o.sun > 0) {
    sun = new THREE.DirectionalLight(o.sunColor, o.sun);
    sun.position.set(o.sunPos[0], o.sunPos[1], o.sunPos[2]);
    if (o.shadows) {
      sun.castShadow = true;
      const ex = Math.max(L.bounds.w, L.bounds.h) * 0.6 + 1.5;
      const sc = sun.shadow.camera;
      sc.left = -ex; sc.right = ex; sc.top = ex * 0.75; sc.bottom = -ex * 0.75; sc.near = 1; sc.far = 70;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.radius = o.shadowRadius;
      sun.shadow.blurSamples = 14;
      sun.shadow.bias = -0.0004;
    }
    scene.add(sun);
  }
  const U = { uGrow: { value: 0 }, uTime: { value: 0 } };
  const B = { L, o, scene, camera, world, sun, U, items: [], labels: [] };
  B.ground = (mat, z) => { const g = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), mat); g.position.set(L.bounds.cx, L.bounds.cy, z || 0); g.receiveShadow = true; world.add(g); return g; };
  B.item = (obj, len) => { B.items.push({ obj, len, base: obj.scale.clone() }); return obj; };
  B.fit = () => fitCamera(camera, L.bounds, o.margin);
  B.fit();
  return B;
}

/**
 * Growth: geometry further from the root than uGrow collapses onto its centre line (tubes) or to
 * nothing (instances), so a branch draws itself outwards with a pointed tip. opt.frag is extra GLSL
 * that may change outgoingLight; it can read vLen, uTime and uGrow.
 */
export function patch(mat, U, opt) {
  const o = Object.assign({ mode: 'tube', frag: '', key: '' }, opt || {});
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGrow = U.uGrow;
    sh.uniforms.uTime = U.uTime;
    const head = 'attribute float aLen;\n' + (o.mode === 'tube' ? 'attribute vec3 aCenter;\n' : '') + 'uniform float uGrow;\nuniform float uTime;\nvarying float vLen;\n';
    const body = o.mode === 'tube'
      ? 'vLen = aLen; { float gk = 1.0 - smoothstep(uGrow - 0.45, uGrow, aLen); transformed = mix(aCenter, transformed, gk); }'
      : 'vLen = aLen; transformed *= smoothstep(aLen, aLen + 0.5, uGrow);';
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + head).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + body);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGrow;\nuniform float uTime;\nvarying float vLen;\n');
    if (o.frag) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', o.frag + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'grow-' + o.mode + '-' + o.key;
  return mat;
}

export function withDepth(mesh, U, mode) {
  mesh.customDepthMaterial = patch(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), U, { mode, key: 'depth' });
  return mesh;
}

export function tubeMesh(geo, mat, U, opt) {
  const m = new THREE.Mesh(geo, patch(mat, U, Object.assign({ mode: 'tube' }, opt || {})));
  m.castShadow = true; m.receiveShadow = true;
  withDepth(m, U, 'tube');
  return m;
}

export function mapLabels(L, opt) {
  const o = Object.assign({ dy: (n) => n.r + 0.07, z: (n) => n.r, valign: 'bottom', rootZ: 0.3, ink: null }, opt || {});
  return L.nodes.map((n) => ({
    text: n.t, depth: n.depth, color: o.ink ? o.ink(n) : '#' + n.color.getHexString(), len: n.depth ? n.len1 : 0,
    pos: n.depth ? new THREE.Vector3(n.x, n.y + (o.valign === 'bottom' ? o.dy(n) : 0), o.z(n)) : new THREE.Vector3(0, 0, o.rootZ),
    valign: n.depth ? o.valign : 'middle'
  }));
}

export function finish(B, opt) {
  const o = Object.assign({ tilt: [-0.1, 0, 0.1, 0.14], growTime: 3.4, paths: [] }, opt || {});
  let maxLen = 0;
  for (const p of o.paths) maxLen = Math.max(maxLen, p.len[p.len.length - 1]);
  const inst = { scene: B.scene, camera: B.camera, world: B.world, labels: B.labels, U: B.U, maxLen: o.maxLen || maxLen, t0: -1, rx: o.tilt[0], ry: o.tilt[1], labelScale: o.labelScale || 1, grow: 0 };
  inst.replay = () => { inst.t0 = -1; };
  // Returns true when the picture changed and the stage has to be drawn again. A stage that is at rest costs
  // nothing: no idle motion, and flow, pulses and the turntable run only on the stage in focus.
  let wasGrowing = true;
  inst.tick = (t, ptr, focus) => {
    if (inst.t0 < 0) inst.t0 = t;
    const g = (t - inst.t0) / o.growTime;
    const growing = g < 1;
    const e = growing ? (inst.maxLen + 1.5) * g : 1e4;
    inst.grow = e;
    B.U.uGrow.value = e; B.U.uTime.value = t;
    if (growing || wasGrowing) for (const it of B.items) { const s = smooth((e - it.len) / 0.6); it.obj.visible = s > 0.002; it.obj.scale.copy(it.base).multiplyScalar(Math.max(s, 0.002)); }
    const dx = o.tilt[0] + (ptr.inside ? -ptr.y * o.tilt[2] : 0) - inst.rx;
    const dy = o.tilt[1] + (ptr.inside ? ptr.x * o.tilt[3] : 0) - inst.ry;
    const moving = Math.abs(dx) + Math.abs(dy) > 3e-4;
    if (moving) { inst.rx += dx * 0.12; inst.ry += dy * 0.12; }
    B.world.rotation.set(inst.rx, inst.ry, 0);
    const live = o.update ? o.update(t, ptr, e, inst, focus) === true : false;
    const ended = wasGrowing && !growing;
    wasGrowing = growing;
    return growing || ended || moving || live || (focus && !!o.animated);
  };
  inst.settle = () => { inst.t0 = -1e6; };
  inst.render = () => { if (o.render) o.render(); else stage.renderer.render(B.scene, B.camera); };
  inst.onResize = () => { B.fit(); if (o.resize) o.resize(); };
  inst.drag = o.drag || null;
  inst.labelFade = o.labelFade || null;
  inst.declutter = !!o.declutter;
  return inst;
}

export function makeBloom(scene, camera, strength, radius, threshold) {
  const c = new EffectComposer(stage.renderer);
  c.addPass(new RenderPass(scene, camera));
  c.addPass(new UnrealBloomPass(new THREE.Vector2(stage.w, stage.h), strength, radius, threshold));
  c.addPass(new OutputPass());
  return c;
}

// ---------- procedural textures ----------

export function canvasTex(w, h, draw, o) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (!o || o.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (o && o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
  t.anisotropy = 8;
  return t;
}

export function paperTex(base, grain, repeat, fibres) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    const im = g.getImageData(0, 0, w, h);
    const R = rng(11);
    for (let i = 0; i < im.data.length; i += 4) { const d = (R() - 0.5) * grain; im.data[i] += d; im.data[i + 1] += d; im.data[i + 2] += d; }
    g.putImageData(im, 0, 0);
    if (fibres !== false) {
      g.strokeStyle = 'rgba(60,40,20,0.05)'; g.lineWidth = 1;
      for (let k = 0; k < 70; k++) { const x = R() * w, y = R() * h, a = R() * 6.28, l = 6 + R() * 16; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
    }
  }, { repeat: [repeat, repeat * 70 / 90] });
}

export function ringsTex() {
  return canvasTex(512, 512, (g, w, h) => {
    const R = rng(5);
    g.fillStyle = '#6a4a2e'; g.fillRect(0, 0, w, h);
    const grad = g.createRadialGradient(256, 256, 10, 256, 256, 250);
    grad.addColorStop(0, '#c99f6a'); grad.addColorStop(0.75, '#e2c08d'); grad.addColorStop(1, '#d3ac78');
    g.fillStyle = grad; g.beginPath(); g.arc(256, 256, 243, 0, 6.2832); g.fill();
    for (let i = 1; i < 34; i++) {
      const base = i * 7.2 + R() * 2.5, ph = R() * 6.28, amp = 1.5 + R() * 2.5;
      g.strokeStyle = 'rgba(112,72,34,' + (0.22 + R() * 0.38).toFixed(2) + ')';
      g.lineWidth = 0.8 + R() * 2.2;
      g.beginPath();
      for (let a = 0; a <= 360; a += 4) { const th = a * Math.PI / 180; const rr = base + amp * Math.sin(3 * th + ph) + 1.2 * Math.sin(7 * th + ph * 2); const x = 256 + rr * Math.cos(th), y = 256 + rr * Math.sin(th); if (a === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.closePath(); g.stroke();
    }
    g.strokeStyle = 'rgba(80,50,24,0.28)';
    for (let k = 0; k < 9; k++) { const th = R() * 6.28, r0 = 12 + R() * 60, r1 = 120 + R() * 120; g.lineWidth = 0.6 + R() * 1.2; g.beginPath(); g.moveTo(256 + r0 * Math.cos(th), 256 + r0 * Math.sin(th)); g.lineTo(256 + r1 * Math.cos(th + 0.04), 256 + r1 * Math.sin(th + 0.04)); g.stroke(); }
  });
}

export function blobTex(seed, count, rmin, rmax) {
  return canvasTex(256, 256, (g, w, h) => {
    const R = rng(seed);
    g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < count; k++) {
      const x = R() * w, y = R() * h, r = rmin + R() * (rmax - rmin), up = R() > 0.5;
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, up ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(128,128,128,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x + ox, y + oy, r, 0, 6.2832); g.fill();
      }
    }
  }, { srgb: false });
}

// ---------- small geometry helpers ----------

/** A rounded rectangle extruded into a plaque whose base sits on z = 0. */
export function pillGeo(w, h, depth, bevel, radius) {
  const r = Math.min(h / 2, radius == null ? h / 2 : radius) - 1e-3;
  const x = w / 2 - r, y = h / 2 - r;
  const s = new THREE.Shape();
  s.moveTo(-x, -h / 2);
  s.lineTo(x, -h / 2); s.absarc(x, -y, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, y); s.absarc(x, y, r, 0, Math.PI / 2, false);
  s.lineTo(-x, h / 2); s.absarc(-x, y, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -y); s.absarc(-x, -y, r, Math.PI, Math.PI * 1.5, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, depth - 2 * bevel), bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 5, curveSegments: 12 });
  g.translate(0, 0, bevel);
  return g;
}

/** A closed stadium-shaped loop as a path, for rims and rings around the root label. */
export function stadiumPath(w, h, z, n) {
  const r = h / 2, x = Math.max(0, w / 2 - r);
  const pts = [];
  const per = 2 * (2 * x) + 2 * Math.PI * r;
  for (let i = 0; i <= n; i++) {
    let d = (i / n) * per, px, py;
    if (d < 2 * x) { px = -x + d; py = -r; }
    else if ((d -= 2 * x) < Math.PI * r) { const a = -Math.PI / 2 + d / r; px = x + r * Math.cos(a); py = r * Math.sin(a); }
    else if ((d -= Math.PI * r) < 2 * x) { px = x - d; py = r; }
    else { d -= 2 * x; const a = Math.PI / 2 + d / r; px = -x + r * Math.cos(a); py = r * Math.sin(a); }
    pts.push(new THREE.Vector3(px, py, z));
  }
  return pts;
}

export function leafGeometry(len, wid) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(len * 0.4, wid, len, 0);
  s.quadraticCurveTo(len * 0.4, -wid, 0, 0);
  return new THREE.ShapeGeometry(s, 8);
}

export function instanced(geo, mat, specs, U) {
  const m = new THREE.InstancedMesh(geo, patch(mat, U, { mode: 'scale', key: 'inst' }), specs.length);
  const lens = new Float32Array(specs.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  specs.forEach((s, i) => {
    Q.setFromEuler(s.euler || new THREE.Euler());
    S.setScalar(s.scale == null ? 1 : s.scale);
    if (s.scale3) S.copy(s.scale3);
    M.compose(s.pos, Q, S);
    m.setMatrixAt(i, M);
    if (s.color) m.setColorAt(i, s.color);
    lens[i] = s.len || 0;
  });
  geo.setAttribute('aLen', new THREE.InstancedBufferAttribute(lens, 1));
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.castShadow = true; m.receiveShadow = true;
  m.frustumCulled = false;
  withDepth(m, U, 'scale');
  return m;
}
