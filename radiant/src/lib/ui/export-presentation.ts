import { zipSync } from 'fflate';
import { premulCss } from '../core/geometry';
import { cloneDoc } from '../core/model';
import { playableSteps, stepNote, stepTitle, stepView } from '../core/model/presentation';
import type { BranchSpec, Doc, NodeBox, NodeId, Presentation, Rect, Scene, Theme } from '../core/types';
import type { CanvasSvgFragment } from '../core/geometry/canvas-scene';
import { Camera } from '../render/camera';
import { measureLabel } from '../render/text';
import { outlineAt } from '../render/screen-outline';
import { decodeImageAspect } from '../host/image-preview';
import type { Host } from '../host/types';
import { renderExport } from './export-visual';
import { Pipeline, type ImageInfo, type SceneState } from './pipeline';
import { presentScope, stepFrame } from './presentation.svelte';

// Presentation handouts (implementation spec 6.3, PRS-50 and 51): a PDF with one page per playable step, optionally
// with the speaker note under the picture; a numbered PNG sequence; and a Markdown speaking script. Each page shows
// what the audience sees at that step: the step's visible set and dimming, framed as the presenting camera frames
// it. Scenes come from a throwaway pipeline over a copy of the document, as the map export builds them.

export interface PresentationExportSource {
  doc: Doc;
  theme: Theme;
  images: ReadonlyMap<string, ImageInfo>;
  failedImages: ReadonlySet<string>;
  onImageFailure?: (hash: string) => void;
  assetUrl: (hash: string) => ReturnType<Host['assetUrl']>;
}

/** 'slide': 16:9; 'a4': A4 landscape. */
export type HandoutPaper = 'slide' | 'a4';

export interface HandoutOptions {
  paper: HandoutPaper;
  /** Speaker notes under each page. Off unless asked for: the pages may reach the audience. */
  notes: boolean;
}

/** Page sizes in points, landscape. */
const PAPER: Record<HandoutPaper, [number, number]> = { slide: [960, 540], a4: [841.89, 595.28] };
/** The presenting camera's fit (ui/presentation.svelte.ts): 48 px padding, at most zoom 2, in a window this wide. */
const FIT_PAD = 48;
const FIT_MAX_ZOOM = 2;
const VIEW_W = 1600;
const PNG_W = 1920;
const MARGIN = 28;

interface StepPage {
  number: number;
  title: string;
  note?: string;
  caption?: string;
  scene: Scene;
  branches: BranchSpec[];
  boxes: Map<NodeId, NodeBox>;
  /** Canvas elements as the step draws them (CNV-60): focused ones as drawn, the rest dimmed. */
  canvas: CanvasSvgFragment[];
  /** World rectangle the audience sees, at the page's aspect ratio. */
  crop: Rect;
}

async function resolveImages(pipeline: Pipeline, source: PresentationExportSource): Promise<void> {
  const failed = new Set(pipeline.failedImages);
  await Promise.all([...pipeline.missingImages].map(async (hash) => {
    try {
      const url = await source.assetUrl(hash);
      pipeline.imageInfo.set(hash, { url, aspect: await decodeImageAspect(url) });
    } catch {
      failed.add(hash);
      source.onImageFailure?.(hash);
    }
  }));
  pipeline.failedImages = failed;
}

