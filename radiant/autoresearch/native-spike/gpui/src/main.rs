// GPUI feasibility spike: draw an exported Radiant scene (branch mesh, node rects, labels)
// with gpui 0.2.2's public paint API and measure frame cost along the shared camera path.
use gpui::{
    canvas, div, point, prelude::*, px, quad, size, App, Application, Bounds, BorderStyle, Context,
    Font, FontWeight, Hsla, Path, Pixels, Rgba, ShapedLine, SharedString, TextRun, TitlebarOptions,
    Window, WindowBounds, WindowOptions,
};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

const EXPORT: &str = "/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/native/export";

// ---------- logging: count gpui renderer errors (e.g. "instance buffer size grew too large") ----------
static ERRORS: AtomicUsize = AtomicUsize::new(0);
static FIRST_ERRORS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool { m.level() <= log::Level::Warn }
    fn log(&self, r: &log::Record) {
        if r.level() <= log::Level::Warn {
            let n = ERRORS.fetch_add(1, Ordering::Relaxed);
            let msg = format!("{} {}: {}", r.level(), r.target(), r.args());
            if n < 20 { eprintln!("{msg}"); FIRST_ERRORS.lock().unwrap().push(msg); }
        }
    }
    fn flush(&self) {}
}
static LOGGER: Logger = Logger;

