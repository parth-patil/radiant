/** Dev-only hooks: window.__radiant and ?demo=... URL parameters. Imported only when import.meta.env.DEV. */
import type { AppController } from './controller.svelte';

export function installDebugHooks(c: AppController, params: URLSearchParams): void {
  const w = window as unknown as { __radiant: unknown };
  w.__radiant = { c, editor: c.editor, pipeline: c.pipeline, camera: c.camera, renderer: c.renderer };
  const demo = params.get('demo');
  const theme = params.get('theme');
  if (theme) c.setTheme(theme);
  if (params.get('outline')) c.showOutline = true;
  if (params.get('inspector')) c.showInspector = true;
  if (params.get('stats')) c.toggleStats();
  if (params.get('dark')) c.isDark = true;
  if (demo === 'generate') {
    c.topic = params.get('topic') ?? 'Photosynthesis';
    c.styleText = params.get('style') ?? '';
    if (params.get('prompt')) c.showPrompt = true;
    void c.generate();
  } else if (demo === 'big') {
    c.loadSynthetic(Number(params.get('n') ?? 5000));
  } else if (demo === 'prompt') {
    c.topic = params.get('topic') ?? '';
    c.showPrompt = true;
  }
}
