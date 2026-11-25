// Bundled into an isolated native fixture only.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 95000) {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > timeout) throw Error('Timed out: ' + label);
    await wait(40);
  }
}

export function buildFixture(c, size, hashes) {
  c.loadSynthetic(size.nodes);
  const doc = c.doc;
  doc.title = 'Ecology field survey · ' + size.nodes;
  doc.id = 'rss-fixture-' + size.nodes;
  doc.seed = 47231;
  doc.created = doc.modified = '2026-01-01T00:00:00Z';
  const ids = new Map(Object.keys(doc.nodes).map((id, i) => [id, 'node-' + i]));
  doc.roots = doc.roots.map(id => ids.get(id));
  doc.rootInfo = Object.fromEntries(Object.entries(doc.rootInfo).map(([id, root]) => [ids.get(id), root]));
  doc.nodes = Object.fromEntries(Object.entries(doc.nodes).map(([id, node]) => {
    const key = ids.get(id);
    return [key, { ...node, id: key, parent: node.parent ? ids.get(node.parent) : null,
      children: node.children.map(child => ids.get(child)) }];
  }));
  delete doc.layoutPlacements;
  const captions = ['Watershed sampling', 'Raised trail markers', 'Canopy variation study',
    'Seasonal changes in the lower marsh', 'Transect methods and station notes', 'Rock and soil profiles',
    'Wind-exposed ridges', 'Bird counts and field observations', 'River access and habitat notes'];
  let i = 0;
  const candidates = [];
  for (const node of Object.values(doc.nodes)) {
    node.text = captions[i % captions.length] + ' ' + ++i;
    if (node.parent) candidates.push(node);
  }
  if (size.pictures) {
    for (const [i, hash] of hashes.entries()) {
      const node = candidates[Math.floor((i + 0.5) * candidates.length / hashes.length)];
      node.imageAsset = hash;
      node.imageAlt = 'Synthetic field survey picture ' + (i + 1);
    }
  }
  return doc;
}

export async function run(c) {
  const native = await c.host.fixtureContext();
  const report = async (kind, extra = {}) => {
    const result = await fetch('/_gate-event', { method: 'POST', body: JSON.stringify({ ...native, kind, ...extra }) });
    if (!result.ok) throw Error('RSS monitor could not receive the fixture event');
    return result.json();
  };
  try {
    const plan = await report('attached');
    if (plan.mode === 'seed') {
      const hashes = plan.hashes;
      if (new Set(hashes).size !== 300) throw Error('Picture fixture must contain 300 distinct files');
      for (const size of plan.scenarios) {
        const doc = buildFixture(c, size, hashes);
        await c.host.docSave(size.path, JSON.stringify(doc));
      }
      await report('seeded');
    } else if (native.label === 'main') {
      await c.finishDesktopSession(false);
      await report('ready');
    } else {
      const { scenario, cycle } = plan;
      await report('opening', { cycle });
      await until(() => c.filePath === scenario.path, 'open saved map');
      const root = c.doc.roots[0];
      const nodeCount = Object.keys(c.doc.nodes).length;
      const pictureCount = Object.values(c.doc.nodes).filter(n => n.imageAsset).length;
      if (nodeCount !== scenario.nodes || pictureCount !== scenario.pictures) throw Error('Wrong reference map');
      if (scenario.visible) await until(() => document.visibilityState === 'visible', 'visible reference map');
      if (nodeCount === 50000 && !scenario.visible) {
        // The hidden WKWebView can suspend the streamed 50k worker handoff.
        // Sample the actual renderer after the application's synchronous fallback.
        c.layoutWorker?.terminate();
        c.layoutWorker = null;
        c.layoutWorkerUnavailable = true;
        c.layoutInFlight = null;
        c.layoutAssembly = null;
        c.layoutReply = null;
        c.flush();
      } else {
        await until(() => {
          c.flush(false);
          return c.pipeline.nodeCount === scenario.nodes && !!c.pipeline.box(root);
        }, 'reference layout');
      }
      if (c.pipeline.nodeCount !== nodeCount) throw Error('The full reference map did not render');
      const source = c.pipeline.lastLayoutSource;
      await report('layout-ready', { cycle, source });
      if (pictureCount && source !== 'worker') throw Error('Large layout did not use the worker');
      if (scenario.visible && nodeCount === 50000 && source !== 'worker') throw Error('Stress layout did not use the worker');
      c.zoomFit(false);
      c.renderer.render();
      let drawnPictures = 0;
      if (pictureCount) {
        const picture = Object.values(c.doc.nodes).find(n => n.imageAsset);
        await Promise.race([c.ensureImage(picture.imageAsset), wait(8000).then(() => {
          throw Error('The reference picture did not decode');
        })]);
        await report('picture-decoded', { cycle });
        c.markLayout();
        await until(() => {
          c.flush(false);
          const placement = c.pipeline.box(picture.id);
          if (!placement) return false;
          c.camera.set({ cx: placement.x, cy: placement.y, zoom: 0.7 });
          c.renderer.render();
          drawnPictures = Math.max(drawnPictures, c.renderer.stats.imagesDrawn);
          return drawnPictures > 0 && c.renderer.stats.gpuImageMB > 0;
        }, 'picture submitted and texture resident', 12000).catch(error => {
          throw Error(String(error) + ': ' + JSON.stringify(c.renderer.stats) + ', image info ' + c.pipeline.imageInfo.size);
        });
      }
      await report('opened', { cycle, nodeCount, pictureCount, drawnPictures, layoutSource: source });
      await until(async () => (await report('map-poll', { step: 'edit' })).step === 'edit', 'edit command');
      const text = 'Edited watershed title · ' + cycle + ' · ' + native.id.slice(0, 8);
      const revision = c.rev;
      c.setNodeText(root, text);
      if (!await c.editor.settled() || c.dirty || c.rev <= revision || c.doc.nodes[root].text !== text) {
        throw Error('Edit did not reach the journal');
      }
      await until(() => { c.flush(false); return !c.needLayout; }, 'edited layout');
      c.renderer.render();
      await report('edited', { cycle });
      await until(async () => (await report('map-poll', { step: 'close' })).step === 'close', 'close command');
      await c.host.fixtureCloseWindow();
    }
  } catch(error) {
    await report('error', { label: native.label, message: String(error) });
  }
}
