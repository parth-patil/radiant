//! Native rendering spike for Radiant: draws a scene exported from the WebGL renderer (branch mesh, node rects,
//! labels) with wgpu + winit, drives a scripted camera path and records per-frame timings.
//! Not part of the app. See radiant/autoresearch/research/04-native-rendering.md.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cosmic_text::{Attrs, Buffer, CacheKey, Family, FontSystem, LayoutGlyph, Metrics, Shaping, SwashCache, SwashContent, Weight};
use serde::Deserialize;
use wgpu::util::DeviceExt;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

// ------------------------------------------------------------------ scene files

#[derive(Deserialize, Clone, Copy, Default)]
struct Rgba { r: f32, g: f32, b: f32, a: f32 }

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct ReliefHdr { material: String, maxWidth: f32, shadowReach: f32, shadowColor: Rgba, hasShadow: bool, hasTwist: bool }

#[derive(Deserialize)]
struct MeshHdr { nv: usize, ni: usize, stride: usize, ox: f64, oy: f64, wide: bool, spans: usize, relief: Option<ReliefHdr> }

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct RectJ { x: f64, y: f64, w: f64, h: f64, radius: f32, fill: Rgba, stroke: Option<Rgba>, strokeWidth: Option<f32>, overBranches: Option<bool> }

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct LabelJ { text: String, x: f64, y: f64, fontSize: f32, bold: bool, italic: bool, color: Rgba, maxWidth: f32, align: String, opacity: Option<f32> }

#[derive(Deserialize)]
struct SceneJ { background: Rgba, mesh: MeshHdr, rects: Vec<RectJ>, labels: Vec<LabelJ> }

#[derive(Deserialize, Clone, Copy)]
struct Cam { cx: f64, cy: f64, zoom: f64 }

struct Scene {
  j: SceneJ,
  vtx: Vec<u8>,
  idx: Vec<u32>,
  span_bounds: Vec<f64>,
  span_ends: Vec<u32>,
}

fn read_vec<T: bytemuck::Pod + Default + Clone>(path: &str) -> Vec<T> {
  let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
  let n = bytes.len() / std::mem::size_of::<T>();
  let mut v = vec![T::default(); n];
  bytemuck::cast_slice_mut::<T, u8>(&mut v).copy_from_slice(&bytes[..n * std::mem::size_of::<T>()]);
  v
}

// ------------------------------------------------------------------ GPU data layouts

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms { view: [f32; 2], zoom: f32, far: f32, off: [f32; 2], off_low: [f32; 2], mat: [f32; 4], color: [f32; 4], res: [f32; 2], coded: f32, pad: f32 }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct RectInst { bx: [f32; 4], misc: [f32; 2], fill: [f32; 4], stroke: [f32; 4] }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct TextInst { rect: [f32; 4], uv: [f32; 4], col: [f32; 4] }

fn premul(c: Rgba, k: f32) -> [f32; 4] { [c.r * k, c.g * k, c.b * k, c.a * k] }

// ------------------------------------------------------------------ text: shaped labels + glyph atlas in zoom buckets

const ATLAS: u32 = 4096;
const BUCKET_STEP: f64 = 0.5; // powers of sqrt(2), as LabelAtlas
const GREEK_PX: f64 = 4.0;
const LINE_HEIGHT: f32 = 1.25;

struct Shaped { glyphs: Vec<(LayoutGlyph, f32, f32)>, w: f32, h: f32 } // glyph, line_y, line x shift

#[derive(Clone, Copy)]
struct Slot { u0: f32, v0: f32, u1: f32, v1: f32, left: i32, top: i32, w: u32, h: u32 }

#[derive(Clone, Copy)]
struct Quad { ox: f32, oy: f32, w: f32, h: f32, uv: [f32; 4] }

struct Text {
  fs: FontSystem,
  swash: SwashCache,
  family: String,
  shaped: Vec<Option<Shaped>>,
  quads: HashMap<(u32, i32), Vec<Quad>>,
  slots: HashMap<CacheKey, Option<Slot>>,
  pixels: Vec<u8>,
  shelf_x: u32, shelf_y: u32, shelf_h: u32,
  dirty: Option<(u32, u32)>, // row range to upload
  resets: u32,
  rasterised: u64,
}

impl Text {
  fn new(n: usize) -> Self {
    let fs = FontSystem::new();
    // -apple-system resolves to San Francisco; fontdb lists it under one of these names.
    let names: Vec<String> = fs.db().faces().flat_map(|f| f.families.iter().map(|(n, _)| n.clone())).collect();
    let family = ["SF Pro", "SF Pro Text", "System Font", ".SF NS", "Helvetica Neue", "Helvetica"].iter()
      .find(|c| names.iter().any(|n| n == **c)).map(|s| s.to_string()).unwrap_or_else(|| "sans-serif".into());
    Text { fs, swash: SwashCache::new(), family, shaped: (0..n).map(|_| None).collect(), quads: HashMap::new(), slots: HashMap::new(),
      pixels: vec![0; (ATLAS * ATLAS) as usize], shelf_x: 0, shelf_y: 0, shelf_h: 0, dirty: None, resets: 0, rasterised: 0 }
  }

  fn shape(&mut self, i: usize, l: &LabelJ) {
    let fam = self.family.clone();
    let mut attrs = Attrs::new().family(if fam == "sans-serif" { Family::SansSerif } else { Family::Name(&fam) });
    if l.bold { attrs = attrs.weight(Weight::BOLD); }
    if l.italic { attrs = attrs.style(cosmic_text::Style::Italic); }
    let lh = l.fontSize * LINE_HEIGHT;
    let mut b = Buffer::new(&mut self.fs, Metrics::new(l.fontSize, lh));
    let wrap = if l.maxWidth.is_finite() && l.maxWidth > 0.0 { Some(l.maxWidth) } else { None };
    b.set_size(wrap, None);
    b.set_text(&l.text, &attrs, Shaping::Advanced, None);
    b.shape_until_scroll(&mut self.fs, false);
    let mut w: f32 = 0.0;
    let mut lines = 0;
    for run in b.layout_runs() { w = w.max(run.line_w); lines += 1; }
    let h = lines as f32 * lh;
    let k = match l.align.as_str() { "left" => 0.0, "right" => 1.0, _ => 0.5 };
    let mut glyphs = Vec::new();
    for run in b.layout_runs() {
      let shift = (w - run.line_w) * k - w * 0.5;
      for g in run.glyphs { glyphs.push((g.clone(), run.line_y - h * 0.5, shift)); }
    }
    self.shaped[i] = Some(Shaped { glyphs, w, h });
  }

  fn alloc(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
    if w + 2 > ATLAS || h + 2 > ATLAS { return None; }
    if self.shelf_x + w + 2 > ATLAS { self.shelf_y += self.shelf_h; self.shelf_x = 0; self.shelf_h = 0; }
    if self.shelf_y + h + 2 > ATLAS { return None; }
    let at = (self.shelf_x + 1, self.shelf_y + 1);
    self.shelf_x += w + 2;
    self.shelf_h = self.shelf_h.max(h + 2);
    Some(at)
  }

