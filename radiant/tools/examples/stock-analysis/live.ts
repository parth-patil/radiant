// Build the stock-analysis map in the open Radiant app through the live MCP server, as an MCP client such as Claude Code would.
// Run: bun tools/examples/stock-analysis/live.ts   then choose "Read and edit" and click Allow in Radiant.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BRANCHES, canvasOps, count, treeOps } from './content';
const transport = new StdioClientTransport({ command: 'bun', args: [new URL('../../agent-cli.ts', import.meta.url).pathname, 'mcp', '--live'] });
const client = new Client({ name: 'stock-map', version: '1' });
await client.connect(transport);
const log = (step: string, value: unknown) => console.log(step + ' ' + JSON.stringify(value).slice(0, 700));
async function call(name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  let value: any = result.content?.[0]?.text ?? '';
  try { value = JSON.parse(value); } catch {}
  return { isError: !!result.isError, value };
}
try {
  const status = await call('radiant_status'); log('status', status.value);
  if (!status.value.running) throw new Error('Radiant is not running.');
  let connect = await call('radiant_connect', { access: 'edit' }); log('connect', connect.value);
  // The owner may be away from the app: ask again a few times, a minute each.
  for (let attempt = 1; attempt < 6 && connect.isError && (connect.value?.error?.code === 'no_answer' || /already asking/.test(connect.value?.error?.message ?? '')); attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    connect = await call('radiant_connect', { access: 'edit' }); log('connect again', connect.value);
  }
  if (connect.isError) throw new Error('Not connected: ' + connect.value?.error?.message);
  const data = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    if (r.isError || !r.value?.data) throw new Error(name + ' failed: ' + JSON.stringify(r.value).slice(0, 600));
    return r.value.data;
  };
  const stats = await data('radiant_query', { command: 'stats', args: ['@live'] }); log('before', { nodes: stats.nodes, roots: stats.roots, title: stats.title });
  const blank = stats.nodes === 1 && ['', 'Central topic'].includes(stats.roots[0].text);
  let rootId: string = stats.roots[0].id;
  let ops = treeOps(rootId, blank);
  if (!blank) {
    // Keep what is there: the new map goes to the right of the existing content.
    const lay = await data('radiant_query', { command: 'layout', args: ['@live', '--limit', '1'] });
    const b = lay.bounds;
    ops = treeOps(rootId, false).map((op) => op.op === 'add-root' ? { ...op, position: { x: b.x + b.w + 1500, y: b.y + b.h / 2 } } : op);
  }
  const dry = await call('radiant_edit', { ops, label: 'Build the stock analysis map', dryRun: true }); log('dry run', dry.isError ? dry.value : { status: dry.value.data.status, applied: dry.value.data.applied, ops: dry.value.data.ops });
  if (dry.isError) throw new Error('The batch did not pass the dry run.');
  const tree = await call('radiant_edit', { ops, label: 'Build the stock analysis map' });
  log('tree', tree.isError ? tree.value : { status: tree.value.data.status, tx: tree.value.data.tx, applied: tree.value.data.applied, ops: tree.value.data.ops, backend: tree.value.data.backend, warnings: tree.value.data.warnings });
  if (tree.isError) throw new Error('The tree was not applied.');
  if (!blank) rootId = tree.value.data.created.root;
  await new Promise((r) => setTimeout(r, 1500));
  const lay = await data('radiant_query', { command: 'layout', args: ['@live', '--node', rootId, '--limit', '1'] });
  const bounds = lay.bounds; log('bounds', bounds);
  const sketch = await call('radiant_edit', { ops: canvasOps(bounds), label: 'Sketch the workflow, formulas and decision' });
  log('sketch', sketch.isError ? sketch.value : { status: sketch.value.data.status, tx: sketch.value.data.tx, applied: sketch.value.data.applied, elements: sketch.value.data.elements?.length });
  await new Promise((r) => setTimeout(r, 800));
  log('view', (await call('radiant_view', { select: [rootId], fit: 'map' })).value);
  const after = await data('radiant_query', { command: 'stats', args: ['@live'] }); log('after', { nodes: after.nodes, title: after.title, depth: after.depth, links: after.links });
  const lint = await data('radiant_query', { command: 'lint', args: ['@live'] }); log('lint', { counts: lint.counts, rules: (lint.issues ?? []).map((i: any) => i.rule) });
  log('find', (await call('radiant_find', { query: 'margin of safety', limit: 3 })).value.data?.matches?.map((m: any) => m.path ?? m.label ?? m.text));
  console.log('planned nodes ' + (count(BRANCHES) + 1));
} catch (e) {
  console.log('STOPPED ' + (e instanceof Error ? e.message : String(e)));
} finally {
  await client.close();
}
