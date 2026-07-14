import type { DerivedWaveform } from '../types/waveform';

export interface PublicationFigureContext {
  stations: string[];
  events: string[];
  preprocessing: string;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function coordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(4)}\u00b0${value >= 0 ? positive : negative}`;
}

function stationDescription(waveform: DerivedWaveform): string {
  const { stationCode, stationLat, stationLon } = waveform.metadata;
  const code = stationCode?.trim();
  const location = finite(stationLat) && finite(stationLon)
    ? `${coordinate(stationLat, 'N', 'S')}, ${coordinate(stationLon, 'E', 'W')}`
    : undefined;
  if (code && location) return `${code} (${location})`;
  return code || location || 'unspecified station';
}

function eventDescription(waveform: DerivedWaveform): string {
  const { originTime, magnitude, eventLat, eventLon, depthKm } = waveform.metadata;
  const parts: string[] = [originTime?.trim() || 'origin time unavailable'];
  if (finite(magnitude)) parts.push(`M ${Number(magnitude.toFixed(2))}`);
  if (finite(eventLat) && finite(eventLon)) {
    parts.push(`${coordinate(eventLat, 'N', 'S')}, ${coordinate(eventLon, 'E', 'W')}`);
  }
  if (finite(depthKm)) parts.push(`depth ${Number(depthKm.toFixed(2))} km`);
  return parts.join('; ');
}

function conciseList(values: readonly string[], singularFallback: string): string {
  if (values.length === 0) return singularFallback;
  if (values.length <= 2) return values.join(' / ');
  return `${values.slice(0, 2).join(' / ')} / +${values.length - 2} more`;
}

/**
 * Return a symmetric publication ordinate with 12--about 13% headroom.
 * Three-significant-digit upward rounding keeps the limit readable without the
 * large jumps introduced by a conventional 1/2/5 ceiling.
 */
export function publicationSymmetricLimit(absoluteMaximum: number): number {
  if (!Number.isFinite(absoluteMaximum) || absoluteMaximum <= 0) return 1;
  const target = absoluteMaximum * 1.12;
  const exponent = Math.floor(Math.log10(target));
  const quantum = 10 ** (exponent - 2);
  const rounded = Math.ceil((target - quantum * 1e-10) / quantum) * quantum;
  return Number(rounded.toPrecision(12));
}

export function buildPublicationFigureContext(
  waveforms: readonly DerivedWaveform[],
  preprocessingDescription?: string,
): PublicationFigureContext {
  const sourceCorrections = unique(waveforms.map((waveform) => waveform.metadata.lastCorrection));
  const preprocessing = preprocessingDescription?.trim()
    || [
      'active viewer preprocessing applied to derived waveforms (exact filter settings not supplied to this figure)',
      sourceCorrections.length > 0 ? `source correction: ${sourceCorrections.join(' / ')}` : undefined,
    ].filter((value): value is string => Boolean(value)).join('; ');

  return {
    stations: unique(waveforms.map(stationDescription)),
    events: unique(waveforms.map(eventDescription)),
    preprocessing,
  };
}

export function publicationContextCaption(context: PublicationFigureContext): string {
  return [
    `Station: ${conciseList(context.stations, 'unspecified')}.`,
    `Event: ${conciseList(context.events, 'unspecified')}.`,
    `Preprocessing: ${context.preprocessing}.`,
  ].join(' ');
}
