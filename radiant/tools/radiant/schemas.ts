import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  LINT_RULES, MAP_SPEC_VERSION, SPEC_ALIGNMENTS, SPEC_ARROWS, SPEC_BRANCHES, SPEC_BRANCH_LAYOUTS, SPEC_DASHES, SPEC_LAYOUTS,
  SPEC_LIMITS, SPEC_SHAPES, SPEC_SIDES, SPEC_SPACINGS, specThemeIds
} from '../../src/lib/core/io/map-spec';
import { agentEdits } from '../agent-write';
import { agentOpsSchema } from '../../src/lib/core/model';
import { SCHEMA_VERSION } from './envelope';

const S = 'https://json-schema.org/draft/2020-12/schema';
const hex = { type: 'string', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const flag = { type: 'boolean' };
const pair = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

/** JSON Schema of the nested JSON twin of a ".map.md" spec. Attribute names match the Markdown attribute block. */
export function specSchema() {
  const node = {
    type: 'object',
    required: ['label'],
    additionalProperties: false,
    properties: {
      label: { type: 'string', description: 'Node text ("" for a picture-only node).' },
      id: { ...id, description: 'Explicit id; needed only where something refers to the node.' },
      note: { type: 'string', maxLength: SPEC_LIMITS.noteBytes },
      task: { enum: ['open', 'done'] },
      color: { ...hex, description: 'Branch colour; inherited by the branch.' },
      text: { ...hex, description: 'Text colour.' },
      fill: { ...hex, description: 'Fill colour.' },
      shape: { enum: [...SPEC_SHAPES] },
      branch: { enum: [...SPEC_BRANCHES] },
      width: { type: 'number', minimum: 0.5, maximum: 64, description: 'Branch width.' },
      bold: flag, italic: flag, curved: flag, boundary: flag, extruded: flag, folded: flag,
      size: { type: 'number', minimum: 6, maximum: 200, description: 'Font size.' },
      font: { type: 'string', description: 'CSS font family list.' },
      align: { enum: [...SPEC_ALIGNMENTS] },
      emphasis: { enum: [0, 1, 2] },
      sticker: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: SPEC_LIMITS.tags },
      href: { type: 'string', description: 'URL or map link. Never opened by the tooling.' },
      side: { enum: [...SPEC_SIDES], description: 'Main branches only.' },
      layout: { enum: [...SPEC_LAYOUTS], description: 'Root layout, or a main-branch override (' + SPEC_BRANCH_LAYOUTS.join(', ') + ').' },
      spacing: { enum: [...SPEC_SPACINGS], description: 'Roots only.' },
      organic: { ...flag, description: 'Roots only.' },
      image: { type: 'string', description: 'Asset name from "assets".' },
      alt: { type: 'string' },
      scale: { type: 'number', minimum: 0.1, maximum: 8 },
      offset: { ...pair, description: 'Manual offset; applied only with --allow-geometry.' },
      pin: { ...pair, description: 'Pinned centre; applied only with --allow-geometry.' },
      children: { type: 'array', items: { $ref: '#/$defs/node' } }
    }
  };
  return {
    $schema: S,
    $id: 'radiant:map-spec:' + MAP_SPEC_VERSION,
    title: 'Radiant map spec (nested JSON twin of .map.md)',
    type: 'object',
    required: ['roots'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      radiant: { const: MAP_SPEC_VERSION },
      title: { type: 'string' },
      theme: { enum: specThemeIds() },
      themeSettings: { type: 'object', description: 'Partial theme overrides accepted by parseThemeSettings; unknown keys are dropped with a warning.' },
      layout: { enum: [...SPEC_LAYOUTS] },
      spacing: { enum: [...SPEC_SPACINGS] },
      seed: { type: 'integer' },
      tagColors: { type: 'object', additionalProperties: hex },
      assets: { type: 'object', propertyNames: { pattern: '^[A-Za-z0-9][\\w.-]{0,63}$' },
        additionalProperties: { type: 'string', description: 'Local file path relative to the spec, or sha256:<hash> with --assets-from.' } },
      roots: { type: 'array', items: { $ref: '#/$defs/node' } },
      links: {
        type: 'array',
        items: {
          type: 'object', required: ['from', 'to'], additionalProperties: false,
          properties: { from: id, to: id, label: { type: 'string' }, dash: { enum: [...SPEC_DASHES] }, arrows: { enum: [...SPEC_ARROWS] }, color: hex }
        }
      }
    },
    $defs: { node }
  };
}

