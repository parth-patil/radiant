import { escapeXml } from '../core/io/xml';

/** Illustrations for the offline browser preview. The desktop uses the Codex image tool. */
export async function previewPicture(prompt: string): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  let seed = 0;
  for (const char of prompt) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
  ctx.fillStyle = `hsl(${seed % 360} 62% 52%)`;
  ctx.beginPath();
  ctx.ellipse(64, 72, 48, 40, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#38754a';
  ctx.beginPath();
  ctx.ellipse(82, 29, 22, 9, -0.65, 0, 2 * Math.PI);
  ctx.fill();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Preview unavailable'))));
  return new Uint8Array(await blob.arrayBuffer());
}

export function previewSvg(prompt: string): string {
  const frame = prompt.match(/Frame: viewBox="([\d. ,\-]+)"/)?.[1] ?? '0 0 100 100';
  const fill = prompt.match(/Palette \(the only allowed colours\): (#[a-f\d]{6})/i)?.[1] ?? '#555555';
  const groups: string[] = [];
  for (const row of prompt.split('\n')) {
    const box = row.match(/^- id ("(?:[^"\\]|\\.)+") .*?: box x=([\d.\-]+) y=([\d.\-]+) width=([\d.]+) height=([\d.]+);/);
    if (!box) continue;
    const [x, y, w, h] = box.slice(2).map(Number);
    const cx = x + w / 2, cy = y + h / 2, rx = w * .42, ry = h * .4;
    const angle = (side: string) => side === 'right' ? 0 : side === 'bottom' ? Math.PI / 2 : side === 'top' ? -Math.PI / 2 : Math.PI;
    const inSide = row.match(/data-anchor-in on the (left|right|top|bottom) side/)?.[1] ?? 'left';
    const outSide = row.match(/data-anchor-out on the (left|right|top|bottom) side/)?.[1];
    const at = (a: number) => `${cx + Math.cos(a) * rx},${cy + Math.sin(a) * ry}`;
    const direction = (kind: 'in' | 'out', side: string): number => {
      const target = row.match(new RegExp(`${kind} target (-?[\\d.]+),(-?[\\d.]+)`));
      if (!target) return angle(side);
      const [tx, ty] = target.slice(1).map(Number);
      let nearest = angle(side), distance = Infinity;
      for (let i = 0; i < 64; i++) {
        const a = i * Math.PI / 32;
        const d = Math.hypot(tx - (cx + rx * Math.cos(a)), ty - (cy + ry * Math.sin(a)));
        if (d < distance) { nearest = a; distance = d; }
      }
      return nearest;
    };
    let inAngle = direction('in', inSide);
    let outAngle = outSide ? direction('out', outSide) : 0;
    if (outSide && Math.hypot(rx * (Math.cos(inAngle) - Math.cos(outAngle)), ry * (Math.sin(inAngle) - Math.sin(outAngle))) < 0.25 * Math.hypot(w, h)) {
      const sideAngle = angle(outSide);
      inAngle = sideAngle - Math.PI / 5;
      outAngle = sideAngle + Math.PI / 5;
    }
    const anchors = `data-anchor-in="${at(inAngle)}"${outSide ? ` data-anchor-out="${at(outAngle)}"` : ''}`;
    const id = escapeXml(JSON.parse(box[1]) as string);
    groups.push(`<g id="node-${id}" ${anchors}><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/></g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${frame}">${groups.join('')}</svg>`;
}
