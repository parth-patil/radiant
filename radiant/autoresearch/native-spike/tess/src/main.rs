//! bench <dataset dir>... --runs N --out results.json
//! Each dataset dir holds specs.json (BranchSpec[] from the dev server) and the TS outputs ts-pos.bin (f64 positions),
//! ts-col.bin (f32 colours), ts-idx.bin (u32), ts-vtx.bin (packed) and ts.json (with SHA-256 of bounds and ends).
use radiant_tess_spike::*;
use sha2::{Digest, Sha256};
use std::time::Instant;

fn sha<T: Copy>(v: &[T]) -> String {
    let bytes = unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) };
    Sha256::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect()
}
fn read_f64(p: &str) -> Vec<f64> { std::fs::read(p).unwrap().chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect() }
fn read_f32(p: &str) -> Vec<f32> { std::fs::read(p).unwrap().chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect() }
fn read_u32(p: &str) -> Vec<u32> { std::fs::read(p).unwrap().chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect() }

fn stats(v: &[f64]) -> String {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| s[((p * (s.len() - 1) as f64) + 0.5) as usize];
    format!("{{\"n\":{},\"med\":{:.3},\"min\":{:.3},\"p25\":{:.3},\"p75\":{:.3},\"max\":{:.3},\"all\":[{}]}}",
        s.len(), q(0.5), s[0], q(0.25), q(0.75), s[s.len() - 1],
        v.iter().map(|x| format!("{:.3}", x)).collect::<Vec<_>>().join(","))
}

fn time<R>(runs: usize, mut f: impl FnMut() -> R) -> Vec<f64> {
    for _ in 0..2 { drop(std::hint::black_box(f())); }
    (0..runs).map(|_| {
        let t = Instant::now();
        let r = f();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        drop(std::hint::black_box(r));
        ms
    }).collect()
}

