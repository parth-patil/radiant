import type { AppController } from './controller.svelte';

export function confirmArtIslands(c: AppController, count: number): Promise<string> {
  return c.ask('Create separate SVG artwork?',
    count === 1
      ? 'This SVG subtree will start with its current style and keep its own style sheet inside the picture subtree.'
      : `These ${count} SVG subtrees will start with their current styles and keep separate style sheets inside the picture subtree.`,
    [{ id: 'cancel', label: 'Cancel' }, { id: 'island', label: 'Create SVG Island', primary: true }]);
}
