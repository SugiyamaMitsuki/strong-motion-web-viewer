import { downloadBlob } from '../utils/file';

const SVG_STYLE_PROPERTIES = [
  'color',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'shape-rendering',
  'vector-effect',
] as const;

export interface SvgExportOptions {
  /** Physical width of the intended printed figure. */
  widthMm?: number;
  /** Physical height. When omitted, the SVG viewBox aspect ratio is retained. */
  heightMm?: number;
}

export interface PngExportOptions extends SvgExportOptions {
  /** Raster resolution stored in the PNG metadata. */
  dpi?: number;
  /** Explicit multiplier, primarily for backwards-compatible custom exports. */
  scale?: number;
  background?: string;
}

export interface SvgPhysicalSize {
  widthMm: number;
  heightMm: number;
}

const DEFAULT_SVG_WIDTH_MM = 180;

function positiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function resolveSvgPhysicalSize(
  viewWidth: number,
  viewHeight: number,
  options: SvgExportOptions = {},
): SvgPhysicalSize {
  const safeViewWidth = positiveFinite(viewWidth) ? viewWidth : 1;
  const safeViewHeight = positiveFinite(viewHeight) ? viewHeight : 1;
  const widthMm = positiveFinite(options.widthMm)
    ? options.widthMm
    : positiveFinite(options.heightMm)
      ? options.heightMm * (safeViewWidth / safeViewHeight)
      : DEFAULT_SVG_WIDTH_MM;
  const heightMm = positiveFinite(options.heightMm)
    ? options.heightMm
    : widthMm * (safeViewHeight / safeViewWidth);
  return { widthMm, heightMm };
}

function formatMillimetres(value: number): string {
  return `${Number(value.toFixed(6))}mm`;
}

function inlineComputedStyles(source: SVGSVGElement, clone: SVGSVGElement): void {
  // Elements with explicit SVG presentation attributes are already portable.
  // Restrict computed-style work to the root and class-styled elements; this
  // avoids thousands of expensive style reads for wavelet heatmap cells.
  const sourceElements = [source, ...Array.from(source.querySelectorAll<SVGElement>('[class]'))];
  const cloneElements = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('[class]'))];

  sourceElements.forEach((element, index) => {
    const target = cloneElements[index];
    if (!target) return;
    const computed = window.getComputedStyle(element);
    SVG_STYLE_PROPERTIES.forEach((property) => {
      const value = computed.getPropertyValue(property);
      if (value) target.style.setProperty(property, value);
    });
  });
}

export function serializeSvg(svg: SVGSVGElement, options: SvgExportOptions = {}): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  const dimensions = svgDimensions(svg);
  const physicalSize = resolveSvgPhysicalSize(dimensions.width, dimensions.height, options);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('version', '1.1');
  clone.setAttribute('width', formatMillimetres(physicalSize.widthMm));
  clone.setAttribute('height', formatMillimetres(physicalSize.heightMm));
  if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${dimensions.width} ${dimensions.height}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

export function downloadSvg(svg: SVGSVGElement, fileName: string, options: SvgExportOptions = {}): void {
  const text = serializeSvg(svg, options);
  downloadBlob(fileName, new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
}

function pngChunkType(source: Uint8Array, offset: number): string {
  return String.fromCharCode(source[offset + 4], source[offset + 5], source[offset + 6], source[offset + 7]);
}

function buildPngResolutionChunk(dpi: number): Uint8Array {
  const pixelsPerMetre = Math.max(1, Math.round(dpi / 0.0254));
  const chunk = new Uint8Array(21);
  writeUint32(chunk, 0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  writeUint32(chunk, 8, pixelsPerMetre);
  writeUint32(chunk, 12, pixelsPerMetre);
  chunk[16] = 1; // unit is metre
  writeUint32(chunk, 17, crc32(chunk.slice(4, 17)));
  return chunk;
}

export function setPngResolutionMetadata(source: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (source.length < 33 || pngSignature.some((byte, index) => source[index] !== byte)) return new Uint8Array(source);

  const chunks: Array<{ start: number; end: number; type: string }> = [];
  let offset = pngSignature.length;
  while (offset + 12 <= source.length) {
    const dataLength = new DataView(source.buffer, source.byteOffset + offset, 4).getUint32(0, false);
    const end = offset + 12 + dataLength;
    if (end > source.length) return new Uint8Array(source);
    chunks.push({ start: offset, end, type: pngChunkType(source, offset) });
    offset = end;
  }
  if (offset !== source.length || chunks[0]?.type !== 'IHDR') return new Uint8Array(source);

  const resolutionChunk = buildPngResolutionChunk(dpi);
  const parts: Uint8Array[] = [source.slice(0, pngSignature.length)];
  chunks.forEach((chunk, index) => {
    if (chunk.type !== 'pHYs') parts.push(source.slice(chunk.start, chunk.end));
    if (index === 0) parts.push(resolutionChunk);
  });

  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let outputOffset = 0;
  parts.forEach((part) => {
    output.set(part, outputOffset);
    outputOffset += part.length;
  });
  return output;
}

async function addPngResolution(blob: Blob, dpi: number): Promise<Blob> {
  const source = new Uint8Array(await blob.arrayBuffer());
  return new Blob([setPngResolutionMetadata(source, dpi)], { type: 'image/png' });
}

function svgDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox.baseVal;
  const width = Number(svg.getAttribute('width')) || viewBox.width || svg.clientWidth || 900;
  const height = Number(svg.getAttribute('height')) || viewBox.height || svg.clientHeight || 360;
  return { width, height };
}

export async function downloadPng(
  svg: SVGSVGElement,
  fileName: string,
  options: PngExportOptions = {},
): Promise<void> {
  const svgText = serializeSvg(svg, options);
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

    const { width, height } = svgDimensions(svg);
    const dpi = options.dpi ?? 800;
    const widthMm = options.widthMm ?? DEFAULT_SVG_WIDTH_MM;
    const targetWidth = (widthMm / 25.4) * dpi;
    const scale = options.scale ?? targetWidth / width;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context is unavailable.');
    ctx.scale(scale, scale);
    ctx.fillStyle = options.background ?? '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const rawBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('PNG export failed.'));
      }, 'image/png');
    });
    downloadBlob(fileName, await addPngResolution(rawBlob, dpi));
  } finally {
    URL.revokeObjectURL(url);
  }
}
