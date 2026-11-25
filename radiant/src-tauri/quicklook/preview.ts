import { getTheme, parseDocReport } from '../../src/lib/core/model';
import { premulCss } from '../../src/lib/core/geometry';
import { measureLabel } from '../../src/lib/render/text';
import { Pipeline } from '../../src/lib/ui/pipeline';
import { renderExport } from '../../src/lib/ui/export-visual';
import type { Doc, Rect } from '../../src/lib/core/types';

declare const webkit: {
  messageHandlers: { preview: { postMessage(request: { kind: string; hash?: string }): Promise<string> } };
};

// The preview shows the first root and its immediate neighbourhood, even on very large maps.
function rootArea(doc: Doc) {
  const root = doc.roots[0];
  const ids = [root];
  for (let i = 0; i < ids.length && ids.length < 128; i++) {
    const node = doc.nodes[ids[i]];
    if (!node.collapsed) ids.push(...node.children.slice(0, 128 - ids.length));
  }
  const visible = new Set(ids);
  for (const id of ids) doc.nodes[id].children = doc.nodes[id].children.filter(child => visible.has(child));
  doc.roots = [root];
  doc.rootInfo = { [root]: doc.rootInfo[root] };
  doc.nodes = Object.fromEntries(ids.map(id => [id, doc.nodes[id]]));
  doc.links = doc.links.filter(link => visible.has(link.from) && visible.has(link.to));
  if (doc.layoutPlacements) {
    const saved = doc.layoutPlacements;
    saved.nodes = Object.fromEntries(ids.filter(id => saved.nodes[id]).map(id => [id, saved.nodes[id]]));
  }
  return root;
}

function rootViewport(bounds: Rect, root: { x: number; y: number }): Rect {
  const w = Math.min(1500, bounds.w + 64), h = Math.min(1000, bounds.h + 64);
  return {
    w, h,
    x: Math.max(bounds.x - 32, Math.min(root.x - w / 2, bounds.x + bounds.w + 32 - w)),
    y: Math.max(bounds.y - 32, Math.min(root.y - h / 2, bounds.y + bounds.h + 32 - h))
  };
}

async function showMap() {
  const bridge = webkit.messageHandlers.preview;
  const { doc } = parseDocReport(await bridge.postMessage({ kind: 'document' }));
  const root = rootArea(doc);
  const theme = { ...getTheme(doc.themeId, doc.themeSettings?.canvasAppearance === 'dark'), ...doc.themeSettings };
  const pipeline = new Pipeline(measureLabel);
  pipeline.relayout(doc, theme);
  for (const hash of pipeline.missingImages) {
    const url = await bridge.postMessage({ kind: 'asset', hash });
    if (!url) continue;
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { continue; }
    pipeline.imageInfo.set(hash, { url, aspect: image.naturalWidth / image.naturalHeight });
  }
  if (pipeline.imageInfo.size) pipeline.relayout(doc, theme);
  const scene = pipeline.fullScene({ selection: new Set(), focus: null, hover: null, editing: null });
  const viewport = rootViewport(pipeline.layout.bounds, pipeline.box(root)!);
  const bytes = await renderExport('svg', {
    scene, branches: pipeline.branchSpecs(), boxes: pipeline.layout.boxes, links: doc.links,
    linkColor: premulCss(theme.connectionColor, .65), viewport, scale: 1, transparent: false, tiles: false
  });
  const image = document.querySelector('img')!;
  image.alt = doc.nodes[root].text || doc.title;
  image.src = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  await image.decode();
  document.body.style.backgroundColor = theme.background;
  await bridge.postMessage({ kind: 'ready' });
}
void showMap().catch(() => webkit.messageHandlers.preview.postMessage({ kind: 'failed' }));
