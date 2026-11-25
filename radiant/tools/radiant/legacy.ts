import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { outlineFromDoc, outlineFromSubtree, parseDocReport } from '../../src/lib/core/model';
import { toMarkdownOutline } from '../../src/lib/core/io/markdown';
import type { Doc } from '../../src/lib/core/types';
import { agentEdits, optionalConnection, requestEdits, requestSnapshot, writeConnection, type AgentConnection } from '../agent-write';
import { CliError, EXIT, conflict, type CommandResult } from './envelope';
import { openMap } from './sources';
import { readStoredMap } from './store';
import type { Ctx } from './read';

async function readDoc(path: string, connection?: AgentConnection | null): Promise<Doc> {
  return (await openMap(path, { connection })).doc;
}

async function search(path: string, query: string, connection?: AgentConnection | null) {
  const doc = await readDoc(path, connection);
  const q = query.toLowerCase();
  return Object.values(doc.nodes).filter(n => [n.text, n.note, ...(n.tags ?? [])].some(s => s?.toLowerCase().includes(q)))
    .map(({ id, text }) => ({ id, text }));
}

export async function markdownCommand(ctx: Ctx): Promise<CommandResult> {
  const src = await openMap(ctx.args.positionals[0]);
  const markdown = toMarkdownOutline(src.doc.roots.map(id => outlineFromDoc(src.doc, id)));
  return { type: 'markdown', data: { backend: src.backend, path: src.path, markdown }, text: markdown };
}

export async function jsonCommand(ctx: Ctx): Promise<CommandResult> {
  const src = await openMap(ctx.args.positionals[0]);
  return { type: 'map.json', data: src.doc, text: JSON.stringify(src.doc, null, 2) };
}

export async function searchCommand(ctx: Ctx): Promise<CommandResult> {
  const [path, ...words] = ctx.args.positionals;
  if (!words.length) throw new CliError('usage', EXIT.usage, 'Provide a search term', { hint: 'radiant find ' + path + ' TEXT' });
  const matches = await search(path, words.join(' '));
  return { type: 'search.result', data: { matches }, text: JSON.stringify(matches, null, 2) };
}

export async function skillPackCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const { zipSync } = await import('fflate');
  const sources = [
    'SKILL.md', 'agents/openai.yaml', 'references/radiant-map.schema.json', 'references/file-format.md',
    'references/spec.md', 'references/cli.md', 'references/lint-rules.md', 'references/ops.md',
    'references/examples/coffee.map.md', 'references/examples/project-plan.map.md', 'references/examples/study-notes.map.md',
    'references/examples/art/cup.svg'
  ];
  const files: Record<string, Uint8Array> = {};
  for (const name of sources) {
    const url = new URL('../../skills/radiant-map/' + name, import.meta.url);
    let bytes: Uint8Array;
    try { bytes = readFileSync(url); } catch { continue; }
    if (/\.(md|json|yaml)$/.test(name)) {
      const text = new TextDecoder().decode(bytes).replace('../src/lib/core/io/radiant-map.schema.json', 'radiant-map.schema.json');
      bytes = new TextEncoder().encode(text);
    }
    files['radiant-map/' + name] = bytes;
  }
  try {
    writeFileSync(path, zipSync(files), { flag: 'wx' });
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') throw conflict('file_exists', path + ' already exists.', { hint: 'Choose a new file name.' });
    throw e;
  }
  return { type: 'skill-pack.result', data: { path, files: Object.keys(files) }, text: 'Wrote the Radiant agent skill and schema pack.' };
}

/** The stdio MCP server (unchanged tool set: list_maps, read_map, search_map, and edit_map with --write). */
export async function serve(paths: string[], allowWrite: boolean) {
  if (!paths.length) throw Error('Specify the individual .radiant files to share');
  const files = [...new Set(paths.map(p => realpathSync(p)))];
  const connection = allowWrite ? writeConnection() : optionalConnection();
  const granted = connection ? files.indexOf(connection.path) : -1;
  if (allowWrite && granted < 0) throw Error('Specify the granted map among the shared Radiant files');
  for (const [index, path] of files.entries()) {
    if (index !== granted) readStoredMap(path);
    else if (connection) {
      const snapshot = await requestSnapshot(connection);
      if (parseDocReport(snapshot.snapshot).doc.id !== connection.documentId) throw Error('The active map does not match this grant.');
      if (allowWrite && !snapshot.writable) throw Error('This grant allows live reads only.');
    }
  }
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'radiant', version: '0.1.0' });
  const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const map = z.number().int().min(0).max(files.length - 1);
  server.registerTool('list_maps', { description: 'List maps shared with this session' }, async () =>
    result(JSON.stringify(files.map((path, id) => ({ id, name: basename(path) })))));
  server.registerTool('read_map', { description: 'Read a map or a subtree as Markdown', inputSchema: { map, node: z.string().optional() } }, async ({ map, node }) => {
    const doc = await readDoc(files[map], connection);
    if (node && !Object.hasOwn(doc.nodes, node)) throw Error('Unknown node');
    return result(toMarkdownOutline(node ? [outlineFromSubtree(doc, node)] : doc.roots.map(id => outlineFromDoc(doc, id))));
  });
  server.registerTool('search_map', { description: 'Search node text, notes and tags', inputSchema: { map, query: z.string().min(1) } },
    async ({ map, query }) => result(JSON.stringify(await search(files[map], query, connection))));
  if (allowWrite && connection) {
    server.registerTool('edit_map', {
      description: 'Apply one undoable batch of edits to the explicitly granted open map.',
      inputSchema: { map, edits: agentEdits }
    }, async ({ map, edits }) => {
      if (map !== granted) throw Error('Write access is scoped to the explicitly granted map');
      await requestEdits(connection, edits);
      return result('Applied in Radiant as one undoable batch.');
    });
  }
  await server.connect(new StdioServerTransport());
}