  fn reset(&mut self) {
    self.slots.clear(); self.quads.clear(); self.pixels.fill(0);
    self.shelf_x = 0; self.shelf_y = 0; self.shelf_h = 0; self.dirty = Some((0, ATLAS)); self.resets += 1;
  }

  fn glyph(&mut self, key: CacheKey) -> Option<Slot> {
    if let Some(s) = self.slots.get(&key) { return *s; }
    self.rasterised += 1;
    let img = self.swash.get_image_uncached(&mut self.fs, key);
    let slot = match img {
      Some(img) if img.placement.width > 0 && img.placement.height > 0 && matches!(img.content, SwashContent::Mask) => {
        let (w, h) = (img.placement.width, img.placement.height);
        let at = match self.alloc(w, h) { Some(a) => a, None => { self.reset(); self.alloc(w, h)? } };
        for row in 0..h {
          let dst = ((at.1 + row) * ATLAS + at.0) as usize;
          let src = (row * w) as usize;
          self.pixels[dst..dst + w as usize].copy_from_slice(&img.data[src..src + w as usize]);
        }
        let d = self.dirty.get_or_insert((at.1, at.1 + h));
        d.0 = d.0.min(at.1); d.1 = d.1.max(at.1 + h);
        let s = ATLAS as f32;
        Some(Slot { u0: at.0 as f32 / s, v0: at.1 as f32 / s, u1: (at.0 + w) as f32 / s, v1: (at.1 + h) as f32 / s,
          left: img.placement.left, top: img.placement.top, w, h })
      }
      _ => None,
    };
    self.slots.insert(key, slot);
    slot
  }

  /// Glyph quads of label i at a zoom bucket, in world units relative to the label centre.
  fn quads_for(&mut self, i: usize, bucket: i32) -> &Vec<Quad> {
    let key = (i as u32, bucket);
    if !self.quads.contains_key(&key) {
      let s = 2f64.powf(bucket as f64 * BUCKET_STEP) as f32;
      let glyphs: Vec<(LayoutGlyph, f32, f32)> = self.shaped[i].as_ref().unwrap().glyphs.clone();
      let mut out = Vec::with_capacity(glyphs.len());
      for (g, line_y, shift) in glyphs.iter() {
        let pg = g.physical((shift * s, line_y * s), s);
        if let Some(sl) = self.glyph(pg.cache_key) {
          let x = (pg.x + sl.left) as f32 / s;
          let y = (pg.y - sl.top) as f32 / s;
          out.push(Quad { ox: x, oy: y, w: sl.w as f32 / s, h: sl.h as f32 / s, uv: [sl.u0, sl.v0, sl.u1, sl.v1] });
        }
      }
      self.quads.insert(key, out);
    }
    &self.quads[&key]
  }
}

// ------------------------------------------------------------------ label/rect culling grid

struct Grid { x0: f64, y0: f64, cell: f64, nx: i64, ny: i64, cells: Vec<Vec<u32>> }
impl Grid {
  fn new(pts: &[(f64, f64)], cell: f64) -> Self {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &(x, y) in pts { x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y); }
    if pts.is_empty() { x0 = 0.0; y0 = 0.0; x1 = 0.0; y1 = 0.0; }
    let nx = ((x1 - x0) / cell).floor() as i64 + 1;
    let ny = ((y1 - y0) / cell).floor() as i64 + 1;
    let mut cells = vec![Vec::new(); (nx * ny) as usize];
    for (i, &(x, y)) in pts.iter().enumerate() {
      let cx = ((x - x0) / cell) as i64; let cy = ((y - y0) / cell) as i64;
      cells[(cy * nx + cx) as usize].push(i as u32);
    }
    Grid { x0, y0, cell, nx, ny, cells }
  }
  fn query(&self, r: [f64; 4], out: &mut Vec<u32>) {
    out.clear();
    let cx0 = (((r[0] - self.x0) / self.cell).floor() as i64).max(0);
    let cy0 = (((r[1] - self.y0) / self.cell).floor() as i64).max(0);
    let cx1 = (((r[2] - self.x0) / self.cell).floor() as i64).min(self.nx - 1);
    let cy1 = (((r[3] - self.y0) / self.cell).floor() as i64).min(self.ny - 1);
    for cy in cy0..=cy1 { for cx in cx0..=cx1 { out.extend_from_slice(&self.cells[(cy * self.nx + cx) as usize]); } }
  }
}

// ------------------------------------------------------------------ options and records

#[derive(Clone)]
struct Opts { data: String, cams: String, size: String, scenarios: Vec<String>, dur: f64, warm: f64, labels: bool, present: String, out: String, cull: bool, shot: String, offscreen: bool, hz: f64, ranges: bool, gpusync: bool }

fn parse_opts() -> Opts {
  let mut o = Opts { data: String::new(), cams: String::new(), size: "5000".into(), scenarios: vec!["fit".into(), "z035".into(), "z1".into()],
    dur: 5.0, warm: 1.0, labels: true, present: "fifo".into(), out: "result.json".into(), cull: true, shot: String::new(), offscreen: false, hz: 120.0, ranges: false, gpusync: true };
  let a: Vec<String> = std::env::args().collect();
  let mut i = 1;
  while i + 1 < a.len() {
    let v = a[i + 1].clone();
    match a[i].as_str() {
      "--data" => o.data = v, "--cams" => o.cams = v, "--size" => o.size = v,
      "--scenarios" => o.scenarios = v.split(',').map(|s| s.to_string()).collect(),
      "--dur" => o.dur = v.parse().unwrap(), "--warm" => o.warm = v.parse().unwrap(),
      "--labels" => o.labels = v == "1", "--present" => o.present = v, "--out" => o.out = v, "--cull" => o.cull = v == "1", "--shot" => o.shot = v, "--offscreen" => o.offscreen = v == "1", "--hz" => o.hz = v.parse().unwrap(), "--cullmode" => o.ranges = v == "ranges", "--gpusync" => o.gpusync = v == "1",
      x => panic!("unknown option {x}"),
    }
    i += 2;
  }
  o
}

#[derive(Default, Clone, serde::Serialize)]
struct FrameRec { draws: u32, t: f64, cpu_ms: f64, prep_ms: f64, encode_ms: f64, acquire_ms: f64, present_ms: f64, interval_ms: f64, gpu_ms: f64, labels: u32, glyphs: u32, greeked: u32, tris: u32, raster: u32 }

// ------------------------------------------------------------------ renderer

