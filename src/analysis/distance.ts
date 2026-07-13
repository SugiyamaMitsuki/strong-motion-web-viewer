import type { WaveformMetadata, WaveformRecord } from '../types/waveform';

export interface SourceLocation {
  eventLat?: number;
  eventLon?: number;
  depthKm?: number;
}

export interface StationDistanceRow {
  id: string;
  label: string;
  stationLabel: string;
  eventId: string;
  eventLabel: string;
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

interface Identity {
  key: string;
  label: string;
}

interface DistanceGroup {
  id: string;
  station: Identity;
  event: Identity;
  records: WaveformRecord[];
}

const EARTH_RADIUS_KM = 6371.0088;
const METADATA_TOLERANCE = 1e-9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function consistentNumber(records: readonly WaveformRecord[], key: keyof WaveformMetadata): number | undefined {
  let selected: number | undefined;
  for (const record of records) {
    const value = record.metadata[key];
    if (!isFiniteNumber(value)) continue;
    if (selected === undefined) {
      selected = value;
      continue;
    }
    const scale = Math.max(1, Math.abs(selected), Math.abs(value));
    if (Math.abs(value - selected) > METADATA_TOLERANCE * scale) return undefined;
  }
  return selected;
}

function stationIdentity(record: WaveformRecord): Identity {
  const { stationCode, stationLat, stationLon } = record.metadata;
  if (stationCode?.trim()) return { key: `station:${stationCode.trim()}`, label: stationCode.trim() };
  if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) {
    const label = `${stationLat.toFixed(5)}, ${stationLon.toFixed(5)}`;
    return { key: `coord:${stationLat.toFixed(5)}:${stationLon.toFixed(5)}`, label };
  }
  return { key: 'station:loaded-waveform-set', label: 'Loaded waveform set' };
}

function normalizedSourceName(fileName: string): string {
  return fileName.split('#')[0]
    .replace(/\.(NS|EW|UD)\d*$/i, '')
    .replace(/([._-])(NS|EW|UD)(?=\.[^.]+$)/i, '');
}

function eventIdentity(record: WaveformRecord): Identity {
  const { originTime, recordTime, eventLat, eventLon, depthKm } = record.metadata;
  if (originTime?.trim()) {
    const value = originTime.trim();
    return { key: `origin:${value}`, label: value };
  }
  if (recordTime?.trim()) {
    const value = recordTime.trim();
    return { key: `record:${value}`, label: value };
  }
  if (isFiniteNumber(eventLat) && isFiniteNumber(eventLon)) {
    const depth = isFiniteNumber(depthKm) ? depthKm.toFixed(3) : '-';
    return {
      key: `source:${eventLat.toFixed(5)}:${eventLon.toFixed(5)}:${depth}`,
      label: `${eventLat.toFixed(5)}, ${eventLon.toFixed(5)}${isFiniteNumber(depthKm) ? `, ${depthKm.toFixed(1)} km` : ''}`,
    };
  }
  const sourceName = normalizedSourceName(record.fileName) || record.fileName || 'loaded-waveform-set';
  return { key: `file:${sourceName}`, label: sourceName };
}

function buildDistanceGroups(records: readonly WaveformRecord[]): DistanceGroup[] {
  const groups = new Map<string, DistanceGroup>();
  for (const record of records) {
    const station = stationIdentity(record);
    const event = eventIdentity(record);
    const id = `${event.key}|${station.key}`;
    const group = groups.get(id) ?? { id, station, event, records: [] };
    group.records.push(record);
    groups.set(id, group);
  }
  return Array.from(groups.values());
}

export function sourceLocationFromRecords(records: readonly WaveformRecord[]): SourceLocation {
  return {
    eventLat: consistentNumber(records, 'eventLat'),
    eventLon: consistentNumber(records, 'eventLon'),
    depthKm: consistentNumber(records, 'depthKm'),
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
  const groups = buildDistanceGroups(records);
  const stationOccurrences = new Map<string, number>();
  groups.forEach((group) => {
    stationOccurrences.set(group.station.key, (stationOccurrences.get(group.station.key) ?? 0) + 1);
  });

  return groups.map((group) => {
    const stationLat = consistentNumber(group.records, 'stationLat');
    const stationLon = consistentNumber(group.records, 'stationLon');
    const eventLat = consistentNumber(group.records, 'eventLat');
    const eventLon = consistentNumber(group.records, 'eventLon');
    const depthKm = consistentNumber(group.records, 'depthKm');
    const label = (stationOccurrences.get(group.station.key) ?? 0) > 1
      ? `${group.station.label} · ${group.event.label}`
      : group.station.label;
    const base: StationDistanceRow = {
      id: group.id,
      label,
      stationLabel: group.station.label,
      eventId: group.event.key,
      eventLabel: group.event.label,
      recordIds: group.records.map((record) => record.id),
      components: [...new Set(group.records.map((record) => record.componentLabel))],
      stationLat,
      stationLon,
      eventLat,
      eventLon,
      depthKm,
    };

    if (
      isFiniteNumber(eventLat)
      && isFiniteNumber(eventLon)
      && isFiniteNumber(stationLat)
      && isFiniteNumber(stationLon)
    ) {
      const epicentralDistance = epicentralDistanceKm(eventLat, eventLon, stationLat, stationLon);
      return {
        ...base,
        epicentralDistanceKm: epicentralDistance,
        hypocentralDistanceKm: isFiniteNumber(depthKm)
          ? hypocentralDistanceKm(epicentralDistance, depthKm)
          : undefined,
      };
    }

    return base;
  });
}
