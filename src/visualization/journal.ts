export type JournalWidthPreset = 'single' | 'double';

export interface JournalFigurePreset {
  id: JournalWidthPreset;
  label: string;
  widthMm: number;
}

export interface JournalRasterSize {
  widthPx: number;
  heightPx: number;
}

/**
 * Publisher-level working sizes used by Wiley and a conservative line-art
 * resolution for strong-motion plots. Individual journals can override these
 * values during final submission.
 */
export const JOURNAL_FIGURE_PRESETS: Readonly<Record<JournalWidthPreset, JournalFigurePreset>> = {
  single: { id: 'single', label: 'Single column · 80 mm', widthMm: 80 },
  double: { id: 'double', label: 'Double column · 180 mm', widthMm: 180 },
};

export const JOURNAL_LINE_ART_DPI = 800;
export const JOURNAL_MIN_FONT_PT = 7;
export const JOURNAL_AXIS_FONT_PT = 10;
export const JOURNAL_SUPPORT_FONT_PT = 8;
export const JOURNAL_PANEL_FONT_PT = 12;
export const JOURNAL_MIN_LINE_PT = 0.5;
export const JOURNAL_DATA_LINE_PT = 0.8;

export function millimetresToPixels(millimetres: number, dpi: number): number {
  if (!Number.isFinite(millimetres) || millimetres <= 0) return 0;
  if (!Number.isFinite(dpi) || dpi <= 0) return 0;
  return Math.round((millimetres / 25.4) * dpi);
}

export function journalRasterSize(
  viewWidth: number,
  viewHeight: number,
  widthMm: number,
  dpi = JOURNAL_LINE_ART_DPI,
): JournalRasterSize {
  const widthPx = millimetresToPixels(widthMm, dpi);
  const safeWidth = Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : 1;
  const safeHeight = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 1;
  return {
    widthPx,
    heightPx: Math.round(widthPx * (safeHeight / safeWidth)),
  };
}

/** Convert a desired final printed point size into SVG viewBox user units. */
export function pointsToUserUnits(
  points: number,
  viewWidth: number,
  widthMm: number,
): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) return 0;
  if (!Number.isFinite(widthMm) || widthMm <= 0) return 0;
  return ((points * 25.4) / 72) * (viewWidth / widthMm);
}

/** Convert an SVG viewBox size back to its final printed point size. */
export function userUnitsToPoints(
  userUnits: number,
  viewWidth: number,
  widthMm: number,
): number {
  if (!Number.isFinite(userUnits) || userUnits <= 0) return 0;
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) return 0;
  if (!Number.isFinite(widthMm) || widthMm <= 0) return 0;
  return ((userUnits / viewWidth) * widthMm * 72) / 25.4;
}