struct Gpu {
  window: Arc<Window>,
  surface: wgpu::Surface<'static>,
  device: wgpu::Device,
  queue: wgpu::Queue,
  config: wgpu::SurfaceConfiguration,
  ubuf: wgpu::Buffer,
  ubind: wgpu::BindGroup,
  tex_layout: wgpu::BindGroupLayout,
  sampler: wgpu::Sampler,
  p_flat: wgpu::RenderPipeline,
  p_rope: Option<wgpu::RenderPipeline>,
  p_shadow: Option<wgpu::RenderPipeline>,
  p_composite: wgpu::RenderPipeline,
  p_rect: wgpu::RenderPipeline,
  p_text: wgpu::RenderPipeline,
  vbuf: wgpu::Buffer,
  ibuf: wgpu::Buffer,
  cbuf: wgpu::Buffer,
  rect_buf: wgpu::Buffer,
  text_buf: wgpu::Buffer,
  atlas: wgpu::Texture,
  atlas_bind: wgpu::BindGroup,
  shadow: Option<(wgpu::Texture, wgpu::TextureView, wgpu::BindGroup, u32, u32)>,
  offscreen: Option<wgpu::Texture>,
  in_flight: std::collections::VecDeque<wgpu::SubmissionIndex>,
  ts: Option<(wgpu::QuerySet, wgpu::Buffer, Vec<(wgpu::Buffer, Arc<AtomicBool>, Option<(String, usize)>)>, f32)>,
}

struct Phase { name: String, base: Cam, start: Instant, timed: bool }

struct App {
  o: Opts,
  scene: Scene,
  cams: HashMap<String, Cam>,
  text: Text,
  grid: Grid,
  gpu: Option<Gpu>,
  t_process: Instant,
  load: serde_json::Map<String, serde_json::Value>,
  phase_i: usize,
  phase: Option<Phase>,
  frames: HashMap<String, Vec<FrameRec>>,
  last_frame: Option<Instant>,
  frame_no: u64,
  // scratch
  culled: Vec<u32>,
  runs: Vec<(u32, u32)>,
  vis: Vec<u32>,
  rects: Vec<RectInst>,
  bars: Vec<RectInst>,
  glyphs: Vec<TextInst>,
  first_present_ms: Option<f64>,
  acquire_fail: HashMap<String, u64>,
}

fn rect_inst(x: f64, y: f64, w: f64, h: f64, radius: f32, sw: f32, fill: [f32; 4], stroke: [f32; 4]) -> RectInst {
  RectInst { bx: [x as f32, y as f32, w as f32, h as f32], misc: [radius, sw], fill, stroke }
}

impl App {
  fn camera(&self, ph: &Phase, now: Instant) -> Cam {
    if !ph.timed { return ph.base; }
    let t = now.duration_since(ph.start).as_secs_f64();
    let tau = std::f64::consts::TAU;
    let z0 = ph.base.zoom;
    Cam { cx: ph.base.cx + 400.0 / z0 * (tau * t / 5.0).sin(), cy: ph.base.cy + 250.0 / z0 * (2.0 * tau * t / 5.0).sin(),
      zoom: z0 * 2f64.powf(0.5 * (tau * t / 5.0).sin()) }
  }

