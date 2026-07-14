import { computeStationDistanceRows } from '../analysis/distance';
import type { DerivedWaveform, WaveformRecord } from '../types/waveform';

export interface WaveformRecordSet {
  id: string;
  label: string;
  waveforms: DerivedWaveform[];
}

export interface WaveformTimeAlignment {
  values: Map<string, number[]>;
  reference: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function componentRank(component: DerivedWaveform['component']): number {
  if (component === 'NS') return 0;
  if (component === 'EW') return 1;
  if (component === 'UD') return 2;
  return 3;
}

function componentSuffix(waveform: DerivedWaveform): string {
  if (waveform.component !== 'NS' && waveform.component !== 'EW' && waveform.component !== 'UD') return '';
  const match = waveform.componentLabel.toUpperCase().match(new RegExp(`^${waveform.component}(.*)$`));
  return match?.[1] ?? '';
}

function fallbackLabel(waveform: DerivedWaveform): string {
  if (waveform.metadata.stationCode?.trim()) return waveform.metadata.stationCode.trim();
  if (isFiniteNumber(waveform.metadata.stationLat) && isFiniteNumber(waveform.metadata.stationLon)) {
    return `${waveform.metadata.stationLat.toFixed(5)}, ${waveform.metadata.stationLon.toFixed(5)}`;
  }
  return 'Loaded record set';
}

function asRecord(waveform: DerivedWaveform): WaveformRecord {
  return {
    id: waveform.sourceRecordId,
    fileName: waveform.fileName,
    sourceType: 'unknown',
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    quantity: 'acceleration',
    unit: 'cm/s²',
    values: [],
    dt: waveform.dt,
    samplingHz: waveform.samplingHz,
    metadata: waveform.metadata,
  };
}

/**
 * Split derived waveforms by event, station, and sensor channel before plotting.
 * A manuscript figure must never compress unrelated events onto one time axis.
 */
export function buildWaveformRecordSets(waveforms: readonly DerivedWaveform[]): WaveformRecordSet[] {
  if (waveforms.length === 0) return [];
  const rows = computeStationDistanceRows(waveforms.map(asRecord));
  if (rows.length === 0) {
    return [{
      id: 'all',
      label: fallbackLabel(waveforms[0]),
      waveforms: [...waveforms].sort((left, right) => componentRank(left.component) - componentRank(right.component)),
    }];
  }

  return rows.flatMap((row) => {
    const ids = new Set(row.recordIds);
    const channels = new Map<string, DerivedWaveform[]>();
    waveforms.filter((waveform) => ids.has(waveform.sourceRecordId)).forEach((waveform) => {
      const suffix = componentSuffix(waveform);
      channels.set(suffix, [...(channels.get(suffix) ?? []), waveform]);
    });

    return [...channels.entries()].map(([suffix, channelWaveforms]) => ({
      id: `${row.id}|channel:${suffix || 'default'}`,
      label: suffix ? `${row.label} channel ${suffix}` : row.label,
      waveforms: channelWaveforms.sort((left, right) => (
        componentRank(left.component) - componentRank(right.component)
        || left.componentLabel.localeCompare(right.componentLabel)
      )),
    }));
  });
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, secondsText] = match;
  const seconds = Number(secondsText);
  if (!Number.isFinite(seconds)) return undefined;
  const wholeSeconds = Math.floor(seconds);
  const milliseconds = Math.round((seconds - wholeSeconds) * 1000);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), wholeSeconds, milliseconds);
}

/** Align component-relative time arrays when every record start is parseable. */
export function alignWaveformTimes(waveforms: readonly DerivedWaveform[]): WaveformTimeAlignment {
  const parsed = waveforms.map((waveform) => parseTimestamp(waveform.metadata.recordTime));
  const values = new Map<string, number[]>();
  if (parsed.length > 0 && parsed.every((value): value is number => value !== undefined)) {
    const earliest = Math.min(...parsed);
    waveforms.forEach((waveform, index) => {
      const offset = (parsed[index] - earliest) / 1000;
      values.set(waveform.sourceRecordId, waveform.time.map((time) => time + offset));
    });
    const referenceText = waveforms[parsed.indexOf(earliest)]?.metadata.recordTime;
    return {
      values,
      reference: parsed.some((value) => value !== earliest)
        ? `elapsed time from earliest record start (${referenceText})`
        : `time from record start (${referenceText})`,
    };
  }

  waveforms.forEach((waveform) => values.set(waveform.sourceRecordId, waveform.time));
  return { values, reference: 'time from each record start; absolute alignment unavailable' };
}
