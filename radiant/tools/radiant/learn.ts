import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  LINT_RULES, MAP_SPEC_VERSION, SPEC_ALIGNMENTS, SPEC_ARROWS, SPEC_BRANCHES, SPEC_BRANCH_LAYOUTS, SPEC_DASHES,
  SPEC_FRONT_MATTER_KEYS, SPEC_GEOMETRY_ATTRIBUTES, SPEC_LAYOUTS, SPEC_LIMITS, SPEC_NODE_ATTRIBUTES, SPEC_SHAPES, SPEC_SIDES,
  SPEC_SPACINGS, suggest
} from '../../src/lib/core/io/map-spec';
import { AGENT_LIMITS, AGENT_OPS, getTheme, listThemes } from '../../src/lib/core/model';
import type { Theme } from '../../src/lib/core/types';
import { EXIT_MEANINGS, OUTPUT_BUDGET, SCHEMA_VERSION, TOOL_VERSION, notFound, type CommandResult } from './envelope';
import { READABLE_VERSIONS } from './store';
import { MAX_PICTURE_BYTES } from './spec-io';
import { SCHEMA_NAMES, schemaFor } from './schemas';
import { grantFromEnvironment } from './sources';
import type { Ctx } from './read';

export const EXAMPLES_DIR = new URL('../../skills/radiant-map/references/examples/', import.meta.url);

export function capabilitiesCommand(_ctx: Ctx, commands: { name: string; group: string; summary: string }[]): CommandResult {
  let live: Record<string, unknown>;
  try {
    const connection = grantFromEnvironment();
    live = connection ? { configured: true, path: connection.path, documentId: connection.documentId } : { configured: false };
  } catch (e) {
    live = { configured: false, error: e instanceof Error ? e.message : String(e) };
  }
  const data = {
    tool: TOOL_VERSION,
    spec: MAP_SPEC_VERSION,
    schemaVersion: SCHEMA_VERSION,
    fileFormats: {
      read: { radiant: [...READABLE_VERSIONS], other: ['portable-bundle', 'radiant-json', 'spec-markdown', 'spec-json'] },
      write: { radiant: [], other: ['portable-bundle', 'spec-markdown', 'spec-json', 'radiant-json', 'markdown', 'opml', 'freemind', 'excalidraw'] },
      import: ['markdown', 'text', 'opml', 'freemind', 'canvas', 'xmind', 'mindnode', 'portable-bundle', 'radiant-json', 'excalidraw'],
      note: 'build, import and edit -o write portable bundles (.radiant.zip); edit --in-place changes bundles and JSON; .radiant files change only through the open app (live).'
    },
    backends: { file: true, live },
    engines: { app: false, headless: { layout: true, render: false, metrics: 'approximate' }, lint: 'document+layout' },
    edit: {
      ops: Object.fromEntries(Object.entries(AGENT_OPS).map(([name, def]) => [name, { tier: def.tier, required: def.required, fields: Object.keys(def.fields), summary: def.summary }])),
      tiers: { read: 'reads, layout, lint', write: 'add, edit, style, move, link, theme, presentations, canvas elements', destructive: 'delete, unlink, presentation-delete, canvas-delete, apply --mode replace' },
      fileFlags: { write: '--in-place or -o', destructive: '--allow-destructive' },
      liveMessages: ['read', 'edits', 'ops', 'undo']
    },
    commands: commands.map((c) => ({ name: c.name, group: c.group, summary: c.summary })),
    enums: {
      theme: listThemes().map((t) => t.id),
      layout: SPEC_LAYOUTS,
      branchLayout: SPEC_BRANCH_LAYOUTS,
      spacing: SPEC_SPACINGS,
      shape: SPEC_SHAPES,
      branch: SPEC_BRANCHES,
      side: SPEC_SIDES,
      align: SPEC_ALIGNMENTS,
      emphasis: [0, 1, 2],
      dash: SPEC_DASHES,
      arrows: SPEC_ARROWS,
      task: ['open', 'done'],
      nodeAttributes: SPEC_NODE_ATTRIBUTES,
      frontMatter: SPEC_FRONT_MATTER_KEYS,
      ignoredGeometry: SPEC_GEOMETRY_ATTRIBUTES,
      lintRules: LINT_RULES
    },
    limits: { ...SPEC_LIMITS, pictureBytes: MAX_PICTURE_BYTES, outputChars: OUTPUT_BUDGET, opsPerBatch: AGENT_LIMITS.ops, nodesPerBatch: AGENT_LIMITS.nodes,
      opLabelBytes: AGENT_LIMITS.labelBytes, opNoteBytes: AGENT_LIMITS.noteBytes, opsFrameBytes: AGENT_LIMITS.frameBytes,
      legacyEditsPerBatch: 32, legacyEditFrameBytes: 65536 },
    exitCodes: EXIT_MEANINGS
  };
  return { type: 'capabilities', data, text: JSON.stringify(data, null, 2) };
}

