import { BRANCH_MIME, parseBranches } from '../core/model/clipboard';

export function readBranches(clipboard: DataTransfer) {
  const json = clipboard.getData(BRANCH_MIME);
  if (json) return parseBranches(json);
  const html = clipboard.getData('text/html');
  if (!html.includes('data-radiant-branches')) return null;
  const encoded = new DOMParser().parseFromString(html, 'text/html')
    .querySelector('[data-radiant-branches]')?.getAttribute('data-radiant-branches');
  return encoded ? parseBranches(encoded) : null;
}
