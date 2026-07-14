import type { DerivedWaveform } from '../types/waveform';

export function waveformSeriesLabel(waveform: DerivedWaveform): string {
  const station = waveform.metadata.stationCode?.trim();
  return station ? `${station} · ${waveform.componentLabel}` : waveform.componentLabel;
}
