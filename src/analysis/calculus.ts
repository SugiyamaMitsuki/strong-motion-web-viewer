import { fftComplex, nextPowerOfTwo } from './fft';
import { subtractMean } from './statistics';

export interface FrequencyTaperSettings {
  enabled: boolean;
  leftHz: number;
  startHz: number;
  endHz: number;
  rightHz: number;
}

export const defaultFrequencyTaper: FrequencyTaperSettings = {
  enabled: true,
  leftHz: 0.05,
  startHz: 0.1,
  endHz: 20,
  rightHz: 30,
};

export function referenceFftLength(sampleCount: number): number {
  return nextPowerOfTwo(Math.max(2, sampleCount * 2 + 1));
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length, Math.floor(value)));
}

export function frequencyTaperGain(frequencyHz: number, settings: FrequencyTaperSettings = defaultFrequencyTaper): number {
  if (!settings.enabled) return 1;
  if (frequencyHz < settings.leftHz || frequencyHz > settings.rightHz) return 0;
  if (frequencyHz >= settings.startHz && frequencyHz <= settings.endHz) return 1;

  if (frequencyHz < settings.startHz) {
    const span = settings.startHz - settings.leftHz;
    if (span <= 0) return 1;
    const ratio = (frequencyHz - settings.leftHz) / span;
    return 0.5 * (1 - Math.cos(Math.PI * ratio));
  }

  const span = settings.rightHz - settings.endHz;
  if (span <= 0) return 0;
  const ratio = (frequencyHz - settings.endHz) / span;
  return 0.5 * (1 + Math.cos(Math.PI * ratio));
}

export function buildFrequencyCosineTaper(
  fftLength: number,
  dt: number,
  settings: FrequencyTaperSettings = defaultFrequencyTaper,
): number[] {
  if (!settings.enabled || fftLength <= 0 || dt <= 0) return Array(fftLength).fill(1);

  const df = 1 / (fftLength * dt);
  const left = clampIndex(settings.leftHz / df, fftLength);
  const start = clampIndex(settings.startHz / df, fftLength);
  const end = clampIndex(settings.endHz / df, fftLength);
  const right = clampIndex(settings.rightHz / df, fftLength);
  const taper = Array(fftLength).fill(0);

  for (let i = left; i < start; i += 1) {
    const ratio = start === left ? 1 : (i - start) / (start - left);
    taper[i] = 0.5 * (1 + Math.cos(Math.PI * ratio));
  }

  for (let i = start; i < end; i += 1) taper[i] = 1;

  for (let i = end; i < right; i += 1) {
    const ratio = right === end ? 1 : (i - end) / (right - end);
    taper[i] = 0.5 * (1 + Math.cos(Math.PI * ratio));
  }

  return taper;
}

function complexMultiply(a: { re: number; im: number }, b: { re: number; im: number }): { re: number; im: number } {
  return {
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  };
}

function complexReciprocal(value: { re: number; im: number }): { re: number; im: number } {
  const denominator = value.re ** 2 + value.im ** 2;
  if (denominator === 0) return { re: 0, im: 0 };
  return { re: value.re / denominator, im: -value.im / denominator };
}

function complexMultiplierForDerivativeOrder(frequencyHz: number, derivativeOrder: number): { re: number; im: number } {
  if (frequencyHz === 0) return { re: 0, im: 0 };
  if (derivativeOrder === 0) return { re: 1, im: 0 };

  const omega = 2 * Math.PI * frequencyHz;
  const base = { re: 0, im: omega };
  let result = { re: 1, im: 0 };
  const steps = Math.abs(derivativeOrder);

  for (let i = 0; i < steps; i += 1) {
    result = complexMultiply(result, base);
  }

  return derivativeOrder > 0 ? result : complexReciprocal(result);
}

export function frequencyDomainDerivative(
  values: readonly number[],
  dt: number,
  derivativeOrder: number,
  taperSettings: FrequencyTaperSettings = defaultFrequencyTaper,
): number[] {
  const sampleCount = values.length;
  if (sampleCount === 0 || dt <= 0) return [];

  const fftLength = referenceFftLength(sampleCount);
  const centered = subtractMean(values);
  const input = Array(fftLength).fill(0);
  for (let i = 0; i < sampleCount; i += 1) input[i] = centered[i];

  const spectrum = fftComplex(input);
  const outRe = Array(fftLength).fill(0);
  const outIm = Array(fftLength).fill(0);
  const df = 1 / (fftLength * dt);

  for (let k = 0; k < fftLength; k += 1) {
    const frequencyHz = k <= fftLength / 2 ? k * df : (k - fftLength) * df;
    const gain = frequencyTaperGain(Math.abs(frequencyHz), taperSettings);
    const multiplier = complexMultiplierForDerivativeOrder(frequencyHz, derivativeOrder);
    const re = spectrum.re[k] * gain;
    const im = spectrum.im[k] * gain;
    outRe[k] = re * multiplier.re - im * multiplier.im;
    outIm[k] = re * multiplier.im + im * multiplier.re;
  }

  const inverse = fftComplex(outRe, outIm, true);
  return inverse.re.slice(0, sampleCount);
}