/**
 * The edit batch accepted by "radiant edit", generated from the validator's own definitions (core/model/agent-ops.ts).
 * The earlier three-edit array (MCP edit_map) is listed under $defs.legacyEdits.
 */
export function opsSchema() {
  return { $schema: S, title: 'Radiant agent edit batch (radiant edit, apply, the app socket)', ...agentOpsSchema(),
    $defs: { legacyEdits: z.toJSONSchema(agentEdits) } };
}

export function docSchema() {
  return JSON.parse(readFileSync(new URL('../../src/lib/core/io/radiant-map.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
}

const diagnostic = {
  type: 'object', required: ['severity', 'code', 'message'],
  properties: {
    severity: { enum: ['error', 'warning'] }, code: { type: 'string' }, message: { type: 'string' },
    line: { type: 'integer' }, column: { type: 'integer' }, path: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'string' } }, hint: { type: 'string' }
  }
};
const issue = {
  type: 'object', required: ['rule', 'severity', 'ids', 'message', 'hint'],
  properties: {
    rule: { enum: LINT_RULES.map((r) => r.rule) }, severity: { enum: ['error', 'warn', 'info'] },
    ids: { type: 'array', items: { type: 'string' } }, message: { type: 'string' }, hint: { type: 'string' }
  }
};
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', required, properties });

/** Data shapes of the main report types, keyed by envelope "type". */
export function reportSchemas(): Record<string, unknown> {
  return {
    'build.result': obj(['path', 'backend', 'format', 'revision', 'roots', 'nodes', 'depth', 'links', 'assets', 'ids', 'warnings'], {
      path: { type: ['string', 'null'] }, backend: { const: 'file' }, format: { const: 'portable-bundle' }, status: { enum: ['written', 'dry_run'] },
      revision: { type: 'string' }, roots: { type: 'integer' }, nodes: { type: 'integer' }, depth: { type: 'integer' },
      links: { type: 'integer' }, assets: { type: 'integer' }, ids: obj(['explicit', 'derived'], {}),
      assigned: { type: 'array' }, warnings: { type: 'array', items: diagnostic }
    }),
    'validate.result': obj(['kind', 'valid'], { kind: { type: 'string' }, valid: { type: 'boolean' }, nodes: { type: 'integer' },
      diagnostics: { type: 'array', items: diagnostic }, problems: { type: 'array', items: { type: 'string' } } }),
    'lint.report': obj(['engine', 'issues', 'counts', 'skipped'], { engine: { enum: ['document', 'headless'] }, metrics: { const: 'approximate' },
      issues: { type: 'array', items: issue }, counts: obj([], {}), skipped: { type: 'array' }, presentation: { type: 'string' } }),
    'layout.report': obj(['engine', 'metrics', 'bounds', 'boxes', 'elements', 'sides'], { engine: { const: 'headless' }, metrics: { const: 'approximate' },
      bounds: obj(['x', 'y', 'w', 'h'], {}), aspect: { type: 'number' }, nodes: { type: 'integer' }, visible: { type: 'integer' },
      boxes: { type: 'array', items: obj(['id', 'x', 'y', 'w', 'h', 'depth', 'side', 'lines'], {}) },
      elements: { type: 'array', items: obj(['id', 'kind', 'band', 'x', 'y', 'w', 'h'], {}) }, issues: { type: 'array', items: issue } }),
    'edit.result': obj(['status', 'backend', 'tx', 'applied', 'created', 'links', 'touched', 'revision'], {
      status: { enum: ['applied', 'dry_run'] }, backend: { enum: ['file', 'live'] }, tx: { type: 'string' }, tier: { enum: ['write', 'destructive'] },
      applied: { type: 'integer' }, ops: { type: 'integer' }, created: { type: 'object', additionalProperties: { type: 'string' } },
      links: { type: 'array', items: { type: 'string' } }, elements: { type: 'array', items: { type: 'string' } },
      presentations: { type: 'array', items: { type: 'string' } }, touched: { type: 'array', items: { type: 'string' } },
      revision: { type: 'string' }, previousRevision: { type: 'string' }, output: { type: 'string' }, warnings: { type: 'array' } }),
    'apply.result': obj(['status', 'backend', 'applied', 'plan'], { status: { enum: ['applied', 'dry_run', 'unchanged'] }, plan: obj(['mode'], {}) }),
    'get.result': obj(['backend', 'format', 'nodes', 'total', 'truncated'], { backend: { enum: ['file', 'live'] },
      format: { enum: ['outline', 'spec', 'spec-json', 'json'] }, text: { type: 'string' }, nodes: { type: 'integer' }, total: { type: 'integer' },
      truncated: { type: 'boolean' }, cut: { type: 'array' }, continue: { type: 'array', items: { type: 'string' } } }),
    'find.result': obj(['total', 'truncated', 'matches'], { total: { type: 'integer' }, truncated: { type: 'boolean' },
      matches: { type: 'array', items: obj(['id', 'text', 'path'], { id: { type: 'string' }, text: { type: 'string' },
        path: { type: 'array', items: { type: 'string' } }, depth: { type: 'integer' } }) } }),
    'node.result': obj(['id', 'text', 'path', 'children', 'resolved'], {}),
    'stats.result': obj(['nodes', 'roots', 'depth', 'mainBranches', 'tags', 'tasks', 'pictures', 'links'], {}),
    'list.result': obj(['maps', 'truncated'], { maps: { type: 'array', items: obj(['path', 'modified'], {
      path: { type: 'string' }, title: { type: 'string' }, nodes: { type: 'integer' }, modified: { type: 'string' }, formatVersion: { type: 'integer' } }) } }),
    'history.result': obj(['entries', 'total'], {}),
    'capabilities': obj(['tool', 'spec', 'fileFormats', 'commands', 'enums', 'limits'], {})
  };
}

export function envelopeSchema() {
  return {
    $schema: S,
    title: 'Radiant CLI JSON envelope',
    oneOf: [
      obj(['ok', 'schemaVersion', 'type', 'data'], { ok: { const: true }, schemaVersion: { const: SCHEMA_VERSION }, type: { type: 'string' }, data: {} }),
      obj(['ok', 'schemaVersion', 'error'], {
        ok: { const: false }, schemaVersion: { const: SCHEMA_VERSION },
        error: obj(['code', 'exit', 'message', 'suggestions'], {
          code: { type: 'string' }, exit: { type: 'integer', minimum: 1, maximum: 7 }, message: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } }, hint: { type: 'string' }, diagnostics: { type: 'array', items: diagnostic }
        })
      })
    ]
  };
}

export const SCHEMA_NAMES = {
  spec: 'Nested JSON twin of a .map.md spec',
  ops: 'Edit batch for radiant edit (the agent op vocabulary)',
  doc: 'Stored map document (radiant-map.schema.json)',
  report: 'Data of each report type, by envelope type',
  envelope: 'The --json envelope'
} as const;

export function schemaFor(name: keyof typeof SCHEMA_NAMES): unknown {
  switch (name) {
    case 'spec': return specSchema();
    case 'ops': return opsSchema();
    case 'doc': return docSchema();
    case 'report': return { $schema: S, title: 'Radiant CLI report data, by envelope type', $defs: reportSchemas() };
    case 'envelope': return envelopeSchema();
  }
}
