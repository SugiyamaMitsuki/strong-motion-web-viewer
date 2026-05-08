export function makeId(prefix = 'id'): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}-${time}-${random}`;
}

export function downloadTextFile(fileName: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  downloadBlob(fileName, blob);
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
}

export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 100000)) return value.toExponential(digits);
  return Number(value.toFixed(digits)).toString();
}

export async function readFileAsText(file: File): Promise<string> {
  return await file.text();
}

export function isSupportedWaveformFileName(fileName: string): boolean {
  const baseName = fileName.split('/').pop() ?? fileName;
  if (baseName.startsWith('.')) return false;
  return /\.(csv|txt|dat|ns\d*|ew\d*|ud\d*)$/i.test(baseName);
}
