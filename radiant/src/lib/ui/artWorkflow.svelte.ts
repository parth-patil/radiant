import { artStyleAt } from '../core/art/subtree-style';
import { planArtNesting } from '../core/art/nesting';
export { artStyleAt } from '../core/art/subtree-style';
import { checkedSvgRegion, existingSvgColours, joinSvgGroups, legacySvgSpec, moveSvgSpec, regionSpecs, spliceSvgGroup,
  type SvgRegionAsset } from '../core/art/svg-region';
import { parseSvg } from '../core/art/svg';
import { artworkProvenance } from '../core/asset-meta';
import {
  artPreset, artSubtree, setArtRepresentation, buildNodeImageBrief, buildStyleReferencePrompt, buildSvgRepairPrompt,
  buildSvgSubtreePrompt, completeCustomPictureBrief, DEFAULT_PICTURE_CONCURRENCY, describeStyle, extractSvg, fitSvgGroups, IMAGE_INSTRUCTIONS, PICTURE_TEMPLATE_VERSION, planPictureBatch, planSvgRegions, resolvePalette,
  SVG_REGION_SIZE, svgNodeAssets, svgRegionCount, validateSvg, type ArtStyleSheet, type PictureJob, type SvgReport, type SvgSubtreeRequest
} from '../core/art';
import type { AiTurnRequest } from '../core/ai/provider';
import imageTurnPrefix from '../core/ai/image-turn-prefix.txt?raw';
import type { PromptPair } from '../core/ai/prompts';
import { createStyleResolver } from '../core/geometry';
import type { Doc, NodeArt, NodeId, Op, Theme, Vec2 } from '../core/types';
import type { AppController } from './controller.svelte';
import { ART_STYLE_VERSION, artInputHash, attachFinishedPicture, finishPicture } from './artAssets';
import { ArtTurnError, runArtTurn } from './artJobs';
import { blockedAiAllowance, friendlyAiError } from './util';
import { confirmArtIslands } from './art-nesting';

interface SvgJob {
  request: SvgSubtreeRequest;
  original: PromptPair;
  next: PromptPair;
  round: number;
}

export interface ArtPreview {
  id: string;
  title: string;
  url: string;
}

export interface ArtRequestPreview {
  id: string;
  scope: string;
  instructions: string;
  prompt: string;
  refs: { hash: string; url: string }[];
}

interface ArtworkOptions {
  rework?: boolean;
  single?: boolean;
  depth?: number;
  concurrency?: number;
  prompt?: string;
  svgRepairs?: number;
  pictureEstimateAbove?: number;
  approvedReference?: NodeArt;
}

interface ArtConfirmation {
  title: string;
  root: NodeId;
  turnCount: number;
  imageCount?: number;
  estimatedSeconds?: number;
  includesReference?: boolean;
  previewsSample: boolean;
}

interface ArtworkRun {
  id: string;
  doc: Doc;
  root: NodeId;
  style: ArtStyleSheet;
  branchColour: string;
  kind: 'picture' | 'svg';
  abort: AbortController;
  targets: ReturnType<typeof artSubtree>;
  depth: number;
  concurrency: number;
  single: boolean;
  customPrompt?: string;
  replacement?: Op[];
  svgJobs?: SvgJob[];
  svgSplice?: { source: string; nodes: SvgRegionAsset['nodes']; palette: string[]; peers: Map<NodeId, string> };
  svgRegionTotal?: number;
  svgSuccess?: number;
  svgRepairs: number;
  pictureEstimateAbove?: number;
  originalMode: Doc['nodes'][string]['representation'];
  representation: Op[];
  plannedRevision: number;
  approvedIslands: number;
  expected: string;
  reference?: NodeArt;
  approvedReference?: NodeArt;
  referenceApproved: boolean;
  sample: Map<NodeId, NodeArt>;
  pictureInputs: Map<string, Promise<{ art: NodeArt; owner?: NodeId }>>;
  queue: PictureJob[];
  accepted: boolean;
  rework: boolean;
  errors: string[];
  pictureSampleErrors: Map<NodeId, string>;
  group?: { end(): void };
}

function nodePath(doc: Doc, id: NodeId): string[] {
  const path: string[] = [];
  let node = doc.nodes[id];
  while (node) {
    path.push(node.text);
    if (node.parent === null) break;
    node = doc.nodes[node.parent];
  }
  return path.reverse();
}

function snapshot(doc: Doc, root: NodeId, depth: number, includeStyle = true): string {
  return JSON.stringify([
    nodePath(doc, root),
    includeStyle ? artStyleAt(doc, root) : undefined,
    artSubtree(doc, root, depth).map(({ id }) => {
      const n = doc.nodes[id];
      return [id, n.parent, n.text, n.note, n.representation,
        ...(includeStyle ? [n.style?.color, n.artStyleOverrides, n.artStyleId, n.generatedStyle] : [])];
    })
  ]);
}

function artRootAt(doc: Doc, id: NodeId): NodeId {
  let n = doc.nodes[id];
  while (n && n.parent !== null && !n.representation) n = doc.nodes[n.parent];
  return n?.id ?? id;
}

function branchColourAt(doc: Doc, theme: Theme, id: NodeId): string {
  return createStyleResolver(doc, theme).get(id, nodePath(doc, id).length - 1).color;
}

export function artPaletteAt(doc: Doc, theme: Theme, id: NodeId): string[] {
  const style = artStyleAt(doc, id);
  const artRoot = artRootAt(doc, id);
  const root = doc.nodes[artRoot]?.representation === 'picture' || doc.nodes[artRoot]?.representation === 'svg' ? artRoot : id;
  return resolvePalette(style, branchColourAt(doc, theme, root));
}

function sourceHash(node: Doc['nodes'][string], style: ArtStyleSheet, branchColour: string): Promise<string> {
  const description = describeStyle(style, branchColour);
  const presetDescription = describeStyle(artPreset(style.id), branchColour);
  const edits = description === presetDescription ? [] : [description];
  return artInputHash(node.text, node.note ?? '', style.id, resolvePalette(style, branchColour), ...edits);
}

export async function artIsStale(doc: Doc, theme: Theme, id: NodeId, art: NodeArt): Promise<boolean> {
  const style = artStyleAt(doc, id);
  if (art.styleId !== style.id || art.styleVersion !== ART_STYLE_VERSION ||
      (art.svgSeed !== undefined && art.svgSeed !== style.seed)) return true;
  const root = artRootAt(doc, id);
  return !!art.sourceHash && art.sourceHash !== await sourceHash(doc.nodes[id], style, branchColourAt(doc, theme, root));
}

