import type { DerivedWaveform, Quantity } from '../types/waveform';

export type OrbitProjection = 'EW_NS' | 'EW_UD' | 'NS_UD';

export interface ParticleOrbitResult {
  id: string;
  label: string;
  quantity: Quantity;
  projection: OrbitProjection;
  xComponent: string;
  yComponent: string;
  unit: string;
  time: number[];
  x: number[];
  y: number[];
}

interface OrbitGroup {
  key: string;
  label: string;
  duplicateComponents: Set<'NS' | 'EW' | 'UD'>;
  ns?: DerivedWaveform;
  ew?: DerivedWaveform;
  ud?: DerivedWaveform;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function valuesForQuantity(waveform: DerivedWaveform, quantity: Quantity): number[] {
  if (quantity === 'acceleration') return waveform.acceleration;
  if (quantity === 'velocity') return waveform.velocity;
  return waveform.displacement;
}

export function unitForQuantity(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

export function quantityLabel(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'Acceleration';
  if (quantity === 'velocity') return 'Velocity';
  return 'Displacement';
}

export function projectionComponents(projection: OrbitProjection): { x: 'EW' | 'NS'; y: 'NS' | 'UD' } {
  if (projection === 'EW_NS') return { x: 'EW', y: 'NS' };
  if (projection === 'EW_UD') return { x: 'EW', y: 'UD' };
  return { x: 'NS', y: 'UD' };
}

export function projectionLabel(projection: OrbitProjection): string {
  const components = projectionComponents(projection);
  return `${components.x}-${components.y}`;
}

function stationIdentity(waveform: DerivedWaveform): { key: string; label: string } {
  const { stationCode, stationLat, stationLon } = waveform.metadata;
  if (stationCode) return { key: `station:${stationCode}`, label: stationCode };
  if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) {
    const lat = stationLat.toFixed(5);
    const lon = stationLon.toFixed(5);
    return { key: `coord:${lat}:${lon}`, label: `${lat}, ${lon}` };
  }
  return { key: 'dataset', label: 'Loaded waveform set' };
}

function componentSuffix(waveform: DerivedWaveform): string {
  const label = waveform.componentLabel.toUpperCase();
  const component = waveform.component;
  if (component !== 'NS' && component !== 'EW' && component !== 'UD') return '';
  const match = label.match(new RegExp(`^${component}(.*)$`));
  return match?.[1] ?? '';
}

function normalizedSourceName(fileName: string): string {
  return fileName.split('#')[0]
    .replace(/\.(NS|EW|UD)\d*$/i, '')
    .replace(/([._-])(NS|EW|UD)(?=\.[^.]+$)/i, '');
}

function eventIdentity(waveform: DerivedWaveform): { key: string; label?: string } {
  const originTime = waveform.metadata.originTime?.trim();
  if (originTime) return { key: `origin:${originTime}`, label: originTime };
  const recordTime = waveform.metadata.recordTime?.trim();
  if (recordTime) return { key: `record:${recordTime}`, label: recordTime };
  return { key: `source:${normalizedSourceName(waveform.fileName)}` };
}

function buildGroups(waveforms: readonly DerivedWaveform[]): OrbitGroup[] {
  const groups = new Map<string, OrbitGroup>();

  for (const waveform of waveforms) {
    if (waveform.component !== 'NS' && waveform.component !== 'EW' && waveform.component !== 'UD') continue;

    const station = stationIdentity(waveform);
    const event = eventIdentity(waveform);
    const suffix = componentSuffix(waveform);
    const key = `${station.key}|${event.key}|${suffix}`;
    const stationChannelLabel = suffix ? `${station.label} channel ${suffix}` : station.label;
    const label = event.label ? `${stationChannelLabel} (${event.label})` : stationChannelLabel;
    const group = groups.get(key) ?? { key, label, duplicateComponents: new Set<'NS' | 'EW' | 'UD'>() };

    if (waveform.component === 'NS') {
      if (group.ns) group.duplicateComponents.add('NS');
      else group.ns = waveform;
    }
    if (waveform.component === 'EW') {
      if (group.ew) group.duplicateComponents.add('EW');
      else group.ew = waveform;
    }
    if (waveform.component === 'UD') {
      if (group.ud) group.duplicateComponents.add('UD');
      else group.ud = waveform;
    }

    groups.set(key, group);
  }

  return Array.from(groups.values());
}

function waveformForComponent(group: OrbitGroup, component: 'EW' | 'NS' | 'UD'): DerivedWaveform | undefined {
  if (component === 'EW') return group.ew;
  if (component === 'NS') return group.ns;
  return group.ud;
}

function parseRecordTimeMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, secondText] = match;
  const second = Number(secondText);
  if (!Number.isFinite(second)) return undefined;
  const wholeSecond = Math.floor(second);
  const milliseconds = Math.round((second - wholeSecond) * 1000);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), wholeSecond, milliseconds);
}

