import { isPortableFile, type PortableFiles } from '../core/io/portable';

type DirectoryPicker = () => Promise<FileSystemDirectoryHandle>;
const browser = globalThis as typeof globalThis & { showDirectoryPicker?: DirectoryPicker };
const limit = 48 * 1024 * 1024;

export function browserDirectoryWriter() {
  if (typeof browser.showDirectoryPicker !== 'function') return undefined;
  return async (name: string, prepare: () => Promise<PortableFiles>): Promise<boolean> => {
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await browser.showDirectoryPicker!();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      throw error;
    }
    const files = await prepare();
    try {
      await parent.getDirectoryHandle(name);
      throw new Error(`A folder named ${name} already exists here.`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    const root = await parent.getDirectoryHandle(name, { create: true });
    const assets = await root.getDirectoryHandle('assets', { create: true });
    const sorted = Object.entries(files).sort(([a], [b]) => Number(a === 'manifest.json') - Number(b === 'manifest.json'));
    for (const [name, bytes] of sorted) {
      const dir = name.startsWith('assets/') ? assets : root;
      const file = await dir.getFileHandle(name.split('/').at(-1)!, { create: true });
      const writer = await file.createWritable();
      try {
        await writer.write(new Uint8Array(bytes));
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    }
    return true;
  };
}

export function browserDirectoryReader(): Promise<PortableFiles | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const picked = Array.from(input.files ?? []);
      input.remove();
      if (!picked.length) return resolve(null);
      const entries = picked.map((file) => ({
        file, name: file.webkitRelativePath.split('/').slice(1).join('/')
      })).filter(({ name }) => isPortableFile(name));
      if (entries.reduce((size, item) => size + item.file.size, 0) > limit) {
        reject(new Error('This portable map exceeds Radiant’s import size limit.'));
        return;
      }
      void Promise.all(entries.map(async ({ name, file }) => [name, new Uint8Array(await file.arrayBuffer())] as const))
        .then((pairs) => resolve(Object.fromEntries(pairs)), reject);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
