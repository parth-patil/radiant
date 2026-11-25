import { mapLink, parseMapLink } from '../core/io/map-links';

export function parseNodeLink(value: string): URL {
  // An absolute file name can end in whitespace and can contain a literal backslash on macOS.
  const input = value.trimStart();
  const drive = input.match(/^([A-Za-z]:)[\\/]/);
  let url: URL;
  if (input.startsWith('/') || drive) {
    const segments = drive ? input.slice(3).split(/[\\/]/) : input.slice(1).split('/');
    url = new URL('file:///');
    url.pathname = (drive ? '/' + drive[1] + '/' : '/') + segments.map(encodeURIComponent).join('/');
  } else {
    url = new URL(input);
  }
  if (url.protocol === 'radiant:') {
    const map = parseMapLink(url.href);
    if (!map) throw new Error('This Radiant map link is malformed.');
    return new URL(mapLink(map.path, map.node));
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  if (url.protocol === 'file:' && !url.host) return url;
  throw new Error('Enter an HTTP or HTTPS address, or an absolute local file path.');
}