fn same_mesh(a: &Mesh, b: &Mesh) -> bool {
    a.positions.len() == b.positions.len() && a.indices == b.indices && a.ends == b.ends
        && a.positions.iter().zip(&b.positions).all(|(x, y)| x.to_bits() == y.to_bits())
        && a.colors.iter().zip(&b.colors).all(|(x, y)| x.to_bits() == y.to_bits())
        && a.bounds.iter().zip(&b.bounds).all(|(x, y)| x.to_bits() == y.to_bits())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut runs = 15usize;
    let mut out = String::from("rust-results.json");
    let mut threads: Vec<usize> = vec![4, 10, 14];
    let mut chunk = 256usize;
    let mut dirs = vec![];
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--runs" => { runs = args[i + 1].parse().unwrap(); i += 1; }
            "--out" => { out = args[i + 1].clone(); i += 1; }
            "--threads" => { threads = args[i + 1].split(',').map(|x| x.parse().unwrap()).collect(); i += 1; }
            "--chunk" => { chunk = args[i + 1].parse().unwrap(); i += 1; }
            d => dirs.push(d.to_string()),
        }
        i += 1;
    }
    let mut results = vec![];
    for d in &dirs {
        let t = Instant::now();
        let json = std::fs::read_to_string(format!("{d}/specs.json")).unwrap();
        let read_ms = t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now();
        let specs = parse_specs(&json);
        let parse_ms = t.elapsed().as_secs_f64() * 1e3;
        let zoom = MESH_DETAIL_ZOOM;

        // ---- parity with the TypeScript output
        let m = tessellate(&specs, zoom);
        let p = pack(&m);
        let ts_pos = read_f64(&format!("{d}/ts-pos.bin"));
        let ts_col = read_f32(&format!("{d}/ts-col.bin"));
        let ts_idx = read_u32(&format!("{d}/ts-idx.bin"));
        let ts_vtx = std::fs::read(format!("{d}/ts-vtx.bin")).unwrap();
        let ts_json = std::fs::read_to_string(format!("{d}/ts.json")).unwrap();
        let tsv: serde_json::Value = serde_json::from_str(&ts_json).unwrap();
        let ts = &tsv["ts"];
        let pos_bits_diff = m.positions.iter().zip(&ts_pos).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
        let pos_max_abs = m.positions.iter().zip(&ts_pos).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        let col_diff = m.colors.iter().zip(&ts_col).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
        let idx_diff = m.indices.iter().zip(&ts_idx).filter(|(a, b)| a != b).count();
        let vtx_diff = p.buffer.iter().zip(&ts_vtx).filter(|(a, b)| a != b).count();
        let samples: Vec<String> = [0usize, 1, 7, 1000, m.positions.len() / 4, m.positions.len() / 2 - 1].iter().map(|&v| {
            format!("{{\"v\":{},\"rust\":[{:?},{:?}],\"ts\":[{:?},{:?}]}}", v, m.positions[2 * v], m.positions[2 * v + 1], ts_pos[2 * v], ts_pos[2 * v + 1])
        }).collect();
        let parity = format!(
            "{{\"specs\":{},\"nv\":{},\"ni\":{},\"ts_nv\":{},\"ts_ni\":{},\"pos_values_differing_bits\":{},\"pos_max_abs_diff\":{:e},\"col_values_differing\":{},\"idx_differing\":{},\"packed_bytes\":{},\"ts_packed_bytes\":{},\"packed_bytes_differing\":{},\"ox\":{:?},\"oy\":{:?},\"wide\":{},\"ts_ox\":{},\"ts_oy\":{},\"sha_packed\":{},\"sha_idx\":{},\"sha_bounds\":{},\"sha_ends\":{},\"samples\":[{}]}}",
            specs.len(), m.positions.len() / 2, m.indices.len(), ts["nv"], ts["ni"], pos_bits_diff, pos_max_abs, col_diff, idx_diff,
            p.buffer.len(), ts_vtx.len(), vtx_diff, p.ox, p.oy, p.wide, ts["ox"], ts["oy"],
            sha(&p.buffer) == ts["shaPacked"].as_str().unwrap(), sha(&m.indices) == ts["shaIdx"].as_str().unwrap(),
            sha(&m.bounds) == ts["shaBounds"].as_str().unwrap(), sha(&m.ends) == ts["shaEnds"].as_str().unwrap(),
            samples.join(","));
        eprintln!("{d}: parity {parity}");

        // ---- timings
        let mut timings = vec![];
        timings.push(("st_tess".to_string(), time(runs, || tessellate(&specs, zoom))));
        timings.push(("st_pack".to_string(), time(runs, || pack(&m))));
        timings.push(("st_tess_pack".to_string(), time(runs, || { let m = tessellate(&specs, zoom); let p = pack(&m); (m, p) })));
        // compute only: plans + emit into buffers reused across runs (no fresh pages to fault in)
        let lod = lod_of(zoom);
        let mut reuse = Mesh { positions: vec![0.0; m.positions.len()], colors: vec![0.0; m.colors.len()], indices: vec![0; m.indices.len()], bounds: vec![0.0; m.bounds.len()], ends: vec![0; m.ends.len()] };
        timings.push(("st_tess_reuse_buffers".to_string(), time(runs, || {
            let plans: Vec<Plan> = specs.iter().map(|s| plan(s, lod, zoom)).collect();
            fill(&specs, &plans, &mut reuse);
        })));
        let mut par_same = vec![];
        for &n in &threads {
            let pool = rayon::ThreadPoolBuilder::new().num_threads(n).build().unwrap();
            pool.install(|| {
                let a = par::tessellate_prefix(&specs, zoom, chunk);
                let b = par::tessellate_concat(&specs, zoom, chunk);
                let pp = par::pack_par(&a, 4096);
                par_same.push(format!("{{\"threads\":{},\"prefix_identical\":{},\"concat_identical\":{},\"pack_identical\":{}}}", n, same_mesh(&a, &m), same_mesh(&b, &m), pp.buffer == p.buffer));
                timings.push((format!("par{n}_tess_prefix"), time(runs, || par::tessellate_prefix(&specs, zoom, chunk))));
                timings.push((format!("par{n}_tess_concat"), time(runs, || par::tessellate_concat(&specs, zoom, chunk))));
                timings.push((format!("par{n}_pack"), time(runs, || par::pack_par(&m, 4096))));
                timings.push((format!("par{n}_tess_prefix_pack"), time(runs, || { let m = par::tessellate_prefix(&specs, zoom, chunk); let p = par::pack_par(&m, 4096); (m, p) })));
            });
        }
        let tj: Vec<String> = timings.iter().map(|(k, v)| format!("\"{k}\":{}", stats(v))).collect();
        for (k, v) in &timings {
            let mut s = v.clone(); s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            eprintln!("  {k:28} med {:8.3} ms  min {:8.3}  max {:8.3}", s[s.len() / 2], s[0], s[s.len() - 1]);
        }
        results.push(format!("{{\"dir\":{:?},\"read_ms\":{:.3},\"json_parse_ms\":{:.3},\"chunk\":{},\"parity\":{},\"par_identical\":[{}],\"timings_ms\":{{{}}}}}",
            d, read_ms, parse_ms, chunk, parity, par_same.join(","), tj.join(",")));
    }
    std::fs::write(&out, format!("[{}]\n", results.join(",\n"))).unwrap();
}
