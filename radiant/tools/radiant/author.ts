import { basename, dirname, extname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import {
  LAYOUT_LINT_DEFAULTS, LINT_DEFAULTS, LINT_RULES, lintDocument, specFromDoc, writeMapSpecMarkdown, type LintSeverity, type SpecDiagnostic
} from '../../src/lib/core/io/map-spec';
import { parseFreeMind, parseJsonCanvas, parseMarkdownOutline, parseOpml, parseXmind, toFreeMind, toMarkdownOutline, toOpml } from '../../src/lib/core/io';
import { openMindNode } from '../../src/lib/core/io/mindnode-archive';
import { parseMindNodeClassic } from '../../src/lib/core/io/mindnode';
import { parseMindNodeNext } from '../../src/lib/core/io/mindnode-next';
import { imageReferences, readPortableMap } from '../../src/lib/core/io/portable';
import { docFromOutlines, outlineFromDoc, parseDocReport, parseIndentedText, serializeDoc, validateDoc } from '../../src/lib/core/model';
import type { Doc, OutlineNode } from '../../src/lib/core/types';
import { flagBool, flagNumber, flagString, positiveInt } from './args';
import { CliError, EXIT, diagnosticText, invalid, usageError, type CommandResult } from './envelope';
import { openMap } from './sources';
import { existingFile, sha256 } from './store';
import { bundlePath, decodeText, loadSpec, portableBundle, prepareOutput, preparePicture, writeAtomic, type LoadedSpec } from './spec-io';
import { quoteArg, unknownNode, writeOutput, type Ctx } from './read';
import { layoutIssues } from './see';
import { excalidrawText, importExcalidraw } from './excalidraw';

const SPEC_EXT = /\.(map\.md|md|markdown|mdown|txt)$/i;

function specFailure(loaded: LoadedSpec): CliError {
  const diagnostics = loaded.compiled.diagnostics;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const first = errors[0];
  return new CliError('invalid_spec', EXIT.invalid,
    'The spec has ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + (first ? '; first: ' + diagnosticText(first as unknown as Record<string, unknown>).replace(/\.$/, '') : '') + '.',
    { suggestions: first?.suggestions ?? [], details: { diagnostics }, hint: 'Fix the lines named in diagnostics, then run radiant validate ' + quoteArg(loaded.path) });
}

const warningNotes = (path: string, diagnostics: SpecDiagnostic[]) =>
  diagnostics.map((d) => diagnosticText(d as unknown as Record<string, unknown>, path === '-' ? 'stdin' : path));

async function assetsFrom(ctx: Ctx) {
  const from = flagString(ctx.args, 'assets-from');
  if (!from) return undefined;
  const source = await openMap(from, { connection: null });
  return (hash: string) => source.asset(hash);
}

async function loadFor(ctx: Ctx, path: string): Promise<LoadedSpec> {
  if (path !== '-') path = existingFile(path, 'spec');
  return loadSpec(path, {
    strict: flagBool(ctx.args, 'strict'),
    allowGeometry: flagBool(ctx.args, 'allow-geometry'),
    now: flagString(ctx.args, 'now'),
    root: flagString(ctx.args, 'root'),
    assetsFrom: await assetsFrom(ctx)
  });
}

export async function buildCommand(ctx: Ctx): Promise<CommandResult> {
  const [specPath] = ctx.args.positionals;
  const out = flagString(ctx.args, 'output');
  const dryRun = flagBool(ctx.args, 'dry-run');
  if (!out && !dryRun) throw usageError('build needs -o OUT.radiant.zip (or --dry-run).', { hint: 'radiant build ' + specPath + ' -o Map.radiant.zip' });
  if (out) bundlePath(out);
  const replace = flagBool(ctx.args, 'replace');
  const target = out ? prepareOutput(out, { replace, root: flagString(ctx.args, 'root') }) : null;
  const loaded = await loadFor(ctx, specPath);
  const { doc, diagnostics, summary } = loaded.compiled;
  if (!doc || diagnostics.some((d) => d.severity === 'error')) throw specFailure(loaded);
  const assets = new Map(loaded.assets.map((a) => [a.hash, { bytes: a.bytes, mime: a.mime }]));
  const bytes = await portableBundle(doc, assets);
  if (target && !dryRun) writeAtomic(target, bytes, replace && target.exists);
  const json = serializeDoc(doc);
  const data = {
    status: dryRun ? 'dry_run' : 'written',
    path: dryRun ? null : target!.path,
    backend: 'file',
    format: 'portable-bundle',
    revision: 'sha256:' + sha256(json),
    bytes: bytes.length,
    roots: summary.roots,
    nodes: summary.nodes,
    depth: summary.depth,
    links: summary.links,
    assets: summary.assets,
    pictures: loaded.assets.map((a) => ({ name: a.name, hash: a.hash, mime: a.mime, bytes: a.bytes.length, source: a.source, ...(a.removed?.length ? { removed: a.removed } : {}) })),
    ids: summary.ids,
    assigned: summary.assigned,
    created: doc.created,
    warnings: diagnostics
  };
  const text = (dryRun ? 'Checked ' : 'Built ' + target!.path + ': ') + summary.nodes + ' nodes in ' + summary.roots + ' root' + (summary.roots === 1 ? '' : 's') +
    ', depth ' + summary.depth + ', ' + summary.links + ' links, ' + summary.assets + ' pictures (' + summary.ids.explicit + ' explicit ids, ' + summary.ids.derived + ' derived).';
  return { type: 'build.result', data, text, notes: warningNotes(loaded.path, diagnostics) };
}

function isSpecPath(path: string): boolean {
  if (path === '-') return true;
  if (SPEC_EXT.test(path)) return true;
  if (/\.json$/i.test(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return !('nodes' in raw && 'version' in raw);
    } catch { return false; }
  }
  return false;
}

export async function validateCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  if (isSpecPath(path)) {
    const loaded = await loadFor(ctx, path);
    const { doc, diagnostics, summary } = loaded.compiled;
    if (!doc || diagnostics.some((d) => d.severity === 'error')) throw specFailure(loaded);
    return {
      type: 'validate.result',
      data: { kind: 'spec', path: loaded.path, valid: true, nodes: summary.nodes, roots: summary.roots, depth: summary.depth, links: summary.links, ids: summary.ids, diagnostics },
      text: 'Valid spec: ' + summary.nodes + ' nodes' + (diagnostics.length ? ', ' + diagnostics.length + ' warning' + (diagnostics.length === 1 ? '' : 's') : ''),
      notes: warningNotes(loaded.path, diagnostics)
    };
  }
  const src = await openMap(path);
  const problems = [...src.repairs, ...validateDoc(src.doc)];
  if (problems.length) {
    throw new CliError('invalid_map', EXIT.invalid, problems.join('\n'), { details: { problems }, hint: 'Open the map in Radiant to repair it, then save.' });
  }
  const nodes = Object.keys(src.doc.nodes).length;
  return { type: 'validate.result', data: { kind: src.kind, backend: src.backend, path: src.path, valid: true, nodes, formatVersion: src.formatVersion ?? null, problems }, text: 'Valid map: ' + nodes + ' nodes' };
}

