/**
 * The AI engine choice: which command-line agent runs text turns, and for each engine a model and an effort. These
 * are app-wide settings; a missing or unreadable value means Automatic (the host's default), and the engine
 * defaults to Codex. Pictures always use Codex, so image turns pass through unchanged.
 *
 * Keys: radiant.aiEngine ("codex", "claude" or "antigravity"), radiant.aiModel.<engine> (a model id),
 * radiant.aiEffort.<engine> ("low", "medium", "high", "xhigh" or "max") and radiant.expandGuidance (the user's
 * expansion guidance as plain text; absent means the built-in wording).
 */
import type { AiEffort, AiEngine, AiEngineInfo, AiModel, AiProvider, AiTurnRequest } from '../core/ai/provider';
import { customExpandGuidance, DEFAULT_EXPAND_GUIDANCE } from '../core/ai/prompts';
import { getSetting, onSettingChange, removeSetting, setSetting } from './settings';

export const AI_ENGINES: readonly AiEngine[] = ['codex', 'claude', 'antigravity'];
export const AI_EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ENGINE_LABELS: Record<AiEngine, string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };
export const EFFORT_LABELS: Record<AiEffort, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum'
};

const ENGINE_KEY = 'radiant.aiEngine';
const MODEL_KEY = 'radiant.aiModel.';
const EFFORT_KEY = 'radiant.aiEffort.';
const GUIDANCE_KEY = 'radiant.expandGuidance';
/** What Codex text turns have always run at when the user leaves effort on Automatic. */
const CODEX_EFFORT: AiEffort = 'low';
/** A model id as a command line takes it: no spaces or quotes, at most 128 characters. */
const MODEL_ID = /^[A-Za-z0-9][\w.:/@[\]-]{0,127}$/;

export const isAiEngine = (value: unknown): value is AiEngine =>
  typeof value === 'string' && (AI_ENGINES as readonly string[]).includes(value);
export const isAiEffort = (value: unknown): value is AiEffort =>
  typeof value === 'string' && (AI_EFFORTS as readonly string[]).includes(value);
export const validModelId = (value: unknown): value is string => typeof value === 'string' && MODEL_ID.test(value);

/** One engine's model and effort; undefined means Automatic. */
export interface EnginePick { model?: string; effort?: AiEffort }

/** How a saved job ran, to run it again the same way. Jobs saved before engines could be chosen ran on Codex. */
export function ranWith(job: { engine?: AiEngine; model?: string; effort?: AiEffort; route?: string }): EnginePick & { engine: AiEngine } {
  const engine = job.engine ?? 'codex';
  return { engine, model: job.route === 'replay' ? undefined : job.model, effort: job.effort ?? (engine === 'codex' ? CODEX_EFFORT : undefined) };
}

const noPicks = (): Record<AiEngine, EnginePick> => ({ codex: {}, claude: {}, antigravity: {} });

export class AiChoice {
  engine = $state<AiEngine>('codex');
  picks = $state.raw<Record<AiEngine, EnginePick>>(noPicks());
  /** The user's expansion guidance, or '' for the built-in wording. */
  guidance = $state('');
  /** The engines as the host found them, or null until the first answer. */
  engines = $state.raw<AiEngineInfo[] | null>(null);
  /** The list is the browser preview's sample, not what is installed. */
  sample = $state(false);
  listError = $state('');
  private listing: Promise<void> | null = null;
  private engineListeners = new Set<() => void>();

  /** Read every key; call once settings have loaded. */
  load(): void {
    const engine = getSetting(ENGINE_KEY);
    this.engine = isAiEngine(engine) ? engine : 'codex';
    const picks = noPicks();
    for (const name of AI_ENGINES) {
      const model = getSetting(MODEL_KEY + name);
      const effort = getSetting(EFFORT_KEY + name);
      picks[name] = { model: validModelId(model) ? model : undefined, effort: isAiEffort(effort) ? effort : undefined };
    }
    this.picks = picks;
    this.guidance = customExpandGuidance(getSetting(GUIDANCE_KEY) ?? '') ?? '';
  }

  /** Follow changes from other windows. onEngine runs whenever the chosen engine changes, here or there. */
  listen(onEngine: () => void): () => void {
    this.engineListeners.add(onEngine);
    const off = onSettingChange((key) => {
      if (key !== ENGINE_KEY && key !== GUIDANCE_KEY && !key.startsWith(MODEL_KEY) && !key.startsWith(EFFORT_KEY)) return;
      const before = this.engine;
      this.load();
      if (this.engine !== before) onEngine();
    });
    return () => { off(); this.engineListeners.delete(onEngine); };
  }

  setEngine(engine: AiEngine): void {
    if (!isAiEngine(engine) || engine === this.engine) return;
    this.engine = engine;
    setSetting(ENGINE_KEY, engine);
    for (const listener of this.engineListeners) listener();
  }