// ---------- scene.json ----------
#[derive(Deserialize, Clone, Copy)]
struct Col { r: f32, g: f32, b: f32, a: f32 }
impl Col { fn hsla(self) -> Hsla { Rgba { r: self.r, g: self.g, b: self.b, a: self.a }.into() } }
#[derive(Deserialize)]
struct MeshJ { nv: usize, ni: usize, stride: usize, ox: f64, oy: f64, wide: bool, spans: usize }
#[derive(Deserialize)]
struct RectJ { x: f64, y: f64, w: f64, h: f64, radius: f64, fill: Col, stroke: Option<Col>, #[serde(rename = "strokeWidth")] stroke_width: Option<f64> }
#[derive(Deserialize)]
struct LabelJ {
    text: String, x: f64, y: f64, #[serde(rename = "fontSize")] font_size: f64,
    #[serde(rename = "fontFamily")] font_family: String, bold: bool, color: Col,
    #[serde(rename = "maxWidth")] max_width: Option<f64>,
}
#[derive(Deserialize)]
struct SceneJ { background: Col, mesh: MeshJ, rects: Vec<RectJ>, labels: Vec<LabelJ> }
#[derive(Deserialize, Clone, Copy)]
struct Cam { cx: f64, cy: f64, zoom: f64 }

struct Group { color: Hsla, key: u32, start: u32, end: u32 } // range into soup (vertex units, multiple of 3)
struct Span { x0: f64, y0: f64, x1: f64, y1: f64, groups: Vec<Group> }

struct Data {
    bg: Hsla,
    ox: f64, oy: f64,
    soup: Vec<[f32; 2]>, // de-indexed triangle vertices relative to (ox, oy)
    spans: Vec<Span>,
    rects: Vec<RectJ>,
    labels: Vec<LabelJ>,
    family: SharedString,
    tris: usize,
}

fn rd(p: &str) -> Vec<u8> { std::fs::read(p).unwrap_or_else(|e| panic!("{p}: {e}")) }
fn f32_at(b: &[u8], o: usize) -> f32 { f32::from_le_bytes(b[o..o + 4].try_into().unwrap()) }

fn load(ds: &str) -> Data {
    let dir = format!("{EXPORT}/{ds}");
    let sc: SceneJ = serde_json::from_slice(&rd(&format!("{dir}/scene.json"))).unwrap();
    let vtx = rd(&format!("{dir}/vtx.bin"));
    let idx_b = rd(&format!("{dir}/idx.bin"));
    let sb_b = rd(&format!("{dir}/sb.bin"));
    let se_b = rd(&format!("{dir}/se.bin"));
    let m = &sc.mesh;
    assert_eq!(vtx.len(), m.nv * m.stride);
    assert_eq!(idx_b.len(), m.ni * 4);
    let st = m.stride;
    // positions (hi + lo residual) and colours per vertex
    let mut pos = Vec::with_capacity(m.nv);
    let mut col = Vec::with_capacity(m.nv);
    for v in 0..m.nv {
        let o = v * st;
        let mut x = f32_at(&vtx, o) as f64;
        let mut y = f32_at(&vtx, o + 4) as f64;
        if m.wide { x += f32_at(&vtx, o + st - 8) as f64; y += f32_at(&vtx, o + st - 4) as f64; }
        pos.push([x as f32, y as f32]);
        col.push(u32::from_le_bytes(vtx[o + 8..o + 12].try_into().unwrap()));
    }
    let idx: Vec<u32> = idx_b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    let ends: Vec<u32> = se_b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    let sb: Vec<f64> = sb_b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    assert_eq!(ends.len(), m.spans);
    let mut soup: Vec<[f32; 2]> = Vec::with_capacity(m.ni);
    let mut spans = Vec::with_capacity(m.spans);
    let mut start = 0usize;
    let mut tmp: Vec<(u32, Vec<[f32; 2]>)> = Vec::new();
    for (s, &e) in ends.iter().enumerate() {
        let e = e as usize;
        tmp.clear();
        for t in idx[start..e].chunks_exact(3) {
            let c = col[t[0] as usize]; // every triangle is uniformly coloured (checked offline)
            let slot = match tmp.iter().position(|(k, _)| *k == c) { Some(i) => i, None => { tmp.push((c, Vec::new())); tmp.len() - 1 } };
            for &i in t { tmp[slot].1.push(pos[i as usize]); }
        }
        let mut groups = Vec::new();
        for (c, vs) in tmp.drain(..) {
            let b = c.to_le_bytes();
            let a = b[3] as f32 / 255.0;
            let un = |x: u8| if a > 0.0 { (x as f32 / 255.0 / a).min(1.0) } else { 0.0 };
            let color: Hsla = Rgba { r: un(b[0]), g: un(b[1]), b: un(b[2]), a }.into();
            let s0 = soup.len() as u32;
            soup.extend_from_slice(&vs);
            groups.push(Group { color, key: c, start: s0, end: soup.len() as u32 });
        }
        spans.push(Span { x0: sb[s * 4], y0: sb[s * 4 + 1], x1: sb[s * 4 + 2], y1: sb[s * 4 + 3], groups });
        start = e;
    }
    let family: SharedString = if sc.labels.first().map(|l| l.font_family.contains("Avenir")).unwrap_or(false) { "Avenir Next".into() } else { ".SystemUIFont".into() };
    Data { bg: sc.background.hsla(), ox: m.ox, oy: m.oy, tris: soup.len() / 3, soup, spans, rects: sc.rects, labels: sc.labels, family }
}

// ---------- measurement ----------
#[derive(Default, Clone, serde::Serialize)]
struct Frame {
    scen: String, t: f64,           // seconds since scenario start
    render_gap_ms: f64,             // wall time between successive render() calls (frame callback interval)
    thread_cpu_ms: f64,             // main-thread CPU time between successive render() calls (whole frame incl. gpui draw/encode)
    paint_ms: f64,                  // our canvas paint closure
    render_to_paint_end_ms: f64,    // render() start .. end of paint closure (view + layout + prepaint + paint)
    paths: u32, tris: u32, labels_text: u32, labels_bar: u32, shaped_new: u32,
}
#[derive(Default)]
struct State {
    frames: Vec<Frame>,
    last_render: Option<Instant>,
    last_cpu: f64,
    render_start: Option<Instant>,
    first_paint_ms: Option<f64>,
    scen_idx: usize,
    scen_start: Option<Instant>,
    rss_by_scen: Vec<(String, u64)>,
    done: bool,
}

fn thread_cpu_ms() -> f64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1e3 + ts.tv_nsec as f64 / 1e6
}
fn rusage() -> (f64, u64) {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let cpu = ru.ru_utime.tv_sec as f64 * 1e3 + ru.ru_utime.tv_usec as f64 / 1e3 + ru.ru_stime.tv_sec as f64 * 1e3 + ru.ru_stime.tv_usec as f64 / 1e3;
    (cpu, ru.ru_maxrss as u64) // macOS: bytes
}
fn current_rss_kb() -> u64 {
    std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output()
        .ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

struct Opts { ds: String, scens: Vec<String>, secs: f64, mode: String, min_span_px: f64, labels: bool, out: String }

struct Spike {
    data: Rc<Data>,
    opts: Rc<Opts>,
    bases: Rc<HashMap<String, Cam>>,
    state: Rc<RefCell<State>>,
    shaped: Rc<RefCell<HashMap<(u32, i16), ShapedLine>>>,
    t0: Instant,
    load_ms: f64,
    cpu_scen_start: f64,
    scen_cpu: Vec<(String, f64, usize)>,
}

fn camera(base: Cam, t: f64) -> Cam {
    let tt = 5.0;
    let s1 = (2.0 * std::f64::consts::PI * t / tt).sin();
    let s2 = (4.0 * std::f64::consts::PI * t / tt).sin();
    Cam { zoom: base.zoom * 2f64.powf(0.5 * s1), cx: base.cx + (400.0 / base.zoom) * s1, cy: base.cy + (250.0 / base.zoom) * s2 }
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let cpu = thread_cpu_ms();
        window.request_animation_frame();
        let (scen, t, gap, dcpu, done) = {
            let mut st = self.state.borrow_mut();
            let gap = st.last_render.map(|l| (now - l).as_secs_f64() * 1e3).unwrap_or(0.0);
            let dcpu = if st.last_render.is_some() { cpu - st.last_cpu } else { 0.0 };
            st.last_render = Some(now);
            st.last_cpu = cpu;
            st.render_start = Some(now);
            if st.scen_start.is_none() { st.scen_start = Some(now); self.cpu_scen_start = rusage().0; }
            let mut t = (now - st.scen_start.unwrap()).as_secs_f64();
            if t >= self.opts.secs && !st.done {
                let name = self.opts.scens[st.scen_idx].clone();
                let n = st.frames.iter().filter(|f| f.scen == name).count();
                self.scen_cpu.push((name.clone(), rusage().0 - self.cpu_scen_start, n));
                st.rss_by_scen.push((name, current_rss_kb()));
                st.scen_idx += 1;
                if st.scen_idx >= self.opts.scens.len() { st.done = true; } else { st.scen_start = Some(now); self.cpu_scen_start = rusage().0; t = 0.0; }
            }
            let i = st.scen_idx.min(self.opts.scens.len() - 1);
            (self.opts.scens[i].clone(), t, gap, dcpu, st.done)
        };
        if done {
            self.finish();
            cx.defer(|cx| cx.quit());
        }
        let base = self.bases[&scen];
        let cam = camera(base, t);
        let data = self.data.clone();
        let opts = self.opts.clone();
        let state = self.state.clone();
        let shaped = self.shaped.clone();
        let t0 = self.t0;
        div().size_full().child(
            canvas(move |_, _, _| {}, move |bounds, _, window, cx| {
                let p0 = Instant::now();
                let mut f = Frame { scen: scen.clone(), t, render_gap_ms: gap, thread_cpu_ms: dcpu, ..Default::default() };
                paint_scene(&data, &opts, cam, bounds, &shaped, &mut f, window, cx);
                let p1 = Instant::now();
                let mut st = state.borrow_mut();
                f.paint_ms = (p1 - p0).as_secs_f64() * 1e3;
                f.render_to_paint_end_ms = (p1 - st.render_start.unwrap()).as_secs_f64() * 1e3;
                if st.first_paint_ms.is_none() { st.first_paint_ms = Some((p1 - t0).as_secs_f64() * 1e3); eprintln!("first paint; canvas bounds {:?} scale {}", bounds, window.scale_factor()); }
                if !st.done { st.frames.push(f); if st.frames.len() % 120 == 0 { eprintln!("frames {}", st.frames.len()); } }
            }).size_full(),
        )
    }
}