const SEVERITY_RANK: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };

export async function lintCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const src = await openMap(path, { spec: { strict: false } });
  const node = flagString(ctx.args, 'node');
  if (node !== undefined && !src.doc.nodes[node]) throw unknownNode(src, node);
  const limits = {
    maxWords: flagNumber(ctx.args, 'max-words') ?? LINT_DEFAULTS.maxWords,
    maxChildren: flagNumber(ctx.args, 'max-children') ?? LINT_DEFAULTS.maxChildren,
    minContrast: flagNumber(ctx.args, 'min-contrast') ?? LINT_DEFAULTS.minContrast,
    chain: flagNumber(ctx.args, 'chain') ?? LINT_DEFAULTS.chain
  };
  const layout = layoutIssues(ctx, src.doc, src, node);
  const inScope = node ? new Set(layout.report.boxes.map((b) => b.id)) : null;
  const issues = [...lintDocument(src.doc, limits, node),
    ...layout.issues.filter((i) => !inScope || i.rule.startsWith('step-') || i.rule === 'unvisited-branch' || i.ids.some((id) => inScope.has(id)))]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const failOn = flagString(ctx.args, 'fail-on') as LintSeverity | undefined;
  const failed = failOn ? issues.some((i) => SEVERITY_RANK[i.severity] <= SEVERITY_RANK[failOn]) : false;
  const skipped = layout.presentation ? [] : LINT_RULES.filter((r) => r.presentation).map((r) => ({ rule: r.rule, reason: 'runs with --presentation NAME' }));
  const limit = positiveInt(ctx.args, 'limit', 100, 1)!;
  const shown = issues.slice(0, limit);
  const data = {
    backend: src.backend, path: src.path, engine: 'headless', metrics: 'approximate',
    thresholds: { ...limits, ...LAYOUT_LINT_DEFAULTS, maxEdge: positiveInt(ctx.args, 'max-edge', LAYOUT_LINT_DEFAULTS.maxEdge, 64) },
    issues: shown, total: issues.length, truncated: shown.length < issues.length, counts, skipped,
    ...(layout.presentation ? { presentation: layout.presentation } : {}),
    notes: ['Layout rules use the headless engine with approximate text metrics.'], ...(failOn ? { failOn, failed } : {})
  };
  const text = shown.length
    ? shown.map((i) => i.severity + '\t' + i.rule + '\t' + i.ids.join(',') + '\t' + i.message).join('\n')
    : 'No issues (' + LINT_RULES.filter((r) => !r.presentation || layout.presentation).length + ' rules).';
  const notes = shown.length < issues.length ? ['Showing ' + shown.length + ' of ' + issues.length + ' issues; raise --limit to see more.'] : [];
  return { type: 'lint.report', data, text, notes, ...(failed ? { exit: EXIT.invalid } : {}) };
}

