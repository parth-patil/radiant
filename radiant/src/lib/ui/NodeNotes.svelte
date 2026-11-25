<script lang="ts">
  // Notes opened on the canvas. A note stays folded behind its node's badge until that is clicked; then a card under
  // the node shows it as formatted Markdown. Cards keep one size on screen and follow their node as the map moves.
  import type { AppController } from './controller.svelte';
  import NoteCard from './NoteCard.svelte';

  let { c }: { c: AppController } = $props();
  const WIDTH = 330;
  const HEIGHT = 380;
  const GAP = 8;

  const cards = $derived.by(() => {
    void c.rev; void c.layoutTick; void c.camTick;
    if (!c.ready || c.presenting || !c.openNotes.length || c.camera.zoom < 0.2) return [];
    const { camera } = c;
    const scale = c.interfaceScale;
    const width = Math.min(WIDTH * scale, camera.width - 16);
    const roof = c.topBarHeight * scale + 6, floor = camera.height - c.statusBarHeight * scale - 6;
    return c.openNotes.flatMap((id) => {
      const node = c.doc.nodes[id];
      const box = c.pipeline.canvasLayout.boxes.get(id);
      if (!node || !box || (!node.note && c.noteEditing !== id)) return [];
      const top = camera.worldToScreen({ x: box.x - box.w / 2, y: box.y - box.h / 2 });
      const bottom = camera.worldToScreen({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
      if (bottom.y < roof - 20 || top.y > floor + 20 || bottom.x < 0 || top.x > camera.width) return [];
      // Under the node when there is room for a useful card, else over it.
      const below = floor - bottom.y - GAP, over = top.y - GAP - roof;
      const above = below < 170 * scale && over > below;
      return [{
        id, note: node.note ?? '', title: node.text || 'Unnamed node', above, width,
        left: Math.max(8, Math.min(camera.width - width - 8, top.x)),
        y: above ? camera.height - top.y + GAP : bottom.y + GAP,
        height: Math.max(110, Math.min(HEIGHT * scale, above ? over : below))
      }];
    });
  });
</script>

{#each cards as card (card.id)}
  <NoteCard {c} {...card} editing={c.noteEditing === card.id} />
{/each}
