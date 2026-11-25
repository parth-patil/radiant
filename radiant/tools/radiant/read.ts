import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  specFromDoc, suggest, themeForDoc, writeMapSpecMarkdown, type MapSpecNode
} from '../../src/lib/core/io/map-spec';
import { createStyleResolver } from '../../src/lib/core/geometry/style';
import { mainBranchIndex } from '../../src/lib/core/model';
import type { Doc, MapNode, NodeId } from '../../src/lib/core/types';
import { flagBool, flagList, flagString, positiveInt, type ParsedArgs } from './args';
import { CliError, EXIT, OUTPUT_BUDGET, notFound, usageError, type CommandResult } from './envelope';
import { openMap, type MapSource } from './sources';
import { describeStoredMap, listMapFiles, readHistory } from './store';
import { prepareOutput, writeAtomic } from './spec-io';

export interface Ctx {
  args: ParsedArgs;
  json: boolean;
  command: string;
}

const short = (text: string, max = 60) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

/** Ancestor ids from the root down, excluding id. */
export function ancestors(doc: Doc, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (let p = doc.nodes[id]?.parent ?? null; p !== null; p = doc.nodes[p].parent) out.push(p);
  return out.reverse();
}

/** Not found, with the nearest ids and ids whose label matches what was typed. */
export function unknownNode(src: MapSource, id: string): CliError {
  const ids = Object.keys(src.doc.nodes);
  const q = id.toLowerCase();
  const byLabel = ids.filter((k) => src.doc.nodes[k].text.toLowerCase() === q);
  const contains = q.length >= 3 ? ids.filter((k) => src.doc.nodes[k].text.toLowerCase().includes(q)) : [];
  const suggestions = [...new Set([...suggest(id, ids, 3), ...byLabel, ...contains])].slice(0, 5);
  return notFound('unknown_node', 'No node "' + id + '" in ' + src.path + '.', {
    suggestions, hint: 'radiant find ' + quoteArg(src.path) + ' ' + quoteArg(id)
  });
}

export const quoteArg = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";

function budgetOf(ctx: Ctx, toFile: boolean): number {
  if (toFile || flagBool(ctx.args, 'all')) return Infinity;
  return positiveInt(ctx.args, 'max-chars', OUTPUT_BUDGET, 200)!;
}

/** Write command output to -o FILE when asked; returns the canonical path. */
export function writeOutput(ctx: Ctx, text: string): string | undefined {
  const out = flagString(ctx.args, 'output');
  if (!out) return undefined;
  const target = prepareOutput(out, { replace: flagBool(ctx.args, 'replace'), root: flagString(ctx.args, 'root') });
  writeAtomic(target, new TextEncoder().encode(text), target.exists);
  return target.path;
}

const STYLE_KEYS = ['color', 'text', 'fill', 'shape', 'branch', 'width', 'bold', 'italic', 'size', 'font', 'align', 'emphasis', 'curved', 'boundary', 'extruded'];
const FIELD_GROUPS: Record<string, string[]> = {
  id: ['id'], note: ['note'], style: STYLE_KEYS, tags: ['tags'], task: ['task'], sticker: ['sticker'], href: ['href'],
  folded: ['folded'], side: ['side'], layout: ['layout', 'spacing', 'organic'], image: ['image', 'alt', 'scale']
};

function keepFields(nodes: MapSpecNode[] | undefined, keep: Set<string>): void {
  for (const n of nodes ?? []) {
    for (const key of Object.keys(n)) if (key !== 'label' && key !== 'children' && !keep.has(key)) delete (n as unknown as Record<string, unknown>)[key];
    keepFields(n.children, keep);
  }
}

function fieldList(ctx: Ctx, allowed: string[]): string[] | null {
  const raw = flagList(ctx.args, 'fields').flatMap((f) => f.split(',')).map((f) => f.trim()).filter(Boolean);
  if (!raw.length) return null;
  for (const f of raw) if (!allowed.includes(f)) throw usageError('Unknown field "' + f + '". Fields: ' + allowed.join(', ') + '.', { suggestions: suggest(f, allowed) });
  return raw;
}

function maxDepthBelow(doc: Doc, tops: NodeId[]): number {
  let max = 0;
  const stack: [NodeId, number][] = tops.map((t) => [t, 0]);
  while (stack.length) {
    const [id, d] = stack.pop()!;
    max = Math.max(max, d);
    for (const c of doc.nodes[id].children) stack.push([c, d + 1]);
  }
  return max;
}