  fn init_gpu(&mut self, el: &ActiveEventLoop) {
    let t0 = Instant::now();
    let window = Arc::new(el.create_window(Window::default_attributes().with_title("wgpu spike (Radiant scene)")
      .with_inner_size(LogicalSize::new(1440.0, 900.0)).with_position(LogicalPosition::new(30.0, 40.0))).unwrap());
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::METAL, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let surface = instance.create_surface(window.clone()).unwrap();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
      power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), force_fallback_adapter: false, apply_limit_buckets: false })).unwrap();
    // Pass timestamps on wgpu 30 / Metal returned a stale end-of-pass value (always the previous use of the slot), so GPU
    // time is measured instead as submit-to-completion wall time with the GPU otherwise idle (an upper bound).
    let ts_ok = false && adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY);
    let mut limits = wgpu::Limits::default();
    limits.max_buffer_size = adapter.limits().max_buffer_size;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
      label: None, required_features: if ts_ok { wgpu::Features::TIMESTAMP_QUERY } else { wgpu::Features::empty() },
      required_limits: limits, ..Default::default() })).unwrap();
    let size = window.inner_size();
    let mut config = surface.get_default_config(&adapter, size.width, size.height).unwrap();
    let caps = surface.get_capabilities(&adapter);
    config.format = caps.formats.iter().copied().find(|f| *f == wgpu::TextureFormat::Bgra8Unorm).unwrap_or(caps.formats[0]);
    config.present_mode = match self.o.present.as_str() { "immediate" => wgpu::PresentMode::Immediate, "mailbox" => wgpu::PresentMode::Mailbox, _ => wgpu::PresentMode::Fifo };
    config.desired_maximum_frame_latency = 2;
    if !self.o.shot.is_empty() { config.usage |= wgpu::TextureUsages::COPY_SRC; }
    surface.configure(&device, &config);
    let t_device = t0.elapsed().as_secs_f64() * 1e3;

    let t1 = Instant::now();
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(include_str!("shaders.wgsl").into()) });
    let ulayout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[wgpu::BindGroupLayoutEntry {
      binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }] });
    let tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[
      wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
      wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None }] });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&ulayout), Some(&tex_layout)], immediate_size: 0 });
    let ubuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: std::mem::size_of::<Uniforms>() as u64 * 2, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let ubind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &ulayout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &ubuf, offset: 0, size: None }) }] });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });

    let pm = wgpu::BlendState { color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
      alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add } };
    let max = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max };
    let fmt = config.format;
    let mk = |vs: &str, fs: &str, bufs: &[Option<wgpu::VertexBufferLayout>], topo: wgpu::PrimitiveTopology, f: wgpu::TextureFormat, blend: wgpu::BlendState| {
      device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: Some(vs), layout: Some(&layout),
        vertex: wgpu::VertexState { module: &shader, entry_point: Some(vs), compilation_options: Default::default(), buffers: bufs },
        primitive: wgpu::PrimitiveState { topology: topo, ..Default::default() }, depth_stencil: None, multisample: Default::default(),
        fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some(fs), compilation_options: Default::default(),
          targets: &[Some(wgpu::ColorTargetState { format: f, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL })] }),
        multiview_mask: None, cache: None })
    };
    let m = &self.scene.j.mesh;
    let stride = m.stride as u64;
    use wgpu::VertexFormat as F;
    let va = |loc: u32, off: u64, f: F| wgpu::VertexAttribute { shader_location: loc, offset: off, format: f };
    let flat_attrs = if m.relief.is_some() { vec![va(0, 0, F::Float32x2), va(1, 8, F::Unorm8x4), va(2, stride - 8, F::Float32x2)] }
      else { vec![va(0, 0, F::Float32x2), va(1, 8, F::Unorm8x4), va(2, 12, F::Float32x2)] };
    assert!(m.wide, "spike expects the wide layout the export uses");
    let flat_buf = [Some(wgpu::VertexBufferLayout { array_stride: stride, step_mode: wgpu::VertexStepMode::Vertex, attributes: &flat_attrs })];
    let p_flat = mk("vs_flat", "fs_flat", &flat_buf, wgpu::PrimitiveTopology::TriangleList, fmt, pm);
    let rope = m.relief.as_ref().map(|r| r.material == "rope" && r.hasTwist).unwrap_or(false);
    let (p_rope, p_shadow) = if rope {
      let attrs = vec![va(0, 0, F::Float32x2), va(1, 8, F::Unorm8x4), va(3, 12, F::Snorm8x4), va(4, 16, F::Sint16x2), va(5, 20, F::Float32), va(2, 24, F::Float32x2)];
      let b = [Some(wgpu::VertexBufferLayout { array_stride: stride, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })];
      (Some(mk("vs_rope", "fs_rope", &b, wgpu::PrimitiveTopology::TriangleList, fmt, pm)),
       Some(mk("vs_shadow", "fs_shadow", &b, wgpu::PrimitiveTopology::TriangleList, wgpu::TextureFormat::R8Unorm, wgpu::BlendState { color: max, alpha: max })))
    } else { (None, None) };
    let p_composite = mk("vs_full", "fs_composite", &[], wgpu::PrimitiveTopology::TriangleList, fmt, pm);
    let rect_attrs = [va(0, 0, F::Float32x4), va(1, 16, F::Float32x2), va(2, 24, F::Float32x4), va(3, 40, F::Float32x4)];
    let p_rect = mk("vs_rect", "fs_rect", &[Some(wgpu::VertexBufferLayout { array_stride: 56, step_mode: wgpu::VertexStepMode::Instance, attributes: &rect_attrs })],
      wgpu::PrimitiveTopology::TriangleStrip, fmt, pm);
    let text_attrs = [va(0, 0, F::Float32x4), va(1, 16, F::Float32x4), va(2, 32, F::Float32x4)];
    let p_text = mk("vs_text", "fs_text", &[Some(wgpu::VertexBufferLayout { array_stride: 48, step_mode: wgpu::VertexStepMode::Instance, attributes: &text_attrs })],
      wgpu::PrimitiveTopology::TriangleStrip, fmt, pm);
    device.poll(wgpu::PollType::wait_indefinitely()).ok();
    let t_pipelines = t1.elapsed().as_secs_f64() * 1e3;

    // Scene upload: the packed vertex buffer as is, the full index buffer, and a same-size buffer for culled indices.
    let t2 = Instant::now();
    let vbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("vtx"), contents: &self.scene.vtx, usage: wgpu::BufferUsages::VERTEX });
    let ibuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("idx"), contents: bytemuck::cast_slice(&self.scene.idx), usage: wgpu::BufferUsages::INDEX });
    let cbuf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("culled"), size: (self.scene.idx.len() * 4) as u64, usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    queue.submit([]);
    device.poll(wgpu::PollType::wait_indefinitely()).ok();
    let t_upload = t2.elapsed().as_secs_f64() * 1e3;

    let rect_buf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 56 * 400_000, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let text_buf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 48 * 400_000, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let atlas = device.create_texture(&wgpu::TextureDescriptor { label: Some("atlas"), size: wgpu::Extent3d { width: ATLAS, height: ATLAS, depth_or_array_layers: 1 },
      mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R8Unorm,
      usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
    let av = atlas.create_view(&Default::default());
    let atlas_bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &tex_layout, entries: &[
      wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&av) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) }] });
    let offscreen = if self.o.offscreen {
      Some(device.create_texture(&wgpu::TextureDescriptor { label: Some("offscreen"), size: wgpu::Extent3d { width: config.width, height: config.height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: config.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] }))
    } else { None };
    let ts = if ts_ok {
      let qs = device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 8 });
      let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 1024, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
      let ring = (0..4).map(|_| (device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
        Arc::new(AtomicBool::new(false)), None)).collect();
      Some((qs, resolve, ring, queue.get_timestamp_period()))
    } else { None };
    self.load.insert("device_ms".into(), t_device.into());
    self.load.insert("pipelines_ms".into(), t_pipelines.into());
    self.load.insert("gpu_upload_ms".into(), t_upload.into());
    self.load.insert("timestamp_query".into(), ts_ok.into());
    self.load.insert("adapter".into(), format!("{:?}", adapter.get_info().name).into());
    self.load.insert("surface_format".into(), format!("{:?}", config.format).into());
    self.load.insert("present_mode".into(), format!("{:?}", config.present_mode).into());
    self.load.insert("physical_size".into(), serde_json::json!([size.width, size.height]));
    self.load.insert("scale_factor".into(), window.scale_factor().into());
    if let Some(mon) = window.current_monitor() {
      self.load.insert("monitor".into(), format!("{:?} {:?} {:?}mHz", mon.name(), mon.size(), mon.refresh_rate_millihertz()).into());
    }
    self.gpu = Some(Gpu { window, surface, device, queue, config, ubuf, ubind, tex_layout, sampler, p_flat, p_rope, p_shadow, p_composite, p_rect, p_text,
      vbuf, ibuf, cbuf, rect_buf, text_buf, atlas, atlas_bind, shadow: None, ts, offscreen, in_flight: Default::default() });
  }

  fn next_phase(&mut self) -> bool {
    loop {
      let n = self.o.scenarios.len();
      if self.phase_i >= 2 * n { return false; }
      let name = self.o.scenarios[self.phase_i / 2].clone();
      let timed = self.phase_i % 2 == 1;
      self.phase_i += 1;
      let base = self.cams[&name];
      if !timed && self.o.warm <= 0.0 { continue; }
      self.phase = Some(Phase { name, base, start: Instant::now(), timed });
      return true;
    }
  }

  fn frame(&mut self, el: &ActiveEventLoop) {
    let t_start = Instant::now();
    let interval = self.last_frame.map(|p| t_start.duration_since(p).as_secs_f64() * 1e3).unwrap_or(0.0);
    self.last_frame = Some(t_start);
    let mut ph = self.phase.take().unwrap();
    let lim = if ph.timed { self.o.dur } else { self.o.warm };
    if t_start.duration_since(ph.start).as_secs_f64() >= lim {
      if !self.next_phase() { self.finish(el); return; }
      ph = self.phase.take().unwrap();
      self.last_frame = None;
    }
    let cam = self.camera(&ph, t_start);
    let mut rec = FrameRec { t: t_start.duration_since(ph.start).as_secs_f64(), interval_ms: interval, ..Default::default() };

    // ---- CPU preparation: visible set, culled indices, rect/greek/glyph instances
    let gpu = self.gpu.as_ref().unwrap();
    let vw = gpu.config.width as f64 / gpu.window.scale_factor();
    let vh = gpu.config.height as f64 / gpu.window.scale_factor();
    let dpr = gpu.window.scale_factor();
    let (cx, cy, zoom) = (cam.cx, cam.cy, cam.zoom);
    let margin = 48.0 / zoom;
    let view = [cx - vw / 2.0 / zoom - margin, cy - vh / 2.0 / zoom - margin, cx + vw / 2.0 / zoom + margin, cy + vh / 2.0 / zoom + margin];
    let sb = &self.scene.span_bounds;
    let se = &self.scene.span_ends;
    let n_spans = se.len();
    self.culled.clear();
    self.runs.clear();
    let mut culled_len = 0usize;
    let mut visible_spans = 0;
    if self.o.cull {
      let mut i = 0;
      while i < n_spans {
        let vis = |k: usize| sb[4 * k] <= view[2] && sb[4 * k + 2] >= view[0] && sb[4 * k + 1] <= view[3] && sb[4 * k + 3] >= view[1];
        if !vis(i) { i += 1; continue; }
        let first = i;
        while i < n_spans && vis(i) { i += 1; visible_spans += i - first; }
        let start = if first == 0 { 0 } else { se[first - 1] as usize };
        let end = se[i - 1] as usize;
        culled_len += end - start;
        if self.o.ranges { self.runs.push((start as u32, end as u32)); } else { self.culled.extend_from_slice(&self.scene.idx[start..end]); }
      }
    }
    let _ = visible_spans;
    let all = !self.o.cull || culled_len == self.scene.idx.len();
    let count = if all { self.scene.idx.len() } else { culled_len } as u32;
    if all { self.runs.clear(); self.runs.push((0, count)); }
    rec.tris = count / 3;
    rec.draws = if self.o.ranges && !all { self.runs.len() as u32 } else { 1 };

    self.rects.clear();
    self.bars.clear();
    self.glyphs.clear();
    let px = 0.25 / zoom;
    for r in &self.scene.j.rects {
      if r.x > view[2] || r.x + r.w < view[0] || r.y > view[3] || r.y + r.h < view[1] { continue; }
      if r.w < px && r.h < px { continue; }
      let _ = r.overBranches;
      self.rects.push(rect_inst(r.x - cx, r.y - cy, r.w, r.h, r.radius, r.strokeWidth.unwrap_or(0.0), premul(r.fill, 1.0), r.stroke.map(|s| premul(s, 1.0)).unwrap_or([0.0; 4])));
    }
    let budget_ms = 4.0f64.min(1000.0 / 120.0 * 0.24 * 2.0); // LabelAtlas budget: min(4 ms, 0.24 x refresh interval at 60 Hz)
    let mut raster_n = 0u32;
    if self.o.labels {
      self.grid.query(view, &mut self.vis);
      let bucket = ((zoom * dpr).max(1e-4).log2() / BUCKET_STEP).round() as i32;
      let vis = std::mem::take(&mut self.vis);
      for &li in &vis {
        let l = &self.scene.j.labels[li as usize];
        let lp = l.fontSize as f64 * zoom;
        if lp < 0.65 { continue; }
        // Per-label test against the view (the grid returns whole cells): conservative extent as estimateExtent.
        let ew = (l.text.chars().count() as f64 * l.fontSize as f64 * 0.95).min(if l.maxWidth > 0.0 { l.maxWidth as f64 } else { f64::MAX }) * 0.5;
        let eh = l.fontSize as f64 * 1.25 * 0.5 * (1.0 + l.text.chars().filter(|c| *c == '\n').count() as f64);
        if l.x + ew < view[0] || l.x - ew > view[2] || l.y + eh * 4.0 < view[1] || l.y - eh * 4.0 > view[3] { continue; }
        let op = l.opacity.unwrap_or(1.0);
        if lp < GREEK_PX {
          // estimateExtent + pushBars (alpha 0.55)
          let lh = l.fontSize as f64 * 1.25;
          let natural = l.text.chars().count() as f64 * l.fontSize as f64 * 0.95;
          let mut lines = 1.0; let mut w = natural;
          if l.maxWidth > 0.0 && natural > l.maxWidth as f64 { w = l.maxWidth as f64; lines += (natural / l.maxWidth as f64).ceil(); }
          let bw = w * 0.65; let n = (lines as usize).min(8);
          let top = l.y - (n as f64 * lh) / 2.0;
          let bar_h = (1.4 / zoom).max(l.fontSize as f64 * 0.45);
          let col = premul(l.color, 0.55 * op);
          for k in 0..n {
            let lw = if k == n - 1 && n > 1 { bw * 0.6 } else { bw };
            let free = bw - lw;
            let x0 = l.x - bw / 2.0 + match l.align.as_str() { "left" => 0.0, "center" => free / 2.0, _ => free };
            self.bars.push(rect_inst(x0 - cx, top + (k as f64 + 0.5) * lh - bar_h / 2.0 - cy, lw, bar_h, (bar_h / 2.0) as f32, 0.0, col, [0.0; 4]));
          }
          rec.greeked += 1;
          continue;
        }
        let ready = self.text.shaped[li as usize].is_some() && self.text.quads.contains_key(&(li, bucket));
        if !ready && t_start.elapsed().as_secs_f64() * 1e3 > budget_ms {
          // not rasterised yet: a faint bar this frame, as the WebGL renderer does
          let col = premul(l.color, 0.35 * op);
          let w = l.text.chars().count() as f64 * l.fontSize as f64 * 0.6;
          self.bars.push(rect_inst(l.x - w / 2.0 - cx, l.y - l.fontSize as f64 * 0.225 - cy, w, l.fontSize as f64 * 0.45, l.fontSize * 0.225, 0.0, col, [0.0; 4]));
          continue;
        }
        if self.text.shaped[li as usize].is_none() { self.text.shape(li as usize, l); }
        if !self.text.quads.contains_key(&(li, bucket)) { raster_n += 1; }
        let col = premul(l.color, op);
        let (lx, ly) = ((l.x - cx) as f32, (l.y - cy) as f32);
        let qs = self.text.quads_for(li as usize, bucket);
        for q in qs { self.glyphs.push(TextInst { rect: [lx + q.ox, ly + q.oy, q.w, q.h], uv: q.uv, col }); }
        rec.labels += 1;
      }
      self.vis = vis;
    }
    rec.glyphs = self.glyphs.len() as u32;
    rec.raster = raster_n;
    rec.prep_ms = t_start.elapsed().as_secs_f64() * 1e3;

    // ---- GPU encode
    let t_enc = Instant::now();
    let gpu = self.gpu.as_mut().unwrap();
    if let Some((y0, y1)) = self.text.dirty.take() {
      gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &gpu.atlas, mip_level: 0, origin: wgpu::Origin3d { x: 0, y: y0, z: 0 }, aspect: wgpu::TextureAspect::All },
        &self.text.pixels[(y0 * ATLAS) as usize..(y1 * ATLAS) as usize],
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(ATLAS), rows_per_image: None },
        wgpu::Extent3d { width: ATLAS, height: y1 - y0, depth_or_array_layers: 1 });
    }
    if !all && count > 0 && !self.o.ranges { gpu.queue.write_buffer(&gpu.cbuf, 0, bytemuck::cast_slice(&self.culled)); }
    let nrect = self.rects.len().min(400_000);
    let nbar = self.bars.len().min(400_000 - nrect);
    if nrect > 0 { gpu.queue.write_buffer(&gpu.rect_buf, 0, bytemuck::cast_slice(&self.rects[..nrect])); }
    if nbar > 0 { gpu.queue.write_buffer(&gpu.rect_buf, (nrect * 56) as u64, bytemuck::cast_slice(&self.bars[..nbar])); }
    let nglyph = self.glyphs.len().min(400_000);
    if nglyph > 0 { gpu.queue.write_buffer(&gpu.text_buf, 0, bytemuck::cast_slice(&self.glyphs[..nglyph])); }
    let m = &self.scene.j.mesh;
    let (ox, oy) = (m.ox - cx, m.oy - cy);
    let (hx, hy) = (ox as f32, oy as f32);
    let relief = m.relief.as_ref();
    let mat = [0.52, 0.6, 0.18, 14.0];
    let mut u = Uniforms { view: [vw as f32, vh as f32], zoom: zoom as f32, far: 0.0, off: [hx, hy], off_low: [(ox - hx as f64) as f32, (oy - hy as f64) as f32],
      mat, color: [0.0; 4], res: [gpu.config.width as f32, gpu.config.height as f32], coded: 1.0, pad: 0.0 };
    let shadow_alpha = relief.filter(|r| r.hasShadow && gpu.p_shadow.is_some()).map(|r| ((r.shadowReach as f64 * zoom - 2.5) / 2.5).min(1.0)).unwrap_or(0.0);
    if shadow_alpha > 0.0 {
      let c = relief.unwrap().shadowColor; let a = shadow_alpha as f32;
      u.color = [c.r * a, c.g * a, c.b * a, c.a * a];
    }
    gpu.queue.write_buffer(&gpu.ubuf, 0, bytemuck::bytes_of(&u));
    let lit = relief.map(|r| r.maxWidth as f64 * zoom >= 1.5).unwrap_or(false) && gpu.p_rope.is_some();

    let t_acq = Instant::now();
    let frame = if gpu.offscreen.is_some() { None } else { Some(match gpu.surface.get_current_texture() {
      wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
      other => {
        let s = match other { wgpu::CurrentSurfaceTexture::Timeout => "timeout", wgpu::CurrentSurfaceTexture::Occluded => "occluded", wgpu::CurrentSurfaceTexture::Outdated => "outdated", wgpu::CurrentSurfaceTexture::Lost => "lost", _ => "other" };
        *self.acquire_fail.entry(s.to_string()).or_default() += 1;
        if s == "outdated" || s == "lost" { gpu.surface.configure(&gpu.device, &gpu.config); }
        self.phase = Some(ph); gpu.window.request_redraw(); return;
      }
    }) };
    rec.acquire_ms = t_acq.elapsed().as_secs_f64() * 1e3;
    let target_tex: &wgpu::Texture = match &frame { Some(f) => &f.texture, None => gpu.offscreen.as_ref().unwrap() };
    let view_tex = target_tex.create_view(&Default::default());
    let mut enc = gpu.device.create_command_encoder(&Default::default());
    let (sw, sh) = ((gpu.config.width + 1) / 2, (gpu.config.height + 1) / 2);
    if shadow_alpha > 0.0 && gpu.shadow.as_ref().map(|s| (s.3, s.4)) != Some((sw, sh)) {
      let t = gpu.device.create_texture(&wgpu::TextureDescriptor { label: Some("shadow"), size: wgpu::Extent3d { width: sw, height: sh, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
      let v = t.create_view(&Default::default());
      let b = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &gpu.tex_layout, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&v) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&gpu.sampler) }] });
      gpu.shadow = Some((t, v, b, sw, sh));
    }
    let idx_buf = if all || self.o.ranges { &gpu.ibuf } else { &gpu.cbuf };
    let ranges = self.o.ranges && !all;
    let qs = gpu.ts.as_ref().map(|t| &t.0);
    let slot = (self.frame_no % 4) as usize;
    let (q0, q1) = (2 * slot as u32, 2 * slot as u32 + 1);
    let shadow_pass = shadow_alpha > 0.0 && count > 0;
    if shadow_pass {
      let s = gpu.shadow.as_ref().unwrap();
      let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("shadow"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &s.1, depth_slice: None, resolve_target: None,
          ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: None, occlusion_query_set: None, multiview_mask: None,
        timestamp_writes: qs.map(|q| wgpu::RenderPassTimestampWrites { query_set: q, beginning_of_pass_write_index: Some(q0), end_of_pass_write_index: None }) });
      pass.set_pipeline(gpu.p_shadow.as_ref().unwrap());
      pass.set_bind_group(0, &gpu.ubind, &[]);
      pass.set_bind_group(1, &gpu.atlas_bind, &[]);
      pass.set_vertex_buffer(0, gpu.vbuf.slice(..));
      pass.set_index_buffer(idx_buf.slice(..), wgpu::IndexFormat::Uint32);
      if ranges { for &(a, b) in &self.runs { pass.draw_indexed(a..b, 0, 0..1); } } else { pass.draw_indexed(0..count, 0, 0..1); }
    }
    {
      let bg = self.scene.j.background;
      let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("main"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view_tex, depth_slice: None, resolve_target: None,
          ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: bg.r as f64, g: bg.g as f64, b: bg.b as f64, a: 1.0 }), store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: None, occlusion_query_set: None, multiview_mask: None,
        timestamp_writes: qs.map(|q| wgpu::RenderPassTimestampWrites { query_set: q, beginning_of_pass_write_index: if shadow_pass { None } else { Some(q0) }, end_of_pass_write_index: Some(q1) }) });
      pass.set_bind_group(0, &gpu.ubind, &[]);
      pass.set_bind_group(1, &gpu.atlas_bind, &[]);
      if shadow_pass {
        pass.set_pipeline(&gpu.p_composite);
        pass.set_bind_group(1, &gpu.shadow.as_ref().unwrap().2, &[]);
        pass.draw(0..3, 0..1);
        pass.set_bind_group(1, &gpu.atlas_bind, &[]);
      }
      if nrect > 0 {
        pass.set_pipeline(&gpu.p_rect);
        pass.set_vertex_buffer(0, gpu.rect_buf.slice(..));
        pass.draw(0..4, 0..nrect as u32);
      }
      if count > 0 {
        pass.set_pipeline(if lit { gpu.p_rope.as_ref().unwrap() } else { &gpu.p_flat });
        pass.set_vertex_buffer(0, gpu.vbuf.slice(..));
        pass.set_index_buffer(idx_buf.slice(..), wgpu::IndexFormat::Uint32);
        if ranges { for &(a, b) in &self.runs { pass.draw_indexed(a..b, 0, 0..1); } } else { pass.draw_indexed(0..count, 0, 0..1); }
      }
      if nbar > 0 {
        pass.set_pipeline(&gpu.p_rect);
        pass.set_vertex_buffer(0, gpu.rect_buf.slice(..));
        pass.draw(0..4, nrect as u32..(nrect + nbar) as u32);
      }
      if nglyph > 0 {
        pass.set_pipeline(&gpu.p_text);
        pass.set_vertex_buffer(0, gpu.text_buf.slice(..));
        pass.draw(0..4, 0..nglyph as u32);
      }
    }
    // GPU timestamps: resolve into a ring of readback buffers; read them back a few frames later.
    let key = ph.name.clone() + if ph.timed { "" } else { "/warm" };
    if let Some((qs, resolve, ring, period)) = gpu.ts.as_mut() {
      let (buf, flag, owner) = &mut ring[slot];
      if let Some((k, at)) = owner.take() {
        while !flag.load(Ordering::Acquire) { gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok(); }
        let v: [u64; 2] = { let r = buf.get_mapped_range(..).unwrap(); let d: &[u64] = bytemuck::cast_slice(&r); [d[0], d[1]] };
        buf.unmap();
        flag.store(false, Ordering::Release);
        let ms = (v[1] as i128 - v[0] as i128) as f64 * *period as f64 / 1e6;
        if std::env::var("TSDEBUG").is_ok() && self.frame_no < 40 { eprintln!("ts {} {} {} period {}", v[0], v[1], ms, period); }
        if let Some(list) = self.frames.get_mut(&k) { if at < list.len() { list[at].gpu_ms = ms; } }
      }
      let _ = (qs, resolve);
    }
    let shot = !self.o.shot.is_empty() && ph.timed && self.frames.get(&key).map(|l| l.is_empty()).unwrap_or(true);
    let (w, h) = (gpu.config.width, gpu.config.height);
    let row = (w * 4 + 255) / 256 * 256;
    let shot_buf = if shot {
      let b = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
      enc.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture: target_tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &b, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
      Some(b)
    } else { None };
    let cmd = enc.finish();
    rec.encode_ms = t_enc.elapsed().as_secs_f64() * 1e3 - rec.acquire_ms;
    let sub = gpu.queue.submit([cmd]);
    if frame.is_none() && self.o.offscreen && self.o.gpusync {
      // Wait for this frame's GPU work: frames are paced (8.3 ms) so the GPU is otherwise idle and this wall time is
      // an upper bound of the frame's GPU time. Not counted in cpu_ms.
      let tw = Instant::now();
      gpu.device.poll(wgpu::PollType::Wait { submission_index: Some(sub.clone()), timeout: None }).ok();
      rec.gpu_ms = tw.elapsed().as_secs_f64() * 1e3;
      rec.acquire_ms += rec.gpu_ms;
    }
    if frame.is_none() && !self.o.gpusync {
      // Offscreen: allow two frames in flight, as a swap chain with frame latency 2 would.
      gpu.in_flight.push_back(sub);
      if gpu.in_flight.len() > 2 {
        let old = gpu.in_flight.pop_front().unwrap();
        let tw = Instant::now();
        gpu.device.poll(wgpu::PollType::Wait { submission_index: Some(old), timeout: None }).ok();
        rec.acquire_ms += tw.elapsed().as_secs_f64() * 1e3;
      }
    }
    if let Some((qs, resolve, ring, _)) = gpu.ts.as_mut() {
      // Resolve in a separate submission after the frame's own: on Metal the end-of-pass sample is not ready for a
      // resolve recorded in the same command buffer (it read one frame stale).
      let (buf, flag, owner) = &mut ring[slot];
      let mut e2 = gpu.device.create_command_encoder(&Default::default());
      e2.resolve_query_set(qs, q0..q1 + 1, resolve, (slot * 256) as u64);
      e2.copy_buffer_to_buffer(resolve, (slot * 256) as u64, buf, 0, 16);
      gpu.queue.submit([e2.finish()]);
      let f = flag.clone();
      buf.map_async(wgpu::MapMode::Read, .., move |r| { if r.is_ok() { f.store(true, Ordering::Release); } });
      *owner = Some((key.clone(), self.frames.get(&key).map(|l| l.len()).unwrap_or(0)));
    }
    if let Some(b) = shot_buf {
      b.map_async(wgpu::MapMode::Read, .., |_| {});
      gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok();
      let data = b.get_mapped_range(..).unwrap();
      let mut rgba = Vec::with_capacity((w * h * 4) as usize);
      for y in 0..h { let r = &data[(y * row) as usize..(y * row + w * 4) as usize]; for p in r.chunks(4) { rgba.extend_from_slice(&[p[2], p[1], p[0], 255]); } }
      let path = format!("{}-{}.png", self.o.shot, ph.name);
      let f = std::fs::File::create(&path).unwrap();
      let mut e = png::Encoder::new(std::io::BufWriter::new(f), w, h);
      e.set_color(png::ColorType::Rgba); e.set_depth(png::BitDepth::Eight);
      e.write_header().unwrap().write_image_data(&rgba).unwrap();
    }
    let t_pre = Instant::now();
    if let Some(frame) = frame { gpu.window.pre_present_notify(); gpu.queue.present(frame); }
    rec.present_ms = t_pre.elapsed().as_secs_f64() * 1e3;
    gpu.device.poll(wgpu::PollType::Poll).ok();
    rec.cpu_ms = t_start.elapsed().as_secs_f64() * 1e3 - rec.acquire_ms;
    if self.first_present_ms.is_none() { self.first_present_ms = Some(self.t_process.elapsed().as_secs_f64() * 1e3); }
    self.frames.entry(key).or_default().push(rec);
    self.frame_no += 1;
    self.phase = Some(ph);
    if !self.o.offscreen { gpu.window.request_redraw(); }
  }

  fn finish(&mut self, el: &ActiveEventLoop) {
    let pid = std::process::id();
    let rss_kb = std::process::Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().ok()
      .and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(-1.0);
    let footprint = std::process::Command::new("footprint").args(["-p", &pid.to_string()]).output().ok()
      .map(|o| String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.contains("phys_footprint") || l.contains("Footprint") || l.contains("IOAccelerator") || l.contains("TOTAL")).map(|s| s.trim().to_string()).collect::<Vec<_>>().join(" | ")).unwrap_or_default();
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    self.load.insert("rss_mb".into(), (rss_kb / 1024.0).into());
    self.load.insert("max_rss_mb".into(), (ru.ru_maxrss as f64 / 1048576.0).into());
    self.load.insert("footprint".into(), footprint.into());
    self.load.insert("first_present_ms".into(), self.first_present_ms.unwrap_or(-1.0).into());
    self.load.insert("font_family".into(), self.text.family.clone().into());
    self.load.insert("glyphs_rasterised".into(), self.text.rasterised.into());
    self.load.insert("atlas_resets".into(), self.text.resets.into());
    self.load.insert("acquire_fail".into(), serde_json::to_value(&self.acquire_fail).unwrap());
    self.load.insert("frames_total".into(), self.frame_no.into());
    let mut summary = serde_json::Map::new();
    for (k, v) in &self.frames {
      if k.ends_with("/warm") { continue; }
      let skip = 2usize.min(v.len());
      let pick = |f: &dyn Fn(&FrameRec) -> f64| -> serde_json::Value {
        let mut a: Vec<f64> = v[skip..].iter().map(|r| f(r)).collect();
        if a.is_empty() { return serde_json::Value::Null; }
        a.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let mean = a.iter().sum::<f64>() / a.len() as f64;
        let p = |q: f64| a[((a.len() as f64 * q).ceil() as usize).clamp(1, a.len()) - 1];
        serde_json::json!({ "mean": mean, "median": p(0.5), "p95": p(0.95), "max": a[a.len() - 1] })
      };
      summary.insert(k.clone(), serde_json::json!({
        "frames": v.len(), "cpu_ms": pick(&|r| r.cpu_ms), "prep_ms": pick(&|r| r.prep_ms), "encode_ms": pick(&|r| r.encode_ms),
        "acquire_ms": pick(&|r| r.acquire_ms), "present_ms": pick(&|r| r.present_ms), "interval_ms": pick(&|r| r.interval_ms),
        "gpu_ms": pick(&|r| r.gpu_ms), "labels": pick(&|r| r.labels as f64), "glyphs": pick(&|r| r.glyphs as f64),
        "greeked": pick(&|r| r.greeked as f64), "tris": pick(&|r| r.tris as f64), "raster": pick(&|r| r.raster as f64), "draws": pick(&|r| r.draws as f64) }));
    }
    let out = serde_json::json!({ "opts": { "data": self.o.data, "size": self.o.size, "labels": self.o.labels, "present": self.o.present, "dur": self.o.dur, "cull": self.o.cull, "ranges": self.o.ranges, "gpusync": self.o.gpusync, "offscreen": self.o.offscreen, "hz": self.o.hz },
      "load": self.load, "summary": summary, "frames": self.frames });
    std::fs::write(&self.o.out, serde_json::to_string(&out).unwrap()).unwrap();
    println!("{}", serde_json::to_string(&serde_json::json!({ "load": self.load, "summary": summary })).unwrap());
    el.exit();
  }
}

