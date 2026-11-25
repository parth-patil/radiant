<script lang="ts">
  let { name, size = 16 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    undo: 'M4 6.5h6.2a3.8 3.8 0 0 1 0 7.6H6 M6.6 3.9 4 6.5l2.6 2.6',
    redo: 'M12 6.5H5.8a3.8 3.8 0 0 0 0 7.6H10 M9.4 3.9 12 6.5 9.4 9.1',
    outline: 'M2.5 4h11M5.5 8h8M5.5 12h8M2.5 8h.01M2.5 12h.01',
    inspector: 'M3 3.5h10v9H3z M10 3.5v9',
    sparkle: 'M8 2l1.3 3.7L13 7l-3.7 1.3L8 12 6.7 8.3 3 7l3.7-1.3z M12.5 11.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z',
    plus: 'M8 3.5v9M3.5 8h9',
    minus: 'M3.5 8h9',
    fit: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
    chevron: 'M6 3.5 10.5 8 6 12.5',
    stop: 'M4.5 4.5h7v7h-7z',
    arrange: 'M2.5 8h3.5M6 3.5v9M6 3.5h3M6 8h3M6 12.5h3M11.5 3.5h2M11.5 8h2M11.5 12.5h2'
  };
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name] ?? ''} />
</svg>
