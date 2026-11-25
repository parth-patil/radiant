// WGSL ports of radiant/src/lib/render/shaders.ts (MESH, ROPE, RELIEF_SHADOW, RELIEF_COMPOSITE, RECT, TEX).
struct U {
  view: vec2f,
  zoom: f32,
  far: f32,
  off: vec2f,
  off_low: vec2f,
  mat: vec4f,
  color: vec4f,
  res: vec2f,
  coded: f32,
  pad: f32,
}
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;

fn ndc(p: vec2f) -> vec4f {
  return vec4f(p.x / (u.view.x * 0.5), -p.y / (u.view.y * 0.5), 0.0, 1.0);
}
fn world(pos: vec2f, low: vec2f) -> vec2f {
  // Keep the cancelling high terms together (same trick as MESH_VS).
  let hi = bitcast<vec2f>(bitcast<vec2i>(pos + u.off) & vec2i(-2));
  return hi + (low + u.off_low);
}

struct FlatOut { @builtin(position) pos: vec4f, @location(0) col: vec4f }
@vertex fn vs_flat(@location(0) pos: vec2f, @location(1) col: vec4f, @location(2) low: vec2f) -> FlatOut {
  var o: FlatOut;
  o.pos = ndc(world(pos, low) * u.zoom);
  o.col = col;
  return o;
}
@fragment fn fs_flat(i: FlatOut) -> @location(0) vec4f { return i.col; }

struct RopeOut {
  @builtin(position) pos: vec4f,
  @location(0) col: vec4f,
  @location(1) n: vec4f,
  @location(2) twist: f32,
  @location(3) @interpolate(flat) plies: f32,
}
@vertex fn vs_rope(@location(0) pos: vec2f, @location(1) col: vec4f, @location(2) low: vec2f,
                   @location(3) nrm: vec4f, @location(5) twist: f32) -> RopeOut {
  var o: RopeOut;
  o.pos = ndc(world(pos, low) * u.zoom);
  o.col = col;
  o.n = nrm;
  o.twist = twist;
  o.plies = f32(i32(round(nrm.z * 127.0)) >> 4u);
  return o;
}
const LIGHT = vec3f(-0.24, -0.5, 0.83);
const HALF = vec3f(-0.1255, -0.2615, 0.9570);
@fragment fn fs_rope(i: RopeOut) -> @location(0) vec4f {
  let n = i.n.xy;
  var N = vec3f(n, sqrt(max(0.0, 1.0 - min(dot(n, n), 1.0))));
  var col = i.col.rgb;
  var plies = i.plies;
  var seam = 0.0;
  // Derivatives hoisted out of the branches (WGSL uniformity rules); same values as the GLSL.
  let tt = i.twist * 9.0;
  let fw_tt = fwidth(tt);
  let uu = (asin(clamp(i.n.w, -0.98, 0.98)) * 0.15915494 + i.twist) * plies;
  let fw_u = fwidth(uu);
  let dux = dpdx(uu);
  let duy = dpdy(uu);
  if (plies > 6.5) {
    let groove = smoothstep(0.55, 1.0, abs(fract(tt) * 2.0 - 1.0)) * (1.0 - smoothstep(0.25, 0.5, fw_tt));
    col *= 1.0 - 0.3 * groove;
    plies = 0.0;
  }
  if (plies > 0.5) {
    let detail = 1.0 - smoothstep(0.35, 0.7, fw_u);
    if (detail > 0.0) {
      let f = fract(uu) * 2.0 - 1.0;
      let g = vec2f(dux, -duy);
      let g2 = dot(g, g);
      var across = vec2f(0.0);
      if (g2 > 1e-12) { across = g * inverseSqrt(g2); }
      N = normalize(N + vec3f(across * (f * 0.85 * detail), 0.0));
      let fl = floor(uu);
      let m = fl - plies * floor(fl / plies);
      let tint = fract(sin(m * 12.9898 + 4.1) * 43758.5453) - 0.5;
      col *= 1.0 + 0.16 * tint * detail;
      seam = detail * smoothstep(0.55, 1.0, abs(f));
    }
  }
  let lambert = max(dot(N, LIGHT), 0.0);
  let spec = u.mat.z * pow(max(dot(N, HALF), 0.0), u.mat.w);
  let c = col * (u.mat.x + u.mat.y * lambert) * (1.0 - 0.42 * seam) + spec * (1.0 - seam) * i.col.a;
  return vec4f(min(c, vec3f(i.col.a)), i.col.a);
}

struct ShOut { @builtin(position) pos: vec4f, @location(0) n: vec4f }
@vertex fn vs_shadow(@location(0) pos: vec2f, @location(2) low: vec2f, @location(3) nrm: vec4f,
                     @location(4) soff: vec2i) -> ShOut {
  var o: ShOut;
  o.pos = ndc((world(pos, low) + vec2f(soff) * 0.0078125) * u.zoom);
  var n = nrm;
  if (u.coded > 0.5) { n.z = f32(i32(round(nrm.z * 127.0)) & 15) / 15.0; }
  o.n = n;
  return o;
}
@fragment fn fs_shadow(i: ShOut) -> @location(0) vec4f {
  return vec4f(abs(i.n.z) * (1.0 - smoothstep(0.2, 1.0, abs(i.n.w))));
}

@vertex fn vs_full(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_composite(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  return u.color * textureSample(tex, samp, fc.xy / u.res).r;
}

struct RectOut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) half_: vec2f,
  @location(2) @interpolate(flat) rs: vec2f,
  @location(3) @interpolate(flat) fill: vec4f,
  @location(4) @interpolate(flat) stroke: vec4f,
}
@vertex fn vs_rect(@builtin(vertex_index) vi: u32, @location(0) box_: vec4f, @location(1) misc: vec2f,
                   @location(2) fill: vec4f, @location(3) stroke: vec4f) -> RectOut {
  var o: RectOut;
  let q = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let h = box_.zw * 0.5 * u.zoom;
  let c = (box_.xy + box_.zw * 0.5) * u.zoom;
  let e = h + vec2f(1.5);
  let l = (q * 2.0 - 1.0) * e;
  o.pos = ndc(c + l);
  o.p = l;
  o.half_ = h;
  let sw = select(0.0, max(misc.y * u.zoom, 1.0), misc.y > 0.0);
  o.rs = vec2f(misc.x * u.zoom, sw);
  o.fill = fill;
  o.stroke = stroke;
  return o;
}
fn sd_box(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
@fragment fn fs_rect(i: RectOut) -> @location(0) vec4f {
  let r = min(i.rs.x, min(i.half_.x, i.half_.y));
  let d = sd_box(i.p, i.half_, r);
  let cov = clamp(0.5 - d, 0.0, 1.0);
  var col = i.fill * cov;
  if (i.rs.y > 0.0) {
    let inner = clamp(0.5 - (d + i.rs.y), 0.0, 1.0);
    let s = i.stroke * (cov * (1.0 - inner));
    col = s + col * (1.0 - s.a);
  }
  return col;
}

struct TextOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f }
@vertex fn vs_text(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) uv: vec4f,
                   @location(2) col: vec4f) -> TextOut {
  var o: TextOut;
  let q = vec2f(f32(vi & 1u), f32(vi >> 1u));
  o.pos = ndc((rect.xy + q * rect.zw) * u.zoom);
  o.uv = mix(uv.xy, uv.zw, q);
  o.col = col;
  return o;
}
@fragment fn fs_text(i: TextOut) -> @location(0) vec4f {
  return i.col * textureSample(tex, samp, i.uv).r;
}