impl Spike {
    fn finish(&mut self) {
        let st = self.state.borrow();
        let (_, maxrss) = rusage();
        let out = serde_json::json!({
            "dataset": self.opts.ds, "mode": self.opts.mode, "min_span_px": self.opts.min_span_px, "labels": self.opts.labels,
            "load_ms": self.load_ms, "first_paint_ms_since_start": st.first_paint_ms,
            "triangles": self.data.tris, "spans": self.data.spans.len(),
            "groups": self.data.spans.iter().map(|s| s.groups.len()).sum::<usize>(),
            "max_rss_bytes": maxrss, "rss_kb_by_scenario": st.rss_by_scen,
            "process_cpu_ms_by_scenario": self.scen_cpu,
            "gpui_warnings": ERRORS.load(Ordering::Relaxed), "first_warnings": *FIRST_ERRORS.lock().unwrap(),
            "frames": st.frames,
        });
        std::fs::write(&self.opts.out, serde_json::to_vec(&out).unwrap()).unwrap();
        eprintln!("wrote {}", self.opts.out);
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_scene(d: &Data, o: &Opts, cam: Cam, bounds: Bounds<Pixels>, shaped: &RefCell<HashMap<(u32, i16), ShapedLine>>, f: &mut Frame, window: &mut Window, cx: &mut App) {
    let w = f64::from(bounds.size.width);
    let h = f64::from(bounds.size.height);
    let z = cam.zoom;
    let (bx, by) = (f64::from(bounds.origin.x), f64::from(bounds.origin.y));
    window.paint_quad(gpui::fill(bounds, d.bg));
    // visible world rect with a 48 px margin (as the WebGL renderer's cullMarginPx)
    let m = 48.0 / z;
    let (vx0, vx1, vy0, vy1) = (cam.cx - w / 2.0 / z - m, cam.cx + w / 2.0 / z + m, cam.cy - h / 2.0 / z - m, cam.cy + h / 2.0 / z + m);
    // screen = (world - cam) * z + centre; soup is relative to (ox, oy)
    let zf = z as f32;
    let txf = ((d.ox - cam.cx) * z + w / 2.0 + bx) as f32;
    let tyf = ((d.oy - cam.cy) * z + h / 2.0 + by) as f32;
    let tr = |v: [f32; 2]| point(px(v[0] * zf + txf), px(v[1] * zf + tyf));
    let st0 = point(0.0f32, 1.0f32);
    let st = (st0, st0, st0);
    let mut paths = 0u32;
    let mut tris = 0u32;
    let mut by_color: HashMap<u32, (Hsla, Path<Pixels>)> = HashMap::new();
    let mut color_order: Vec<u32> = Vec::new();
    for s in &d.spans {
        if s.x1 < vx0 || s.x0 > vx1 || s.y1 < vy0 || s.y0 > vy1 { continue; }
        if o.min_span_px > 0.0 && ((s.x1 - s.x0).max(s.y1 - s.y0) * z) < o.min_span_px { continue; }
        for g in &s.groups {
            let vs = &d.soup[g.start as usize..g.end as usize];
            if o.mode == "color" {
                let e = by_color.entry(g.key).or_insert_with(|| { color_order.push(g.key); (g.color, Path::new(tr(vs[0]))) });
                for t in vs.chunks_exact(3) { e.1.push_triangle((tr(t[0]), tr(t[1]), tr(t[2])), st); }
            } else {
                let mut p = Path::new(tr(vs[0]));
                for t in vs.chunks_exact(3) { p.push_triangle((tr(t[0]), tr(t[1]), tr(t[2])), st); }
                window.paint_path(p, g.color);
                paths += 1;
            }
            tris += (vs.len() / 3) as u32;
        }
    }
    if o.mode == "color" {
        for k in color_order { let (c, p) = by_color.remove(&k).unwrap(); window.paint_path(p, c); paths += 1; }
    }
    f.paths = paths;
    f.tris = tris;
    // node rects
    for r in &d.rects {
        if r.x + r.w < vx0 || r.x > vx1 || r.y + r.h < vy0 || r.y > vy1 { continue; }
        let b = Bounds { origin: point(px(((r.x - cam.cx) * z + w / 2.0 + bx) as f32), px(((r.y - cam.cy) * z + h / 2.0 + by) as f32)), size: size(px((r.w * z) as f32), px((r.h * z) as f32)) };
        let sw = r.stroke_width.unwrap_or(0.0) * z;
        let fill = r.fill;
        let stroke = r.stroke.unwrap_or(fill);
        window.paint_quad(quad(b, px((r.radius * z) as f32), fill.hsla(), px(sw as f32), stroke.hsla(), BorderStyle::Solid));
    }
    if !o.labels { return; }
    // labels: skip < 0.65 px, bar < 4 px, else GPUI text shaped at a quantised screen size (cached)
    let mut n_text = 0u32; let mut n_bar = 0u32; let mut n_new = 0u32;
    let mut cache = shaped.borrow_mut();
    if cache.len() > 50_000 { cache.clear(); }
    for (i, l) in d.labels.iter().enumerate() {
        let lp = l.font_size * z;
        if lp < 0.65 { continue; }
        let est_w = (l.text.chars().count() as f64 * l.font_size * 0.55).min(l.max_width.unwrap_or(f64::INFINITY).max(l.font_size));
        let lh = l.font_size * 1.25;
        if l.x + est_w / 2.0 < vx0 || l.x - est_w / 2.0 > vx1 || l.y + lh / 2.0 < vy0 || l.y - lh / 2.0 > vy1 { continue; }
        let sx = (l.x - cam.cx) * z + w / 2.0 + bx;
        let sy = (l.y - cam.cy) * z + h / 2.0 + by;
        if lp < 4.0 {
            let bw = est_w * 0.65 * z;
            let bh = (l.font_size * 0.45 * z).max(1.4);
            let c = l.color; let a = 0.55;
            window.paint_quad(quad(Bounds { origin: point(px((sx - bw / 2.0) as f32), px((sy - bh / 2.0) as f32)), size: size(px(bw as f32), px(bh as f32)) },
                px((bh / 2.0) as f32), Rgba { r: c.r, g: c.g, b: c.b, a: c.a * a }, px(0.0), gpui::transparent_black(), BorderStyle::Solid));
            n_bar += 1;
            continue;
        }
        // quantise the screen font size to 2^(1/16) steps so shaped lines and glyph rasters can be reused
        let b = (lp.log2() * 16.0).round() as i16;
        let fs = 2f64.powf(b as f64 / 16.0);
        let line = cache.entry((i as u32, b)).or_insert_with(|| {
            n_new += 1;
            let font = Font { weight: if l.bold { FontWeight::BOLD } else { FontWeight::NORMAL }, ..gpui::font(d.family.clone()) };
            let run = TextRun { len: l.text.len(), font, color: l.color.hsla(), background_color: None, underline: None, strikethrough: None };
            window.text_system().shape_line(SharedString::from(l.text.clone()), px(fs as f32), &[run], None)
        });
        let lw = f64::from(line.width);
        let lhs = fs * 1.25;
        let _ = line.paint(point(px((sx - lw / 2.0) as f32), px((sy - lhs / 2.0) as f32)), px(lhs as f32), window, cx);
        n_text += 1;
    }
    f.labels_text = n_text; f.labels_bar = n_bar; f.shaped_new = n_new;
}

fn main() {
    let t0 = Instant::now();
    log::set_logger(&LOGGER).ok();
    log::set_max_level(log::LevelFilter::Warn);
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str, dflt: &str| -> String { args.iter().position(|a| a == k).map(|i| args[i + 1].clone()).unwrap_or(dflt.to_string()) };
    let ds = args.get(1).cloned().unwrap_or("5000-clean".into());
    let opts = Opts {
        scens: get("--scen", "fit,z035,z1").split(',').map(String::from).collect(),
        secs: get("--secs", "5").parse().unwrap(),
        mode: get("--mode", "span"),
        min_span_px: get("--min-span-px", "0").parse().unwrap(),
        labels: get("--labels", "1") == "1",
        out: get("--out", &format!("{ds}.json")),
        ds: ds.clone(),
    };
    let kill_after: u64 = get("--kill-after", "60").parse().unwrap();
    std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(kill_after)); eprintln!("watchdog: exiting"); std::process::exit(3); });
    let size_key = ds.split('-').next().unwrap().to_string();
    let cp: serde_json::Value = serde_json::from_slice(&rd(&format!("{EXPORT}/camera-path.json"))).unwrap();
    let bases: HashMap<String, Cam> = serde_json::from_value(cp["bases"][&size_key].clone()).unwrap();
    let l0 = Instant::now();
    let data = load(&ds);
    let load_ms = l0.elapsed().as_secs_f64() * 1e3;
    eprintln!("loaded {ds}: {} spans, {} tris, {} labels in {load_ms:.1} ms", data.spans.len(), data.tris, data.labels.len());
    let data = Rc::new(data);
    let opts = Rc::new(opts);
    let bases = Rc::new(bases);
    Application::new().run(move |cx: &mut App| {
        let displays = cx.displays();
        for dsp in &displays { eprintln!("display {:?} bounds {:?}", dsp.id(), dsp.bounds()); }
        // built-in panel: 3456x2234 physical = 1728x1117 logical
        let builtin = displays.iter().find(|d| (f64::from(d.bounds().size.width) - 1728.0).abs() < 1.0).cloned().or_else(|| cx.primary_display());
        let origin = builtin.as_ref().map(|d| d.bounds().origin).unwrap_or(point(px(0.), px(0.)));
        let wb = Bounds { origin: point(origin.x + px(60.), origin.y + px(60.)), size: size(px(1440.), px(900.)) };
        let opts2 = opts.clone();
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(wb)),
                titlebar: Some(TitlebarOptions { title: Some("gpui-spike".into()), ..Default::default() }),
                focus: false,
                kind: if std::env::var("SPIKE_POPUP").is_ok() { gpui::WindowKind::PopUp } else { gpui::WindowKind::Normal },
                display_id: builtin.as_ref().map(|d| d.id()),
                ..Default::default()
            },
            move |window, cx| {
                if let Ok(ms) = std::env::var("SPIKE_DRIVE_MS") {
                    // The screen may be locked: macOS reports the window occluded and gpui stops its
                    // CVDisplayLink, so no frames are requested. Drive displayLayer: ourselves instead.
                    let period = std::time::Duration::from_secs_f64(ms.parse::<f64>().unwrap() / 1e3);
                    let view = match raw_window_handle::HasWindowHandle::window_handle(window).unwrap().as_raw() {
                        raw_window_handle::RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as usize,
                        _ => panic!("not appkit"),
                    };
                    let mut next = Instant::now();
                    cx.spawn(async move |cx| loop {
                        next += period; // absolute schedule so the cadence does not drift by the timer latency
                        let now = Instant::now();
                        if next < now { next = now; }
                        cx.background_executor().timer(next - now).await;
                        unsafe {
                            use objc::{msg_send, sel, sel_impl};
                            let v = view as *mut objc::runtime::Object;
                            let layer: *mut objc::runtime::Object = msg_send![v, layer];
                            let _: () = msg_send![layer, setNeedsDisplay];
                        }
                    }).detach();
                }
                cx.new(|_| Spike {
                data: data.clone(), opts: opts2, bases: bases.clone(), state: Default::default(), shaped: Default::default(),
                t0, load_ms, cpu_scen_start: 0.0, scen_cpu: Vec::new(),
            })
            },
        ).unwrap();
    });
}
