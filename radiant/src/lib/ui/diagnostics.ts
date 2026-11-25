import type { AiErrorCode, AiStatus, DiagnosticEntry, DiagnosticEvent, Host } from '../host/types';

const STORE_KEY = 'radiant.diagnostics.v1';
const BROWSER_KEEP = 384;
const RECENT_LIMIT = 40;
const pending = new WeakMap<Host, Promise<void>>();
const levels: Record<DiagnosticEvent, DiagnosticEntry['level']> = {
  started: 'info',
  ui_error: 'error', window_error: 'error', unhandled_rejection: 'error',
  layout_worker_fallback: 'warning', webkit_refresh_fallback: 'warning', update_failed: 'error', artwork_unavailable: 'error',
  codex_not_installed: 'warning', codex_not_logged_in: 'warning',
  codex_rate_limit: 'warning', codex_protocol: 'error', codex_timeout: 'error',
  codex_interrupted: 'error', codex_error: 'error'
};

function sanitize(rows: unknown): DiagnosticEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: Partial<DiagnosticEntry> | null) => {
    const event = row?.event;
    const timeMs = row?.timeMs;
    if (typeof event !== 'string' || !Object.hasOwn(levels, event) ||
        typeof timeMs !== 'number' || !Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > Date.now() + 86_400_000) return [];
    return [{ timeMs, event, level: levels[event] }];
  });
}

function localEntries(): DiagnosticEntry[] {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'));
  } catch {
    return [];
  }
}

/** Only fixed, allowlisted categories enter the log. No exception, message, URL or document is accepted. */
export function recordDiagnostic(host: Host, event: DiagnosticEvent): void {
  if (typeof event !== 'string' || !Object.hasOwn(levels, event)) return;
  if (host.diagnosticRecord) {
    const next = (pending.get(host) ?? Promise.resolve())
      .then(() => host.diagnosticRecord!(event))
      .catch(() => { /* diagnostics must never affect the action being recorded */ });
    pending.set(host, next);
  } else {
    try {
      const local = localEntries().slice(0, BROWSER_KEEP - 1);
      local.unshift({ timeMs: Date.now(), level: levels[event], event });
      localStorage.setItem(STORE_KEY, JSON.stringify(local));
    } catch { /* optional browser storage unavailable */ }
  }
}

export function codexDiagnostic(code: AiErrorCode | string): DiagnosticEvent {
  switch (code) {
    case 'not_installed': return 'codex_not_installed';
    case 'not_logged_in': return 'codex_not_logged_in';
    case 'rate_limited':
    case 'usage_exhausted':
    case 'credits_depleted': return 'codex_rate_limit';
    case 'protocol': return 'codex_protocol';
    case 'timeout': return 'codex_timeout';
    case 'offline':
    case 'transient':
    case 'process_exited':
    case 'stream_interrupted': return 'codex_interrupted';
    default: return 'codex_error';
  }
}

interface RenderSummary {
  renderer: 'webgl2' | 'unavailable';
  lastFrameCpuMs: number | null;
  drawsInPreviousSecond: number;
  layoutEngine: 'worker' | 'main' | 'unavailable';
}

function version(raw: string | undefined, prefix = ''): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const value = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4})?)?$/.test(value) ? value : null;
}

function refreshSample(): Promise<{ intervals: number; p50Ms: number | null; p95Ms: number | null }> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let previous: number | undefined;
    let handle = 0;
    const finish = () => {
      cancelAnimationFrame(handle);
      clearTimeout(timeout);
      intervals.sort((a, b) => a - b);
      const percentile = (fraction: number) => intervals.length
        ? Math.round(intervals[Math.ceil(intervals.length * fraction) - 1] * 10) / 10 : null;
      resolve({ intervals: intervals.length, p50Ms: percentile(.5), p95Ms: percentile(.95) });
    };
    const timeout = window.setTimeout(finish, 750);
    const step = (now: number) => {
      if (previous !== undefined) intervals.push(now - previous);
      previous = now;
      if (intervals.length === 12) finish();
      else handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
  });
}

/** Keep this allowlisted projection independent of any document, exception, profile or raw AI trace. */
export async function buildDiagnostics(host: Host, render: RenderSummary, codex: AiStatus | null): Promise<string> {
  await pending.get(host);
  const [platform, frameSample, entries] = await Promise.all([
    host.platformInfo().catch(() => null),
    refreshSample(),
    host.diagnosticRecent ? host.diagnosticRecent().then(sanitize).catch(() => null) : localEntries()
  ]);
  const os = platform?.os;
  const displayHz = platform?.displayHz;
  const recent = (entries ?? []).slice(0, RECENT_LIMIT);
  const data = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    build: {
      version: version(platform?.appVersion),
      mode: import.meta.env.DEV ? 'development' : 'release',
      platform: typeof os === 'string' && ['macos', 'windows', 'linux', 'ios', 'android', 'browser'].includes(os) ? os : 'unknown'
    },
    display: {
      reportedHz: typeof displayHz === 'number' && Number.isInteger(displayHz) && displayHz > 0 && displayHz <= 1000 ? displayHz : null,
      refreshMode: os === 'macos' && platform?.highRefreshEnabled === true ? 'webkit-high-refresh' : 'system-default'
    },
    codex: {
      version: codex?.provider === 'replay' ? null : version(codex?.version, 'codex-cli '),
      status: codex?.provider === 'replay' ? 'replay' : codex?.available === true ? 'streaming' :
        codex?.fallbackAvailable === true ? 'exec-fallback' : 'unavailable'
    },
    harness: {
      type: 'foreground-animation-callbacks',
      ...frameSample,
      renderer: render.renderer,
      lastFrameCpuMs: render.lastFrameCpuMs,
      drawsInPreviousSecond: render.drawsInPreviousSecond,
      layoutEngine: render.layoutEngine
    },
    localLog: {
      availability: entries ? 'available' : 'unavailable',
      recentWarningsAndErrors: recent.filter((entry) => entry.level !== 'info'),
      recentInfoCount: recent.filter((entry) => entry.level === 'info').length
    }
  };
  return JSON.stringify(data, null, 2) + '\n';
}