type PictureJobState = 'Queued' | 'Generating' | 'Sample ready' | 'Complete' | 'Failed' | 'Cancelled';
interface PictureProgress {
  id: NodeId;
  title: string;
  state: PictureJobState;
}

export class ArtWorkflow {
  inspectRequests = $state(false);
  pendingRequests = $state.raw<ArtRequestPreview[]>([]);
  sentRequests = $state.raw<ArtRequestPreview[]>([]);
  private approvals = new Map<string, () => void>();

  confirmation = $state.raw<ArtConfirmation | null>(null);
  refreshingUsage = $state(false);
  phase = $state<'idle' | 'confirm' | 'running' | 'reference' | 'sample' | 'paused'>('idle');
  message = $state('');
  previews = $state.raw<ArtPreview[]>([]);
  done = $state(0);
  total = $state(0);
  pictureProgress = $state<PictureProgress[]>([]);
  private pictureProgressIndex = new Map<NodeId, number>();
  private run: ArtworkRun | null = null;
  private requestDoc: Doc | null = null;

  constructor(private readonly c: AppController) {}

  private setPictureState(id: NodeId, state: PictureJobState): void {
    const index = this.pictureProgressIndex.get(id);
    if (index !== undefined) this.pictureProgress[index].state = state;
  }

  approveRequest(id: string): void {
    this.approvals.get(id)?.();
  }

  private sentPrompt(request: Pick<AiTurnRequest, 'kind' | 'prompt'>): string {
    return request.kind === 'image' && !this.c.isBrowser ? `${imageTurnPrefix.trimEnd()}\n\n${request.prompt}` : request.prompt;
  }

  private async sendTurn(run: ArtworkRun, request: AiTurnRequest, signal = run.abort.signal) {
    const refs = await Promise.all((request.refImages ?? []).map(async (hash) => ({
      hash, url: await this.c.host.assetUrl(hash)
    })));
    signal.throwIfAborted();
    if (!this.current(run)) throw new DOMException('Artwork cancelled.', 'AbortError');
    const preview: ArtRequestPreview = {
      id: crypto.randomUUID(), refs,
      scope: run.depth === 0 ? 'This node only' : run.depth === Infinity ? 'Whole subtree' : `${run.depth + 1} levels`,
      instructions: request.instructions,
      prompt: this.sentPrompt(request)
    };
    if (this.inspectRequests) {
      await new Promise<void>((resolve, reject) => {
        const clear = () => {
          this.pendingRequests = this.pendingRequests.filter((item) => item.id !== preview.id);
          this.approvals.delete(preview.id);
          signal.removeEventListener('abort', abort);
        };
        const abort = () => {
          clear();
          reject(new DOMException('Artwork cancelled.', 'AbortError'));
        };
        this.approvals.set(preview.id, () => { clear(); resolve(); });
        signal.addEventListener('abort', abort, { once: true });
        this.pendingRequests = [...this.pendingRequests, preview];
      });
    }
    return runArtTurn(this.c.host, request, signal, {
      beforeStart: () => {
        if (!this.current(run) || snapshot(run.doc, run.root, run.depth) !== run.expected) {
          throw new DOMException('The artwork target changed.', 'AbortError');
        }
        const blocked = this.blockedAllowance();
        if (blocked) throw new ArtTurnError(blocked, 'The AI allowance was reached.');
      },
      onSubmitted: (id) => {
        this.c.trackAiJob(id, request.kind === 'image' ? 'image' : 'svg');
        if (this.run === run) this.sentRequests = [...this.sentRequests, preview];
      },
      onWarning: (message) => {
        if (this.run === run && !signal.aborted) this.message = message;
      }
    });
  }

  checkDocument(doc: Doc, focusId: NodeId | null): void {
    if (this.requestDoc !== doc) {
      this.requestDoc = doc;
      this.sentRequests = [];
      this.pictureProgress = [];
      this.pictureProgressIndex.clear();
    }
    const run = this.run;
    if (!run) return;
    if (run.doc !== doc || !doc.nodes[run.root]) {
      this.cancel();
    } else if (this.phase === 'confirm' && focusId !== run.root) {
      run.abort.abort();
      this.complete(run, 'Selection changed. Start a new artwork confirmation.');
    }
  }

  private current(run: ArtworkRun): boolean {
    if (run.abort.signal.aborted || this.run !== run || this.c.doc !== run.doc || !run.doc.nodes[run.root]) return false;
    if (!run.accepted && run.plannedRevision !== this.c.rev) {
      const refreshed = planArtNesting(run.doc, setArtRepresentation(run.doc, run.root, run.kind, run.depth), [run.root]);
      if ('error' in refreshed || JSON.stringify(refreshed.changes) !== JSON.stringify(run.representation)) return false;
      run.plannedRevision = this.c.rev;
    }
    return run.doc.nodes[run.root]?.representation === (run.accepted ? run.kind : run.originalMode);
  }

  private beginArtworkGroup(run: ArtworkRun): void {
    if (run.group) return;
    const picture = run.kind === 'picture';
    this.c.snapshotBeforeAi(picture ? 'Before AI picture generation' : 'Before AI SVG generation');
    run.group = this.c.editor.beginGroup(picture ? 'Generate Picture Subtree' : 'Generate SVG Subtree', { ai: run.id });
  }

  private acceptRepresentation(run: ArtworkRun): void {
    run.accepted = true;
    run.expected = snapshot(run.doc, run.root, run.depth);
  }

  private complete(run: ArtworkRun, message: string): void {
    if (run !== this.run) return;
    run.group?.end();
    this.c.pipeline.artPending.clear();
    this.c.refreshLayout();
    for (const row of this.pictureProgress) {
      if (row.state !== 'Complete' && row.state !== 'Failed') row.state = 'Cancelled';
    }
    this.run = null;
    this.confirmation = null;
    this.refreshingUsage = false;
    this.phase = 'idle';
    this.previews = [];
    this.message = message;
  }

  cancel(): void {
    const run = this.run;
    if (!run) return;
    run.abort.abort();
    this.complete(run, this.phase === 'confirm' ? 'Generation declined.' :
      run.accepted ? 'Generation stopped. Finished artwork was kept.' : 'Generation cancelled.');
  }