export async function getCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const src = await openMap(path);
  const { doc } = src;
  const node = flagString(ctx.args, 'node');
  if (node !== undefined && !doc.nodes[node]) throw unknownNode(src, node);
  const format = flagString(ctx.args, 'format') ?? 'outline';
  const depth = positiveInt(ctx.args, 'depth');
  const toFile = !!flagString(ctx.args, 'output');
  const budget = budgetOf(ctx, toFile);
  const base = { backend: src.backend, path: src.path, kind: src.kind, revision: 'sha256:' + src.revision, format,
    ...(node ? { node } : {}), ...(depth !== undefined ? { depth } : {}) };
  const continueWith = (cut: { id: string }[]) => [
    ...cut.slice(0, 10).map((c) => 'radiant get ' + quoteArg(src.path) + ' --node ' + c.id),
    'radiant get ' + quoteArg(src.path) + (format !== 'outline' ? ' --format ' + format : '') + ' -o FILE'
  ];

  if (format === 'json') {
    const fields = fieldList(ctx, ['text', 'note', 'style', 'tags', 'task', 'sticker', 'link', 'collapsed', 'side', 'branchLayout', 'imageAsset', 'imageAlt', 'origin']);
    let value: unknown = doc;
    let count = Object.keys(doc.nodes).length;
    if (node || depth !== undefined || fields) {
      const tops = node ? [node] : doc.roots;
      const nodes: Record<string, Partial<MapNode>> = {};
      const stack: [NodeId, number][] = tops.map((t) => [t, 0]);
      while (stack.length) {
        const [id, d] = stack.pop()!;
        const n = doc.nodes[id];
        const record: Record<string, unknown> = { id: n.id, parent: n.parent, children: n.children };
        for (const [k, v] of Object.entries(n)) if (!fields || fields.includes(k)) record[k] = v;
        nodes[id] = record as Partial<MapNode>;
        if (depth === undefined || d < depth) for (const c of n.children) stack.push([c, d + 1]);
      }
      count = Object.keys(nodes).length;
      value = { ...(node ? { node } : { roots: doc.roots }), nodes, links: doc.links.filter((l) => nodes[l.from] && nodes[l.to]) };
    }
    const text = JSON.stringify(value, null, 2);
    const written = writeOutput(ctx, text + '\n');
    if (written) return { type: 'get.result', data: { ...base, outputPath: written, nodes: count, total: count, truncated: false }, text: 'Wrote ' + written };
    if (text.length > budget) {
      return {
        type: 'get.result',
        data: { ...base, nodes: 0, total: count, truncated: true, size: text.length, budget,
          continue: ['radiant get ' + quoteArg(src.path) + ' --format json -o FILE', 'radiant get ' + quoteArg(src.path) + ' --format json --all',
            'radiant get ' + quoteArg(src.path) + ' --format json --node ID --depth 2'] },
        text: '',
        notes: ['The JSON is ' + text.length + ' characters, over the ' + budget + '-character budget. Use -o FILE, --all, or --node and --depth.']
      };
    }
    return { type: 'get.result', data: { ...base, nodes: count, total: count, truncated: false, value }, text };
  }
  if (!['outline', 'spec', 'spec-json'].includes(format)) throw usageError('Unknown format "' + format + '".', { suggestions: suggest(format, ['outline', 'spec', 'spec-json', 'json']) });
  const fields = fieldList(ctx, Object.keys(FIELD_GROUPS));
  const keep = fields ? new Set(['label', ...fields.flatMap((f) => FIELD_GROUPS[f])]) : null;
  const render = (d: number | undefined, maxNodes?: number) => {
    const r = specFromDoc(doc, { node, depth: d, maxNodes });
    if (keep) keepFields(r.spec.roots, keep);
    const text = format === 'spec-json' ? JSON.stringify(r.spec, null, 2) + '\n'
      : writeMapSpecMarkdown(r.spec, { frontMatter: format === 'spec' });
    return { r, text };
  };
  let result = render(depth);
  let truncated = false;
  if (result.text.length > budget) {
    truncated = true;
    const deepest = depth ?? maxDepthBelow(doc, node ? [node] : doc.roots);
    let fitted: typeof result | null = null;
    for (let d = Math.min(deepest, depth ?? deepest) - 1; d >= 0 && !fitted; d--) {
      const attempt = render(d);
      if (attempt.text.length <= budget) fitted = attempt;
    }
    if (!fitted) {
      let lo = 1;
      let hi = result.r.nodes;
      fitted = render(0, 1);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const attempt = render(0, mid);
        if (attempt.text.length <= budget) { fitted = attempt; lo = mid; } else hi = mid - 1;
      }
    }
    result = fitted;
  }
  const { r, text } = result;
  const written = writeOutput(ctx, text);
  const data = {
    ...base, nodes: r.nodes, total: r.total, truncated,
    ...(r.cut.length ? { cut: r.cut.slice(0, 20), cutCount: r.cut.length } : {}),
    ...(truncated || r.cut.length ? { continue: continueWith(r.cut) } : {}),
    ...(format !== 'outline' && r.omissions.length ? { omissions: r.omissions } : {}),
    ...(written ? { outputPath: written } : { text })
  };
  const notes: string[] = [];
  if (truncated) notes.push('Showing ' + r.nodes + ' of ' + r.total + ' nodes (output budget ' + budget + ' characters). Continue with: ' + continueWith(r.cut).slice(0, 3).join('; '));
  if (format !== 'outline' && r.omissions.length) notes.push('Not carried by the spec: ' + r.omissions.join('; '));
  return { type: 'get.result', data, text: written ? 'Wrote ' + written : text.replace(/\n$/, ''), notes };
}

