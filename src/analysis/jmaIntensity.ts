import type { DerivedWaveform, JmaIntensityResult } from '../types/waveform';
import { referenceFftLength } from './calculus';
import { fftComplex } from './fft';
import { subtractMean } from './statistics';

const JMA_DURATION_SEC = 0.3;
// Some archived JMA files are only a few samples short of their final 60-second interval.
const MIN_JMA_WINDOW_COMPLETENESS = 0.99;

function classLabelFromIntensity(intensity: number): string {
  if (!Number.isFinite(intensity) || intensity < 0.5) return '0';
  if (intensity < 1.5) return '1';
  if (intensity < 2.5) return '2';
  if (intensity < 3.5) return '3';
  if (intensity < 4.5) return '4';
  if (intensity < 5.0) return '5 Lower';
  if (intensity < 5.5) return '5 Upper';
  if (intensity < 6.0) return '6 Lower';
  if (intensity < 6.5) return '6 Upper';
  return '7';
}

function officialJmaInstrumentalIntensity(rawIntensity: number): number {
  if (!Number.isFinite(rawIntensity)) return Number.NaN;
  const roundedToSecondDecimal = Math.round(rawIntensity * 100) / 100;
  return Math.floor(roundedToSecondDecimal * 10) / 10;
}

export function jmaFilterGain(frequencyHz: number): number {
  if (frequencyHz <= 0) return 0;

  const f = frequencyHz;
  const x = f / 10;
  const periodEffect = 1 / Math.sqrt(f);
  const highCut = 1 / Math.sqrt(
    1
    + 0.694 * x ** 2
    + 0.241 * x ** 4
    + 0.0557 * x ** 6
    + 0.009664 * x ** 8
    + 0.00134 * x ** 10
    + 0.000155 * x ** 12,
  );
  const lowCut = Math.sqrt(Math.max(0, 1 - Math.exp(-((f / 0.5) ** 3))));

  return periodEffect * highCut * lowCut;
}

export function applyJmaFrequencyFilter(values: readonly number[], dt: number): number[] {
  if (values.length === 0 || dt <= 0) return [];

  const nFft = referenceFftLength(values.length);
  const centered = subtractMean(values);
  const re = Array(nFft).fill(0);

  for (let i = 0; i < centered.length; i += 1) re[i] = centered[i];

  const spectrum = fftComplex(re);
  const outRe = Array(nFft).fill(0);
  const outIm = Array(nFft).fill(0);
  const df = 1 / (nFft * dt);

  for (let k = 0; k < nFft; k += 1) {
    const signedFrequency = k <= nFft / 2 ? k * df : (k - nFft) * df;
    const gain = jmaFilterGain(Math.abs(signedFrequency));
    outRe[k] = spectrum.re[k] * gain;
    outIm[k] = spectrum.im[k] * gain;
  }

  const filtered = fftComplex(outRe, outIm, true);
  return filtered.re.slice(0, values.length);
}

function interpolateAt(values: readonly number[], sourceDt: number, targetTime: number): number {
  const x = targetTime / sourceDt;
  const i = Math.floor(x);
  const r = x - i;

  if (i < 0) return values[0] ?? 0;
  if (i >= values.length - 1) return values[values.length - 1] ?? 0;
  return values[i] * (1 - r) + values[i + 1] * r;
}

function resampleToDt(values: readonly number[], sourceDt: number, targetDt: number, targetLength: number): number[] {
  return Array.from({ length: targetLength }, (_, i) => interpolateAt(values, sourceDt, i * targetDt));
}

export interface JmaThresholdSelection {
  threshold: number;
  requiredSamples: number;
  selectedSamples: number;
  durationSec: number;
}

type JmaComponent = 'NS' | 'EW' | 'UD';

interface JmaComponentGroup {
  key: string;
  NS: DerivedWaveform[];
  EW: DerivedWaveform[];
  UD: DerivedWaveform[];
}

function unavailableJmaIntensity(message: string): JmaIntensityResult {
  return {
    available: false,
    intensity: Number.NaN,
    classLabel: '-',
    thresholdAcceleration: Number.NaN,
    durationAboveThreshold: 0,
    usedSamples: 0,
    message,
  };
}

function stationGroupKey(waveform: DerivedWaveform): string {
  const stationCode = waveform.metadata.stationCode?.trim();
  if (stationCode) return `station:${stationCode}`;

  const { stationLat, stationLon } = waveform.metadata;
  if (Number.isFinite(stationLat) && Number.isFinite(stationLon)) {
    return `coord:${stationLat!.toFixed(5)}:${stationLon!.toFixed(5)}`;
  }

  return 'station:unidentified';
}