  async start(root: NodeId, kind: ArtworkRun['kind'], options: ArtworkOptions = {}): Promise<void> {
    const { c } = this;
    const doc = c.doc;
    const node = doc.nodes[root];
    c.flush();
    if (this.run || c.dialog || c.focusId !== root || !node || !c.pipeline) return;
    if (kind === 'picture' && c.aiStatus?.capabilities?.images !== true) return;
    const single = options.single ?? false;
    const depth = single ? 0 : options.depth ?? Infinity;
    const plan = planArtNesting(doc, setArtRepresentation(doc, root, kind, depth), [root]);
    if ('error' in plan) { c.say(plan.error, 'error'); return; }
    if (plan.islands) {
      const revision = c.rev;
      if (await confirmArtIslands(c, plan.islands) !== 'island') return;
      if (c.doc !== doc || c.focusId !== root || c.rev !== revision || this.run) return;
    }
    const targets = artSubtree(doc, root, depth);
    const styleRoot = single ? artRootAt(doc, root) : root;
    const run: ArtworkRun = {
      id: crypto.randomUUID(), doc, root, kind, targets, depth, single, style: artStyleAt(doc, root),
      concurrency: options.concurrency === 2 ? 2 : DEFAULT_PICTURE_CONCURRENCY,
      svgRepairs: Math.min(2, Math.max(0, Math.floor(options.svgRepairs ?? 2))),
      pictureEstimateAbove: options.pictureEstimateAbove,
      branchColour: branchColourAt(doc, c.theme, styleRoot), customPrompt: single && options.prompt?.trim() ? options.prompt : undefined,
      originalMode: node.representation, representation: plan.changes, plannedRevision: c.rev, approvedIslands: plan.islands,
      expected: snapshot(doc, root, depth, false), abort: new AbortController(),
      accepted: false, referenceApproved: false, approvedReference: options.approvedReference, rework: options.rework ?? false, sample: new Map(), pictureInputs: new Map(), queue: [], errors: [], pictureSampleErrors: new Map()
    };
    this.run = run;
    this.requestDoc = doc;
    this.sentRequests = [];
    this.done = 0;
    this.total = targets.length;
    this.pictureProgress = kind === 'picture' ? targets.map(({ id }) => ({ id, title: doc.nodes[id].text, state: 'Queued' })) : [];
    this.pictureProgressIndex = new Map(this.pictureProgress.map((row, index) => [row.id, index]));
    if (kind === 'picture') {
      const plan = planPictureBatch(targets, {
        maxConcurrent: run.concurrency, estimateAbove: run.pictureEstimateAbove, withReference: !single
      });
      run.queue = plan.jobs;
      this.total = plan.imageCount;
      this.confirmation = {
        title: single ? 'Generate node picture' : 'Generate picture subtree',
        root,
        turnCount: plan.imageCount,
        imageCount: plan.imageCount,
        estimatedSeconds: plan.showEstimate ? plan.estimatedSeconds : undefined,
        includesReference: !single,
        previewsSample: !single
      };
    } else {
      const regions = svgRegionCount(targets.length);
      const maxTurns = regions * (1 + run.svgRepairs);
      this.confirmation = {
        title: single ? 'Generate node SVG artwork' : 'Generate SVG subtree',
        root, turnCount: maxTurns, previewsSample: regions > 1
      };
    }
    this.message = '';
    this.phase = 'confirm';
    if (c.aiStatus?.capabilities?.rateLimits) {
      this.refreshingUsage = true;
      await c.refreshAiStatus(true);
      if (this.run === run) this.refreshingUsage = false;
    }
  }

  async confirm(): Promise<void> {
    const run = this.run;
    if (!run || this.phase !== 'confirm' || this.refreshingUsage) return;
    const { c } = this;
    if (c.editor.defer(() => { if (this.run === run) void this.confirm(); })) return;
    if (c.doc !== run.doc || c.focusId !== run.root || snapshot(run.doc, run.root, run.depth, false) !== run.expected) {
      return this.complete(run, 'The artwork target changed. Review a fresh confirmation.');
    }
    const plan = planArtNesting(run.doc, setArtRepresentation(run.doc, run.root, run.kind, run.depth), [run.root]);
    if ('error' in plan) return this.complete(run, plan.error);
    if (plan.islands !== run.approvedIslands) {
      return this.complete(run, 'The artwork boundaries changed. Review a fresh confirmation.');
    }
    run.representation = plan.changes;
    run.plannedRevision = c.rev;
    run.style = artStyleAt(run.doc, run.root);
    run.branchColour = branchColourAt(run.doc, c.theme, run.single ? artRootAt(run.doc, run.root) : run.root);
    run.expected = snapshot(run.doc, run.root, run.depth);
    this.confirmation = null;
    await this.begin(run);
  }

  private async begin(run: ArtworkRun): Promise<void> {
    this.phase = 'running';
    this.message = 'Preparing artwork…';
    try {
      if (run.kind === 'svg') {
        await this.runSvg(run);
      } else if (run.single) {
        const refPrompt = buildStyleReferencePrompt(run.style, { branchColour: run.branchColour });
        run.reference = await this.findStyleReference(run.doc, artRootAt(run.doc, run.root), await artInputHash(refPrompt));
        await this.retrySinglePicture(run);
      } else {
        await this.runPictures(run);
      }
    } catch (error) {
      this.fail(run, error);
    }
  }

  private async picture(run: ArtworkRun, signal: AbortSignal, prompt: string, inputHash: string, node?: {
    inward: Vec2; outward: Vec2; children: Array<[NodeId, Vec2]>;
    style: ArtStyleSheet; reference?: NodeArt;
  }): Promise<NodeArt> {
    const style = node?.style ?? run.style;
    const templateVersion = PICTURE_TEMPLATE_VERSION + (node ? ':node' : ':reference');
    const instructions = node && run.customPrompt
      ? `${IMAGE_INSTRUCTIONS}\n${describeStyle(style, run.branchColour)}`
      : IMAGE_INSTRUCTIONS;
    const result = await this.sendTurn(run, {
      templateVersion, kind: 'image', instructions, prompt, effort: 'low',
      refImages: node?.reference ? [node.reference.assetHash] : undefined
    }, signal);
    if (!result.image) throw new Error('The model returned no picture.');
    const art: NodeArt = {
      assetHash: result.image.assetHash, inputHash, prompt: this.sentPrompt({ kind: 'image', prompt }),
      brief: prompt, instructions, effort: 'low', templateVersion, model: result.model, revisedPrompt: result.image.revisedPrompt,
      styleId: style.id, styleVersion: ART_STYLE_VERSION, styleSnapshot: style,
      seed: Number.isSafeInteger(result.image.seed) ? result.image.seed : undefined,
      parentAsset: node?.reference?.assetHash, generatedAt: new Date().toISOString()
    };
    signal.throwIfAborted();
    await this.c.host.assetRecord?.(art.assetHash, artworkProvenance(art));
    return node ? finishPicture(this.c.host, art, node.inward, node.outward, node.children, style.background === 'plain', signal) : art;
  }

