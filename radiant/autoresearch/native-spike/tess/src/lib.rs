//! Faithful port of the FLAT branch tessellation of radiant/src/lib/core/geometry/tessellate.ts
//! (tessellateBatch, as BranchMeshCache.build runs it with no previous batch, zoom = MESH_DETAIL_ZOOM = 4)
//! and of packMeshVertices (radiant/src/lib/render/mesh-vertices.ts). Floating-point operations are written in
//! the same order as the TypeScript so the output can be compared bit for bit.
//! Not ported: the relief path (reliefBatch: clay, arcs, rope, quilling) and the BranchMeshCache reuse of
//! unchanged branches (this always rebuilds every branch, as a cold build does).

use serde::Deserialize;
use std::f64::consts::PI;

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct V2 { pub x: f64, pub y: f64 }
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Rgba { pub r: f64, pub g: f64, pub b: f64, pub a: f64 }
#[derive(Deserialize)]
struct FadeJ { toward: Rgba, amount: f64 }
#[derive(Deserialize)]
struct TipJ { radius: f64, gap: f64 }

/// BranchSpec as JSON.stringify writes it (fields the flat path ignores are skipped).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecJson {
    p0: V2, p1: V2, w0: f64, w1: f64, color: Rgba, style: String, flow: String, seed: f64,
    underline_to: Option<V2>, underline_width: Option<f64>, underline_bend: Option<f64>,
    fade: Option<FadeJ>, round_caps: Option<String>, start_tangent: Option<V2>, tip_dot: Option<TipJ>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Style { Tapered, Organic, Line, Rounded, Angular }
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Flow { H, V, R }

#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub p0: V2, pub p1: V2, pub w0: f64, pub w1: f64, pub color: Rgba, pub style: Style, pub flow: Flow, pub seed: u32,
    pub underline_to: Option<V2>, pub underline_width: Option<f64>, pub underline_bend: f64,
    /// toward (r, g, b; its alpha is unused), amount
    pub fade: Option<(Rgba, f64)>,
    /// 0 none, 1 'start', 2 'both'
    pub round_caps: u8,
    pub start_tangent: Option<V2>,
    /// radius, gap
    pub tip_dot: Option<(f64, f64)>,
}

/// ToUint32 of a JS number.
fn to_u32(x: f64) -> u32 {
    if !x.is_finite() { return 0; }
    (x.trunc().rem_euclid(4294967296.0)) as u32
}

impl From<SpecJson> for Spec {
    fn from(j: SpecJson) -> Spec {
        Spec {
            p0: j.p0, p1: j.p1, w0: j.w0, w1: j.w1, color: j.color,
            style: match j.style.as_str() { "organic" => Style::Organic, "line" => Style::Line, "rounded" => Style::Rounded, "angular" => Style::Angular, _ => Style::Tapered },
            flow: match j.flow.as_str() { "v" => Flow::V, "r" => Flow::R, _ => Flow::H },
            seed: to_u32(j.seed),
            underline_to: j.underline_to, underline_width: j.underline_width, underline_bend: j.underline_bend.unwrap_or(0.0),
            fade: j.fade.map(|f| (f.toward, f.amount)),
            round_caps: match j.round_caps.as_deref() { Some("both") => 2, Some(_) => 1, None => 0 },
            start_tangent: j.start_tangent, tip_dot: j.tip_dot.map(|t| (t.radius, t.gap)),
        }
    }
}

pub fn parse_specs(json: &str) -> Vec<Spec> {
    let v: Vec<SpecJson> = serde_json::from_str(json).expect("specs json");
    v.into_iter().map(Spec::from).collect()
}

/// Flat f64 encoding of a spec (for a WASM / FFI boundary without JSON): FLAT_LEN numbers per spec.
pub const FLAT_LEN: usize = 32;
pub fn spec_from_flat(f: &[f64]) -> Spec {
    let opt = |h: f64, v: V2| if h != 0.0 { Some(v) } else { None };
    Spec {
        p0: V2 { x: f[0], y: f[1] }, p1: V2 { x: f[2], y: f[3] }, w0: f[4], w1: f[5],
        color: Rgba { r: f[6], g: f[7], b: f[8], a: f[9] },
        style: match f[10] as u32 { 1 => Style::Organic, 2 => Style::Line, 3 => Style::Rounded, 4 => Style::Angular, _ => Style::Tapered },
        flow: match f[11] as u32 { 1 => Flow::V, 2 => Flow::R, _ => Flow::H },
        seed: to_u32(f[12]),
        underline_to: opt(f[13], V2 { x: f[14], y: f[15] }),
        underline_width: if f[16] != 0.0 { Some(f[17]) } else { None },
        underline_bend: f[18],
        fade: if f[19] != 0.0 { Some((Rgba { r: f[20], g: f[21], b: f[22], a: 1.0 }, f[23])) } else { None },
        round_caps: f[24] as u8,
        start_tangent: opt(f[25], V2 { x: f[26], y: f[27] }),
        tip_dot: if f[28] != 0.0 { Some((f[29], f[30])) } else { None },
    }
}

