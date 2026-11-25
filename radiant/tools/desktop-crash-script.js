const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check) {
  const deadline = performance.now() + 12_000;
  while (!check()) {
    if (performance.now() > deadline) throw Error('Timed out waiting for the application');
    await sleep(10);
  }
}

export async function run(c) {
  const native = await c.host.fixtureContext();
  const report = (kind, extra = {}) => {
    // A synchronous request makes each observed acceptance boundary unambiguous
    // when the process is interrupted. It does not fake any native write or ACK.
    const request = new XMLHttpRequest();
    request.open('POST', '/_gate-event', false);
    request.send(JSON.stringify({ ...native, kind, ...extra }));
    if (request.status !== 200) throw Error('Gate telemetry failed: ' + request.responseText);
    return JSON.parse(request.responseText);
  };
  try {
    const state = report('attached');
    if (state.mode === 'seed') {
      c.host.pickSavePath = async () => state.path;
      if (!await c.save()) throw Error('Could not create native fixture');
      report('seeded');
      return;
    }
    if (state.phase === 'verify') {
      if (state.mode !== 'webview' && native.label === 'main') {
        await until(() => c.desktopSession.includes(state.path));
        if (state.mode !== 'power' && c.recovery.length) throw Error('Unexpected recovery prompt');
        await c.finishDesktopSession(true);
        return;
      }
      await until(() => c.filePath === state.path);
      await c.checkRecovery();
      const root = c.doc.roots[0];
      if (state.mode === 'generation') {
        const notice = document.querySelector('[aria-label="Recovered AI work"]');
        if (!notice) throw Error('The reopened map did not explain the interrupted generation');
        report('reopened', { titles: Object.values(c.doc.nodes).map(n => n.text).sort(),
          notice: notice.querySelector('span').textContent, busy: c.busy,
          draft: c.doc.roots.some(id => c.doc.nodes[id].generatedDraft),
          jobs: Object.values(c.doc.aiJobs ?? {}).map(job => job.status) });
        return;
      }
      report('reopened', { text: c.doc.nodes[root].text, dirty: c.dirty, recoveries: c.recovery.length,
        undo: c.editor.undoLabel });
      return;
    }
    if (native.label !== 'main') throw Error('Unexpected window during edit script');
    await c.openDoc(state.path, true);
    if (state.mode === 'generation') report('map-open');
    if (c.filePath !== state.path) throw Error('Could not open test map');
    if (state.mode === 'generation') {
      const index = Number(/generation-(\d+)\.radiant$/.exec(state.path)[1]);
      if (index % 2) {
        c.setNodeText(c.doc.roots[0], 'Earlier committed edit');
        if (!await c.editor.settled()) throw Error('The prior user edit was not saved');
      }
      const commit = c.host.docCommit.bind(c.host);
      c.host.docCommit = async (docId, json, path, operation) => {
        const stored = await commit(docId, json, path, operation);
        const nodes = Object.values(JSON.parse(json).nodes);
        if (!stored) throw Error('Generated edit went only to recovery');
        report('generation-ack', { titles: nodes.map(node => node.text).sort() });
        return stored;
      };
      c.topic = 'Fixture topic 0';
      await c.generate();
      if (!c.gen) throw Error(c.aiStatus?.error ?? 'The offline generation did not start');
      const target = 2 + index % 4;
      await until(() => c.gen?.nodes >= target && c.busy);
      await c.editor.settled();
      report('editing');
      return;
    }
    const id = c.doc.roots[0];
    const original = c.host.docCommit.bind(c.host);
    c.host.docCommit = async (docId, json, path, operation) => {
      const number = Number(JSON.parse(json).nodes[id].text.split(':')[1]);
      report('invoke', { number });
      const result = await original(docId, json, path, operation);
      report('ack', { number, result });
      return result;
    };
    c.editor.subscribe(change => {
      if (change.kind === 'apply') {
        report('accepted', { number: Number(change.doc.nodes[id].text.split(':')[1]) });
      }
    });
    report('editing');
    for (let number = 1; number <= 400; number++) {
      c.setNodeText(id, 'crash-edit:' + number);
      // Keep requests coming both before and after acknowledgements.
      if (number % 3 === 0) await sleep(8);
    }
    report('script-finished');
  } catch (error) {
    report('error', { message: String(error) });
  }
}
