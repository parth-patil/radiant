// Browser acceptance fixture loaded by tools/check-ai-cancellation.py.
import { ReplayProvider } from '../src/lib/host/replay';
import { createDoc } from '../src/lib/core/model';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function wait(check, label) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const result = check();
    if (result) return result;
    await sleep(5);
  }
  throw new Error('Timed out waiting for ' + label);
}

function framesFromWire(jsonl) {
  const rows = jsonl.trim().split('\n').map(line => JSON.parse(line));
  const start = rows.find(row => row.dir === 'out' && row.msg.method === 'turn/start');
  const end = rows.find(row => row.dir === 'in' && row.msg.method === 'turn/completed');
  assert(start && end?.msg.params.turn.status === 'interrupted' && end.msg.params.turn.items.length === 0,
    'Expected an interrupted wire recording with empty final items');
  const frames = [{ delay: 0, event: { kind: 'started', route: 'replay' } }];
  let previous = start.t_ms;
  for (const row of rows.filter(row => row.dir === 'in' && row.msg.method === 'item/agentMessage/delta')) {
    frames.push({ delay: Math.max(1, (row.t_ms - previous) * 0.2), event: { kind: 'delta', text: row.msg.params.delta } });
    previous = row.t_ms;
  }
  frames.push({ delay: 350, event: { kind: 'cancelled' } });
  return frames;
}

export async function run(c, jsonl, seed = 87) {
  const frames = framesFromWire(jsonl);
  const duration = frames.reduce((total, frame) => total + frame.delay, 0);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const provider = new ReplayProvider(async () => '', request => request.kind === 'image'
    ? [{ delay: 0, event: { kind: 'started', route: 'replay' } }, { delay: 1500, event: { kind: 'done' } }]
    : frames);
  let observed = [];
  const receive = event => { observed.push(event); c.onAiEvent(event); };
  await provider.onAiEvent(receive);
  c.host.aiStartTurn = provider.aiStartTurn.bind(provider);
  c.host.aiResolveMapRound = provider.aiResolveMapRound.bind(provider);
  c.host.aiCancel = provider.aiCancel.bind(provider);
  c.host.onAiEvent = provider.onAiEvent.bind(provider);

  const runs = [];
  for (let index = 0; index < 10; index++) {
    c.loadDoc(createDoc(), null, false);
    observed = [];
    c.topic = 'Interrupted wire replay';
    c.togglePrompt(true);
    await c.generate();
    const started = await wait(() => observed.find(event => event.kind === 'started'), 'replay start');
    const offset = Math.round((index + random()) * (duration - 100) / 10);
    await sleep(offset);
    const button = await wait(() => document.querySelector('.prompt .actions button:not([disabled])'), 'text cancel control');
    const nodes = Object.keys(c.doc.nodes).length;
    const deltas = observed.filter(event => event.kind === 'delta').length;
    const at = performance.now();
    button.click();
    await wait(() => !c.gen, 'editable map');
    const id = c.doc.roots[0];
    const before = c.doc.nodes[id].text;
    c.setNodeText(id, 'Editable after cancellation');
    assert(c.doc.nodes[id].text === 'Editable after cancellation', 'The editor did not accept the edit');
    const editableMs = performance.now() - at;
    c.undo();
    assert(c.doc.nodes[id].text === before, 'Undo did not restore the editable map');
    receive({ jobId: started.jobId, kind: 'delta', text: '{"id":"late","parent":null,"title":"Late row"}\n' });
    receive({ jobId: started.jobId, kind: 'done' });
    await sleep(16);
    assert(Object.keys(c.doc.nodes).length === nodes && !Object.values(c.doc.nodes).some(node => node.text === 'Late row'),
      'A cancelled job changed the map');
    runs.push({ offsetMs: offset, editableMs: Number(editableMs.toFixed(2)), nodes, deltas });
  }
  assert(runs.some(row => row.deltas === 0) && runs.some(row => row.deltas > 0), 'Expected early and late cancellation points');

  c.loadDoc(createDoc(), null, false);
  c.togglePrompt(false);
  c.showInspector = true;
  observed = [];
  const root = c.doc.roots[0];
  c.select([root]);
  const artButton = name => [...document.querySelectorAll('.art-panel button')]
    .find(button => button.textContent.trim() === name && !button.disabled);
  (await wait(() => artButton('Picture'), 'picture mode')).click();
  (await wait(() => artButton('Generate this node'), 'picture action')).click();
  (await wait(() => artButton('Confirm generation'), 'picture confirmation')).click();
  await wait(() => observed.find(event => event.kind === 'started'), 'picture request');
  const cancelPicture = await wait(() => artButton('Cancel artwork generation'), 'picture cancel control');
  const pictureAt = performance.now();
  cancelPicture.click();
  await wait(() => artButton('Generate this node'), 'editable picture panel');
  assert(!c.doc.nodes[root].pictureArt, 'A cancelled picture was applied');
  return { seed, runs, pictureEditableMs: Number((performance.now() - pictureAt).toFixed(2)) };
}