impl ApplicationHandler for App {
  fn resumed(&mut self, el: &ActiveEventLoop) {
    if self.gpu.is_some() { return; }
    self.init_gpu(el);
    self.next_phase();
    self.gpu.as_ref().unwrap().window.request_redraw();
  }
  fn about_to_wait(&mut self, el: &ActiveEventLoop) {
    if !self.o.offscreen || self.phase.is_none() { return; }
    // Pace offscreen frames to the requested refresh rate, like a display link would.
    let period = 1.0 / self.o.hz;
    if let Some(last) = self.last_frame {
      let next = last + std::time::Duration::from_secs_f64(period);
      let now = Instant::now();
      if next > now + std::time::Duration::from_micros(1500) { std::thread::sleep(next - now - std::time::Duration::from_micros(1200)); }
      while Instant::now() < next { std::hint::spin_loop(); }
    }
    self.frame(el);
  }
  fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, ev: WindowEvent) {
    match ev {
      WindowEvent::CloseRequested => el.exit(),
      WindowEvent::Resized(s) => {
        if let Some(g) = self.gpu.as_mut() { g.config.width = s.width.max(1); g.config.height = s.height.max(1); g.surface.configure(&g.device, &g.config); }
      }
      WindowEvent::RedrawRequested => { if self.phase.is_some() && !self.o.offscreen { self.frame(el); } }
      _ => {}
    }
  }
}