// ------------------------------------------------------------------ JS Math semantics

/// Math.round (V8: ceil, minus one when that went more than half up).
#[inline]
pub fn js_round(x: f64) -> f64 {
    let r = x.ceil();
    if r - 0.5 > x { r - 1.0 } else { r }
}
/// Math.sign (0 stays 0, unlike f64::signum).
#[inline]
fn js_sign(x: f64) -> f64 { if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { x } }
/// Math.hypot of two numbers as V8 computes it (scale by the max, Kahan sum).
#[inline]
pub fn js_hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_infinite() || b.is_infinite() { return f64::INFINITY; }
    if a.is_nan() || b.is_nan() { return f64::NAN; }
    let max = if a > b { a } else { b };
    if max == 0.0 { return 0.0; }
    let mut sum = 0.0f64;
    let mut comp = 0.0f64;
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - comp;
        let prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    sum.sqrt() * max
}
#[inline]
fn jmax(a: f64, b: f64) -> f64 { if a > b { a } else { b } }
#[inline]
fn jmin(a: f64, b: f64) -> f64 { if a < b { a } else { b } }

// ------------------------------------------------------------------ constants and tables

const CAP_STEPS: u32 = 4;
const CAP_VERTS: u32 = CAP_STEPS + 2;
const CAP_INDICES: u32 = CAP_STEPS * 3;
const MAX_CHORD_ERROR: f64 = 0.25;
const MAX_SEGMENTS: f64 = 96.0;
pub const MESH_DETAIL_ZOOM: f64 = 4.0;
const SAMPLES: [f64; 9] = [0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0];
const SAMPLE_MARGIN: f64 = 1.25;

/// arc(steps, turn): cos/sin of turn * k / steps for k = 0..=steps.
fn arc(steps: u32, turn: f64) -> Vec<(f64, f64)> {
    (0..=steps).map(|k| { let angle = turn * k as f64 / steps as f64; (angle.cos(), angle.sin()) }).collect()
}
struct Arcs { half: Vec<Vec<(f64, f64)>>, full: Vec<Vec<(f64, f64)>> }
fn arcs() -> &'static Arcs {
    static A: std::sync::OnceLock<Arcs> = std::sync::OnceLock::new();
    A.get_or_init(|| Arcs {
        half: (0..=16).map(|s| if s == 0 { vec![] } else { arc(s, PI) }).collect(),
        full: (0..=32).map(|s| if s == 0 { vec![] } else { arc(s, 2.0 * PI) }).collect(),
    })
}

fn arc_steps(turn: f64, radius: f64, zoom: f64, min: u32, max: u32) -> u32 {
    let e = MAX_CHORD_ERROR / (zoom * jmax(radius, 1e-6));
    let steps = if e >= 1.0 { 1.0 } else { (turn / (2.0 * (1.0 - e).acos())).ceil() };
    if steps < min as f64 { min } else if steps > max as f64 { max } else { steps as u32 }
}

