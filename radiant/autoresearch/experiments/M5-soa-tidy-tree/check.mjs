// Compare layoutDoc of two builds (old.js, new.js) on captured docs, every tidy layout kind, both balances, and a
// spacing callback. Usage: bun|node check.mjs <input-N.json>...
import { readFileSync } from 'node:fs';
const A = await import('./old.js'), B = await import('./new.js');
let bad = 0;
for (const file of process.argv.slice(2)) {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  const sizes = new Map(input.sizes);
  for (const layout of ['mindmap', 'left', 'right', 'down', 'up', 'compact']) for (const balance of ['extent', 'alternate']) for (const spaced of [false, true]) {
    const doc = structuredClone(input.doc);
    for (const id of Object.keys(doc.nodes)) { doc.nodes[id].children ??= []; }
    const root = doc.roots[0];
    doc.rootInfo[root].layout = layout;
    // pin a few main branches to a side, as users do
    doc.nodes[root].children.forEach((c, i) => { if (i % 3 === 1) doc.nodes[c].side = i % 2 ? 'left' : 'right'; });
    const opts = { levelGap: input.levelGap, siblingGap: input.siblingGap, balance };
    if (spaced) opts.spacing = (a, b) => 4 + ((a.charCodeAt(0) + b.charCodeAt(1)) % 7);
    const a = A.layoutDoc(doc, sizes, opts), b = B.layoutDoc(doc, sizes, opts);
    let diff = 0, n = 0;
    for (const [id, x] of a.boxes) { const y = b.boxes.get(id); n++; if (!y || x.x !== y.x || x.y !== y.y || x.side !== y.side) diff++; }
    if (a.boxes.size !== b.boxes.size) diff++;
    if (diff) bad++;
    console.log(diff ? 'FAIL' : 'PASS', file.split('/').pop(), layout, balance, spaced ? 'spacing' : '', n, 'boxes', diff, 'differ');
  }
}
process.exit(bad ? 1 : 0);