/** The scene of every playable step, framed for a page of the given aspect ratio (width / height). */
async function stepPages(source: PresentationExportSource, presentation: Presentation, aspect: number): Promise<StepPage[]> {
  const doc = cloneDoc(source.doc);
  const playable = playableSteps(doc, presentation);
  if (!playable.length) throw new Error('This presentation has no steps to export.');
  const pipeline = new Pipeline(measureLabel);
  pipeline.canvasGrid = false;
  pipeline.failedImages = source.failedImages;
  for (const [hash, info] of source.images) pipeline.imageInfo.set(hash, info);
  pipeline.relayout(doc, source.theme);
  for (const el of doc.canvas?.elements ?? []) {
    if (el.asset && !pipeline.imageInfo.has(el.asset) && !pipeline.failedImages.has(el.asset)) pipeline.missingImages.add(el.asset);
  }
  if (pipeline.missingImages.size) {
    await resolveImages(pipeline, source);
    pipeline.relayout(doc, source.theme);
  }
  const full = pipeline.layout.boxes;
  const viewH = VIEW_W / aspect;
  return playable.map((index, i) => {
    const view = stepView(doc, presentation, index);
    const present = presentScope(doc, view, full);
    const state: SceneState = { selection: new Set(), focus: null, hover: null, editing: null, present };
    pipeline.fullScene(state);
    const framed = view.frame.length || view.frameElements.length ? view : { ...view, frame: [...view.visible] };
    const rect = stepFrame(doc, framed, full) ?? pipeline.layout.bounds;
    const fit = Camera.fitState(rect, VIEW_W, viewH, FIT_PAD, FIT_MAX_ZOOM);
    const w = VIEW_W / fit.zoom, h = viewH / fit.zoom;
    // The overlay carries the focus outline (PRS-11), sized for the presenting camera's zoom; on the page it lies
    // over the branches, as on screen.
    const withCues = pipeline.withOverlay(state, []);
    const cues = withCues.overlay.map((r) => ({ ...outlineAt(r, fit.zoom), overBranches: true }));
    const scene: Scene = { ...withCues, rects: [...withCues.rects, ...cues], overlay: [] };
    const step = presentation.steps[index];
    return {
      number: i + 1,
      title: stepTitle(doc, step) || 'Untitled step',
      note: stepNote(doc, step)?.trim() || undefined,
      caption: step.caption,
      scene,
      branches: [...pipeline.drawnBranches],
      boxes: new Map(pipeline.canvasLayout.boxes),
      canvas: pipeline.canvas.fragments(),
      crop: { x: fit.cx - w / 2, y: fit.cy - h / 2, w, h }
    };
  });
}

function pageExport(page: StepPage, theme: Theme, scale: number, pdf: boolean) {
  return {
    scene: page.scene, branches: page.branches, boxes: page.boxes, links: [],
    linkColor: premulCss(theme.textColor, 0.6), viewport: page.crop, scale, transparent: false, tiles: false,
    printPreview: pdf, canvas: page.canvas
  };
}

/** Wrap text to lines no wider than `width` with the given measure. */
function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + ' ' + word : word;
      if (!line || measure(candidate) <= width) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

type Pdf = InstanceType<(typeof import('jspdf'))['jsPDF']>;

/** The note block under a page. Latin-1 text stays selectable; other scripts are drawn as a picture of the text. */
function drawNote(pdf: Pdf, page: StepPage, total: number, area: Rect): void {
  const heading = `${page.number} / ${total}  ·  ${page.title}`;
  const body = page.note ?? 'No speaker note.';
  const size = 11, lineHeight = size * 1.4;
  const fits = Math.max(1, Math.floor((area.h - 20) / lineHeight));
  if (!/[^\x00-\xff]/.test(heading + body)) {
    pdf.setTextColor(90, 90, 96);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(heading, area.x, area.y + 10);
    pdf.setFont('helvetica', page.note ? 'normal' : 'italic');
    pdf.setFontSize(size);
    pdf.setTextColor(30, 30, 32);
    const lines = (pdf.splitTextToSize(body, area.w) as string[]);
    const shown = lines.length > fits ? [...lines.slice(0, fits - 1), lines[fits - 1].replace(/\s*\S*$/, ' …')] : lines;
    pdf.text(shown, area.x, area.y + 20 + size, { lineHeightFactor: 1.4 });
    return;
  }
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(area.w * scale);
  canvas.height = Math.ceil(area.h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgb(90,90,96)';
  ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
  ctx.fillText(heading, 0, 10);
  ctx.fillStyle = 'rgb(30,30,32)';
  ctx.font = `${page.note ? '' : 'italic '}${size}px -apple-system, system-ui, sans-serif`;
  const lines = wrap(body, area.w, (s) => ctx.measureText(s).width).slice(0, fits);
  lines.forEach((line, i) => ctx.fillText(line, 0, 20 + size + i * lineHeight));
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', area.x, area.y, area.w, area.h);
  canvas.width = canvas.height = 0;
}

/** PDF with one page per playable step (PRS-50). */
export async function exportPresentationPdf(source: PresentationExportSource, presentation: Presentation,
    options: HandoutOptions): Promise<Uint8Array<ArrayBuffer>> {
  const [pw, ph] = PAPER[options.paper];
  // With notes, the picture keeps the page's proportions (as the slide pages frame it) above the note block.
  const room = { w: pw - 2 * MARGIN, h: (ph - 2 * MARGIN) * 0.68 };
  const fitted = Math.min(room.w / pw, room.h / ph);
  const picture: Rect = options.notes
    ? { x: (pw - pw * fitted) / 2, y: MARGIN, w: pw * fitted, h: ph * fitted }
    : { x: 0, y: 0, w: pw, h: ph };
  const pages = await stepPages(source, presentation, picture.w / picture.h);
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const pdf = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: 'landscape', compress: true, putOnlyUsedFonts: true });
  pdf.setDocumentProperties({ title: presentation.name });
  for (const [i, page] of pages.entries()) {
    if (i) pdf.addPage([pw, ph], 'landscape');
    const bytes = await renderExport('svg', pageExport(page, source.theme, picture.w / page.crop.w, true));
    const svg = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml').documentElement;
    await svg2pdf(svg, pdf, { x: picture.x, y: picture.y, width: picture.w, height: picture.h });
    if (options.notes) {
      pdf.setDrawColor(200, 200, 204);
      pdf.setLineWidth(0.5);
      pdf.rect(picture.x, picture.y, picture.w, picture.h);
      const top = picture.y + picture.h + 16;
      drawNote(pdf, page, pages.length, { x: MARGIN, y: top, w: pw - 2 * MARGIN, h: ph - MARGIN - top });
    }
  }
  return new Uint8Array(pdf.output('arraybuffer'));
}