interface Where { key: string; op: string; value: string }
const WHERE_KEYS = ['task', 'tag', 'has', 'depth', 'origin', 'side', 'folded', 'id', 'sticker'];
const HAS_VALUES = ['image', 'picture', 'note', 'link', 'tags', 'task', 'sticker', 'children', 'style', 'art'];

function parseWhere(raw: string): Where {
  const m = /^([a-z]+)\s*(<=|>=|!=|=|<|>)\s*(.*)$/i.exec(raw.trim());
  if (!m) throw usageError('Filters look like key=value or depth<=2, not "' + raw + '".', { hint: 'radiant find --help' });
  const key = m[1].toLowerCase();
  if (!WHERE_KEYS.includes(key)) throw usageError('Unknown filter "' + key + '". Filters: ' + WHERE_KEYS.join(', ') + '.', { suggestions: suggest(key, WHERE_KEYS) });
  if (key === 'has' && !HAS_VALUES.includes(m[3])) throw usageError('Unknown has= value "' + m[3] + '". Values: ' + HAS_VALUES.join(', ') + '.', { suggestions: suggest(m[3], HAS_VALUES) });
  if (key === 'depth' && !/^\d+$/.test(m[3])) throw usageError('depth needs a whole number.');
  if (key !== 'depth' && !['=', '!='].includes(m[2])) throw usageError('Filter "' + key + '" takes = or !=.');
  return { key, op: m[2], value: m[3] };
}

function matchesWhere(n: MapNode, depth: number, w: Where): boolean {
  let hit: boolean;
  switch (w.key) {
    case 'depth': {
      const v = Number(w.value);
      const ops: Record<string, boolean> = { '=': depth === v, '!=': depth !== v, '<': depth < v, '>': depth > v, '<=': depth <= v, '>=': depth >= v };
      return ops[w.op];
    }
    case 'task': hit = w.value === 'open' ? !!n.task && !n.task.done : w.value === 'done' ? !!n.task?.done : w.value === 'any' ? !!n.task : !n.task; break;
    case 'tag': hit = !!n.tags?.some((t) => t.toLowerCase() === w.value.toLowerCase()); break;
    case 'origin': hit = (n.origin?.by ?? 'user') === w.value; break;
    case 'side': hit = n.side === w.value; break;
    case 'folded': hit = !!n.collapsed === (w.value !== 'false'); break;
    case 'id': hit = n.id === w.value; break;
    case 'sticker': hit = n.sticker === w.value; break;
    default: {
      const has: Record<string, boolean> = {
        image: !!n.imageAsset, picture: !!(n.imageAsset || n.pictureArt || n.svgArt), note: !!n.note, link: !!n.link, tags: !!n.tags?.length,
        task: !!n.task, sticker: !!n.sticker, children: n.children.length > 0, style: !!n.style && Object.keys(n.style).length > 0,
        art: !!(n.pictureArt || n.svgArt)
      };
      hit = has[w.value];
    }
  }
  return w.op === '!=' ? !hit : hit;
}