export function schemaCommand(ctx: Ctx): CommandResult {
  const [name] = ctx.args.positionals;
  if (!name) {
    return { type: 'schema.list', data: { schemas: SCHEMA_NAMES }, text: Object.entries(SCHEMA_NAMES).map(([k, v]) => k + '\t' + v).join('\n') };
  }
  if (!(name in SCHEMA_NAMES)) throw notFound('unknown_schema', 'No schema "' + name + '".', { suggestions: suggest(name, Object.keys(SCHEMA_NAMES)), hint: 'radiant schema' });
  const schema = schemaFor(name as keyof typeof SCHEMA_NAMES);
  return { type: 'schema', data: { name, schema }, text: JSON.stringify(schema, null, 2) };
}

function describeTheme(theme: Theme, dark: Theme) {
  return {
    id: theme.id, name: theme.name, background: theme.background, textColor: theme.textColor, rootColor: theme.rootColor,
    branchColors: theme.branchColors, fontFamily: theme.fontFamily, rootShape: theme.rootShape, mainShape: theme.mainShape ?? theme.shape,
    shape: theme.shape, branch: theme.branch,
    dark: { background: dark.background, textColor: dark.textColor, rootColor: dark.rootColor, branchColors: dark.branchColors }
  };
}

export function themesCommand(ctx: Ctx): CommandResult {
  const [id] = ctx.args.positionals;
  const themes = listThemes();
  if (id) {
    const theme = themes.find((t) => t.id === id);
    if (!theme) throw notFound('unknown_theme', 'No theme "' + id + '".', { suggestions: suggest(id, themes.map((t) => t.id)), hint: 'radiant themes' });
    const data = { theme, dark: getTheme(id, true) };
    return { type: 'theme', data, text: JSON.stringify(data, null, 2) };
  }
  const list = themes.map((t) => describeTheme(t, getTheme(t.id, true)));
  return { type: 'themes', data: { count: list.length, themes: list }, text: list.map((t) => t.id + '\t' + t.name + '\t' + t.branch + '\t' + t.background).join('\n') };
}

interface Example { name: string; title: string; description: string; path: string }

function examples(): Example[] {
  if (!existsSync(EXAMPLES_DIR)) return [];
  return (readdirSync(EXAMPLES_DIR) as string[]).filter((f) => f.endsWith('.map.md')).sort().map((file) => {
    const path = new URL(file, EXAMPLES_DIR).pathname;
    const text = readFileSync(path, 'utf8');
    const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') ?? file;
    const description = /^<!--\s*(.+?)\s*-->/m.exec(text)?.[1] ?? '';
    return { name: file.replace(/\.map\.md$/, ''), title, description, path };
  });
}

export function examplesCommand(ctx: Ctx): CommandResult {
  const [name] = ctx.args.positionals;
  const list = examples();
  if (!name) return { type: 'examples', data: { examples: list }, text: list.map((e) => e.name + '\t' + e.title + (e.description ? '\t' + e.description : '')).join('\n') };
  const found = list.find((e) => e.name === name);
  if (!found) throw notFound('unknown_example', 'No example "' + name + '".', { suggestions: suggest(name, list.map((e) => e.name)), hint: 'radiant examples' });
  const spec = readFileSync(found.path, 'utf8');
  return { type: 'example', data: { ...found, spec }, text: spec.replace(/\n$/, '') };
}

export function helpData(command: { name: string; summary: string; usage: string; args: unknown[]; flags: unknown[]; group: string; details?: string }) {
  return { name: command.name, group: command.group, summary: command.summary, usage: command.usage, args: command.args, flags: command.flags, ...(command.details ? { details: command.details } : {}) };
}

