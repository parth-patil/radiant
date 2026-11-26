import type { Doc, NodeId, OutlineNode } from '../core/types';
import type { AiEngine, RateLimits } from '../core/ai/provider';
import { ENGINE_LABELS } from './ai-engine.svelte';

export function basename(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.slice(p.lastIndexOf('/') + 1).replace(/^browser:/, '');
}

export function stem(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

export function extOf(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}


/** True when the document holds just one untouched default root. */
export function isEmptyDoc(doc: Doc): boolean {
  if (doc.roots.length !== 1) return false;
  const r = doc.nodes[doc.roots[0]];
  return !!r && r.children.length === 0 && (r.text === '' || r.text === 'Central topic') && !r.note && !r.imageAsset;
}

export function fmtTime(d = new Date()): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Pick a theme id from free text such as "Buzan organic" or "dark". */
export function themeFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bhand.?drawn\b/.test(t)) return 'hand-drawn';
  if (/\b(buzan|organic|colou?rful)\b/.test(t)) return 'buzan';
  if (/\b(midnight|dark|night)\b/.test(t)) return 'midnight';
  if (/\b(ink|mono|monochrome|black|sketch)\b/.test(t)) return 'ink';
  if (/\b(clean|minimal|simple|modern)\b/.test(t)) return 'clean';
  return null;
}

/** Outline tree with one more level: wraps several top-level nodes under a root. */
export function wrapOutline(title: string, nodes: OutlineNode[]): OutlineNode {
  if (nodes.length === 1) return nodes[0];
  return { text: title || 'Imported map', children: nodes };
}

/** Plain-words explanation of an AI error with the fix. */
export function rateLimitReset(limits?: RateLimits): string | undefined {
  const active = [
    { used: limits?.primaryUsedPercent, at: limits?.primaryResetsAt ?? limits?.resetsAt },
    { used: limits?.secondaryUsedPercent, at: limits?.secondaryResetsAt }
  ].flatMap(({ used, at }) => {
    if (!at || used === undefined || used < 100) return [];
    const utc = Date.parse(at);
    return Number.isFinite(utc) && utc > Date.now() ? [utc] : [];
  });
  const reset = active.length ? Math.max(...active) : Date.parse(limits?.resetsAt ?? limits?.secondaryResetsAt ?? '');
  return Number.isFinite(reset) && reset > Date.now() ? new Date(reset).toLocaleString() : undefined;
}

export function blockedAiAllowance(limits?: RateLimits): RateLimits['limitReason'] {
  const windows = [
    [limits?.primaryUsedPercent, limits?.primaryResetsAt ?? limits?.resetsAt],
    [limits?.secondaryUsedPercent, limits?.secondaryResetsAt],
  ] as const;
  const full = windows.filter(([used]) => used !== undefined && used >= 100);
  if (full.some(([, reset]) => !reset || !Number.isFinite(Date.parse(reset)) || Date.parse(reset) > Date.now())) {
    return limits?.limitReason ?? 'rate_limited';
  }
  return full.length ? undefined : limits?.limitReason;
}

const INSTALL_HINTS: Record<AiEngine, [notInstalled: string, notSignedIn: string]> = {
  codex: [
    'Codex is not installed, so AI is off. Install it (npm i -g @openai/codex), then restart Radiant.',
    'You are not signed in to Codex. Open Terminal, run "codex login", then try again.'
  ],
  claude: [
    'Claude Code is not installed, so AI is off. Install it (npm i -g @anthropic-ai/claude-code), then try again.',
    'You are not signed in to Claude Code. Open Terminal, run "claude", type /login and sign in, then try again.'
  ],
  antigravity: [
    'The Antigravity CLI is not installed, so AI is off. Install the Antigravity CLI, then try again.',
    'You are not signed in to Antigravity. Open Terminal, run "agy" and sign in, then try again.'
  ]
};

/** Words for an AI error code. engine names the engine the turn ran on (pictures always run on Codex). */
export function friendlyAiError(code: string, message: string, limits?: RateLimits, engine: AiEngine = 'codex'): string {
  const name = ENGINE_LABELS[engine] ?? 'The AI engine';
  switch (code) {
    case 'not_installed':
      return INSTALL_HINTS[engine][0];
    case 'not_logged_in':
      return INSTALL_HINTS[engine][1];
    case 'offline':
      return 'No network connection. Reconnect to use AI.';
    case 'credits_depleted':
      return `Your ${name} credits are depleted. Add credits or ask your workspace owner, then try again.`;
    case 'rate_limited': {
      const reset = rateLimitReset(limits);
      return `You have reached the ${name} rate limit. ${reset ? `Try again after ${reset}.` : 'Wait a minute and try again.'}`;
    }
    case 'usage_exhausted': {
      const reset = rateLimitReset(limits);
      const when = reset ? `Try again after ${reset}` : 'Try again after your plan resets';
      return `Your ${name} usage allowance is used up. ${when}${engine === 'codex' ? ', or use credits if your plan supports them.' : '.'}`;
    }
    case 'transient':
      return `${name} is temporarily overloaded or disconnected. Try again in a moment.`;
    case 'stream_interrupted':
      return `${name} disconnected. Reconnect and retry to start a new job.`;
    case 'timeout':
      return 'The AI took too long to answer. Try again, or use a smaller topic.';
    case 'process_exited':
      return 'The AI helper stopped unexpectedly. Try again; if it keeps happening, restart Radiant.';
    default:
      return message ? `The AI could not finish: ${message}` : 'The AI could not finish. Try again.';
  }
}

export function walkVisible(
  doc: Doc,
  fn: (id: NodeId, depth: number) => boolean | void
): void {
  const stack: Array<[NodeId, number]> = [];
  for (let i = doc.roots.length - 1; i >= 0; i--) stack.push([doc.roots[i], 0]);
  while (stack.length) {
    const [id, d] = stack.pop() as [NodeId, number];
    const n = doc.nodes[id];
    if (!n) continue;
    if (fn(id, d) === false) continue;
    if (!n.collapsed) for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], d + 1]);
  }
}