export async function findCommand(ctx: Ctx): Promise<CommandResult> {
  const [path, query = ''] = ctx.args.positionals;
  const wheres = flagList(ctx.args, 'where').map(parseWhere);
  if (!query && !wheres.length) throw usageError('Give a QUERY, a --where filter, or both.', { hint: 'radiant find MAP "text" --where task=open' });
  const limit = positiveInt(ctx.args, 'limit', 50, 1)!;
  const fieldsIn = (flagString(ctx.args, 'in') ?? 'text,note,tags').split(',').map((s) => s.trim());
  for (const f of fieldsIn) if (!['text', 'note', 'tags'].includes(f)) throw usageError('--in takes text, note and tags.', { suggestions: suggest(f, ['text', 'note', 'tags']) });
  let test: (s: string) => boolean;
  if (flagBool(ctx.args, 'regex')) {
    let re: RegExp;
    try { re = new RegExp(query, 'iu'); } catch (e) { throw usageError('Invalid regular expression: ' + (e instanceof Error ? e.message : String(e))); }
    test = (s) => re.test(s);
  } else {
    const q = query.toLowerCase();
    test = (s) => s.toLowerCase().includes(q);
  }
  const src = await openMap(path);
  const { doc } = src;
  const matches: { id: string; text: string; path: string[]; depth: number; in: string[] }[] = [];
  let total = 0;
  const stack: [NodeId, number][] = doc.roots.slice().reverse().map((r) => [r, 0]);
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    const n = doc.nodes[id];
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], depth + 1]);
    if (!wheres.every((w) => matchesWhere(n, depth, w))) continue;
    const found: string[] = [];
    if (query) {
      if (fieldsIn.includes('text') && test(n.text)) found.push('text');
      if (fieldsIn.includes('note') && n.note && test(n.note)) found.push('note');
      if (fieldsIn.includes('tags') && n.tags?.some(test)) found.push('tags');
      if (!found.length) continue;
    }
    total++;
    if (matches.length < limit) matches.push({ id, text: short(n.text, 80), path: ancestors(doc, id).map((a) => short(doc.nodes[a].text, 40)), depth, in: found });
  }
  const truncated = total > matches.length;
  const text = matches.map((m) => m.id + '\t' + m.text + '\t' + m.path.join(' > ')).join('\n');
  return {
    type: 'find.result',
    data: { backend: src.backend, path: src.path, total, truncated, matches, ...(truncated ? { continue: ['radiant find ' + quoteArg(src.path) + ' ' + quoteArg(query) + ' --limit ' + total] } : {}) },
    text,
    notes: truncated ? ['Showing ' + matches.length + ' of ' + total + ' matches; raise --limit to see more.'] : total ? [] : ['No matches.']
  };
}

export async function nodeCommand(ctx: Ctx): Promise<CommandResult> {
  const [path, id] = ctx.args.positionals;
  const src = await openMap(path);
  const { doc } = src;
  const n = doc.nodes[id];
  if (!n) throw unknownNode(src, id);
  const path_ = ancestors(doc, id);
  const depth = path_.length;
  const theme = themeForDoc(doc);
  const resolved = createStyleResolver(doc, theme).get(id, depth, mainBranchIndex(doc, id));
  const placement = doc.layoutPlacements?.nodes[id];
  const { children, parent, ...fields } = n;
  void children; void parent;
  const data = {
    backend: src.backend,
    id,
    text: n.text,
    depth,
    parent: n.parent,
    path: path_.map((a) => ({ id: a, text: short(doc.nodes[a].text) })),
    children: n.children.map((c) => ({ id: c, text: short(doc.nodes[c].text), children: doc.nodes[c].children.length })),
    mainBranch: depth === 0 ? null : { index: mainBranchIndex(doc, id), id: depth === 1 ? id : path_[1] },
    ...(n.parent === null ? { root: doc.rootInfo[id] } : {}),
    fields,
    theme: doc.themeId,
    resolved,
    links: doc.links.filter((l) => l.from === id || l.to === id),
    box: placement ? { source: 'stored', x: placement.x, y: placement.y, w: placement.w, h: placement.h, side: placement.side } : null,
    ...(placement ? {} : { boxNote: 'No settled layout is stored for this node. Open and save the map in Radiant, or use the layout report when it is available.' })
  };
  return { type: 'node.result', data };
}