  private async pictureJob(run: ArtworkRun, job: PictureJob, signal = run.abort.signal): Promise<void> {
    if (!this.current(run)) throw new DOMException('The artwork target changed.', 'AbortError');
    const doc = run.doc;
    if (job.kind === 'reference') {
      const prompt = buildStyleReferencePrompt(run.style, { branchColour: run.branchColour });
      const inputHash = await artInputHash(prompt);
      const approved = run.approvedReference;
      if (approved?.inputHash === inputHash && await this.hasAsset(approved)) {
        run.reference = approved;
        run.referenceApproved = true;
        this.done++;
        return;
      }
      const existing = !run.rework ? await this.findStyleReference(doc, run.root, inputHash) : undefined;
      if (existing) {
        run.reference = existing;
      } else {
        run.reference = await this.picture(run, signal, prompt, inputHash);
      }
      this.done++;
      return;
    }
    const id = job.nodeId!;
    const n = doc.nodes[id];
    if (!n) throw new Error('A node was deleted.');
    const style = artStyleAt(doc, id);
    const reference = run.single || run.referenceApproved ? run.reference : undefined;
    const brief = this.pictureBrief(run, id, style, !!reference);
    const prompt = run.customPrompt ? completeCustomPictureBrief(run.customPrompt) : brief;
    const box = this.c.pipeline.box(id);
    const pbox = n.parent === null ? undefined : this.c.pipeline.box(n.parent);
    const inward = box && pbox ? { x: pbox.x - box.x, y: pbox.y - box.y } : { x: -1, y: 0 };
    const outward = { x: -inward.x, y: -inward.y };
    const children: Array<[NodeId, Vec2]> = [];
    if (box) {
      for (const child of n.children) {
        const childBox = this.c.pipeline.box(child);
        if (childBox) children.push([child, { x: childBox.x - box.x, y: childBox.y - box.y }]);
      }
    }
    const inputHash = await artInputHash(prompt, reference?.assetHash, ...(run.customPrompt ? [describeStyle(style, run.branchColour)] : []));
    const currentSource = await sourceHash(n, style, run.branchColour);
    const generate = () => this.picture(run, signal, prompt, inputHash, { inward, outward, children, style, reference });
    let asset: NodeArt;
    if (run.rework) {
      asset = await generate();
    } else if (n.pictureArt?.inputHash === inputHash && await this.hasAsset(n.pictureArt)) {
      asset = n.pictureArt;
    } else {
      let shared = run.pictureInputs.get(inputHash);
      if (!shared) {
        shared = (async () => {
          for (const art of [...run.sample.values(), ...Object.values(doc.nodes).map(node => node.pictureArt)]) {
            if (art?.inputHash === inputHash && await this.hasAsset(art)) return { art };
          }
          return { art: await generate(), owner: id };
        })();
        run.pictureInputs.set(inputHash, shared);
      }
      let resolved: Awaited<typeof shared>;
      try {
        resolved = await shared;
      } catch (error) {
        if (run.pictureInputs.get(inputHash) === shared) run.pictureInputs.delete(inputHash);
        throw error;
      }
      asset = resolved.owner === id ? resolved.art :
        await attachFinishedPicture(this.c.host, resolved.art, inward, outward, children, signal);
    }
    signal.throwIfAborted();
    const art = { ...asset, styleId: style.id, styleSnapshot: style, sourceHash: currentSource };
    // Resolve both asset lookups before publishing so a late thumbnail cannot restart the resize animation.
    const hashes = new Set([art.assetHash, art.thumbnailHash]);
    await Promise.all([...hashes].map(async (hash) => {
      if (!hash || this.c.pipeline.imageInfo.has(hash)) return;
      const info = await this.c.host.assetImageInfo?.(hash).catch(() => undefined);
      if (info?.aspect) this.c.pipeline.imageInfo.set(hash, { ...info, aspect: info.aspect });
    }));
    signal.throwIfAborted();
    if (!this.current(run)) throw new DOMException('The artwork target changed.', 'AbortError');
    if (doc.nodes[id]?.parent !== n.parent || !artSubtree(doc, run.root, run.depth).some((target) => target.id === id) || this.pictureBrief(run, id, artStyleAt(doc, id), !!reference) !== brief) {
      throw new Error(`“${n.text}” changed during generation.`);
    }
    if (!run.accepted) run.sample.set(id, art);
    else this.apply(run, [{ t: 'set', id, patch: { pictureArt: art, pictureArtError: undefined } }], 'Generate Node Picture');
    this.setPictureState(id, run.accepted ? 'Complete' : 'Sample ready');
    this.done++;
  }

  private pictureBrief(run: ArtworkRun, id: NodeId, style: ArtStyleSheet, hasReference: boolean): string {
    const n = run.doc.nodes[id];
    const siblings = n.parent === null ? run.doc.roots : run.doc.nodes[n.parent]?.children ?? [];
    return buildNodeImageBrief({
      path: nodePath(run.doc, id), nodeText: n.text, note: n.note, style,
      siblings: siblings.filter((s) => s !== id).map((s) => run.doc.nodes[s].text).sort(),
      branchColour: run.branchColour, hasReference
    });
  }

  private async findStyleReference(doc: Doc, from: NodeId, inputHash: string): Promise<NodeArt | undefined> {
    for (let id: NodeId | null = from; id !== null && doc.nodes[id]; id = doc.nodes[id].parent) {
      const node = doc.nodes[id];
      const reference = node.artReference;
      if (reference?.inputHash === inputHash && await this.hasAsset(reference)) return reference;
      if (node.artStyleId) break;
    }
  }