/// mulberry32, as rng() in tessellate.ts.
struct Rng(u32);
impl Rng {
    #[inline]
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Curve { x1: f64, y1: f64, x2: f64, y2: f64, phase: f64, freq: f64, amp: f64 }

fn curve_of(s: &Spec) -> Curve {
    let (x0, y0, x3, y3) = (s.p0.x, s.p0.y, s.p1.x, s.p1.y);
    let dx = x3 - x0;
    let dy = y3 - y0;
    let chord = (dx * dx + dy * dy).sqrt();
    let (mut x1, mut y1, x2, y2);
    match s.flow {
        Flow::H => {
            let sg = if dx >= 0.0 { 1.0 } else { -1.0 };
            let k = jmax(0.5 * dx.abs(), 6.0);
            x1 = x0 + sg * k; y1 = y0; x2 = x3 - sg * k; y2 = y3;
            if let Some(st) = s.start_tangent { x1 = x0 + st.x * k; y1 = y0 + st.y * k; }
        }
        Flow::V => {
            let sg = if dy >= 0.0 { 1.0 } else { -1.0 };
            let k = jmax(0.5 * dy.abs(), 6.0);
            x1 = x0; y1 = y0 + sg * k; x2 = x3; y2 = y3 - sg * k;
            if let Some(st) = s.start_tangent { x1 = x0 + st.x * k; y1 = y0 + st.y * k; }
        }
        Flow::R => {
            x1 = x0 + dx / 3.0; y1 = y0 + dy / 3.0; x2 = x0 + (2.0 * dx) / 3.0; y2 = y0 + (2.0 * dy) / 3.0;
        }
    }
    let (mut x2, mut y2) = (x2, y2);
    let (mut phase, mut freq, mut amp) = (0.0, 0.0, 0.0);
    if s.style == Style::Organic {
        let mut rand = Rng(s.seed);
        let inv = if chord > 1e-6 { 1.0 / chord } else { 0.0 };
        let nx = -dy * inv;
        let ny = dx * inv;
        let max_amp = jmin(0.1 * chord, 22.0);
        let o1 = (rand.next() * 2.0 - 1.0) * max_amp;
        let o2 = (rand.next() * 2.0 - 1.0) * max_amp;
        x1 += nx * o1; y1 += ny * o1; x2 += nx * o2; y2 += ny * o2;
        phase = rand.next() * PI * 2.0;
        freq = 1.2 + rand.next() * 1.6;
        amp = 0.14;
    }
    Curve { x1, y1, x2, y2, phase, freq, amp }
}

fn segment_count(s: &Spec, lod: f64, zoom: f64, c: &Curve) -> u32 {
    let (x0, y0, x3, y3) = (s.p0.x, s.p0.y, s.p1.x, s.p1.y);
    let dx = x3 - x0;
    let dy = y3 - y0;
    let chord = (dx * dx + dy * dy).sqrt();
    if s.style == Style::Angular { return if dx.abs() > 1e-6 && dy.abs() > 1e-6 { 3 } else { 1 }; }
    if s.style == Style::Line || (s.flow == Flow::R && s.style != Style::Organic) { return 1; }
    let mut n = js_round((4.0 + chord * 0.045) * lod);
    let ax = x0 - 2.0 * c.x1 + c.x2;
    let ay = y0 - 2.0 * c.y1 + c.y2;
    let bx = c.x1 - 2.0 * c.x2 + x3;
    let by = c.y1 - 2.0 * c.y2 + y3;
    let half_width = 0.5 * jmax(s.w0, s.w1) * (1.0 + c.amp);
    let mut error = 0.0f64;
    for t in SAMPLES {
        let u = 1.0 - t;
        let tx = 3.0 * (u * u * (c.x1 - x0) + 2.0 * u * t * (c.x2 - c.x1) + t * t * (x3 - c.x2));
        let ty = 3.0 * (u * u * (c.y1 - y0) + 2.0 * u * t * (c.y2 - c.y1) + t * t * (y3 - c.y2));
        let speed = (tx * tx + ty * ty).sqrt();
        if speed < 1e-6 { continue; }
        let normal = (tx * 6.0 * (u * ay + t * by) - ty * 6.0 * (u * ax + t * bx)).abs() / speed;
        error = jmax(error, normal * (1.0 + jmin(4.0, half_width * normal / (speed * speed))));
    }
    if error > 0.0 { n = jmax(n, (SAMPLE_MARGIN * zoom * error / (8.0 * MAX_CHORD_ERROR)).sqrt().ceil()); }
    if n < 3.0 { 3 } else if n > MAX_SEGMENTS { MAX_SEGMENTS as u32 } else { n as u32 }
}

fn underline_steps(s: &Spec) -> u32 {
    match s.underline_to {
        Some(to) if s.underline_bend != 0.0 => {
            let v = ((to.x - s.p1.x).abs() / 12.0).ceil();
            jmax(6.0, jmin(18.0, v)) as u32
        }
        _ => 1,
    }
}
#[inline]
fn underline_offset(t: f64, rise: f64) -> f64 { ((2.0 * PI * t).cos() - 1.0) * rise / 2.0 }
#[inline]
fn underline_slope(t: f64, rise: f64) -> f64 { -PI * rise * (2.0 * PI * t).sin() }

pub fn branch_end_color(s: &Spec) -> Rgba {
    let c = s.color;
    match s.fade {
        None => c,
        Some((to, amount)) => {
            let f = if amount < 0.0 { 0.0 } else if amount > 1.0 { 1.0 } else { amount };
            Rgba { r: c.r + (to.r * c.a - c.r) * f, g: c.g + (to.g * c.a - c.g) * f, b: c.b + (to.b * c.a - c.b) * f, a: c.a }
        }
    }
}

fn tip_dot_center(s: &Spec) -> Option<(f64, f64)> {
    let (radius, gap) = s.tip_dot?;
    let end = match s.underline_to { None => return Some((s.p1.x, s.p1.y)), Some(e) => e };
    let dx = end.x - s.p1.x;
    let dy = end.y - s.p1.y;
    let length = js_hypot(dx, dy);
    let ux = if length > 1e-9 { dx / length } else if s.p1.x >= s.p0.x { 1.0 } else { -1.0 };
    let uy = if length > 1e-9 { dy / length } else { 0.0 };
    Some((end.x + ux * (gap + radius), end.y + uy * (gap + radius)))
}

// ------------------------------------------------------------------ plan (first pass) and emit (second pass)

#[derive(Clone, Copy, Default, Debug)]
pub struct Plan { pub n: u32, pub fans: [u32; 3], pub nv: u32, pub ni: u32, pub curve: Curve }

#[inline]
pub fn lod_of(zoom: f64) -> f64 { if zoom < 0.12 { 0.35 } else if zoom < 0.3 { 0.55 } else if zoom < 0.6 { 0.8 } else { 1.0 } }

pub fn plan(s: &Spec, lod: f64, zoom: f64) -> Plan {
    let curve = curve_of(s);
    let n = segment_count(s, lod, zoom, &curve);
    let mut nv = 2 * (n + 1) + CAP_VERTS;
    let mut ni = n * 6 + CAP_INDICES;
    let mut fans = [0u32; 3];
    if s.round_caps != 0 {
        let start = arc_steps(PI, s.w0 * 0.5, zoom, CAP_STEPS, 16);
        fans[0] = start;
        nv += start - CAP_STEPS;
        ni += (start - CAP_STEPS) * 3;
        if s.round_caps == 2 {
            let w = if s.underline_to.is_some() { s.underline_width.unwrap_or(s.w1) } else { s.w1 };
            let end = arc_steps(PI, w * 0.5, zoom, CAP_STEPS, 16);
            fans[1] = end;
            nv += end + 2;
            ni += end * 3;
        }
    }
    if let Some((radius, _)) = s.tip_dot {
        let dot = arc_steps(2.0 * PI, radius, zoom, 8, 32);
        fans[2] = dot;
        nv += dot + 1;
        ni += dot * 3;
    }
    if s.underline_to.is_some() {
        let steps = underline_steps(s);
        nv += 2 * (steps + 1);
        ni += steps * 6;
    }
    Plan { n, fans, nv, ni, curve }
}

/// Output slices for a run of branches; vp/ip are local cursors, vbase the global index of local vertex 0.
pub struct Sink<'a> {
    pub pos: &'a mut [f64],
    pub col: &'a mut [f32],
    pub idx: &'a mut [u32],
    pub vp: usize,
    pub ip: usize,
    pub vbase: u32,
}
impl<'a> Sink<'a> {
    #[inline(always)]
    fn vert(&mut self, x: f64, y: f64, c: [f32; 4]) {
        let o = self.vp * 2;
        self.pos[o] = x;
        self.pos[o + 1] = y;
        self.col[self.vp * 4..self.vp * 4 + 4].copy_from_slice(&c);
        self.vp += 1;
    }
    #[inline(always)]
    fn tri(&mut self, a: usize, b: usize, c: usize) {
        let base = self.vbase as usize;
        self.idx[self.ip] = (base + a) as u32;
        self.idx[self.ip + 1] = (base + b) as u32;
        self.idx[self.ip + 2] = (base + c) as u32;
        self.ip += 3;
    }
    #[inline(always)]
    fn strip(&mut self, first: usize, n: usize) {
        for j in 0..n {
            let q = first + j * 2;
            self.tri(q, q + 1, q + 2);
            self.tri(q + 1, q + 3, q + 2);
        }
    }
    /// Half-disk around (cx, cy) from +normal through the unit direction (bx, by) to -normal.
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn cap(&mut self, cx: f64, cy: f64, nx: f64, ny: f64, bx: f64, by: f64, radius: f64, c: [f32; 4], steps: u32) {
        let arc = &arcs().half[steps as usize];
        let first = self.vp;
        self.vert(cx, cy, c);
        for k in 0..=steps as usize {
            let co = arc[k].0 * radius;
            let sn = arc[k].1 * radius;
            self.vert(cx + co * nx + sn * bx, cy + co * ny + sn * by, c);
        }
        for k in 0..steps as usize { self.tri(first, first + 1 + k, first + 2 + k); }
    }
}

