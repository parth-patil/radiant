// Copied into the isolated release build by check-reference-performance.py.
import { buildFixture } from './desktop-memory-fixture.js';
import { panReference } from './reference-pan.js';

export async function referenceDocument(c, scenario, hashes) {
  const doc = buildFixture(c, scenario, hashes);
  if (scenario.pictures) {
    const illustrated = Object.values(doc.nodes).filter(node => node.imageAsset);
    for (const node of illustrated) node.representation = 'picture';
    // Include a vector artwork subtree in addition to the 300 stored raster pictures.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M5 85L40 22L60 50L75 33L95 85Z" fill="#536e58"/></svg>');
    const hash = await c.host.assetPut(svg, 'image/svg+xml');
    const node = Object.values(doc.nodes).find(n => n.parent && !n.imageAsset && n.children.length);
    node.representation = 'svg';
    node.svgArt = { assetHash: hash, inputHash: hash, prompt: 'Mountain survey', styleId: 'survey',
      styleVersion: 1, generatedAt: doc.created };
  }
  return doc;
}

export async function run(c) {
  const native = await c.host.fixtureContext();
  async function report(kind, extra = {}) {
    const response = await fetch('/_gate-event', { method: 'POST', body: JSON.stringify({ ...native, kind, ...extra }) });
    if (!response.ok) throw Error('Performance monitor rejected a receipt');
    return response.json();
  }
  try {
    const plan = await report('attached');
    if (plan.mode === 'seed') {
      for (const scenario of plan.scenarios) {
        const doc = await referenceDocument(c, scenario, plan.hashes);
        await c.host.docSave(scenario.path, JSON.stringify(doc));
      }
      await report('seeded');
    } else if (native.label === 'main') {
      await c.finishDesktopSession(false);
      await report('ready');
    } else {
      const { scenario, cycle } = plan;
      if (!window.__referenceFrame) {
        await new Promise(resolve => window.addEventListener('reference-frame', resolve, { once: true }));
      }
      if (c.filePath !== scenario.path) throw Error('Opened the wrong map');
      const info = await c.host.platformInfo();
      const monitor = await c.host.fixtureMonitor();
      if (!monitor) throw Error('Window has no physical display');
      const capture = { monitor: monitor.name, monitorX: monitor.position.x, monitorY: monitor.position.y,
        dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
        screenWidth: screen.width, screenHeight: screen.height,
        screenX: window.screenX, screenY: window.screenY, ...info };
      const pan = await panReference(c, scenario, scenario.slowdownMs);
      await report('measured', { cycle, sample: { name: scenario.name, nodes: scenario.nodes,
        pictures: scenario.pictures, capture, ...window.__referenceFrame, ...pan } });
      await c.host.fixtureCloseWindow();
    }
  } catch (error) {
    await report('error', { message: String(error), label: native.label });
  }
}
