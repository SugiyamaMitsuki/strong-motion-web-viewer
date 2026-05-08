import type { DerivedWaveform, JmaIntensityResult } from '../types/waveform';
import { referenceFftLength } from './calculus';
import { fftComplex } from './fft';
import { subtractMean } from './statistics';

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

function jmaFilterGain(frequencyHz: number): number {
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

function applyJmaFrequencyFilter(values: readonly number[], dt: number): number[] {
  const nFft = referenceFftLength(values.length);
  const centered = subtractMean(values);
  const re = Array(nFft).fill(0);

  for (let i = 0; i < centered.length; i += 1) re[i] = centered[i];

  const spectrum = fftComplex(re);
  const outRe = Array(nFft).fill(0);
  const nyquistIndex = Math.floor(nFft / 2);

  for (let k = 0; k <= nyquistIndex; k += 1) {
    const frequency = k / (nFft * dt);
    outRe[k] = spectrum.re[k] * jmaFilterGain(frequency);
  }

  const filtered = fftComplex(outRe, undefined, true);
  return filtered.re.map((value) => value * 4);
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

export function computeJmaIntensity(waveforms: DerivedWaveform[]): JmaIntensityResult {
  const ns = waveforms.find((w) => w.component === 'NS');
  const ew = waveforms.find((w) => w.component === 'EW');
  const ud = waveforms.find((w) => w.component === 'UD');

  if (!ns || !ew || !ud) {
    return {
      available: false,
      intensity: Number.NaN,
      classLabel: '-',
      thresholdAcceleration: Number.NaN,
      durationAboveThreshold: 0,
      usedSamples: 0,
      message: 'JMA intensity is calculated when NS, EW, and UD components are all available.',
    };
  }

  const targetDt = Math.min(ns.dt, ew.dt, ud.dt);
  const duration = Math.min(
    ns.acceleration.length * ns.dt,
    ew.acceleration.length * ew.dt,
    ud.acceleration.length * ud.dt,
  );
  const n = Math.max(0, Math.floor(duration / targetDt));

  if (n < Math.ceil(0.3 / targetDt) + 1) {
    return {
      available: false,
      intensity: Number.NaN,
      classLabel: '-',
      thresholdAcceleration: Number.NaN,
      durationAboveThreshold: 0,
      usedSamples: 0,
      message: 'The record is too short for JMA intensity calculation.',
    };
  }

  const nsAcc = resampleToDt(ns.acceleration, ns.dt, targetDt, n);
  const ewAcc = resampleToDt(ew.acceleration, ew.dt, targetDt, n);
  const udAcc = resampleToDt(ud.acceleration, ud.dt, targetDt, n);

  const fNs = applyJmaFrequencyFilter(nsAcc, targetDt);
  const fEw = applyJmaFrequencyFilter(ewAcc, targetDt);
  const fUd = applyJmaFrequencyFilter(udAcc, targetDt);

  const vectorAcceleration = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    vectorAcceleration[i] = Math.hypot(fNs[i], fEw[i], fUd[i]);
  }

  const sorted = [...vectorAcceleration].sort((a, b) => b - a);
  const requiredSamples = Math.max(1, Math.floor(0.3 / targetDt));
  const threshold = sorted[Math.min(requiredSamples, sorted.length - 1)] ?? 0;

  if (threshold <= 0) {
    return {
      available: true,
      intensity: 0,
      classLabel: '0',
      thresholdAcceleration: 0,
      durationAboveThreshold: requiredSamples * targetDt,
      usedSamples: requiredSamples,
    };
  }

  const rawIntensity = 2 * Math.log10(threshold) + 0.94;
  const intensity = officialJmaInstrumentalIntensity(rawIntensity);
  return {
    available: true,
    intensity,
    classLabel: classLabelFromIntensity(intensity),
    thresholdAcceleration: threshold,
    durationAboveThreshold: requiredSamples * targetDt,
    usedSamples: requiredSamples,
  };
}