  private async hasAsset(art: NodeArt): Promise<boolean> {
    return this.c.host.assetUrl(art.assetHash).then(() => true, () => false);
  }

  private async runPictures(run: ArtworkRun): Promise<void> {
    this.phase = 'running';
    let paused: ArtTurnError['code'] | undefined;
    const batch = new AbortController();
    const stop = () => batch.abort();
    const pauseWorkers = (reason: ArtTurnError['code']) => {
      paused ??= reason;
      stop();
    };
    run.abort.signal.addEventListener('abort', stop, { once: true });
    const work = async () => {
      while (this.current(run) && !batch.signal.aborted) {
        const blocked = this.blockedAllowance();
        if (blocked) {
          pauseWorkers(blocked);
          return;
        }
        const next = run.queue[0];
        if (!next || (!run.accepted && next.phase === 'batch') ||
            (next.kind === 'node' && !run.referenceApproved)) return;
        run.queue.shift();
        if (next.nodeId) this.setPictureState(next.nodeId, 'Generating');
        if (run.accepted && next.nodeId) {
          this.c.pipeline.artPending.set(next.nodeId, 'Generating');
          this.c.refreshLayout();
        }
        this.message = next.kind === 'reference' ? 'Generating a style reference…' :
          `Generating pictures · ${this.done} of ${this.total} finished`;
        try {
          await this.pictureJob(run, next, batch.signal);
          if (next.nodeId) this.c.pipeline.artPending.delete(next.nodeId);
        } catch (error) {
          if (!this.current(run)) return;
          const denied = paused ?? (this.isRateError(error) ? error.code : undefined);
          if (denied) {
            run.queue.unshift(next);
            if (next.nodeId) this.setPictureState(next.nodeId, 'Queued');
            if (run.accepted && next.nodeId) {
              this.c.pipeline.artPending.set(next.nodeId, 'Queued');
              this.c.refreshLayout();
            }
            pauseWorkers(denied);
            return;
          }
          if (next.kind === 'reference' || (error instanceof ArtTurnError &&
            (error.code === 'not_logged_in' || error.code === 'not_installed'))) throw error;
          const id = next.nodeId!;
          this.setPictureState(id, 'Failed');
          const node = run.doc.nodes[id];
          const message = this.errorMessage(error);
          run.errors.push(`${node?.text ?? 'Deleted node'}: ${message}`);
          this.done++;
          this.c.pipeline.artPending.delete(id);
          if (node && run.accepted) {
            this.apply(run, [{ t: 'set', id, patch: { pictureArtError: message.slice(0, 280) } }], 'Mark Failed Picture');
          } else if (node) {
            run.pictureSampleErrors.set(id, message.slice(0, 280));
          }
        }
      }
    };
    try {
      if (run.accepted) await Promise.all(Array.from({ length: run.concurrency }, () => work()));
      else await work();
    } catch (error) {
      stop();
      throw error;
    } finally {
      run.abort.signal.removeEventListener('abort', stop);
    }
    if (!this.current(run)) return this.complete(run, 'The artwork target changed.');
    if (paused) {
      run.queue.sort((a, b) => a.order - b.order);
      this.pause(paused);
      return;
    }
    if (run.accepted) {
      const failures = run.errors.length;
      this.complete(run, failures
        ? `${failures} ${failures === 1 ? 'picture' : 'pictures'} could not be generated. Select a marked node for details.`
        : 'Subtree pictures are ready.');
      return;
    }
    if (run.reference && !run.referenceApproved) {
      const url = await this.c.host.assetUrl(run.reference.assetHash);
      if (!this.current(run)) return this.complete(run, 'The artwork target changed.');
      this.previews = [{ id: 'reference', title: 'Style reference', url }];
      this.phase = 'reference';
      this.message = 'Review the style reference before generating sample nodes.';
      return;
    }
    if (run.sample.size === 0) {
      const failures = this.pictureSampleIssues(run);
      if (failures.length) this.apply(run, failures, 'Mark Failed Picture Sample');
      throw new Error(run.errors.join(' ') || 'No sample pictures were generated.');
    }
    await this.showPreviews(run);
  }

  private async showPreviews(run: ArtworkRun): Promise<void> {
    const previews: ArtPreview[] = [];
    for (const [id, art] of run.sample) {
      previews.push({ id, title: this.c.doc.nodes[id]?.text ?? 'Sample', url: await this.c.host.assetUrl(art.assetHash) });
    }
    if (!this.current(run)) return this.complete(run, 'The artwork target changed.');
    this.previews = previews;
    this.phase = 'sample';
    this.message = run.single ? 'Review the proposed artwork before replacing the node’s current artwork.' :
      'Review the sample artwork before generating the rest.';
  }

  acceptReference(): void {
    const run = this.run;
    if (!run || this.phase !== 'reference' || !run.reference || !this.current(run)) return;
    if (run.expected !== snapshot(run.doc, run.root, run.depth)) return this.complete(run, 'The subtree changed. Generate a fresh reference.');
    run.referenceApproved = true;
    this.previews = [];
    void this.runPictures(run).catch((error: unknown) => this.fail(run, error));
  }

