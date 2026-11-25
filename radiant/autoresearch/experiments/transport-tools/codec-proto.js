
window.__codec = (() => {
  function encode(records) {
    const shapes = [], shapeIndex = new Map(), shapeOf = new Uint16Array(records.length);
    const cols = new Map();
    const strings = [], stringIndex = new Map();
    const str = (s) => { let i = stringIndex.get(s); if (i === undefined) { i = strings.length; strings.push(s); stringIndex.set(s, i); } return i; };
    for (let r = 0; r < records.length; r++) {
      const o = records[r];
      const keys = Object.keys(o);
      const sig = keys.join('|');
      let s = shapeIndex.get(sig);
      if (s === undefined) { s = shapes.length; shapes.push(keys); shapeIndex.set(sig, s); }
      shapeOf[r] = s;
      for (const k of keys) {
        const v = o[k];
        let c = cols.get(k);
        if (!c) cols.set(k, c = { vals: [], tags: [] });
        const t = typeof v;
        if (t === 'number') { c.tags.push(0); c.vals.push(v); }
        else if (t === 'string') { c.tags.push(1); c.vals.push(str(v)); }
        else if (t === 'boolean') { c.tags.push(2); c.vals.push(v ? 1 : 0); }
        else if (v === undefined) { c.tags.push(3); c.vals.push(0); }
        else if (v === null) { c.tags.push(4); c.vals.push(0); }
        else { c.tags.push(5); (c.nested ??= []).push(v); c.vals.push(0); }
      }
    }
    const columns = {};
    const transfer = [];
    for (const [k, c] of cols) {
      const vals = Float64Array.from(c.vals), tags = Uint8Array.from(c.tags);
      transfer.push(vals.buffer, tags.buffer);
      let nested;
      if (c.nested) {
        if (c.nested.every(v => v && typeof v === 'object' && !Array.isArray(v))) { const e = encode(c.nested); transfer.push(...e.transfer); const { transfer: _t, ...rest } = e; nested = rest; }
        else nested = { raw: c.nested };
      }
      columns[k] = { vals, tags, nested };
    }
    return { n: records.length, shapes, shapeOf, strings, columns, transfer: [shapeOf.buffer, ...transfer] };
  }
  function decode(p) {
    const out = new Array(p.n);
    const cursors = {}, nestedOut = {};
    for (const k in p.columns) { cursors[k] = 0; const c = p.columns[k]; if (c.nested) nestedOut[k] = { list: c.nested.raw ?? decode(c.nested), at: 0 }; }
    const { columns, strings, shapes, shapeOf } = p;
    for (let r = 0; r < p.n; r++) {
      const keys = shapes[shapeOf[r]];
      const o = {};
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        const c = columns[k];
        const i = cursors[k]++;
        const tag = c.tags[i];
        o[k] = tag === 0 ? c.vals[i] : tag === 1 ? strings[c.vals[i]] : tag === 2 ? c.vals[i] === 1 : tag === 3 ? undefined : tag === 4 ? null : nestedOut[k].list[nestedOut[k].at++];
      }
      out[r] = o;
    }
    return out;
  }
  const FLOW = ['h', 'v', 'r'];
  function encodeBoxes(map) {
    const n = map.size, ids = new Array(n), f = new Float64Array(n * 4), depth = new Int32Array(n), main = new Int32Array(n), side = new Int8Array(n), flow = new Uint8Array(n);
    let i = 0;
    for (const [id, b] of map) { ids[i] = id; f[4*i] = b.x; f[4*i+1] = b.y; f[4*i+2] = b.w; f[4*i+3] = b.h; depth[i] = b.depth; main[i] = b.mainBranch; side[i] = b.side; flow[i] = b.flow === 'h' ? 0 : b.flow === 'v' ? 1 : 2; i++; }
    return { ids, f, depth, main, side, flow, transfer: [f.buffer, depth.buffer, main.buffer, side.buffer, flow.buffer] };
  }
  function decodeBoxes(p) {
    const m = new Map(), { ids, f, depth, main, side, flow } = p;
    for (let i = 0; i < ids.length; i++) m.set(ids[i], { id: ids[i], x: f[4*i], y: f[4*i+1], w: f[4*i+2], h: f[4*i+3], depth: depth[i], side: side[i], flow: FLOW[flow[i]], mainBranch: main[i] });
    return m;
  }
  return { encode, decode, encodeBoxes, decodeBoxes };
})();
