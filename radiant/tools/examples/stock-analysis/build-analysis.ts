// Finish a filled analysis: check it against the template, place the sketch panels around the laid-out map, build the bundle.
// Run: bun tools/examples/stock-analysis/build-analysis.ts DIR [--template FILE]
// DIR holds analysis.map.md (the filled outline and links, without a canvas block) and panels.json:
// { company, ticker, asOf, steps: [{ title, finding } × 5], keyNumbers: [{ title, lines: [...] } × up to 5],
//   decision: { question, yes, no, answer: "yes" | "no", summary } }
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('Usage: build-analysis.ts DIR [--template FILE]'); process.exit(2); }
const flag = args.indexOf('--template');
const templatePath = flag >= 0 ? args[flag + 1] : new URL('./template.map.md', import.meta.url).pathname;
const cli = new URL('../../agent-cli.ts', import.meta.url).pathname;
const fail = (message: string): never => { console.error('STOPPED ' + message); process.exit(1); };

function radiant(argv: string[]): { ok: boolean; data?: any; error?: any } {
  const run = spawnSync('bun', [cli, ...argv, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(run.stdout); } catch { return { ok: false, error: { message: (run.stderr || run.stdout || 'no output').slice(0, 600) } }; }
}

const specPath = join(dir, 'analysis.map.md'), panelsPath = join(dir, 'panels.json');
if (!existsSync(specPath) || !existsSync(panelsPath)) fail('DIR needs analysis.map.md and panels.json.');
const spec = readFileSync(specPath, 'utf8');
if (/^```canvas/m.test(spec)) fail('analysis.map.md must not hold a canvas block; this script draws the panels.');
const panels = JSON.parse(readFileSync(panelsPath, 'utf8'));

// ---------------------------------------------------------------- the template is the checklist
const nodeLine = /^\s*(?:#{1,6}|[-*])\s+(.*?)\s*\{#([A-Za-z0-9_-]+)[^}]*\}\s*$/;
const read = (text: string) => {
  const nodes = new Map<string, string>();
  for (const line of text.split('\n')) { const m = nodeLine.exec(line); if (m) nodes.set(m[2], m[1].replace(/^\[[ x]\]\s*/, '')); }
  return nodes;
};
const template = read(readFileSync(templatePath, 'utf8')), filled = read(spec);
const missing = [...template].filter(([id]) => !filled.has(id)).map(([id, label]) => label + ' (#' + id + ')');
const unfilled = [...template].filter(([id, label]) => filled.get(id) === label).map(([id, label]) => label + ' (#' + id + ')');
if (missing.length) fail('These template attributes are missing from the analysis; keep every one, marked "not found" when nothing was found:\n  ' + missing.join('\n  '));

// ---------------------------------------------------------------- lay the map out, then draw around it
const draft = join(dir, '.draft.radiant.zip');
const first = radiant(['build', specPath, '-o', draft, '--replace']);
if (!first.ok) fail('The outline does not build: ' + JSON.stringify(first.error).slice(0, 1200));
const layout = radiant(['layout', draft, '--limit', '1']);
const b = layout.data?.bounds as { x: number; y: number; w: number; h: number } | undefined;
if (!b) fail('No layout bounds: ' + JSON.stringify(layout.error ?? layout.data).slice(0, 600));

const escape = (text: string) => text.replace(/&/g, '&#38;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/\r?\n/g, '&#10;');
function wrap(text: string, width: number, most: number): string {
  const lines: string[] = [];
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const tail = lines[lines.length - 1];
    if (tail !== undefined && (tail + ' ' + word).length <= width) lines[lines.length - 1] = tail + ' ' + word; else lines.push(word);
  }
  if (lines.length > most) { lines.length = most; lines[most - 1] = lines[most - 1].slice(0, width - 1).trimEnd() + '…'; }
  return lines.join('\n');
}
const lines: string[] = [];
const el = (kind: string, id: string, x: number, y: number, w: number, h: number, attrs: string, text?: string) =>
  lines.push(kind + ' #' + id + ' at=' + Math.round(x) + ',' + Math.round(y) + ' size=' + Math.round(w) + 'x' + Math.round(h) + ' roughness=1' + (attrs ? ' ' + attrs : '') + (text ? ' : ' + escape(text) : ''));
const arrow = (id: string, from: string, to: string, attrs: string, text?: string) =>
  lines.push('arrow #' + id + ' at=0,0 size=100x0 roughness=1 points=0,0,100,0 from=' + from + ' to=' + to + (attrs ? ' ' + attrs : '') + (text ? ' : ' + escape(text) : ''));
const cx = b!.x + b!.w / 2;
const heading = [panels.company && panels.ticker ? panels.company + ' (' + panels.ticker + ')' : panels.company ?? panels.ticker ?? 'Analysis', panels.asOf ? 'as of ' + panels.asOf : ''].filter(Boolean).join(' · ');

// The path through the analysis: one box per stage, with what that stage found.
const palette = [['#2B7DE9', '#CDE7FD'], ['#12A07C', '#C9F0E2'], ['#8A5CF5', '#E2D8FD'], ['#F08C00', '#FFE8BF'], ['#E8478B', '#FBD3E3']];
const steps: { title: string; finding: string }[] = (panels.steps ?? []).slice(0, 5);
if (steps.length) {
  const bw = 270, bh = 96, gap = 70, capH = 76, stripW = steps.length * bw + (steps.length - 1) * gap + 120, stripH = 70 + bh + 14 + capH + 30, top = b!.y - stripH - 110;
  el('frame', 'flow', cx - stripW / 2, top, stripW, stripH, '', heading);
  steps.forEach((step, i) => {
    const x = cx - stripW / 2 + 60 + i * (bw + gap), [stroke, fill] = palette[i % palette.length];
    el('rect', 's' + i, x, top + 70, bw, bh, 'stroke=' + stroke + ' fill=' + fill + ' fillStyle=hachure round frame=flow', wrap(step.title, 22, 2));
    el('text', 't' + i, x - 10, top + 70 + bh + 14, bw + 20, capH, 'frame=flow fontSize=16 font=hand align=center', wrap(step.finding, 32, 3));
    if (i) arrow('a' + i, 's' + (i - 1), 's' + i, 'stroke=#495057 frame=flow');
  });
}

// Key numbers and the decision, below the map.
const fills = ['#FFF3BF', '#D3F9D8', '#D0EBFF', '#E5DBFF', '#FFE3E3'];
const notes: { title: string; lines: string[] }[] = (panels.keyNumbers ?? []).slice(0, 5);
const nw = 290, nh = 200, ngap = 36, rowW = Math.max(1, notes.length) * nw + (Math.max(1, notes.length) - 1) * ngap + 100, bottom = b!.y + b!.h + 130;
const decision = panels.decision as { question: string; yes: string; no: string; answer: 'yes' | 'no'; summary?: string } | undefined;
const decisionW = decision ? 660 : 0, left = cx - (rowW + (decision ? 60 + decisionW : 0)) / 2, frameH = nh + 150;
if (notes.length) {
  el('frame', 'numbers', left, bottom, rowW, frameH, '', 'Key numbers');
  notes.forEach((note, i) => el('note', 'k' + i, left + 50 + i * (nw + ngap), bottom + 70, nw, nh, 'fill=' + fills[i % fills.length] + ' frame=numbers fontSize=17 font=hand',
    [note.title, ...(note.lines ?? []).slice(0, 5).map((line) => wrap(line, 30, 2))].join('\n')));
}
if (decision) {
  const dx = left + (notes.length ? rowW + 60 : 0), yes = decision.answer === 'yes';
  const chosen = 'strokeWidth=4 fillStyle=solid', other = 'fillStyle=hachure opacity=0.45';
  el('frame', 'decision', dx, bottom, decisionW, frameH, '', 'The decision');
  el('diamond', 'q', dx + 40, bottom + 70, 240, 170, 'stroke=#F08C00 fill=#FFE8BF fillStyle=hachure frame=decision', wrap(decision.question, 16, 3));
  el('rect', 'yes', dx + 390, bottom + 62, 230, 76, 'stroke=#12A07C fill=#C9F0E2 round frame=decision ' + (yes ? chosen : other), wrap(decision.yes, 22, 2));
  el('rect', 'no', dx + 390, bottom + 172, 230, 76, 'stroke=#E03131 fill=#FFE3E3 round frame=decision ' + (yes ? other : chosen), wrap(decision.no, 22, 2));
  arrow('ay', 'q', 'yes', 'stroke=#12A07C frame=decision' + (yes ? ' strokeWidth=4' : ' opacity=0.45'), 'yes');
  arrow('an', 'q', 'no', 'stroke=#E03131 frame=decision' + (yes ? ' opacity=0.45' : ' strokeWidth=4'), 'no');
  if (decision.summary) el('text', 'verdict', dx + 30, bottom + frameH - 84, decisionW - 60, 60, 'frame=decision fontSize=17 font=hand align=center', wrap(decision.summary, 60, 2));
}

// ---------------------------------------------------------------- build and check
const name = String(panels.ticker ?? basename(resolve(dir))).replace(/[^A-Za-z0-9._-]+/g, '-');
const finalSpec = join(dir, name + '-fundamental-analysis.map.md'), out = join(dir, name + '-fundamental-analysis.radiant.zip');
writeFileSync(finalSpec, spec.trimEnd() + '\n\n```canvas\n' + lines.join('\n') + '\n```\n');
const built = radiant(['build', finalSpec, '-o', out, '--replace']);
if (!built.ok) fail('The finished map does not build: ' + JSON.stringify(built.error).slice(0, 1200));
spawnSync('rm', ['-f', draft]);
const stats = radiant(['stats', out]).data, lint = radiant(['lint', out]).data, valid = radiant(['validate', out]);
console.log(JSON.stringify({
  map: out, spec: finalSpec, nodes: stats?.nodes, depth: stats?.depth, links: stats?.links, canvasElements: lines.length,
  templateAttributes: template.size, stillTemplateText: unfilled, warnings: built.data?.warnings ?? [], valid: valid.ok,
  lint: { counts: lint?.counts, rules: [...new Set((lint?.issues ?? []).map((i: { rule: string }) => i.rule))] }
}, null, 2));
