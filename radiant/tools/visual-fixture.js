const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = performance.now() + 12_000;
while (!window.__radiant?.c.ready) {
  if (performance.now() > deadline) throw Error('Open the Radiant development server first');
  await wait(20);
}
const { c, editor, renderer, pipeline } = window.__radiant;
if (!c.isBrowser) throw Error('Visual fixture requires the offline browser host');
await document.fonts.ready;

const fixedDate = '2026-01-01T00:00:00Z';
const photo = document.createElement('canvas');
photo.width = 120;
photo.height = 84;
const context = photo.getContext('2d');
const sky = context.createLinearGradient(0, 0, 0, 84);
sky.addColorStop(0, '#659fc2');
sky.addColorStop(1, '#f7d7bc');
context.fillStyle = sky;
context.fillRect(0, 0, 120, 84);
context.fillStyle = '#fff0a9';
context.beginPath();
context.arc(88, 25, 13, 0, 2 * Math.PI);
context.fill();
context.fillStyle = '#335949';
context.beginPath();
context.moveTo(0, 80);
context.lineTo(35, 27);
context.lineTo(75, 75);
context.lineTo(105, 47);
context.lineTo(120, 65);
context.lineTo(120, 84);
context.lineTo(0, 84);
context.fill();
const photoBytes = await new Promise(resolve => photo.toBlob(resolve, 'image/png'));
const photoHash = 'fixture-photo';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 84"><circle cx="60" cy="42" r="34" fill="#f1ce77"/><path d="M25 62 Q60 11 95 62 Q60 38 25 62Z" fill="#3f716b" stroke="#284944" stroke-width="3"/></svg>';
const svgHash = 'fixture-svg';
const urls = new Map([[photoHash, URL.createObjectURL(photoBytes)],
  [svgHash, URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))]]);
const mockAssetUrl = c.host.assetUrl.bind(c.host);
c.host.assetUrl = async hash => urls.get(hash) ?? mockAssetUrl(hash);

c.showInspector = false;
c.showOutline = false;
c.showMinimap = false;
c.showGeneratedArtwork = true;
c.darkChrome = false;
const layouts = ['mindmap', 'right', 'left', 'down', 'radial'];
const branches = ['tapered', 'organic', 'line', 'rounded', 'angular'];
const captures = {};
for (const [index, layout] of layouts.entries()) {
  const nodes = {};
  function add(id, parent, text, fields = {}) {
    nodes[id] = { id, parent, text, children: [], origin: { by: 'user' }, ...fields };
    if (parent) nodes[parent].children.push(id);
  }
  add('root', null, 'Field notes');
  add('survey', 'root', 'Survey');
  add('canopy', 'survey', 'Canopy');
  add('soil', 'survey', 'Soil');
  add('wildlife', 'root', 'Wildlife');
  add('tracks', 'wildlife', 'Tracks');
  add('birdsong', 'wildlife', 'Birdsong');
  add('water', 'root', 'Water');
  add('rain', 'water', 'Rain');
  add('streams', 'water', 'Streams');
  if (index === 0) {
    nodes.canopy.imageAsset = photoHash;
    nodes.canopy.imageAlt = 'Synthetic mountain scene';
    nodes.wildlife.collapsed = true;
    nodes.rain.representation = 'svg';
    nodes.rain.svgArt = { assetHash: svgHash, inputHash: 'fixture', prompt: 'Fixed vector',
      styleId: 'fixture', styleVersion: 1, generatedAt: fixedDate,
      pixelSize: { width: 120, height: 84, padding: 0 } };
  }
  const themeSettings = { branch: fault === 'shape' && index === 0 ? 'angular' : branches[index] };
  if (fault === 'colour' && index === 0) themeSettings.branchColors = ['#ff0066', '#912cec', '#009057'];
  editor.load({ id: 'visual-regression', version: 1, title: 'Field notes', roots: ['root'],
    rootInfo: { root: { layout, position: { x: 0, y: 0 } } }, nodes, links: [],
    themeId: 'clean', themeSettings, seed: 27477, created: fixedDate, modified: fixedDate });
  c.select(index === 0 ? ['canopy', 'water'] : []);
  if (index === 0) await Promise.all([c.ensureImage(photoHash), c.ensureImage(svgHash)]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    c.flush();
    const box = pipeline.layout.bounds;
    const zoom = Math.min(1.3, (c.camera.width - 100) / box.w, (c.camera.height - 80) / box.h);
    c.camera.set({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom });
    renderer.render();
    // The renderer can temporarily draw from a nearby atlas bucket. Wait for the
    // actual requested resolution so warm-up timing cannot change the baseline.
    const exactLabels = renderer.drawIdx.every((label, i) =>
      renderer.atlas.exact(renderer.labelEntries[label], renderer.drawBucket[i]));
    if (renderer.stats.meshTriangles > 0 && exactLabels &&
        renderer.stats.labelsGreeked === 0 && renderer.stats.labelsDrawn === renderer.scene.labels.length &&
        (index !== 0 || (renderer.stats.imagesDrawn === 2 && renderer.images.textureCount >= 2))) {
      ready = true;
      break;
    }
    await wait(40);
  }
  if (!ready) throw Error('Fixture did not settle: ' + layout + ', stats=' + JSON.stringify(renderer.stats));
  captures[layout + '-' + branches[index]] = renderer.canvas.toDataURL('image/png').split(',')[1];
  if (fault !== 'none') break;
}
// One scene per Everyday theme (light), with the spec's sample map (THM-34).
const everyday = ['daylight', 'studio', 'sorbet', 'citrus', 'lagoon', 'boardroom'];
for (const themeId of fault === 'none' ? everyday : []) {
  const nodes = {};
  function add(id, parent, text) {
    nodes[id] = { id, parent, text, children: [], origin: { by: 'user' } };
    if (parent) nodes[parent].children.push(id);
  }
  add('root', null, 'Launch');
  for (const [id, text, leaves] of [['channels', 'Channels', ['Newsletter', 'Community']], ['audience', 'Audience', ['Early adopters', 'Design teams']],
    ['timeline', 'Timeline', ['Private beta', 'Public launch']], ['risks', 'Risks', ['Capacity', 'Pricing']],
    ['metrics', 'Metrics', ['Activation', 'Referrals']]]) {
    add(id, 'root', text);
    leaves.forEach((leaf, i) => add(id + i, id, leaf));
  }
  editor.load({ id: 'visual-regression', version: 1, title: 'Launch', roots: ['root'],
    rootInfo: { root: { layout: 'mindmap', position: { x: 0, y: 0 } } }, nodes, links: [],
    themeId, themeSettings: { canvasAppearance: 'light' }, seed: 27477, created: fixedDate, modified: fixedDate });
  c.select([]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    c.flush();
    const box = pipeline.layout.bounds;
    c.camera.set({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 1 });
    renderer.render();
    const exactLabels = renderer.drawIdx.every((label, i) =>
      renderer.atlas.exact(renderer.labelEntries[label], renderer.drawBucket[i]));
    if (renderer.stats.meshTriangles > 0 && exactLabels && renderer.stats.labelsGreeked === 0 &&
        renderer.stats.labelsDrawn === renderer.scene.labels.length) {
      ready = true;
      break;
    }
    await wait(40);
  }
  if (!ready) throw Error('Fixture did not settle: ' + themeId + ', stats=' + JSON.stringify(renderer.stats));
  captures['theme-' + themeId] = renderer.canvas.toDataURL('image/png').split(',')[1];
}
return { captures, width: renderer.canvas.width, height: renderer.canvas.height,
  dpr: window.devicePixelRatio, webkit: navigator.userAgent };