export async function statsCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const src = await openMap(path);
  const { doc } = src;
  let depth = 0;
  let leaves = 0;
  let notes = 0;
  let folded = 0;
  let stickers = 0;
  let styled = 0;
  const tasks = { open: 0, done: 0 };
  const pictures = { attached: 0, generated: 0, missingAlt: 0 };
  const tags = new Map<string, number>();
  const size = new Map<NodeId, number>();
  const order: [NodeId, number][] = [];
  const stack: [NodeId, number][] = doc.roots.map((r) => [r, 0]);
  while (stack.length) {
    const [id, d] = stack.pop()!;
    order.push([id, d]);
    const n = doc.nodes[id];
    depth = Math.max(depth, d);
    if (!n.children.length) leaves++;
    if (n.note) notes++;
    if (n.collapsed) folded++;
    if (n.sticker) stickers++;
    if (n.style && Object.keys(n.style).length) styled++;
    if (n.task) n.task.done ? tasks.done++ : tasks.open++;
    if (n.imageAsset) { pictures.attached++; if (!n.imageAlt) pictures.missingAlt++; }
    if (n.pictureArt || n.svgArt) pictures.generated++;
    for (const t of n.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
    for (const c of n.children) stack.push([c, d + 1]);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const [id] = order[i];
    size.set(id, 1 + doc.nodes[id].children.reduce((s, c) => s + (size.get(c) ?? 0), 0));
  }
  const data = {
    backend: src.backend,
    path: src.path,
    title: doc.title,
    theme: doc.themeId,
    nodes: Object.keys(doc.nodes).length,
    roots: doc.roots.map((r) => ({ id: r, text: short(doc.nodes[r].text), layout: doc.rootInfo[r].layout, nodes: size.get(r) })),
    depth,
    leaves,
    mainBranches: doc.roots.flatMap((r) => doc.nodes[r].children.map((c) => ({ id: c, root: r, text: short(doc.nodes[c].text), nodes: size.get(c) ?? 1, side: doc.nodes[c].side ?? null }))),
    tags: Object.fromEntries([...tags].sort((a, b) => b[1] - a[1]).slice(0, 50)),
    tasks,
    pictures,
    links: doc.links.length,
    notes,
    folded,
    stickers,
    styled
  };
  const text = [
    'Title: ' + data.title, 'Theme: ' + data.theme, 'Nodes: ' + data.nodes + ' in ' + data.roots.length + ' root' + (data.roots.length === 1 ? '' : 's') + ', depth ' + depth + ', ' + leaves + ' leaves',
    'Main branches: ' + data.mainBranches.map((m) => m.text + ' (' + m.nodes + ')').join(', '),
    'Tasks: ' + tasks.open + ' open, ' + tasks.done + ' done', 'Pictures: ' + pictures.attached + ' attached, ' + pictures.generated + ' generated',
    'Links: ' + data.links + '; notes: ' + notes + '; folded: ' + folded,
    'Tags: ' + (tags.size ? [...tags].map(([t, c]) => t + ' ' + c).join(', ') : 'none')
  ].join('\n');
  return { type: 'stats.result', data, text };
}

export async function historyCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const limit = positiveInt(ctx.args, 'limit', 50, 1)!;
  const source = flagString(ctx.args, 'source');
  const src = await openMap(path, { connection: null });
  if (src.kind !== 'radiant') {
    return { type: 'history.result', data: { path: src.path, kind: src.kind, entries: [], total: 0, note: 'Only .radiant files keep an operation log.' }, text: 'No operation log in a ' + src.kind + ' file.' };
  }
  const { entries, total, version } = readHistory(src.path, limit, source);
  const text = entries.map((e) => '#' + e.sequence + '\t' + e.kind + '\t' + (e.source || '-') + '\t' + (e.label ?? '')).join('\n');
  return {
    type: 'history.result',
    data: { backend: 'file', path: src.path, formatVersion: version, total, shown: entries.length, entries, ...(version < 2 && !total ? { note: 'Version 1 files may have no operation log.' } : {}) },
    text: text || 'No entries.'
  };
}

export async function listCommand(ctx: Ctx): Promise<CommandResult> {
  const dir = ctx.args.positionals[0] ?? '.';
  if (!existsSync(dir)) throw notFound('directory_not_found', 'No folder at ' + dir + '.');
  if (!statSync(dir).isDirectory()) throw new CliError('not_a_directory', EXIT.usage, dir + ' is not a folder.', { hint: 'radiant stats ' + dir });
  const { files, truncated } = listMapFiles(dir, flagBool(ctx.args, 'recursive'));
  const long = flagBool(ctx.args, 'long');
  const maps = ctx.json || long ? files.map(describeStoredMap) : files.map((path) => ({ path }));
  const lines = long
    ? (maps as ReturnType<typeof describeStoredMap>[]).map((m) => [m.path, m.title ?? '', m.nodes ?? '', m.formatVersion ? 'v' + m.formatVersion : '', m.modified, m.error ?? ''].join('\t'))
    : files;
  let text = lines.join('\n');
  const budget = budgetOf(ctx, false);
  const notes: string[] = [];
  if (text.length > budget) {
    text = text.slice(0, text.lastIndexOf('\n', budget));
    notes.push('Output cut at ' + budget + ' characters; pass --all.');
  }
  if (truncated) notes.push('Stopped after ' + files.length + ' maps.');
  return { type: 'list.result', data: { dir: resolve(dir), recursive: flagBool(ctx.args, 'recursive'), maps, truncated }, text, notes };
}