function recordStartOffsets(left: DerivedWaveform, right: DerivedWaveform): [number, number] | undefined {
  const leftTime = left.metadata.recordTime?.trim();
  const rightTime = right.metadata.recordTime?.trim();
  if (!leftTime && !rightTime) return [0, 0];
  if (!leftTime || !rightTime) return undefined;

  const leftMs = parseRecordTimeMs(leftTime);
  const rightMs = parseRecordTimeMs(rightTime);
  if (leftMs !== undefined && rightMs !== undefined) {
    const earliestMs = Math.min(leftMs, rightMs);
    return [(leftMs - earliestMs) / 1000, (rightMs - earliestMs) / 1000];
  }

  return leftTime === rightTime ? [0, 0] : undefined;
}

function interpolateAt(times: readonly number[], values: readonly number[], targetTime: number): number | undefined {
  const n = Math.min(times.length, values.length);
  if (n === 0 || targetTime < times[0] || targetTime > times[n - 1]) return undefined;
  if (targetTime === times[0]) return values[0];
  if (targetTime === times[n - 1]) return values[n - 1];

  let left = 0;
  let right = n - 1;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (times[middle] <= targetTime) left = middle;
    else right = middle;
  }

  const span = times[right] - times[left];
  if (span <= 0) return undefined;
  const ratio = (targetTime - times[left]) / span;
  return values[left] * (1 - ratio) + values[right] * ratio;
}

export function computeParticleOrbits(
  waveforms: readonly DerivedWaveform[],
  projection: OrbitProjection,
  quantity: Quantity,
): ParticleOrbitResult[] {
  const results: ParticleOrbitResult[] = [];
  const unit = unitForQuantity(quantity);
  const components = projectionComponents(projection);

  for (const group of buildGroups(waveforms)) {
    if (group.duplicateComponents.has(components.x) || group.duplicateComponents.has(components.y)) continue;
    const xWaveform = waveformForComponent(group, components.x);
    const yWaveform = waveformForComponent(group, components.y);
    if (!xWaveform || !yWaveform) continue;
    if (!Number.isFinite(xWaveform.dt) || xWaveform.dt <= 0 || !Number.isFinite(yWaveform.dt) || yWaveform.dt <= 0) continue;
    const startOffsets = recordStartOffsets(xWaveform, yWaveform);
    if (!startOffsets) continue;

    const xValues = valuesForQuantity(xWaveform, quantity);
    const yValues = valuesForQuantity(yWaveform, quantity);
    const xLength = Math.min(xValues.length, xWaveform.time.length);
    const yLength = Math.min(yValues.length, yWaveform.time.length);
    if (xLength === 0 || yLength === 0) continue;
    const alignedXValues = xValues.slice(0, xLength);
    const alignedYValues = yValues.slice(0, yLength);
    const xTimes = xWaveform.time.slice(0, xLength).map((time) => time + startOffsets[0]);
    const yTimes = yWaveform.time.slice(0, yLength).map((time) => time + startOffsets[1]);

    const targetDt = Math.min(xWaveform.dt, yWaveform.dt);
    const commonStart = Math.max(xTimes[0], yTimes[0]);
    const commonEnd = Math.min(xTimes[xTimes.length - 1], yTimes[yTimes.length - 1]);
    if (!Number.isFinite(commonStart) || !Number.isFinite(commonEnd) || commonEnd < commonStart) continue;
    const commonSampleSpan = commonEnd - commonStart;
    const n = Math.max(0, Math.floor(commonSampleSpan / targetDt + 1e-9) + 1);
    const time: number[] = [];
    const x: number[] = [];
    const y: number[] = [];

    for (let i = 0; i < n; i += 1) {
      const sampleTime = commonStart + i * targetDt;
      const xv = interpolateAt(xTimes, alignedXValues, sampleTime);
      const yv = interpolateAt(yTimes, alignedYValues, sampleTime);
      if (xv === undefined || yv === undefined || !Number.isFinite(xv) || !Number.isFinite(yv)) continue;
      time.push(sampleTime);
      x.push(xv);
      y.push(yv);
    }

    if (x.length === 0) continue;

    results.push({
      id: `${group.key}:${projection}:${quantity}`,
      label: group.label,
      quantity,
      projection,
      xComponent: xWaveform.componentLabel,
      yComponent: yWaveform.componentLabel,
      unit,
      time,
      x,
      y,
    });
  }

  return results;
}
