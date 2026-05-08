import type { WaveformMetadata, WaveformRecord } from '../types/waveform';

export interface SourceLocation {
  eventLat?: number;
  eventLon?: number;
  depthKm?: number;
}

export interface StationDistanceRow {
  id: string;
  label: string;
  recordIds: string[];
  components: string[];
  stationLat?: number;
  stationLon?: number;
  eventLat?: number;
  eventLon?: number;
  depthKm?: number;
  epicentralDistanceKm?: number;
  hypocentralDistanceKm?: number;
}

const EARTH_RADIUS_KM = 6371.0088;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function firstNumber(records: readonly WaveformRecord[], key: keyof WaveformMetadata): number | undefined {
  for (const record of records) {
    const value = record.metadata[key];
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

function stationGroupKey(record: WaveformRecord): string {
  const { stationCode, stationLat, stationLon } = record.metadata;
  if (stationCode) return `station:${stationCode}`;
  if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) {
    return `coord:${stationLat.toFixed(5)}:${stationLon.toFixed(5)}`;
  }
  return 'station:loaded-waveform-set';
}

function stationLabel(record: WaveformRecord): string {
  const { stationCode, stationLat, stationLon } = record.metadata;
  if (stationCode) return stationCode;
  if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) {
    return `${stationLat.toFixed(5)}, ${stationLon.toFixed(5)}`;
  }
  return 'Loaded waveform set';
}

export function sourceLocationFromRecords(records: readonly WaveformRecord[]): SourceLocation {
  return {
    eventLat: firstNumber(records, 'eventLat'),
    eventLon: firstNumber(records, 'eventLon'),
    depthKm: firstNumber(records, 'depthKm'),
  };
}

export function epicentralDistanceKm(
  eventLat: number,
  eventLon: number,
  stationLat: number,
  stationLon: number,
): number {
  const lat1 = toRadians(eventLat);
  const lat2 = toRadians(stationLat);
  const deltaLat = toRadians(stationLat - eventLat);
  const deltaLon = toRadians(stationLon - eventLon);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function hypocentralDistanceKm(epicentralDistance: number, depthKm: number): number {
  return Math.sqrt(epicentralDistance ** 2 + depthKm ** 2);
}

export function computeStationDistanceRows(records: readonly WaveformRecord[]): StationDistanceRow[] {
  const source = sourceLocationFromRecords(records);
  const rows = new Map<string, StationDistanceRow>();

  for (const record of records) {
    const key = stationGroupKey(record);
    const existing = rows.get(key);

    if (existing) {
      existing.recordIds.push(record.id);
      if (!existing.components.includes(record.componentLabel)) existing.components.push(record.componentLabel);
      if (!isFiniteNumber(existing.stationLat) && isFiniteNumber(record.metadata.stationLat)) existing.stationLat = record.metadata.stationLat;
      if (!isFiniteNumber(existing.stationLon) && isFiniteNumber(record.metadata.stationLon)) existing.stationLon = record.metadata.stationLon;
    } else {
      rows.set(key, {
        id: key,
        label: stationLabel(record),
        recordIds: [record.id],
        components: [record.componentLabel],
        stationLat: isFiniteNumber(record.metadata.stationLat) ? record.metadata.stationLat : undefined,
        stationLon: isFiniteNumber(record.metadata.stationLon) ? record.metadata.stationLon : undefined,
        eventLat: source.eventLat,
        eventLon: source.eventLon,
        depthKm: source.depthKm,
      });
    }
  }

  return Array.from(rows.values()).map((row) => {
    if (
      isFiniteNumber(row.eventLat)
      && isFiniteNumber(row.eventLon)
      && isFiniteNumber(row.stationLat)
      && isFiniteNumber(row.stationLon)
    ) {
      const epicentralDistance = epicentralDistanceKm(row.eventLat, row.eventLon, row.stationLat, row.stationLon);
      return {
        ...row,
        epicentralDistanceKm: epicentralDistance,
        hypocentralDistanceKm: isFiniteNumber(row.depthKm)
          ? hypocentralDistanceKm(epicentralDistance, row.depthKm)
          : undefined,
      };
    }

    return row;
  });
}