function normalizedSourceName(fileName: string): string {
  const sourceName = fileName.split('#')[0];
  return sourceName
    .replace(/\.(NS|EW|UD)\d*$/i, '')
    .replace(/([._-])(NS|EW|UD)(?=\.[^.]+$)/i, '');
}

function eventGroupKey(waveform: DerivedWaveform): string {
  const hasStationIdentity = Boolean(waveform.metadata.stationCode?.trim())
    || (Number.isFinite(waveform.metadata.stationLat) && Number.isFinite(waveform.metadata.stationLon));
  const recordTime = waveform.metadata.recordTime?.trim();
  if (hasStationIdentity && recordTime) return `record:${recordTime}`;
  return `source:${normalizedSourceName(waveform.fileName)}`;
}

function componentSuffix(waveform: DerivedWaveform): string {
  const component = waveform.component as JmaComponent;
  const match = waveform.componentLabel.toUpperCase().match(new RegExp(`^${component}(.*)$`));
  return match?.[1] ?? '';
}

function selectJmaComponents(waveforms: readonly DerivedWaveform[]): {
  components?: [DerivedWaveform, DerivedWaveform, DerivedWaveform];
  error?: string;
} {
  const groups = new Map<string, JmaComponentGroup>();

  for (const waveform of waveforms) {
    if (waveform.component !== 'NS' && waveform.component !== 'EW' && waveform.component !== 'UD') continue;
    const key = `${stationGroupKey(waveform)}|${eventGroupKey(waveform)}|${componentSuffix(waveform)}`;
    const group = groups.get(key) ?? { key, NS: [], EW: [], UD: [] };
    group[waveform.component].push(waveform);
    groups.set(key, group);
  }

  if (groups.size > 1) {
    return { error: 'Multiple station, channel, event, or start time groups are loaded. Select one complete NS/EW/UD set.' };
  }

  const completeGroups = Array.from(groups.values()).filter((group) => (
    group.NS.length > 0 && group.EW.length > 0 && group.UD.length > 0
  ));

  if (completeGroups.length === 0) {
    return { error: 'JMA intensity requires a complete NS/EW/UD set from the same station and channel.' };
  }
  if (completeGroups.length > 1) {
    return { error: 'Multiple complete NS/EW/UD groups are loaded. Select a single station and channel for JMA intensity.' };
  }

  const group = completeGroups[0];
  if (group.NS.length !== 1 || group.EW.length !== 1 || group.UD.length !== 1) {
    return { error: 'Multiple records exist for the same station, channel, and component. Select one event before calculating JMA intensity.' };
  }

  const components: [DerivedWaveform, DerivedWaveform, DerivedWaveform] = [group.NS[0], group.EW[0], group.UD[0]];
  const recordTimes = components.map((waveform) => waveform.metadata.recordTime?.trim()).filter((value): value is string => Boolean(value));
  if (recordTimes.length !== 0 && recordTimes.length !== components.length) {
    return { error: 'JMA component start time metadata is incomplete; the three records cannot be aligned safely.' };
  }
  if (new Set(recordTimes).size > 1) {
    return { error: 'JMA component start times do not match.' };
  }

  return { components };
}

export function selectJmaThreshold(values: readonly number[], dt: number): JmaThresholdSelection {
  if (values.length === 0 || dt <= 0) {
    return { threshold: 0, requiredSamples: 0, selectedSamples: 0, durationSec: 0 };
  }

  const requiredSamples = Math.max(1, Math.ceil(JMA_DURATION_SEC / dt - 1e-12));
  const sorted = [...values].sort((a, b) => b - a);
  const index = Math.min(requiredSamples - 1, sorted.length - 1);
  const threshold = sorted[index] ?? 0;
  const selectedSamples = values.filter((value) => value >= threshold).length;

  return {
    threshold,
    requiredSamples,
    selectedSamples,
    durationSec: selectedSamples * dt,
  };
}