/** A file name safe on every system. */
function safeName(text: string): string {
  return text.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80) || 'Untitled';
}

/** PNG pictures of every playable step, numbered in step order (PRS-51). */
export async function exportPresentationPngs(source: PresentationExportSource, presentation: Presentation,
    options: Pick<HandoutOptions, 'paper'>): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }[]> {
  const [pw, ph] = PAPER[options.paper];
  const pages = await stepPages(source, presentation, pw / ph);
  const digits = Math.max(2, String(pages.length).length);
  const out: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  for (const page of pages) {
    const bytes = await renderExport('png', pageExport(page, source.theme, PNG_W / page.crop.w, false));
    out.push({ name: `${String(page.number).padStart(digits, '0')} ${safeName(page.title)}.png`, bytes });
  }
  return out;
}

/** The PNG sequence as one zip archive, the files numbered in step order. */
export async function exportPresentationPngZip(source: PresentationExportSource, presentation: Presentation,
    options: Pick<HandoutOptions, 'paper'>): Promise<Uint8Array<ArrayBuffer>> {
  const files = await exportPresentationPngs(source, presentation, options);
  const zip = zipSync(Object.fromEntries(files.map(({ name, bytes }) => [name, bytes])), { level: 0 });
  return new Uint8Array(zip);
}

function duration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Speaking script (PRS-51): Markdown with one heading per playable step and its note beneath. */
export function speakingScript(doc: Doc, presentation: Presentation): string {
  const playable = playableSteps(doc, presentation);
  const facts = [`${playable.length} ${playable.length === 1 ? 'step' : 'steps'}`];
  if (presentation.targetMinutes) facts.push(`${presentation.targetMinutes} minutes`);
  const out = [`# ${presentation.name.trim() || 'Presentation'}`, '', `${doc.title.trim() || 'Untitled map'} · ${facts.join(' · ')}`, ''];
  playable.forEach((index, i) => {
    const step = presentation.steps[index];
    const title = (stepTitle(doc, step) || 'Untitled step').replace(/\s+/g, ' ').trim();
    out.push(`## ${i + 1}. ${title}`, '');
    if (step.caption?.trim()) out.push(`> ${step.caption.trim()}`, '');
    const note = stepNote(doc, step)?.trim();
    out.push(note || '_No speaker note._', '');
    if (step.seconds) out.push(`_Time: ${duration(step.seconds)}_`, '');
  });
  return out.join('\n').replace(/\n+$/, '\n');
}

export function presentationFilename(docTitle: string, presentation: Presentation, suffix: string): string {
  return `${safeName(`${docTitle.trim() || 'Untitled'} - ${presentation.name.trim() || 'Presentation'}`)}${suffix}`;
}
