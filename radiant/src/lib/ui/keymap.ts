import type { MenuId } from '../host/types';
export const commands: [MenuId, string, string][] = [
    ['edit-link', 'Edit node link', 'Mod+K'],
    ['edit-note', 'Edit node note', 'Mod+Shift+K'],
    ['new', 'New Map', 'Mod+N'],
    ['node-menu','Node actions and artwork…','Shift+F10'],
    ['browse-maps','Browse map folder…',''],
    ['open', 'Open…', 'Mod+O'],
    ['save', 'Save', 'Mod+S'],
    ['save-as', 'Save As…', 'Mod+Shift+S'],
    ['export', 'Export Map…', ''],
    ['next-pane', 'Focus next pane', 'F6'],
    ['previous-pane', 'Focus previous pane', 'Shift+F6'],
    ['cancel-generation', 'Cancel map generation or expansion', ''],
    ['print', 'Print…', 'Mod+P'],
    ['import-markdown', 'Import map or outline…', ''],
    ['extract-branch', 'Move branch to a new map…', ''],
    ['copy-map-link', 'Copy link to selected node', ''],
    ['back-map-link', 'Back to previous linked map', ''],
    ['import-folder', 'Import portable map folder…', ''],
    ['copy-markdown', 'Copy Map as Markdown', ''],
    ['find-replace','Find and replace','Mod+Alt+F'],
    ['find', 'Find in Map…', 'Mod+F'],
    ['commands', 'Command Palette…', 'Mod+Shift+P'],
    ['undo', 'Undo', 'Mod+Z'],
    ['redo', 'Redo', 'Mod+Shift+Z'],
    ['generate', 'Generate with AI…', 'Mod+G'],
    ['expand', 'Expand Selected Node with AI', 'Mod+Shift+E'],
    ['collapse-toggle', 'Fold or Unfold', 'Mod+.'],
    ['connect', 'Connect to Node…', 'Mod+L'],
    ['task', 'Toggle Task', 'Mod+Shift+T'],
    ['detach', 'Detach branch as main node', 'Mod+Shift+D'],
    ['fold-alt', 'Fold or unfold (alternate)', 'Alt+.'],
    ['fold-siblings', 'Fold with siblings', 'Mod+Alt+.'],
    ['unfold-one', 'Unfold one level', 'Ctrl+Alt+.'],
    ['unfold-all', 'Unfold all descendants', 'Ctrl+Alt+Shift+.'],
    ['fold-level', 'Fold to level…', 'Mod+Alt+Shift+.'],
    ['add-child', 'Add child', 'Tab'],
    ['add-parent', 'Insert Parent', 'Alt+Tab'],
    ['duplicate', 'Duplicate Branch', 'Mod+D'],
    ['create-alias', 'Create Alias', ''],
    ['next-layout', 'Change Layout', ''],
    ['balance', 'Balance main node', 'Mod+Alt+B'],
    ['new-variation', 'New organic variation', ''],
    ['next-theme', 'Next Theme', 'Mod+T'],
    ['zoom-in', 'Zoom In', 'Mod+='],
    ['zoom-actual', 'Actual size (100%)', 'Mod+0'],
    ['zoom-plus', 'Zoom in (plus key)', 'Mod+Shift+='],
    ['move-left', 'Move sibling left in vertical layout', 'Mod+ArrowLeft'],
    ['move-right', 'Move sibling right in vertical layout', 'Mod+ArrowRight'],
    ['sort-tasks', 'Sort children by task state', ''],
    ['zoom-out', 'Zoom Out', 'Mod+-'],
    ['zoom-fit', 'Zoom to Fit', 'Mod+NumpadMultiply'],
    ['centre-selection', 'Centre Selection', 'Mod+Shift+8'],
    ['zoom-selection', 'Zoom to Selection', 'Mod+Shift+1'],
    ['map-view','Map only','Mod+1'],
    ['outline-view','Map with outline','Mod+2'],
    ['toggle-outline', 'Show or Hide Outline', 'Mod+Alt+O'],
    ['toggle-inspector', 'Show or Hide Inspector', 'Mod+Alt+I'],
    ['toggle-minimap', 'Show or Hide Minimap', ''],
    ['filter-map', 'Filter Map…', ''],
    ['focus-branch', 'Focus on Branch', 'Mod+Shift+F'],
    ['present-branches', 'Present', 'Mod+Alt+P'],
    ['present-from-here', 'Present from Here', ''],
    ['presentations', 'Presentations…', ''],
    ['toggle-stats', 'Show or Hide Performance Stats', 'Mod+Alt+D'],
    ['select-subtree', 'Select subtree', ''],
    ['select-siblings', 'Select siblings', ''],
    ['select-level', 'Select nodes at the same level', ''],
    ['arrange', 'Arrange map or selected branches', 'Mod+Alt+L'],
    ['tidy-layout', 'Tidy selected branches', ''],
    ['tidy-map', 'Tidy whole map', ''],
    ['pin-position', 'Toggle absolute position pin', ''],
    ['reset-offset', 'Reset selected node positions', 'Ctrl+Meta+R'],
    ['reset-branch-offsets', 'Reset positions in selected branches', ''],
    ['reset-map-offsets', 'Reset positions in whole map', ''],
    ['sort-children', 'Sort children alphabetically', ''],
    ['add-sibling', 'Add sibling after', 'Enter'],
    ['sibling-before', 'Add sibling before', 'Shift+Enter'],
    ['sibling-above', 'Add sibling before (alternate)', 'Alt+Enter'],
    ['new-main', 'Add main node', ''],
    ['outdent', 'Outdent node', 'Shift+Tab'],
    ['delete', 'Delete subtree', 'Backspace'],
    ['delete-forward', 'Delete subtree (forward delete)', 'Delete'],
    ['promote', 'Delete and promote children', 'Alt+Backspace'],
    ['promote-forward', 'Delete and promote children (forward delete)', 'Alt+Delete'],
    ['edit-label', 'Edit label', 'F2'],
    ['edit-label-alt', 'Edit label (alternate)', 'Mod+Enter'],
    ['select-all', 'Select all nodes', 'Mod+A'],
    ['move-up', 'Move sibling earlier', 'Mod+ArrowUp'],
    ['move-down', 'Move sibling later', 'Mod+ArrowDown'],
    ['art-visibility', 'Toggle generated artwork', 'Mod+Alt+A'],
    ['nav-up', 'Select node up', 'ArrowUp'],
    ['nav-down', 'Select node down', 'ArrowDown'],
    ['nav-left', 'Select node left', 'ArrowLeft'],
    ['nav-right', 'Select node right', 'ArrowRight'],
  ];

