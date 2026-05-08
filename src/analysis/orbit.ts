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

function buildGroups(waveforms: readonly DerivedWaveform[]): OrbitGroup[] {
  const groups = new Map<string, OrbitGroup>();

  for (const waveform of waveforms) {
    if (waveform.component !== 'NS' && waveform.component !== 'EW' && waveform.component !== 'UD') continue;

    const station = stationIdentity(waveform);
    const suffix = componentSuffix(waveform);
    const key = `${station.key}|${suffix}`;
    const label = suffix ? `${station.label} channel ${suffix}` : station.label;
    const group = groups.get(key) ?? { key, label };

    if (waveform.component === 'NS' && !group.ns) group.ns = waveform;
    if (waveform.component === 'EW' && !group.ew) group.ew = waveform;
    if (waveform.component === 'UD' && !group.ud) group.ud = waveform;

    groups.set(key, group);
  }

  return Array.from(groups.values());
}

function waveformForComponent(group: OrbitGroup, component: 'EW' | 'NS' | 'UD'): DerivedWaveform | undefined {
  if (component === 'EW') return group.ew;
  if (component === 'NS') return group.ns;
  return group.ud;
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
    const xWaveform = waveformForComponent(group, components.x);
    const yWaveform = waveformForComponent(group, components.y);
    if (!xWaveform || !yWaveform) continue;

    const xValues = valuesForQuantity(xWaveform, quantity);
    const yValues = valuesForQuantity(yWaveform, quantity);
    const n = Math.min(xValues.length, yValues.length, xWaveform.time.length, yWaveform.time.length);
    const time: number[] = [];
    const x: number[] = [];
    const y: number[] = [];

    for (let i = 0; i < n; i += 1) {
      const xv = xValues[i];
      const yv = yValues[i];
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
      time.push(Math.min(xWaveform.time[i], yWaveform.time[i]));
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
