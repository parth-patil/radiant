import { layoutReport, LAYOUT_LINT_DEFAULTS, lintLayout, lintPresentation, suggest, type LayoutReport } from '../../src/lib/core/io/map-spec';
import type { Doc, Presentation } from '../../src/lib/core/types';
import { flagBool, flagString, positiveInt } from './args';
import { notFound, type CommandResult } from './envelope';
import { openMap, type MapSource } from './sources';
import { quoteArg, unknownNode, type Ctx } from './read';

/** Boxes printed by default; the counts always cover the whole map. */
const DEFAULT_BOXES = 400;

export async function layoutCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const src = await openMap(path, { spec: { strict: false } });
  const node = flagString(ctx.args, 'node');
  if (node !== undefined && !src.doc.nodes[node]) throw unknownNode(src, node);
  const report = layoutReport(src.doc, { node });
  const limit = flagBool(ctx.args, 'all') ? Infinity : positiveInt(ctx.args, 'limit', DEFAULT_BOXES, 1)!;
  const boxes = report.boxes.slice(0, limit);
  const elements = report.elements.slice(0, limit);
  const truncated = boxes.length < report.boxes.length || elements.length < report.elements.length;
  const issues = lintLayout(src.doc, report).filter((i) => i.rule !== 'long-label');
  const data = {
    backend: src.backend, path: src.path, revision: 'sha256:' + src.revision, ...report, boxes, elements,
    box: 'centre', truncated, ...(truncated ? { continue: ['radiant layout ' + quoteArg(src.path) + ' --all', 'radiant layout ' + quoteArg(src.path) + ' --node ID'] } : {}),
    issues, note: 'Text is measured with an approximate, DOM-free measurer; positions can differ from the app by a few units per label.'
  };
  const text = [
    'Layout (headless engine, approximate metrics): ' + report.visible + ' of ' + report.nodes + ' nodes visible, depth ' + report.depth + ', ' + report.elements.length + ' canvas elements.',
    'Bounds x ' + report.bounds.x + ', y ' + report.bounds.y + ', ' + report.bounds.w + ' x ' + report.bounds.h + ' (aspect ' + report.aspect + ').',
    'Sides: left ' + report.sides.left.nodes + ' nodes over ' + report.sides.left.extent + ', right ' + report.sides.right.nodes + ' nodes over ' + report.sides.right.extent + '.',
    ...boxes.map((b) => b.id + '\t' + b.x + ',' + b.y + '\t' + b.w + 'x' + b.h + '\tdepth ' + b.depth + '\tside ' + b.side + '\tlines ' + b.lines),
    ...elements.map((e) => e.id + '\t' + e.kind + '\t' + e.x + ',' + e.y + '\t' + e.w + 'x' + e.h + '\t' + e.band),
    ...issues.map((i) => i.severity + '\t' + i.rule + '\t' + i.ids.join(',') + '\t' + i.message)
  ].join('\n');
  return { type: 'layout.report', data, text, notes: truncated ? ['Showing ' + boxes.length + ' of ' + report.boxes.length + ' boxes; pass --all or --node.'] : [] };
}

/** The presentation named by id or name, or a not-found error listing the others. */
export function findPresentation(src: MapSource, wanted: string): Presentation {
  const list = src.doc.presentations ?? [];
  const found = list.find((p) => p.id === wanted) ?? list.find((p) => p.name === wanted) ?? list.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found;
  throw notFound('unknown_presentation', 'No presentation "' + wanted + '" in ' + src.path + '.', {
    suggestions: suggest(wanted, [...list.map((p) => p.id), ...list.map((p) => p.name)]),
    hint: list.length ? 'Presentations: ' + list.map((p) => p.name + ' (' + p.id + ')').join(', ') : 'The map has no presentations.'
  });
}

/** Layout lint for lintCommand: the layout rules, and the presentation pre-flight when asked. */
export function layoutIssues(ctx: Ctx, doc: Doc, src: MapSource, node?: string): { report: LayoutReport; issues: ReturnType<typeof lintLayout>; presentation?: string } {
  const report = layoutReport(doc, { node });
  const limits = {
    maxEdge: positiveInt(ctx.args, 'max-edge', LAYOUT_LINT_DEFAULTS.maxEdge, 64)!,
    ...(ctx.args.flags['max-lines'] !== undefined ? { maxLines: positiveInt(ctx.args, 'max-lines', 2, 1)! } : {})
  };
  const issues = lintLayout(doc, report, limits);
  const wanted = flagString(ctx.args, 'presentation');
  if (!wanted) return { report, issues };
  const p = findPresentation(src, wanted);
  return { report, issues: [...issues, ...lintPresentation(doc, p, node ? layoutReport(doc) : report)], presentation: p.id };
}
