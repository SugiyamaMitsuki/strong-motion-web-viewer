import { fftComplex, nextPowerOfTwo } from './fft';
import { subtractMean } from './statistics';

export interface WaveletOptions {
  minFrequency: number;
  maxFrequency: number;
  frequencyCount: number;
  morletOmega0: number;
  maxSamples: number;
}

export interface WaveletResult {
  time: number[];
  frequency: number[];
  amplitude: number[][];
  unit: string;
  effectiveDt: number;
  inputSamples: number;
  computedSamples: number;
}

export const defaultWaveletOptions: WaveletOptions = {
  minFrequency: 0.1,
  maxFrequency: 10,
  frequencyCount: 80,
  morletOmega0: 8,
  maxSamples: 6144,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function logSpace(min: number, max: number, count: number): number[] {
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || min <= 0 || max <= min) return [];
  const n = Math.max(2, Math.floor(count));
  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  return Array.from({ length: n }, (_, index) => 10 ** (logMin + ((logMax - logMin) * index) / (n - 1)));
}

function resampleEvenly(values: readonly number[], dt: number, maxSamples: number): { values: number[]; dt: number } {
  const n = values.length;
  const targetCount = Math.max(64, Math.floor(maxSamples));
  if (n <= targetCount) return { values: [...values], dt };

  const duration = (n - 1) * dt;
  const nextDt = duration / (targetCount - 1);
  const output = Array(targetCount).fill(0);

  for (let i = 0; i < targetCount; i += 1) {
    const sourceIndex = (i * nextDt) / dt;
    const left = Math.floor(sourceIndex);
    const right = Math.min(n - 1, left + 1);
    const ratio = sourceIndex - left;
    output[i] = values[left] * (1 - ratio) + values[right] * ratio;
  }

  return { values: output, dt: nextDt };
}

export function computeMorletWavelet(
  values: readonly number[],
  dt: number,
  unit: string,
  options: Partial<WaveletOptions> = {},
): WaveletResult {
  const settings = {
    ...defaultWaveletOptions,
    ...options,
  };

  if (values.length === 0 || dt <= 0) {
    return {
      time: [],
      frequency: [],
      amplitude: [],
      unit,
      effectiveDt: dt,
      inputSamples: values.length,
      computedSamples: 0,
    };
  }

  const working = resampleEvenly(values, dt, settings.maxSamples);
  const signal = subtractMean(working.values);
  const n = signal.length;
  const nyquist = 0.5 / working.dt;
  const requestedMinFrequency = isFiniteNumber(settings.minFrequency) && settings.minFrequency > 0
    ? settings.minFrequency
    : defaultWaveletOptions.minFrequency;
  const requestedMaxFrequency = isFiniteNumber(settings.maxFrequency) && settings.maxFrequency > requestedMinFrequency
    ? settings.maxFrequency
    : defaultWaveletOptions.maxFrequency;
  const minFrequency = Math.max(requestedMinFrequency, 1 / Math.max(n * working.dt, working.dt));
  const maxFrequency = Math.min(requestedMaxFrequency, nyquist * 0.98);
  const frequency = logSpace(minFrequency, maxFrequency, settings.frequencyCount);

  if (frequency.length === 0) {
    return {
      time: [],
      frequency: [],
      amplitude: [],
      unit,
      effectiveDt: working.dt,
      inputSamples: values.length,
      computedSamples: n,
    };
  }

  const paddedPointCount = n * 2;
  const fftLength = nextPowerOfTwo(paddedPointCount) * 2;
  const input = Array(fftLength).fill(0);
  for (let i = 0; i < n; i += 1) input[i] = signal[i];

  const signalSpectrum = fftComplex(input);
  const time = Array.from({ length: n }, (_, index) => index * working.dt);
  const amplitude: number[][] = [];
  const omega0 = Math.max(2, settings.morletOmega0);
  const timeMax = (paddedPointCount - 1) * working.dt;
  const centerTime = timeMax / 2;
  const startIndex = Math.max(0, Math.floor(centerTime / working.dt));
  const morletNorm = Math.PI ** -0.25;

  for (const f of frequency) {
    const scale = omega0 / (2 * Math.PI * f);
    const waveletRe = Array(fftLength).fill(0);
    const waveletIm = Array(fftLength).fill(0);

    for (let i = 0; i < paddedPointCount; i += 1) {
      const tau = -((i * working.dt) - centerTime) / scale;
      const envelope = (morletNorm * Math.exp(-0.5 * tau * tau)) / Math.sqrt(Math.abs(scale));
      const phase = omega0 * tau;
      waveletRe[i] = envelope * Math.cos(phase);
      waveletIm[i] = -envelope * Math.sin(phase);
    }

    const waveletSpectrum = fftComplex(waveletRe, waveletIm);
    const productRe = Array(fftLength).fill(0);
    const productIm = Array(fftLength).fill(0);

    for (let i = 0; i < fftLength; i += 1) {
      productRe[i] = waveletSpectrum.re[i] * signalSpectrum.re[i] - waveletSpectrum.im[i] * signalSpectrum.im[i];
      productIm[i] = waveletSpectrum.re[i] * signalSpectrum.im[i] + waveletSpectrum.im[i] * signalSpectrum.re[i];
    }

    const transformed = fftComplex(productRe, productIm, true);
    const row = Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      const sourceIndex = startIndex + i;
      row[i] = Math.hypot(transformed.re[sourceIndex] ?? 0, transformed.im[sourceIndex] ?? 0) * working.dt;
    }
    amplitude.push(row);
  }

  return {
    time,
    frequency,
    amplitude,
    unit,
    effectiveDt: working.dt,
    inputSamples: values.length,
    computedSamples: n,
  };
}