  accept(): void {
    const run = this.run;
    if (!run || this.phase !== 'sample' || !this.current(run)) return;
    if (run.expected !== snapshot(run.doc, run.root, run.depth)) return this.complete(run, 'The subtree changed. Generate a fresh sample.');
    if (run.kind === 'svg' && run.replacement) {
      if (run.single) {
        const updates = [...run.replacement];
        const region = run.sample.get(run.root)?.svgRegion;
        if (region && run.svgSplice) {
          for (const [id, hash] of run.svgSplice.peers) {
            const peer = run.doc.nodes[id]?.svgArt;
            if (!peer) continue;
            if (peer.assetHash !== hash) return this.complete(run, 'A peer SVG group changed. Generate a fresh sample.');
            updates.push({ t: 'set', id, patch: { svgArt: { ...peer, svgRegion: region } } });
          }
        }
        this.apply(run, updates, 'Regenerate SVG Node');
        this.complete(run, 'Node artwork is ready.');
        return;
      }
      this.beginArtworkGroup(run);
      this.apply(run, [...run.replacement, ...run.representation], 'Use SVG Sample');
      this.acceptRepresentation(run);
      for (const job of run.svgJobs ?? []) for (const node of job.request.nodes) this.c.pipeline.artPending.set(node.id, 'Queued');
      this.c.refreshLayout();
      this.phase = 'running';
      this.previews = [];
      void this.runSvg(run).catch((error: unknown) => this.fail(run, error));
      return;
    }
    if (run.single) {
      const art = run.sample.get(run.root);
      if (art) {
        this.apply(run, [{ t: 'set', id: run.root, patch: { pictureArt: art, pictureArtError: undefined } }], 'Regenerate Node Picture');
        this.setPictureState(run.root, 'Complete');
      }
      this.complete(run, 'Node artwork is ready.');
      return;
    }
    const updates: Op[] = [...run.sample].map(([id, art]) => ({ t: 'set', id, patch: { pictureArt: art, pictureArtError: undefined } }));
    updates.push(...run.representation, ...this.pictureSampleIssues(run));
    updates.push({ t: 'set', id: run.root, patch: { artReference: run.reference } });
    this.beginArtworkGroup(run);
    this.apply(run, updates, 'Use Picture Subtree');
    for (const id of run.sample.keys()) this.setPictureState(id, 'Complete');
    this.acceptRepresentation(run);
    for (const job of run.queue) if (job.nodeId) this.c.pipeline.artPending.set(job.nodeId, 'Queued');
    this.c.refreshLayout();
    this.previews = [];
    void this.runPictures(run).catch((error: unknown) => this.fail(run, error));
  }

  reroll(): void {
    const run = this.run;
    if (!run || (this.phase !== 'sample' && this.phase !== 'reference')) return;
    const approvedReference = run.referenceApproved ? run.reference : undefined;
    this.cancel();
    void this.start(run.root, run.kind, {
      rework: true, single: run.single, depth: run.depth, concurrency: run.concurrency,
      prompt: run.customPrompt, svgRepairs: run.svgRepairs, pictureEstimateAbove: run.pictureEstimateAbove, approvedReference
    });
  }

  async resume(): Promise<void> {
    const run = this.run;
    if (!run || this.phase !== 'paused') return;
    this.phase = 'running';
    await this.c.refreshAiStatus(true);
    if (!this.current(run)) return;
    if (run.accepted && !this.blockedAllowance()) {
      const pending = run.kind === 'svg'
        ? (run.svgJobs ?? []).flatMap(job => job.request.nodes.map(node => node.id))
        : run.queue.flatMap(job => job.nodeId ? [job.nodeId] : []);
      for (const id of pending) this.c.pipeline.artPending.set(id, 'Queued');
      if (pending.length) this.c.refreshLayout();
    }
    const retry = run.kind === 'svg' ? this.runSvg(run) : run.single ? this.retrySinglePicture(run) : this.runPictures(run);
    await retry.catch((error: unknown) => this.fail(run, error));
  }

  private pictureSampleIssues(run: ArtworkRun): Op[] {
    return [...run.pictureSampleErrors].flatMap(([id, message]) => run.doc.nodes[id]
      ? [{ t: 'set', id, patch: { pictureArtError: message } }]
      : []);
  }

  private async retrySinglePicture(run: ArtworkRun): Promise<void> {
    const job: PictureJob = { kind: 'node', nodeId: run.root, order: 0, phase: 'sample' };
    this.setPictureState(run.root, 'Generating');
    try {
      await this.pictureJob(run, job);
    } catch (error) {
      if (this.current(run) && !this.isRateError(error) &&
          !(error instanceof ArtTurnError && (error.code === 'not_logged_in' || error.code === 'not_installed'))) {
        this.setPictureState(run.root, 'Failed');
        this.apply(run, [{ t: 'set', id: run.root, patch: { pictureArtError: this.errorMessage(error).slice(0, 280) } }], 'Mark Failed Picture');
      }
      throw error;
    }
    await this.showPreviews(run);
  }