export type Shortcuts = Partial<Record<MenuId,string>>;
export function preset(name: string): Shortcuts {
  const bindings: Shortcuts = Object.fromEntries(commands.map(([id,,binding])=>[id,binding]));
  if (!/Mac/.test(globalThis.navigator?.platform ?? '')) {
    // Ctrl+Alt stays available for unfolding on platforms where Ctrl is the primary modifier.
    bindings['fold-siblings'] = 'Mod+Shift+.';
    bindings['fold-level'] = 'Mod+Alt+Shift+F';
  }
  if (name === 'MindNode') {
    bindings['sibling-before'] = '';
    bindings['new-main'] = 'Shift+Enter';
  }
  return bindings;
}

export function chord(e: KeyboardEvent): string {
  let key = e.key;
  if (['Alt','Control','Meta','Shift','Dead','Unidentified'].includes(key)) return '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  if (e.code === 'Equal') key = '=';
  if (e.code === 'Minus') key = '-';
  if (e.code === 'Period') key = '.';
  if (e.code === 'Space') key = 'Space';
  if (e.code === 'NumpadMultiply') key = 'NumpadMultiply';
  const modifier = e.ctrlKey && e.metaKey ? 'Ctrl+Meta' : e.ctrlKey && e.altKey && (e.code === 'Period' || /Mac/.test(navigator.platform)) ? 'Ctrl' : e.metaKey || e.ctrlKey ? 'Mod' : '';
  return [modifier, e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key]
    .filter(Boolean).join('+');
}
