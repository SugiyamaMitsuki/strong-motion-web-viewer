import { downloadBlob } from '../utils/file';

export function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

export function downloadSvg(svg: SVGSVGElement, fileName: string): void {
  const text = serializeSvg(svg);
  downloadBlob(fileName, new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
}

export async function downloadPng(svg: SVGSVGElement, fileName: string, scale = 2): Promise<void> {
  const svgText = serializeSvg(svg);
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const image = new Image();
    const loadPromise = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG image loading failed.'));
    });
    image.src = url;
    await loadPromise;

    const width = Number(svg.getAttribute('width')) || svg.clientWidth || 900;
    const height = Number(svg.getAttribute('height')) || svg.clientHeight || 360;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context is unavailable.');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('PNG export failed.'));
      }, 'image/png');
    });
    downloadBlob(fileName, blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}