  private svgRegions(run: ArtworkRun): SvgJob[] {
    const ids = run.targets.map((node) => node.id);
    const boxes = this.c.pipeline.planSvgBoxes(ids, run.root);
    if (boxes.size !== ids.length) throw new Error('The subtree could not be laid out.');
    const stored = run.svgSplice;
    const regionTarget = stored?.nodes.find(node => node.id === run.root)?.box;
    const plannedTarget = boxes.get(run.root);
    const sourceGroups = stored ? parseSvg(stored.source).root?.children : undefined;
    const context = (id: NodeId) => {
      const original = stored?.nodes.find(node => node.id === id)?.box;
      if (original && regionTarget && plannedTarget) {
        const dx = plannedTarget.x - regionTarget.x, dy = plannedTarget.y - regionTarget.y;
        const centre = { x: original.x + original.w / 2, y: original.y + original.h / 2 };
        const target = { x: regionTarget.x + regionTarget.w / 2, y: regionTarget.y + regionTarget.h / 2 };
        const group = sourceGroups?.find(el => typeof el !== 'string' && el.attrs.id === 'node-' + id);
        const anchor = (key: string) => {
          if (!group || typeof group === 'string') return;
          const [x, y] = (group.attrs[key] ?? '').trim().split(/[\s,]+/).map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y) ||
              (x - centre.x) * (target.x - centre.x) + (y - centre.y) * (target.y - centre.y) <= 0) return;
          return { x: x + dx, y: y + dy };
        };
        return {
          id, text: run.doc.nodes[id].text.slice(0, 160), centre: { x: centre.x + dx, y: centre.y + dy },
          anchorIn: anchor('data-anchor-in'), anchorOut: anchor('data-anchor-out')
        };
      }
      const box = boxes.get(id);
      const visible = this.c.pipeline.box(id);
      return {
        id, text: run.doc.nodes[id].text.slice(0, 160),
        centre: box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : visible ? { x: visible.x, y: visible.y } : undefined
      };
    };
    const request: SvgSubtreeRequest = {
      nodes: ids.map((id) => {
        const node = run.doc.nodes[id];
        const parent = node.parent && run.doc.nodes[node.parent] ? context(node.parent) : undefined;
        const box = boxes.get(id)!;
        const previous = run.svgSplice?.nodes.find(node => node.id === id)?.box;
        return {
          id, text: node.text.slice(0, 200), box: previous ? { ...box, w: previous.w, h: previous.h } : box,
          parentId: node.parent, parent,
          children: node.children.filter((child) => run.doc.nodes[child]).map(context),
          siblings: parent ? run.doc.nodes[parent.id].children.filter((sibling) => sibling !== id && run.doc.nodes[sibling]).slice(0, 6).map(context) : undefined
        };
      }),
      brief: run.customPrompt, style: run.style, palette: resolvePalette(run.style, run.branchColour), branchColour: run.branchColour
    };
    return planSvgRegions(request).map((region) => {
      const original = buildSvgSubtreePrompt(region);
      return { request: region, original, next: original, round: 0 };
    });
  }

  private async runSvg(run: ArtworkRun): Promise<void> {
    if (!run.svgJobs) {
      if (run.single) run.svgSplice = await this.prepareSvgSplice(run);
      run.svgJobs = this.svgRegions(run);
    }
    run.svgRegionTotal ??= run.svgJobs.length;
    run.svgSuccess ??= 0;
    while (run.svgJobs.length) {
      if (!this.current(run) || snapshot(run.doc, run.root, run.depth) !== run.expected) {
        return this.complete(run, 'The subtree changed. Completed artwork was kept.');
      }
      const job = run.svgJobs[0];
      const region = run.svgRegionTotal - run.svgJobs.length + 1;
      if (run.accepted) for (const spec of job.request.nodes) this.c.pipeline.artPending.set(spec.id, 'Generating');
      this.message = job.round
        ? `Repairing SVG region ${region} of ${run.svgRegionTotal} · attempt ${job.round} of ${run.svgRepairs}`
        : `Preparing SVG region ${region} of ${run.svgRegionTotal}`;
      let artwork: Map<NodeId, NodeArt>;
      let issues: SvgReport['issues'] = [];
      try {
        const cached = !run.rework && job.round === 0 ? await this.cachedSvgAssets(run, job) : undefined;
        if (cached) {
          artwork = cached;
        } else {
          const result = await this.sendTurn(run, { kind: 'text', ...job.next, effort: 'low' });
          if (!this.current(run) || snapshot(run.doc, run.root, run.depth) !== run.expected) {
            return this.complete(run, 'The subtree changed. Completed artwork was kept.');
          }
          let svg = extractSvg(result.text);
          let report = validateSvg(svg, job.request);
          const fitted = fitSvgGroups(svg, job.request, report);
          if (fitted) {
            svg = fitted;
            report = validateSvg(svg, job.request);
          }
          issues = report.issues;
          if (!report.ok && job.round < run.svgRepairs) {
            job.round++;
            job.next = buildSvgRepairPrompt(svg, report, job.request);
            continue;
          }
          artwork = await this.storeSvgGroups(run, job, svg, report, !!fitted, result.model);
        }
      } catch (error) {
        if (!this.current(run) || this.isRateError(error) ||
          (error instanceof ArtTurnError && (error.code === 'not_logged_in' || error.code === 'not_installed'))) throw error;
        if (run.single) throw error;
        issues = [{ severity: 'error', code: 'turn', message: this.errorMessage(error) }];
        artwork = new Map();
      }
      if (!this.current(run) || snapshot(run.doc, run.root, run.depth) !== run.expected) {
        return this.complete(run, 'The subtree changed. Completed artwork was kept.');
      }
      const updates: Op[] = [];
      for (const spec of job.request.nodes) {
        this.c.pipeline.artPending.delete(spec.id);
        const art = artwork.get(spec.id);
        if (art) {
          updates.push({ t: 'set', id: spec.id, patch: { svgArt: art, svgArtError: undefined } });
        } else {
          const message = issues.find((i) => i.severity === 'error' && i.nodeId === spec.id)?.message ??
            issues.find((i) => i.severity === 'error')?.message ?? 'The SVG group was rejected.';
          updates.push({ t: 'set', id: spec.id, patch: { svgArtError: message.slice(0, 280) } });
          run.errors.push(spec.text);
        }
      }
      this.done += job.request.nodes.length;
      run.svgSuccess += artwork.size;
      run.svgJobs.shift();
      if (run.single && artwork.size) {
        const art = artwork.get(run.root)!;
        updates.push(...run.representation);
        run.replacement = updates;
        run.sample.set(run.root, art);
        await this.showPreviews(run);
        return;
      }
      if (!run.single && !run.accepted && run.targets.length > SVG_REGION_SIZE) {
        if (!artwork.size) {
          this.apply(run, updates, 'Mark Failed SVG Sample');
          return this.complete(run, 'The SVG sample could not be validated. Retry the marked nodes or generate a fresh sample.');
        }
        run.replacement = updates;
        for (const [id, art] of artwork) run.sample.set(id, art);
        await this.showPreviews(run);
        return;
      }
      if (artwork.size && !run.accepted && !run.single) {
        updates.push(...run.representation);
      }
      this.beginArtworkGroup(run);
      this.apply(run, updates, 'Use SVG Artwork Region');
      if (artwork.size && !run.accepted && !run.single) this.acceptRepresentation(run);
    }
    const failed = run.errors.length;
    this.complete(run, failed
      ? `${run.svgSuccess} SVG groups are ready. Retry ${failed} marked ${failed === 1 ? 'node' : 'nodes'}.`
      : 'SVG artwork is ready.');
  }

  private async cachedSvgAssets(run: ArtworkRun, job: SvgJob): Promise<Map<NodeId, NodeArt> | undefined> {
    const assets = new Map<NodeId, NodeArt>();
    for (const node of job.request.nodes) {
      const existing = run.doc.nodes[node.id]?.svgArt;
      if (!existing || existing.inputHash !== await artInputHash(job.original.prompt, node.id) || !await this.hasAsset(existing)) return;
      assets.set(node.id, existing);
    }
    return assets;
  }

  private async svgSource(hash: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(await this.c.host.assetUrl(hash), { signal });
    if (!response.ok) throw new Error('The stored SVG could not be loaded.');
    return response.text();
  }

  private async prepareSvgSplice(run: ArtworkRun): Promise<ArtworkRun['svgSplice']> {
    const selected = run.doc.nodes[run.root].svgArt;
    if (!selected || this.c.failedImages.has(selected.assetHash)) return;
    const region = selected.svgRegion;
    if (region && this.c.failedImages.has(region.assetHash)) return;
    const peers = new Map<NodeId, string>();
    if (region && Array.isArray(region.nodes) && region.nodes.some(node => node.id === run.root)) {
      const source = await this.svgSource(region.assetHash, run.abort.signal);
      const root = parseSvg(source).root;
      if (!root || checkedSvgRegion(root, region.nodes, region.palette, run.style) !== source) {
        throw new Error('The stored SVG region could not be validated.');
      }
      for (const peer of region.nodes) {
        if (peer.id === run.root) continue;
        const art = run.doc.nodes[peer.id]?.svgArt;
        if (art?.svgRegion?.assetHash === region.assetHash) peers.set(peer.id, art.assetHash);
      }
      return { source, nodes: region.nodes, palette: region.palette, peers };
    }

    // Older maps saved standalone wrappers. Equal provider prompts identify the original
    // regional siblings. Leave each wrapper and its content-addressed asset untouched.
    const nodes: SvgRegionAsset['nodes'] = [];
    const wrappers: string[] = [];
    for (const [id, node] of Object.entries(run.doc.nodes)) {
      const art = node.svgArt;
      if (!art || (id !== run.root && (art.svgRegion || art.prompt !== selected.prompt ||
        art.templateVersion !== selected.templateVersion))) continue;
      const source = await this.svgSource(art.assetHash, run.abort.signal);
      const spec = legacySvgSpec(source, id);
      if (!spec) continue;
      nodes.push(spec);
      wrappers.push(source);
      if (id !== run.root) peers.set(id, art.assetHash);
    }
    if (!nodes.some(node => node.id === run.root)) return;
    const root = joinSvgGroups(wrappers);
    const palette = existingSvgColours(root);
    return { source: checkedSvgRegion(root, nodes, palette, run.style), nodes, palette, peers };
  }

  private async storeSvgGroups(
    run: ArtworkRun, job: SvgJob, svg: string, report: SvgReport, fitted: boolean, model?: string
  ): Promise<Map<NodeId, NodeArt>> {
    const assets = new Map<NodeId, NodeArt>();
    const failed = new Set<NodeId>();
    for (const issue of report.issues) {
      if (issue.severity !== 'error') continue;
      if (!issue.nodeId) return assets;
      failed.add(issue.nodeId);
    }
    const valid = job.request.nodes.filter((node) => !failed.has(node.id));
    const markup = svgNodeAssets(svg, { ...job.request, nodes: valid }, { ...report, ok: true });
    if (!markup.size) return assets;
    let specs = regionSpecs(job.request.nodes).filter(spec => markup.has(spec.id));
    let palette = job.request.palette;
    let root = joinSvgGroups(markup.values());
    const splice = run.svgSplice;
    const previous = splice?.nodes.find(node => node.id === run.root);
    if (splice && previous) {
      const next = specs[0];
      root = spliceSvgGroup(splice.source, markup.get(next.id)!, previous, next);
      specs = splice.nodes.map(node => node.id === previous.id ? moveSvgSpec(next, previous.box) : node);
      palette = [...new Set([...splice.palette, ...palette])];
    }
    const whole = checkedSvgRegion(root, specs, palette, run.style);
    const region: SvgRegionAsset = {
      assetHash: await this.c.host.assetPut(new TextEncoder().encode(whole), 'image/svg+xml'),
      nodes: specs, palette
    };
    for (const spec of valid) {
      run.abort.signal.throwIfAborted();
      const value = markup.get(spec.id);
      if (!value) continue;
      const parentAsset = run.doc.nodes[spec.id]?.svgArt?.assetHash;

      const { anchorIn, anchorOut } = report.nodes[spec.id];
      const normalize = (point: Vec2) => ({
        x: Math.max(0, Math.min(1, (point.x - spec.box.x) / spec.box.w)),
        y: Math.max(0, Math.min(1, (point.y - spec.box.y) / spec.box.h))
      });
      const warnings = report.issues.filter((issue) => issue.severity === 'warning' && (!issue.nodeId || issue.nodeId === spec.id))
        .slice(0, 10).map((issue) => issue.message);
      const art: Omit<NodeArt, 'assetHash'> = {
        inputHash: await artInputHash(job.original.prompt, spec.id), prompt: job.next.prompt,
        brief: job.request.brief, instructions: job.next.instructions, effort: 'low',
        sourceHash: await sourceHash(run.doc.nodes[spec.id], run.style, run.branchColour), model,
        templateVersion: job.next.templateVersion, styleId: run.style.id, styleVersion: ART_STYLE_VERSION,
        styleSnapshot: run.style, svgSeed: job.request.style.seed, parentAsset, generatedAt: new Date().toISOString(),
        svgRegion: region,
        svgValidation: warnings.length || fitted ? { warnings, fitted: fitted || undefined } : undefined,
        anchors: {
          in: anchorIn ? normalize(anchorIn) : { x: 0, y: 0.5 },
          out: anchorOut ? normalize(anchorOut) : { x: 1, y: 0.5 }
        }
      };
      const assetHash = await this.c.host.assetPut(new TextEncoder().encode(value), 'image/svg+xml', artworkProvenance(art));
      assets.set(spec.id, { ...art, assetHash, parentAsset: parentAsset === assetHash ? undefined : parentAsset });
    }
    return assets;
  }

  private apply(run: ArtworkRun, ops: Op[], label: string): void {
    this.c.editor.apply({ ops, label, source: { ai: run.id } });
  }

  private blockedAllowance() {
    return blockedAiAllowance(this.c.aiStatus?.rateLimits);
  }

  private isRateError(error: unknown): error is ArtTurnError {
    return error instanceof ArtTurnError &&
      (error.code === 'rate_limited' || error.code === 'usage_exhausted' || error.code === 'credits_depleted');
  }

  private pause(code: ArtTurnError['code']): void {
    if (this.c.pipeline.artPending.size) {
      this.c.pipeline.artPending.clear();
      this.c.refreshLayout();
    }
    this.phase = 'paused';
    this.message = friendlyAiError(code, '', this.c.aiStatus?.rateLimits);
  }

  private fail(run: ArtworkRun, error: unknown): void {
    if (!this.current(run)) return this.complete(run, 'The artwork target changed.');
    if (this.isRateError(error)) { this.pause(error.code); return; }
    run.abort.abort();
    this.complete(run, this.errorMessage(error));
  }

  private errorMessage(error: unknown): string {
    return error instanceof ArtTurnError
      ? friendlyAiError(error.code, error.message, this.c.aiStatus?.rateLimits)
      : error instanceof Error ? error.message : String(error);
  }
}