// ====================================================================== import and export

type Imported = { doc: Doc; skipped: string[]; assets: Map<string, { bytes: Uint8Array; mime: string }>; format: string };

const IMPORT_FORMATS = ['markdown', 'text', 'opml', 'freemind', 'canvas', 'xmind', 'mindnode', 'bundle', 'json'] as const;

async function importFile(path: string, title: string | undefined, format?: string): Promise<Imported> {
  const ext = extname(path).toLowerCase().slice(1);
  const kind = format ?? ({ md: 'markdown', markdown: 'markdown', txt: 'text', opml: 'opml', mm: 'freemind', canvas: 'canvas',
    xmind: 'xmind', mindnode: 'mindnode', zip: 'bundle', json: 'json' } as Record<string, string>)[ext];
  if (!kind) throw usageError('Cannot tell the format of ' + basename(path) + '. Pass --from.', { suggestions: [...IMPORT_FORMATS] });
  const stem = basename(path).replace(/\.[^.]+$/, '');
  const bytes = new Uint8Array(readFileSync(path));
  const outline = (nodes: OutlineNode[], skipped: string[], name?: string): Imported => {
    if (!nodes.length) throw invalid('empty_import', basename(path) + ' has no outline to import.');
    return { doc: docFromOutlines(title ?? (name || stem), nodes), skipped, assets: new Map(), format: kind };
  };
  try {
    switch (kind) {
      case 'markdown': {
        const skipped = new Set<string>();
        const nodes = parseMarkdownOutline(decodeText(bytes, path), skipped);
        return outline(nodes, [...skipped]);
      }
      case 'text': return outline(parseIndentedText(decodeText(bytes, path)), []);
      case 'opml': { const r = parseOpml(decodeText(bytes, path)); return outline(r.nodes, r.skipped, r.title); }
      case 'freemind': { const r = parseFreeMind(decodeText(bytes, path)); return outline(r.nodes, r.skipped, r.title); }
      case 'xmind': { const r = parseXmind(bytes); return outline(r.nodes, r.skipped ?? [], r.title); }
      case 'canvas': { const r = parseJsonCanvas(decodeText(bytes, path), title ?? stem); return { doc: r.doc, skipped: r.skipped, assets: new Map(), format: kind }; }
      case 'json': {
        const r = parseDocReport(decodeText(bytes, path));
        const skipped = [...r.repairs];
        if (imageReferences(r.doc).size) {
          // A JSON export carries asset hashes but no bytes; drop the references rather than write a broken bundle.
          for (const node of Object.values(r.doc.nodes)) {
            if (node.imageAsset && node.representation === 'picture') delete node.representation;
            delete node.imageAsset; delete node.imageAspect; delete node.pictureArt; delete node.svgArt; delete node.artReference;
          }
          skipped.push('Pictures in a JSON export have no bytes; they were not included.');
        }
        return { doc: r.doc, skipped, assets: new Map(), format: kind };
      }
      case 'bundle': {
        const r = await readPortableMap(bytes);
        return { doc: r.doc, skipped: r.skipped, assets: new Map(r.assets.map((a) => [a.hash, { bytes: a.bytes, mime: a.mime }])), format: kind };
      }
      case 'mindnode': {
        const archive = openMindNode(bytes);
        const { parse } = await import('plist');
        const map = archive.next ? parseMindNodeNext(archive.content, title ?? stem) : parseMindNodeClassic(parse(new TextDecoder().decode(archive.content)) as never, title ?? stem);
        const resources = archive.resources(map.attachments.flatMap((a) => a.entry ? [a.entry] : []));
        const assets = new Map<string, { bytes: Uint8Array; mime: string }>();
        const skipped = [...map.skipped];
        for (const attachment of map.attachments) {
          const source = attachment.entry && Object.hasOwn(resources, attachment.entry) ? resources[attachment.entry] : undefined;
          const node = map.doc.nodes[attachment.node];
          if (!source || !node) continue;
          try {
            const picture = preparePicture(attachment.entry!, source, attachment.entry!);
            if (picture.mime === 'image/svg+xml') throw new Error('SVG attachment');
            assets.set(picture.hash, { bytes: picture.bytes, mime: picture.mime });
            node.imageAsset = picture.hash;
            node.representation = 'picture';
            if (picture.aspect) node.imageAspect = picture.aspect;
          } catch {
            skipped.push('An attachment in a format other than PNG, JPEG, WebP or GIF was skipped.');
          }
        }
        return { doc: map.doc, skipped, assets, format: kind };
      }
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw invalid('invalid_import', 'Could not import ' + basename(path) + ': ' + (e instanceof Error ? e.message : String(e)));
  }
  throw usageError('Unsupported import format "' + kind + '".', { suggestions: [...IMPORT_FORMATS] });
}

export async function importCommand(ctx: Ctx): Promise<CommandResult> {
  const [input] = ctx.args.positionals;
  const from = flagString(ctx.args, 'from');
  if (from === 'excalidraw' || (!from && /.excalidraw(.json)?$/i.test(input))) return importExcalidraw(ctx, existingFile(input, 'file'));
  if (flagString(ctx.args, 'into')) throw usageError('--into works with .excalidraw drawings; other formats become a new map with -o.', { hint: 'radiant import ' + input + ' -o Map.radiant.zip' });
  const out = flagString(ctx.args, 'output');
  if (!out) throw usageError('import needs -o OUT.radiant.zip.', { hint: 'radiant import ' + input + ' -o Map.radiant.zip' });
  bundlePath(out);
  const replace = flagBool(ctx.args, 'replace');
  const target = prepareOutput(out, { replace, root: flagString(ctx.args, 'root') });
  const file = existingFile(input, 'file');
  const imported = await importFile(file, flagString(ctx.args, 'title'), flagString(ctx.args, 'from'));
  const problems = validateDoc(imported.doc);
  if (problems.length) throw invalid('invalid_document', 'The imported map is invalid: ' + problems[0]);
  const bytes = await portableBundle(imported.doc, imported.assets);
  writeAtomic(target, bytes, replace && target.exists);
  const skipped = [...new Set(imported.skipped)].sort();
  return {
    type: 'import.result',
    data: { path: target.path, format: imported.format, output: 'portable-bundle', nodes: Object.keys(imported.doc.nodes).length,
      roots: imported.doc.roots.length, links: imported.doc.links.length, assets: imported.assets.size, skipped, revision: 'sha256:' + sha256(serializeDoc(imported.doc)) },
    text: 'Imported ' + basename(file) + ' (' + imported.format + ') to ' + target.path + ': ' + Object.keys(imported.doc.nodes).length + ' nodes.',
    notes: skipped.map((s) => 'skipped: ' + s)
  };
}

const EXPORT_FORMATS = ['spec', 'spec-json', 'json', 'md', 'opml', 'freemind', 'excalidraw'] as const;

export async function exportCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const format = flagString(ctx.args, 'format') ?? 'spec';
  const src = await openMap(path);
  const { doc } = src;
  const out = flagString(ctx.args, 'output');
  const outlines = () => doc.roots.map((r) => outlineFromDoc(doc, r));
  let text: string;
  let omissions: string[] = [];
  const picturesWritten: string[] = [];
  switch (format) {
    case 'spec': case 'spec-json': {
      const r = specFromDoc(doc);
      omissions = r.omissions;
      if (out && r.spec.assets && format === 'spec') {
        // Write the pictures beside the spec so it builds without the source map.
        const folder = basename(out).replace(/\.map\.md$|\.md$/i, '') + '-assets';
        const dir = join(dirname(out), folder);
        if (!existsSync(dir)) mkdirSync(dir);
        for (const [name, ref] of Object.entries(r.spec.assets)) {
          const hash = ref.replace(/^sha256:/, '');
          const asset = src.asset(hash);
          if (!asset) { omissions.push('picture ' + name + ': bytes not available'); continue; }
          const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' } as Record<string, string>)[asset.mime] ?? 'bin';
          const target = prepareOutput(join(dir, name + '.' + ext), { replace: flagBool(ctx.args, 'replace'), root: flagString(ctx.args, 'root') });
          writeAtomic(target, asset.bytes, target.exists);
          r.spec.assets[name] = folder + '/' + name + '.' + ext;
          picturesWritten.push(target.path);
        }
      }
      text = format === 'spec' ? writeMapSpecMarkdown(r.spec) : JSON.stringify(r.spec, null, 2) + '\n';
      break;
    }
    case 'json': text = JSON.stringify(doc, null, 2) + '\n'; break;
    case 'md': text = toMarkdownOutline(outlines(), { headingLevels: 2 }); break;
    case 'opml': text = toOpml(doc.title, outlines()); break;
    case 'freemind': text = toFreeMind(doc.title, outlines()); break;
    case 'excalidraw': ({ text, omissions } = excalidrawText(src)); break;
    default: throw usageError('Unknown export format "' + format + '".', { suggestions: [...EXPORT_FORMATS] });
  }
  const written = writeOutput(ctx, text);
  const budget = flagBool(ctx.args, 'all') ? Infinity : (positiveInt(ctx.args, 'max-chars', 40_000, 200) as number);
  if (!written && text.length > budget) {
    throw new CliError('output_too_large', EXIT.invalid, 'The export is ' + text.length + ' characters, over the ' + budget + '-character output budget.', {
      hint: 'radiant export ' + quoteArg(src.path) + ' --format ' + format + ' -o FILE'
    });
  }
  return {
    type: 'export.result',
    data: { backend: src.backend, path: src.path, format, ...(written ? { outputPath: written } : { text }), omissions, pictures: picturesWritten, characters: text.length },
    text: written ? 'Wrote ' + written : text.replace(/\n$/, ''),
    notes: omissions.length ? ['Not carried by this format: ' + omissions.join('; ')] : []
  };
}