#[inline(always)]
fn c32(r: f64, g: f64, b: f64, a: f64) -> [f32; 4] { [r as f32, g as f32, b as f32, a as f32] }

/// Second pass of tessellateBatch for one branch. Returns its bounds [minX, minY, maxX, maxY].
pub fn emit(s: &Spec, p: &Plan, k: &mut Sink) -> [f64; 4] {
    let n = p.n as usize;
    let Rgba { r, g, b, a } = s.color;
    let end = branch_end_color(s);
    let fade = s.fade.is_some();
    let (x0, y0, x3, y3) = (s.p0.x, s.p0.y, s.p1.x, s.p1.y);
    let dx = x3 - x0;
    let dy = y3 - y0;
    let c = &p.curve;
    let (x1, y1, x2, y2) = (c.x1, c.y1, c.x2, c.y2);
    let organic = s.style == Style::Organic;
    let elbow: Option<[[f64; 2]; 4]> = if s.style == Style::Angular && n == 3 {
        Some(if s.flow == Flow::V {
            [[x0, y0], [x0, (y0 + y3) / 2.0], [x3, (y0 + y3) / 2.0], [x3, y3]]
        } else {
            [[x0, y0], [(x0 + x3) / 2.0, y0], [(x0 + x3) / 2.0, y3], [x3, y3]]
        })
    } else { None };
    let ax = x1 - x0;
    let ay = y1 - y0;
    let bx = x2 - x1;
    let by = y2 - y1;
    let cx = x3 - x2;
    let cy = y3 - y2;
    let base = k.vp;
    let mut last_tx = dx;
    let mut last_ty = dy;
    let mut t0x = 1.0;
    let mut t0y = 0.0;
    let base_color = c32(r, g, b, a);
    for j in 0..=n {
        let t = j as f64 / n as f64;
        let u = 1.0 - t;
        let uu = u * u;
        let tt = t * t;
        let mut px = uu * u * x0 + 3.0 * uu * t * x1 + 3.0 * u * tt * x2 + tt * t * x3;
        let mut py = uu * u * y0 + 3.0 * uu * t * y1 + 3.0 * u * tt * y2 + tt * t * y3;
        let mut tx = 3.0 * (uu * ax + 2.0 * u * t * bx + tt * cx);
        let mut ty = 3.0 * (uu * ay + 2.0 * u * t * by + tt * cy);
        if n == 1 { tx = dx; ty = dy; }
        let mut join = 1.0;
        if let Some(e) = elbow {
            px = e[j][0];
            py = e[j][1];
            let pa = e[j.saturating_sub(1)];
            let pb = e[(j + 1).min(n)];
            tx = js_sign(px - pa[0]) + js_sign(pb[0] - px);
            ty = js_sign(py - pa[1]) + js_sign(pb[1] - py);
            if j > 0 && j < n { join = std::f64::consts::SQRT_2; }
        }
        let mut tl = (tx * tx + ty * ty).sqrt();
        if tl < 1e-6 {
            tx = last_tx;
            ty = last_ty;
            tl = (tx * tx + ty * ty).sqrt();
            if tl < 1e-6 { tx = 1.0; ty = 0.0; tl = 1.0; }
        }
        tx /= tl;
        ty /= tl;
        last_tx = tx;
        last_ty = ty;
        if j == 0 { t0x = tx; t0y = ty; }
        let mut w = s.w0 + (s.w1 - s.w0) * t;
        if organic { w *= 1.0 + c.amp * (PI * t).sin() * (c.freq * 2.0 * PI * t + c.phase).sin(); }
        let hw = w * 0.5 * join;
        let nx = -ty * hw;
        let ny = tx * hw;
        let col = if fade {
            c32(r + (end.r - r) * t, g + (end.g - g) * t, b + (end.b - b) * t, a)
        } else { base_color };
        k.vert(px + nx, py + ny, col);
        k.vert(px - nx, py - ny, col);
    }
    k.strip(base, n);
    let (end_tx, end_ty) = (last_tx, last_ty);
    let end_color = c32(end.r, end.g, end.b, end.a);
    let start_steps = if s.round_caps != 0 { p.fans[0] } else { CAP_STEPS };
    k.cap(x0, y0, -t0y, t0x, -t0x, -t0y, s.w0 * 0.5, base_color, start_steps);

    if let Some(to) = s.underline_to {
        let ux = to.x - x3;
        let uy = to.y - y3;
        let rise = s.underline_bend;
        let steps = underline_steps(s) as usize;
        let hw = s.underline_width.unwrap_or(s.w1) * 0.5;
        let q = k.vp;
        let has_rise = rise != 0.0 && !rise.is_nan();
        for j in 0..=steps {
            let t = j as f64 / steps as f64;
            let x = x3 + ux * t;
            let y = y3 + uy * t + (if has_rise { underline_offset(t, rise) } else { 0.0 });
            let dy_bar = uy + (if has_rise { underline_slope(t, rise) } else { 0.0 });
            let len = js_hypot(ux, dy_bar);
            let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
            let nx = -dy_bar * hw / len;
            let ny = ux * hw / len;
            k.vert(x + nx, y + ny, end_color);
            k.vert(x - nx, y - ny, end_color);
        }
        k.strip(q, steps);
    }
    if s.round_caps == 2 {
        let (mut ex, mut ey, mut tx, mut ty, mut radius) = (x3, y3, end_tx, end_ty, s.w1 * 0.5);
        if let Some(to) = s.underline_to {
            let ux = to.x - x3;
            let uy = to.y - y3;
            let length = js_hypot(ux, uy);
            ex = to.x;
            ey = to.y;
            radius = s.underline_width.unwrap_or(s.w1) * 0.5;
            if length > 1e-9 { tx = ux / length; ty = uy / length; }
        }
        k.cap(ex, ey, -ty, tx, tx, ty, radius, end_color, p.fans[1]);
    }
    if let Some((dxc, dyc)) = tip_dot_center(s) {
        let radius = s.tip_dot.unwrap().0;
        let steps = p.fans[2] as usize;
        let disk = &arcs().full[steps];
        let first = k.vp;
        k.vert(dxc, dyc, end_color);
        for kk in 0..steps { k.vert(dxc + disk[kk].0 * radius, dyc + disk[kk].1 * radius, end_color); }
        for kk in 0..steps { k.tri(first, first + 1 + kk, first + 1 + (kk + 1) % steps); }
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for v in base..k.vp {
        let x = k.pos[v * 2];
        let y = k.pos[v * 2 + 1];
        min_x = jmin(min_x, x);
        min_y = jmin(min_y, y);
        max_x = jmax(max_x, x);
        max_y = jmax(max_y, y);
    }
    [min_x, min_y, max_x, max_y]
}

#[derive(Default)]
pub struct Mesh {
    pub positions: Vec<f64>,
    pub colors: Vec<f32>,
    pub indices: Vec<u32>,
    pub bounds: Vec<f64>,
    pub ends: Vec<u32>,
}

/// Single-threaded tessellateBatch: plan every branch, allocate once, emit in order.
pub fn tessellate(specs: &[Spec], zoom: f64) -> Mesh {
    let lod = lod_of(zoom);
    let plans: Vec<Plan> = specs.iter().map(|s| plan(s, lod, zoom)).collect();
    let (nv, ni) = plans.iter().fold((0usize, 0usize), |(v, i), p| (v + p.nv as usize, i + p.ni as usize));
    let mut m = Mesh {
        positions: vec![0.0; nv * 2], colors: vec![0.0; nv * 4], indices: vec![0; ni],
        bounds: vec![0.0; specs.len() * 4], ends: vec![0; specs.len()],
    };
    fill(specs, &plans, &mut m);
    m
}

/// Emit every branch into buffers already sized for these plans (single thread).
pub fn fill(specs: &[Spec], plans: &[Plan], m: &mut Mesh) {
    let mut k = Sink { pos: &mut m.positions, col: &mut m.colors, idx: &mut m.indices, vp: 0, ip: 0, vbase: 0 };
    for (i, (s, p)) in specs.iter().zip(plans).enumerate() {
        let b = emit(s, p, &mut k);
        m.bounds[i * 4..i * 4 + 4].copy_from_slice(&b);
        m.ends[i] = k.ip as u32;
    }
}

/// Packed GPU vertices as packMeshVertices writes them.
pub struct Packed { pub buffer: Vec<u8>, pub ox: f64, pub oy: f64, pub wide: bool }

#[inline]
fn unorm8(c: f32) -> u8 {
    let v = js_round(c as f64 * 255.0);
    (if v < 0.0 { 0.0 } else if v > 255.0 { 255.0 } else { v }) as u8
}

fn bbox(p: &[f64]) -> [f64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for v in p.chunks_exact(2) {
        let (x, y) = (v[0], v[1]);
        if x < x0 { x0 = x; }
        if x > x1 { x1 = x; }
        if y < y0 { y0 = y; }
        if y > y1 { y1 = y; }
    }
    [x0, y0, x1, y1]
}

#[inline(always)]
fn pack_into(out: &mut [u8], pos: &[f64], col: &[f32], ox: f64, oy: f64, wide: bool) {
    let stride = if wide { 20 } else { 12 };
    for ((o, p), c) in out.chunks_exact_mut(stride).zip(pos.chunks_exact(2)).zip(col.chunks_exact(4)) {
        let x = p[0] - ox;
        let y = p[1] - oy;
        let fx = x as f32;
        let fy = y as f32;
        o[0..4].copy_from_slice(&fx.to_le_bytes());
        o[4..8].copy_from_slice(&fy.to_le_bytes());
        o[8] = unorm8(c[0]);
        o[9] = unorm8(c[1]);
        o[10] = unorm8(c[2]);
        o[11] = unorm8(c[3]);
        if wide {
            o[12..16].copy_from_slice(&((x - fx as f64) as f32).to_le_bytes());
            o[16..20].copy_from_slice(&((y - fy as f64) as f32).to_le_bytes());
        }
    }
}

pub fn pack(m: &Mesh) -> Packed {
    let nv = m.positions.len() / 2;
    let [x0, y0, x1, y1] = bbox(&m.positions);
    let ox = (x0 + x1) / 2.0;
    let oy = (y0 + y1) / 2.0;
    let wide = jmax(x1 - x0, y1 - y0) > 65536.0;
    let stride = if wide { 20 } else { 12 };
    let mut buffer = vec![0u8; nv * stride];
    pack_into(&mut buffer, &m.positions, &m.colors, ox, oy, wide);
    Packed { buffer, ox, oy, wide }
}

// ------------------------------------------------------------------ rayon variants

#[cfg(not(target_arch = "wasm32"))]
pub mod par {
    use super::*;
    use rayon::prelude::*;

    /// Plans in parallel, prefix sums per chunk of branches, then every chunk emits in parallel straight into its
    /// disjoint slice of one preallocated mesh.
    pub fn tessellate_prefix(specs: &[Spec], zoom: f64, chunk: usize) -> Mesh {
        let lod = lod_of(zoom);
        let plans: Vec<Plan> = specs.par_iter().with_min_len(chunk).map(|s| plan(s, lod, zoom)).collect();
        let sums: Vec<(usize, usize)> = plans.par_chunks(chunk)
            .map(|c| c.iter().fold((0, 0), |(v, i), p| (v + p.nv as usize, i + p.ni as usize))).collect();
        let (nv, ni) = sums.iter().fold((0, 0), |(v, i), s| (v + s.0, i + s.1));
        let mut m = Mesh {
            positions: vec![0.0; nv * 2], colors: vec![0.0; nv * 4], indices: vec![0; ni],
            bounds: vec![0.0; specs.len() * 4], ends: vec![0; specs.len()],
        };
        let mut pieces = Vec::with_capacity(sums.len());
        {
            let (mut pos, mut col, mut idx) = (&mut m.positions[..], &mut m.colors[..], &mut m.indices[..]);
            let (mut bnd, mut ends) = (&mut m.bounds[..], &mut m.ends[..]);
            let (mut v0, mut i0) = (0usize, 0usize);
            for (ci, &(cv, cn)) in sums.iter().enumerate() {
                let nb = chunk.min(specs.len() - ci * chunk);
                let (a, r) = pos.split_at_mut(cv * 2); pos = r;
                let (b, r) = col.split_at_mut(cv * 4); col = r;
                let (c, r) = idx.split_at_mut(cn); idx = r;
                let (d, r) = bnd.split_at_mut(nb * 4); bnd = r;
                let (e, r) = ends.split_at_mut(nb); ends = r;
                pieces.push((ci, v0, i0, a, b, c, d, e));
                v0 += cv;
                i0 += cn;
            }
        }
        pieces.into_par_iter().for_each(|(ci, v0, i0, pos, col, idx, bnd, ends)| {
            let mut k = Sink { pos, col, idx, vp: 0, ip: 0, vbase: v0 as u32 };
            let start = ci * chunk;
            for (l, i) in (start..(start + ends.len())).enumerate() {
                let b = emit(&specs[i], &plans[i], &mut k);
                bnd[l * 4..l * 4 + 4].copy_from_slice(&b);
                ends[l] = (i0 + k.ip) as u32;
            }
        });
        m
    }

    /// Each chunk of branches builds its own small mesh (local indices) in parallel; then they are concatenated
    /// in order, with the vertex offset added to the indices.
    pub fn tessellate_concat(specs: &[Spec], zoom: f64, chunk: usize) -> Mesh {
        let parts: Vec<Mesh> = specs.par_chunks(chunk).map(|c| tessellate(c, zoom)).collect();
        let nv: usize = parts.iter().map(|p| p.positions.len() / 2).sum();
        let ni: usize = parts.iter().map(|p| p.indices.len()).sum();
        let mut m = Mesh {
            positions: Vec::with_capacity(nv * 2), colors: Vec::with_capacity(nv * 4), indices: Vec::with_capacity(ni),
            bounds: Vec::with_capacity(specs.len() * 4), ends: Vec::with_capacity(specs.len()),
        };
        for p in parts {
            let v0 = (m.positions.len() / 2) as u32;
            let i0 = m.indices.len() as u32;
            m.positions.extend_from_slice(&p.positions);
            m.colors.extend_from_slice(&p.colors);
            m.indices.extend(p.indices.iter().map(|&x| x + v0));
            m.bounds.extend_from_slice(&p.bounds);
            m.ends.extend(p.ends.iter().map(|&x| x + i0));
        }
        m
    }

    /// packMeshVertices with a parallel bounding box and parallel packing.
    pub fn pack_par(m: &Mesh, chunk: usize) -> Packed {
        let nv = m.positions.len() / 2;
        let [x0, y0, x1, y1] = m.positions.par_chunks(chunk * 2).map(bbox)
            .reduce(|| [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
                |a, b| [jmin(a[0], b[0]), jmin(a[1], b[1]), jmax(a[2], b[2]), jmax(a[3], b[3])]);
        let ox = (x0 + x1) / 2.0;
        let oy = (y0 + y1) / 2.0;
        let wide = jmax(x1 - x0, y1 - y0) > 65536.0;
        let stride = if wide { 20 } else { 12 };
        let mut buffer = vec![0u8; nv * stride];
        buffer.par_chunks_mut(chunk * stride)
            .zip(m.positions.par_chunks(chunk * 2))
            .zip(m.colors.par_chunks(chunk * 4))
            .for_each(|((o, p), c)| pack_into(o, p, c, ox, oy, wide));
        Packed { buffer, ox, oy, wide }
    }
}

// ------------------------------------------------------------------ wasm32 entry points (no wasm-bindgen)

#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use super::*;
    static mut OUT: Option<(Mesh, Packed)> = None;

    #[no_mangle]
    pub extern "C" fn alloc_f64(n: usize) -> *mut f64 {
        let mut v = vec![0.0f64; n];
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }
    /// Tessellate count flat-encoded specs at ptr, then pack when asked; returns the vertex count.
    #[allow(static_mut_refs)]
    #[no_mangle]
    pub extern "C" fn tess(ptr: *const f64, count: usize, do_pack: u32) -> usize {
        unsafe { OUT = None; }
        let f = unsafe { std::slice::from_raw_parts(ptr, count * FLAT_LEN) };
        let specs: Vec<Spec> = f.chunks_exact(FLAT_LEN).map(spec_from_flat).collect();
        let m = tessellate(&specs, MESH_DETAIL_ZOOM);
        let p = if do_pack != 0 { pack(&m) } else { Packed { buffer: vec![], ox: 0.0, oy: 0.0, wide: false } };
        let nv = m.positions.len() / 2;
        unsafe { OUT = Some((m, p)); }
        nv
    }
    #[allow(static_mut_refs)]
    #[no_mangle]
    pub extern "C" fn out_indices_len() -> usize { unsafe { OUT.as_ref().map_or(0, |o| o.0.indices.len()) } }
    #[allow(static_mut_refs)]
    #[no_mangle]
    pub extern "C" fn out_packed_ptr() -> *const u8 { unsafe { OUT.as_ref().map_or(std::ptr::null(), |o| o.1.buffer.as_ptr()) } }
    #[allow(static_mut_refs)]
    #[no_mangle]
    pub extern "C" fn out_packed_len() -> usize { unsafe { OUT.as_ref().map_or(0, |o| o.1.buffer.len()) } }
}