function computeAlignedJmaWindow(
  nsAcceleration: readonly number[],
  ewAcceleration: readonly number[],
  udAcceleration: readonly number[],
  dt: number,
): JmaIntensityResult {
  const n = Math.min(nsAcceleration.length, ewAcceleration.length, udAcceleration.length);
  const fNs = applyJmaFrequencyFilter(nsAcceleration.slice(0, n), dt);
  const fEw = applyJmaFrequencyFilter(ewAcceleration.slice(0, n), dt);
  const fUd = applyJmaFrequencyFilter(udAcceleration.slice(0, n), dt);

  const vectorAcceleration = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    vectorAcceleration[i] = Math.hypot(fNs[i], fEw[i], fUd[i]);
  }

  const thresholdSelection = selectJmaThreshold(vectorAcceleration, dt);
  const threshold = thresholdSelection.threshold;

  if (threshold <= 0) {
    return {
      available: true,
      intensity: 0,
      classLabel: '0',
      thresholdAcceleration: 0,
      durationAboveThreshold: thresholdSelection.durationSec,
      usedSamples: thresholdSelection.selectedSamples,
    };
  }

  const rawIntensity = 2 * Math.log10(threshold) + 0.94;
  const intensity = officialJmaInstrumentalIntensity(rawIntensity);
  return {
    available: true,
    intensity,
    classLabel: classLabelFromIntensity(intensity),
    thresholdAcceleration: threshold,
    durationAboveThreshold: thresholdSelection.durationSec,
    usedSamples: thresholdSelection.selectedSamples,
  };
}

export function computeJmaIntensity(waveforms: DerivedWaveform[]): JmaIntensityResult {
  const selection = selectJmaComponents(waveforms);
  if (!selection.components) return unavailableJmaIntensity(selection.error ?? 'JMA intensity is unavailable.');
  const [ns, ew, ud] = selection.components;

  if (
    !Number.isFinite(ns.dt) || ns.dt <= 0 || ns.acceleration.length === 0
    || !Number.isFinite(ew.dt) || ew.dt <= 0 || ew.acceleration.length === 0
    || !Number.isFinite(ud.dt) || ud.dt <= 0 || ud.acceleration.length === 0
  ) {
    return unavailableJmaIntensity('JMA intensity requires non-empty component records with valid sampling intervals.');
  }

  const targetDt = Math.min(ns.dt, ew.dt, ud.dt);
  const commonSampleSpan = Math.min(
    (ns.acceleration.length - 1) * ns.dt,
    (ew.acceleration.length - 1) * ew.dt,
    (ud.acceleration.length - 1) * ud.dt,
  );
  const n = Math.max(0, Math.floor(commonSampleSpan / targetDt + 1e-9) + 1);
  const requiredSamples = Math.max(1, Math.ceil(JMA_DURATION_SEC / targetDt - 1e-12));

  if (n < requiredSamples) {
    return unavailableJmaIntensity('The common component record span is too short for JMA intensity calculation.');
  }

  const nsAcc = resampleToDt(ns.acceleration, ns.dt, targetDt, n);
  const ewAcc = resampleToDt(ew.acceleration, ew.dt, targetDt, n);
  const udAcc = resampleToDt(ud.acceleration, ud.dt, targetDt, n);
  const windowSettings = [ns, ew, ud].map((waveform) => waveform.metadata.jmaIntensityWindowSec);
  const definedWindowSettings = windowSettings.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
  ));
  if (definedWindowSettings.length !== 0 && definedWindowSettings.length !== windowSettings.length) {
    return unavailableJmaIntensity('JMA interval metadata is incomplete across the three components.');
  }
  if (new Set(definedWindowSettings).size > 1) {
    return unavailableJmaIntensity('JMA interval metadata does not match across the three components.');
  }

  const windowSec = definedWindowSettings[0];
  if (windowSec === undefined) return computeAlignedJmaWindow(nsAcc, ewAcc, udAcc, targetDt);

  const windowSamples = Math.max(requiredSamples, Math.round(windowSec / targetDt));
  let bestResult: JmaIntensityResult | undefined;
  for (let start = 0; start < n; start += windowSamples) {
    const end = Math.min(n, start + windowSamples);
    if (end - start < Math.ceil(windowSamples * MIN_JMA_WINDOW_COMPLETENESS)) continue;
    const result = computeAlignedJmaWindow(
      nsAcc.slice(start, end),
      ewAcc.slice(start, end),
      udAcc.slice(start, end),
      targetDt,
    );
    if (!bestResult || result.thresholdAcceleration > bestResult.thresholdAcceleration) bestResult = result;
  }

  return bestResult ?? unavailableJmaIntensity('No sufficiently complete JMA interval was available in the common component span.');
}