  /** Choose a model (undefined: Automatic). An effort the new model does not accept falls back to Automatic. */
  setModel(engine: AiEngine, model: string | undefined): boolean {
    const id = model?.trim() || undefined;
    if (id !== undefined && !validModelId(id)) return false;
    const pick = { ...this.picks[engine], model: id };
    if (pick.effort && !this.efforts(engine, id).includes(pick.effort)) pick.effort = undefined;
    this.store(engine, pick);
    return true;
  }

  setEffort(engine: AiEngine, effort: AiEffort | undefined): void {
    this.store(engine, { ...this.picks[engine], effort: isAiEffort(effort) ? effort : undefined });
  }

  private store(engine: AiEngine, pick: EnginePick): void {
    this.picks = { ...this.picks, [engine]: pick };
    if (pick.model) setSetting(MODEL_KEY + engine, pick.model);
    else removeSetting(MODEL_KEY + engine);
    if (pick.effort) setSetting(EFFORT_KEY + engine, pick.effort);
    else removeSetting(EFFORT_KEY + engine);
  }

  /** Keep the user's guidance; empty, blank or the built-in wording clears the setting. */
  setGuidance(text: string): void {
    const custom = customExpandGuidance(text) ?? '';
    if (custom === this.guidance) return;
    this.guidance = custom;
    if (custom) setSetting(GUIDANCE_KEY, custom);
    else removeSetting(GUIDANCE_KEY);
  }

  /** The guidance as the expansion prompt uses it. */
  get expandGuidance(): string {
    return this.guidance || DEFAULT_EXPAND_GUIDANCE;
  }

  info(engine: AiEngine = this.engine): AiEngineInfo | undefined {
    return this.engines?.find((item) => item.engine === engine);
  }

  label(engine: AiEngine = this.engine): string {
    return this.info(engine)?.label || ENGINE_LABELS[engine];
  }

  /** The listed model for an id, or for Automatic (undefined) the host's default model. */
  model(engine: AiEngine, id: string | undefined): AiModel | undefined {
    const info = this.info(engine);
    const wanted = id ?? info?.defaultModel;
    return info?.models.find((item) => item.id === wanted);
  }

  /**
   * Effort levels a model accepts. For a model the host did not list (a typed id, or before the list arrives),
   * every level the engine's models accept, or all five when nothing is known.
   */
  efforts(engine: AiEngine, id: string | undefined): AiEffort[] {
    const listed = this.model(engine, id);
    if (listed) return listed.efforts;
    const models = this.info(engine)?.models ?? [];
    if (!models.length) return [...AI_EFFORTS];
    const accepted = new Set(models.flatMap((item) => item.efforts));
    return AI_EFFORTS.filter((effort) => accepted.has(effort));
  }

  /** What Automatic effort means for an engine: Codex keeps its usual low effort, the others use the host's default. */
  automaticEffort(engine: AiEngine): AiEffort | undefined {
    const accepted = this.efforts(engine, this.picks[engine].model);
    if (engine === 'codex') return accepted.includes(CODEX_EFFORT) ? CODEX_EFFORT : undefined;
    const effort = this.info(engine)?.defaultEffort;
    return effort && accepted.includes(effort) ? effort : undefined;
  }

  /** The model and effort a fresh text turn on this engine sends; undefined leaves it to the host. */
  sends(engine: AiEngine = this.engine): EnginePick {
    const pick = this.picks[engine];
    const accepted = this.efforts(engine, pick.model);
    const effort = pick.effort && accepted.includes(pick.effort) ? pick.effort
      : engine === 'codex' && accepted.includes(CODEX_EFFORT) ? CODEX_EFFORT : undefined;
    return { model: pick.model, effort };
  }

  /**
   * The one place a text turn gets its engine, model and effort. A request that already names the chosen engine
   * (a retry of a job that ran on it, or a request applied before) keeps its own model and effort; any other
   * request's model and effort are replaced by the user's choice. Image turns are left alone: pictures use Codex.
   */
  apply(request: AiTurnRequest): AiTurnRequest {
    if (request.kind !== 'text' || request.engine === this.engine) return request;
    const { engine: _engine, model: _model, effort: _effort, ...rest } = request;
    const { model, effort } = this.sends();
    return { ...rest, engine: this.engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  /** Ask the host which engines are installed. Without native engines (the browser preview) use the sample list. */
  loadEngines(host: AiProvider, sample: AiEngineInfo[]): Promise<void> {
    this.listing ??= (async () => {
      try {
        if (host.aiEngines) {
          this.engines = await host.aiEngines();
          this.sample = false;
        } else {
          this.engines = sample;
          this.sample = true;
        }
        this.listError = '';
      } catch (error) {
        this.listError = 'Could not list the AI engines: ' + (error instanceof Error ? error.message : String(error));
      } finally {
        this.listing = null;
      }
    })();
    return this.listing;
  }
}

/** The app-wide choice, shared by every part of the window. */
export const aiChoice = new AiChoice();