fn main() {
  let t_process = Instant::now();
  let o = parse_opts();
  let mut load = serde_json::Map::new();
  let t0 = Instant::now();
  let sj: SceneJ = serde_json::from_slice(&std::fs::read(format!("{}/scene.json", o.data)).unwrap()).unwrap();
  load.insert("json_ms".into(), (t0.elapsed().as_secs_f64() * 1e3).into());
  let t1 = Instant::now();
  let scene = Scene { vtx: std::fs::read(format!("{}/vtx.bin", o.data)).unwrap(), idx: read_vec(&format!("{}/idx.bin", o.data)),
    span_bounds: read_vec(&format!("{}/sb.bin", o.data)), span_ends: read_vec(&format!("{}/se.bin", o.data)), j: sj };
  load.insert("read_bins_ms".into(), (t1.elapsed().as_secs_f64() * 1e3).into());
  assert_eq!(scene.vtx.len(), scene.j.mesh.nv * scene.j.mesh.stride);
  assert_eq!(scene.idx.len(), scene.j.mesh.ni);
  assert_eq!(scene.span_ends.len(), scene.j.mesh.spans);
  load.insert("vertex_mb".into(), (scene.vtx.len() as f64 / 1048576.0).into());
  load.insert("index_mb".into(), ((scene.idx.len() * 4) as f64 / 1048576.0).into());
  load.insert("labels".into(), scene.j.labels.len().into());
  load.insert("rects".into(), scene.j.rects.len().into());
  let cj: serde_json::Value = serde_json::from_slice(&std::fs::read(&o.cams).unwrap()).unwrap();
  let mut cams = HashMap::new();
  for name in ["fit", "z035", "z1"] {
    let c = &cj["bases"][&o.size][name];
    cams.insert(name.to_string(), Cam { cx: c["cx"].as_f64().unwrap(), cy: c["cy"].as_f64().unwrap(), zoom: c["zoom"].as_f64().unwrap() });
  }
  let t2 = Instant::now();
  let text = Text::new(scene.j.labels.len());
  load.insert("font_system_ms".into(), (t2.elapsed().as_secs_f64() * 1e3).into());
  let t3 = Instant::now();
  let pts: Vec<(f64, f64)> = scene.j.labels.iter().map(|l| (l.x, l.y)).collect();
  let grid = Grid::new(&pts, 1024.0);
  load.insert("grid_ms".into(), (t3.elapsed().as_secs_f64() * 1e3).into());
  let el = EventLoop::new().unwrap();
  el.set_control_flow(ControlFlow::Poll);
  let mut app = App { o, scene, cams, text, grid, gpu: None, t_process, load, phase_i: 0, phase: None, frames: HashMap::new(), last_frame: None, frame_no: 0,
    culled: Vec::new(), runs: Vec::new(), vis: Vec::new(), rects: Vec::new(), bars: Vec::new(), glyphs: Vec::new(), first_present_ms: None, acquire_fail: HashMap::new() };
  el.run_app(&mut app).unwrap();
}
