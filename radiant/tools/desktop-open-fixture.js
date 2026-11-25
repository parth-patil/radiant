// Copied into a scratch native WebView build by check-disk-open.py.
import { buildFixture } from './memory-fixture.js';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};

async function digest(doc) {
  const data = new TextEncoder().encode(JSON.stringify(canonical(doc)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

function frame() {
  if (window.__diskOpenFrame) return Promise.resolve(window.__diskOpenFrame);
  return new Promise((resolve, reject) => {
    const complete = () => {
      clearTimeout(timer);
      resolve(window.__diskOpenFrame);
    };
    const timer = setTimeout(() => {
      window.removeEventListener('radiant-disk-open-frame', complete);
      reject(Error('No 5,000-node frame reached the WebView'));
    }, 15000);
    window.addEventListener('radiant-disk-open-frame', complete, { once: true });
  });
}

export async function run(c) {
  const native = await c.host.fixtureContext();
  const report = async (kind, extra = {}) => {
    const response = await fetch('/_gate-event', { method: 'POST', body: JSON.stringify({ ...native, kind, ...extra }) });
    if (!response.ok) throw Error('The disk open monitor rejected a receipt');
    return response.json();
  };
  try {
    const plan = await report('attached');
    if (plan.mode === 'seed') {
      const doc = buildFixture(c, plan.scenario, plan.hashes);
      const node = Object.values(doc.nodes).find(n => n.imageAsset);
      Object.assign(node, {
        note: 'Transect notes with line breaks and Unicode.\nMarsh plot Δ.',
        style: { color: '#237290', fontSize: 19, bold: true },
        offset: { x: -47, y: 21 },
        representation: 'picture',
      });
      doc.nodes[doc.roots[0]].representation = 'vector';
      const expected = await digest(doc);
      await c.host.docSave(plan.scenario.path, JSON.stringify(doc));
      await report('seeded', { expected });
    } else if (native.label === 'main') {
      await c.finishDesktopSession(false);
      await report('ready');
    } else {
      await report('waiting');
      const start = performance.now();
      while (!c.filePath) {
        if (performance.now() - start > 10000) throw Error('The native document was never installed');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await report('loaded', {
        visibility: document.visibilityState, nodes: Object.keys(c.doc.nodes).length,
        sceneNodes: c.pipeline.nodeCount, read: window.__diskOpenRead
      });
      if (plan.mode === 'structure') {
        await report('structure', {
          structure: await digest(c.doc), read: window.__diskOpenRead,
          images: Object.values(c.doc.nodes).filter(n => n.imageAsset).length,
        });
        await c.host.fixtureCloseWindow();
        return;
      }
      const sample = await frame();
      void report('drawn', sample).catch(() => {});
      const snapshot = await c.host.fixtureOpenSnapshot();
      const count = Object.values(c.doc.nodes).filter(n => n.imageAsset).length;
      if (count !== 300) throw Error('Wrong reference picture count');
      await report('presented', { ...sample, snapshot, read: window.__diskOpenRead, structure: await digest(c.doc), images: count });
      await c.host.fixtureCloseWindow();
    }
  } catch (error) {
    await report('error', {
      message: String(error), visibility: document.visibilityState,
      nodes: c.pipeline.nodeCount, currentDocument: c.pipeline.doc === c.doc,
      frame: window.__diskOpenFrame, render: c.diagnosticRenderSummary()
    });
  }
}
