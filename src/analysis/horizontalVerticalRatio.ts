import type { DerivedWaveform, FourierSpectrum, HorizontalVerticalRatioResult, Quantity } from '../types/waveform';
import { computeFourierSpectrum } from './fourier';

interface HvsrGroup {
  key: string;
  label: string;
  ns?: DerivedWaveform;
  ew?: DerivedWaveform;
  ud?: DerivedWaveform;
}

export interface HorizontalVerticalRatioOptions {
  minFrequency: number;
  maxFrequency: number;
  frequencyCount: number;
  smoothingBandwidth: number;
  horizontalMerge: 'geometric' | 'rms';
}

export const defaultHorizontalVerticalRatioOptions: HorizontalVerticalRatioOptions = {
  minFrequency: 0.05,
  maxFrequency: 50,
  frequencyCount: 240,
  smoothingBandwidth: 40,
  horizontalMerge: 'geometric',
};

const HvsrFourierOptions = {
  applyFrequencyTaper: false,
  applyTimeTaper: true,
  timeTaperFraction: 0.05,
};

const hvsrSpectrumCache = new WeakMap<DerivedWaveform, Map<Quantity, FourierSpectrum>>();

interface PreparedSpectrum {
  frequency: number[];
  amplitude: number[];
  logFrequency: number[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function valuesForQuantity(waveform: DerivedWaveform, quantity: Quantity): number[] {
  if (quantity === 'acceleration') return waveform.acceleration;
  if (quantity === 'velocity') return waveform.velocity;
  return waveform.displacement;
}

function unitForQuantity(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function getCachedSpectrum(waveform: DerivedWaveform, quantity: Quantity): FourierSpectrum {
  const cachedByQuantity = hvsrSpectrumCache.get(waveform);
  const cached = cachedByQuantity?.get(quantity);
  if (cached) return cached;

  const spectrum = computeFourierSpectrum(
    valuesForQuantity(waveform, quantity),
    waveform.dt,
    unitForQuantity(quantity),
    HvsrFourierOptions,
  );
  const nextCache = cachedByQuantity ?? new Map<Quantity, FourierSpectrum>();
  nextCache.set(quantity, spectrum);
  if (!cachedByQuantity) hvsrSpectrumCache.set(waveform, nextCache);
  return spectrum;
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

function buildGroups(waveforms: readonly DerivedWaveform[]): HvsrGroup[] {
  const groups = new Map<string, HvsrGroup>();

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

function interpolate(x: readonly number[], y: readonly number[], target: number): number | undefined {
  const n = Math.min(x.length, y.length);
  if (n === 0 || target < x[0] || target > x[n - 1]) return undefined;

  let left = 0;
  let right = n - 1;

  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (x[middle] <= target) left = middle;
    else right = middle;
  }

  if (x[left] === target) return y[left];
  if (x[right] === target) return y[right];

  const span = x[right] - x[left];
  if (span <= 0) return undefined;

  const t = (target - x[left]) / span;
  return y[left] + (y[right] - y[left]) * t;
}

function lowerBound(values: readonly number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound(values: readonly number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function logSpace(min: number, max: number, count: number): number[] {
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || min <= 0 || max <= min) return [];
  const n = Math.max(2, Math.floor(count));
  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  return Array.from({ length: n }, (_, index) => 10 ** (logMin + (logMax - logMin) * index / (n - 1)));
}

function prepareSpectrum(
  frequency: readonly number[],
  amplitude: readonly number[],
  minFrequency: number,
  maxFrequency: number,
  smoothingBandwidth: number,
): PreparedSpectrum {
  const n = Math.min(frequency.length, amplitude.length);
  const margin = smoothingBandwidth > 0 ? 10 ** (12 / smoothingBandwidth) : 1;
  const lowerFrequency = minFrequency / margin;
  const upperFrequency = maxFrequency * margin;
  const prepared: PreparedSpectrum = { frequency: [], amplitude: [], logFrequency: [] };

  const start = Math.min(lowerBound(frequency, lowerFrequency), n);
  const end = Math.min(upperBound(frequency, upperFrequency), n);

  for (let i = start; i < end; i += 1) {
    const f = frequency[i];
    const value = amplitude[i];
    if (!isFiniteNumber(f) || !isFiniteNumber(value) || f <= 0 || value < 0) continue;
    if (f < lowerFrequency || f > upperFrequency) continue;
    prepared.frequency.push(f);
    prepared.amplitude.push(value);
    prepared.logFrequency.push(Math.log10(f));
  }

  return prepared;
}

function spectrumAmplitudeAt(spectrum: PreparedSpectrum, targetFrequency: number, smoothingBandwidth: number): number | undefined {
  if (spectrum.frequency.length === 0 || targetFrequency <= 0) return undefined;
  if (smoothingBandwidth <= 0) return interpolate(spectrum.frequency, spectrum.amplitude, targetFrequency);

  const center = Math.log10(targetFrequency);
  const cutoff = 12 / smoothingBandwidth;
  const left = lowerBound(spectrum.logFrequency, center - cutoff);
  const right = upperBound(spectrum.logFrequency, center + cutoff);
  if (left >= right) return undefined;

  let weightedSum = 0;
  let weightTotal = 0;
  for (let j = left; j < right; j += 1) {
    const argument = smoothingBandwidth * (spectrum.logFrequency[j] - center);
    const weight = Math.abs(argument) < 1e-12 ? 1 : (Math.sin(argument) / argument) ** 4;
    weightedSum += spectrum.amplitude[j] * weight;
    weightTotal += weight;
  }

  if (weightTotal <= 0) return undefined;
  return weightedSum / weightTotal;
}

function commonFrequencyDomain(spectra: readonly PreparedSpectrum[], options: HorizontalVerticalRatioOptions): [number, number] | undefined {
  let minFrequency = options.minFrequency;
  let maxFrequency = options.maxFrequency;

  for (const spectrum of spectra) {
    if (spectrum.frequency.length === 0) return undefined;
    minFrequency = Math.max(minFrequency, spectrum.frequency[0]);
    maxFrequency = Math.min(maxFrequency, spectrum.frequency[spectrum.frequency.length - 1]);
  }

  return minFrequency < maxFrequency ? [minFrequency, maxFrequency] : undefined;
}

function mergeHorizontalAmplitudes(amplitudes: readonly number[], method: HorizontalVerticalRatioOptions['horizontalMerge']): number {
  if (amplitudes.length === 1) return amplitudes[0];
  if (method === 'rms') {
    return Math.sqrt(amplitudes.reduce((sum, amplitude) => sum + amplitude ** 2, 0) / amplitudes.length);
  }

  return Math.exp(amplitudes.reduce((sum, amplitude) => sum + Math.log(amplitude), 0) / amplitudes.length);
}

export function computeHorizontalVerticalRatios(
  waveforms: readonly DerivedWaveform[],
  quantity: Quantity,
  options: Partial<HorizontalVerticalRatioOptions> = {},
): HorizontalVerticalRatioResult[] {
  const settings: HorizontalVerticalRatioOptions = {
    ...defaultHorizontalVerticalRatioOptions,
    ...options,
  };
  const results: HorizontalVerticalRatioResult[] = [];
  const groups = buildGroups(waveforms);

  for (const group of groups) {
    const horizontalWaveforms = [group.ns, group.ew].filter((waveform): waveform is DerivedWaveform => waveform !== undefined);
    if (!group.ud || horizontalWaveforms.length === 0) continue;

    const verticalSpectrum = getCachedSpectrum(group.ud, quantity);
    const horizontalSpectra = horizontalWaveforms.map((waveform) => getCachedSpectrum(waveform, quantity));
    const preparedVertical = prepareSpectrum(
      verticalSpectrum.frequency,
      verticalSpectrum.amplitude,
      settings.minFrequency,
      settings.maxFrequency,
      settings.smoothingBandwidth,
    );
    const preparedHorizontalSpectra = horizontalSpectra.map((spectrum) => prepareSpectrum(
      spectrum.frequency,
      spectrum.amplitude,
      settings.minFrequency,
      settings.maxFrequency,
      settings.smoothingBandwidth,
    ));
    const frequencyDomain = commonFrequencyDomain([preparedVertical, ...preparedHorizontalSpectra], settings);
    if (!frequencyDomain) continue;

    const frequency: number[] = [];
    const ratio: number[] = [];

    for (const f of logSpace(frequencyDomain[0], frequencyDomain[1], settings.frequencyCount)) {
      const vAmplitude = spectrumAmplitudeAt(preparedVertical, f, settings.smoothingBandwidth);
      if (!isFiniteNumber(vAmplitude) || vAmplitude <= 0) continue;

      const horizontalAmplitudes = preparedHorizontalSpectra
        .map((spectrum) => spectrumAmplitudeAt(spectrum, f, settings.smoothingBandwidth))
        .filter((value): value is number => isFiniteNumber(value) && value > 0);

      if (horizontalAmplitudes.length === 0) continue;

      const horizontalAmplitude = mergeHorizontalAmplitudes(horizontalAmplitudes, settings.horizontalMerge);
      const hv = horizontalAmplitude / vAmplitude;

      if (isFiniteNumber(hv) && hv > 0) {
        frequency.push(f);
        ratio.push(hv);
      }
    }

    let peakIndex = -1;
    for (let i = 0; i < ratio.length; i += 1) {
      if (peakIndex < 0 || ratio[i] > ratio[peakIndex]) peakIndex = i;
    }

    const peakFrequency = peakIndex >= 0 ? frequency[peakIndex] : undefined;

    results.push({
      id: group.key,
      label: group.label,
      quantity,
      frequency,
      ratio,
      horizontalComponents: horizontalWaveforms.map((waveform) => waveform.componentLabel),
      verticalComponent: group.ud.componentLabel,
      peakFrequency,
      peakPeriod: peakFrequency ? 1 / peakFrequency : undefined,
      peakRatio: peakIndex >= 0 ? ratio[peakIndex] : undefined,
    });
  }

  return results;
}
