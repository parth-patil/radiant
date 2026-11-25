// In radiant/, run `bun build tools/check-keyboard-menu.js --format=iife`.
// Paste the resulting script into a native development window's Web Inspector console.
// Use the default shortcut preset and close any open dialog first.
import menuSource from '../src-tauri/src/menu.rs' with { type: 'text' };

async function until(read, label) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    // Yield to rendering and native IPC even when WebKit throttles background timers.
    await new Promise(resolve => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => { port1.close(); port2.close(); resolve(); };
      port2.postMessage(null);
    });
  }
  throw new Error('Timed out waiting for ' + label);
}

function key(target, key, code = key, options = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...options }));
}

export async function checkKeyboardMenu(c) {
  const items = await c.host.paletteItems();
  const expectedIds = [
    ...Array.from(menuSource.matchAll(/\bitem\(\s*app,\s*"([^"]+)"/g), match => match[1]),
    ...Array.from(menuSource.matchAll(/PredefinedMenuItem::(\w+)\(/g), match => 'native:' + match[1].replaceAll('_', '-'))
  ];
  for (const id of expectedIds) {
    if (!items.some(item => item.id === id)) throw new Error('Desktop action missing from palette: ' + id);
  }

  // Exercise actual key routing and palette selection. Observe the dispatch boundary
  // so Close, Quit and clipboard actions cannot affect the window or its contents.
  const command = c.command;
  const native = c.host.runPaletteItem;
  const canvas = document.querySelector('canvas.map');
  const originalFocus = document.activeElement;
  const routes = [];
  let selecting = false;
  let dispatched;
  c.command = function (id, ...args) {
    if (!selecting) return command.call(this, id, ...args);
    dispatched = id;
  };
  c.host.runPaletteItem = async id => { dispatched = id; };
  try {
    for (const item of items) {
      selecting = false;
      dispatched = null;
      canvas.focus();
      key(canvas, 'P', 'KeyP', { metaKey: true, shiftKey: true });
      const field = await until(() => document.querySelector('dialog[open] input[placeholder="Search commands…"]'), 'palette');
      const dialog = field.closest('dialog');
      await until(() => dialog.querySelector('[data-command="native:select-all"]'), 'desktop menu catalog');
      field.value = item.label;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      const index = await until(() => {
        const rows = [...dialog.querySelectorAll('.results button')];
        const i = rows.findIndex(row => row.dataset.command === item.id);
        return i >= 0 && i + 1;
      }, item.label) - 1;
      for (let i = 0; i < index; i++) key(field, 'ArrowDown');
      await until(() => dialog.querySelector('.results .active')?.dataset.command === item.id, 'selection of ' + item.id);
      selecting = true;
      key(field, 'Enter');
      const received = await until(() => dispatched, item.id + ' dispatch');
      const expected = item.id === 'native:select-all' ? 'select-all' : item.id;
      if (received !== expected) throw new Error(item.id + ' dispatched ' + received);
      routes.push({ id: item.id, menu: item.group, label: item.label, down: index, dispatched: received });
    }
  } finally {
    c.command = command;
    c.host.runPaletteItem = native;
    const field = document.querySelector('dialog[open][aria-label="Command palette"] input');
    if (field) { field.closest('dialog').dispatchEvent(new Event('cancel', { cancelable: true })); }
    originalFocus?.focus?.();
  }
  console.table(routes);
  return routes;
}

if (window.__radiant?.c.ready) {
  window.keyboardMenuReport = checkKeyboardMenu(window.__radiant.c);
}
