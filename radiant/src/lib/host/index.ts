import type { Host } from './types';
import { TauriHost } from './tauri';
import { MockHost } from './mock';

let instance: Host | null = null;

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The Host for this environment: Tauri inside the desktop app, an in-browser mock otherwise. Singleton. */
export function getHost(): Host {
  if (!instance) {
    instance = inTauri() ? new TauriHost() : new MockHost(import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('text-only-provider'));
  }
  return instance;
}

export type * from './types';
