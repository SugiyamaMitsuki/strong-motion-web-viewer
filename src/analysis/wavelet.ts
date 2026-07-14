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
  /** Unit of the input signal before the continuous wavelet transform. */
  inputUnit: string;
  /** Unit of an L2-normalized CWT coefficient: input unit multiplied by sqrt(s). */
  unit: string;
  normalization: 'L2';
  effectiveDt: number;
  inputSamples: number;
  computedSamples: number;
  resampling: WaveletResamplingMetadata;
}

export interface WaveletResamplingMetadata {
  applied: boolean;
  method: 'none' | 'Kaiser-windowed sinc polyphase anti-alias resampling';
  inputSamples: number;
  computedSamples: number;
  inputDtSeconds: number;
  effectiveDtSeconds: number;
  /** Conservative flat-band limit used to cap the reported CWT grid. */
  passbandEndHz?: number;
  /** New-sampling Nyquist frequency; the anti-alias transition ends here. */
  stopbandStartHz?: number;
  kaiserBeta?: number;
  kernelHalfWidthInputSamples?: number;
}

export interface DominantWaveletRidgeOptions {
  /** Morlet non-dimensional central frequency used by the transform. */
  morletOmega0?: number;
  /** Omit coefficient maxima where the wavelet support intersects a record edge. */
  excludeOutsideConeOfInfluence?: boolean;
}

export interface DominantWaveletRidge {
  time: number[];
  /** Per-time maximum-coefficient frequency. NaN denotes no valid value inside the COI. */
  frequency: number[];
  amplitude: number[];
}

export const defaultWaveletOptions: WaveletOptions = {
  minFrequency: 0.1,
  maxFrequency: 10,
  frequencyCount: 80,
  morletOmega0: 8,
  maxSamples: 6144,
};

export const MORLET_CWT_NORMALIZATION = 'L2-normalized: psi_scale(t) = psi(t / scale) / sqrt(scale)';

export function cwtCoefficientUnit(inputUnit: string): string {
  const normalized = inputUnit.trim();
  return normalized ? `${normalized}·√s` : '√s';
}

/** Convert a positive CWT coefficient magnitude to amplitude decibels. */
export function waveletMagnitudeToDecibels(magnitude: number, reference = 1): number {
  if (!Number.isFinite(magnitude) || magnitude <= 0 || !Number.isFinite(reference) || reference <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(magnitude / reference);
}

/**
 * Return the descriptive per-time maximum of the CWT magnitude.
 * This is deliberately not presented as a phase pick, modal ridge, or uncertainty estimate.
 */
export function computeDominantWaveletRidge(
  result: WaveletResult,
  options: DominantWaveletRidgeOptions = {},
): DominantWaveletRidge {
  const omega0 = Number.isFinite(options.morletOmega0) && (options.morletOmega0 ?? 0) >= 2
    ? options.morletOmega0 as number
    : defaultWaveletOptions.morletOmega0;
  const excludeOutsideConeOfInfluence = options.excludeOutsideConeOfInfluence ?? true;
  const startTime = result.time[0] ?? 0;
  const endTime = result.time[result.time.length - 1] ?? startTime;
  const frequency = Array(result.time.length).fill(Number.NaN);
  const amplitude = Array(result.time.length).fill(Number.NaN);

  for (let timeIndex = 0; timeIndex < result.time.length; timeIndex += 1) {
    const currentTime = result.time[timeIndex];
    const edgeDistance = Math.max(0, Math.min(currentTime - startTime, endTime - currentTime));
    let bestAmplitude = Number.NEGATIVE_INFINITY;
    let bestFrequency = Number.NaN;

    for (let frequencyIndex = 0; frequencyIndex < result.frequency.length; frequencyIndex += 1) {
      const currentFrequency = result.frequency[frequencyIndex];
      if (!Number.isFinite(currentFrequency) || currentFrequency <= 0) continue;
      if (excludeOutsideConeOfInfluence) {
        const scale = omega0 / (2 * Math.PI * currentFrequency);
        if (edgeDistance < Math.SQRT2 * scale) continue;
      }

      const currentAmplitude = result.amplitude[frequencyIndex]?.[timeIndex];
      if (!Number.isFinite(currentAmplitude) || currentAmplitude < 0 || currentAmplitude <= bestAmplitude) continue;
      bestAmplitude = currentAmplitude;
      bestFrequency = currentFrequency;
    }

    if (Number.isFinite(bestFrequency) && bestAmplitude > 0) {
      frequency[timeIndex] = bestFrequency;
      amplitude[timeIndex] = bestAmplitude;
    }
  }

  return { time: [...result.time], frequency, amplitude };
}

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

interface ResampledSignal {
  values: number[];
  dt: number;
  metadata: WaveletResamplingMetadata;
}

const KAISER_BETA = 8.6;

function modifiedBesselI0(value: number): number {
  // Standard piecewise approximation; avoids a power-series loop for every tap.
  const absolute = Math.abs(value);
  if (absolute < 3.75) {
    const y = (absolute / 3.75) ** 2;
    return 1 + y * (3.5156229 + y * (3.0899424 + y * (1.2067492
      + y * (0.2659732 + y * (0.0360768 + y * 0.0045813)))));
  }
  const y = 3.75 / absolute;
  return (Math.exp(absolute) / Math.sqrt(absolute)) * (0.39894228 + y * (0.01328592
    + y * (0.00225319 + y * (-0.00157565 + y * (0.00916281 + y * (-0.02057706
      + y * (0.02635537 + y * (-0.01647633 + y * 0.00392377))))))));
}

function sinc(value: number): number {
  return Math.abs(value) < 1e-12 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
}

function reflectedIndex(index: number, length: number): number {
  if (length <= 1) return 0;
  const period = 2 * (length - 1);
  const wrapped = ((index % period) + period) % period;
  return wrapped < length ? wrapped : period - wrapped;
}

function resampleEvenly(values: readonly number[], dt: number, maxSamples: number): ResampledSignal {
  const n = values.length;
  const targetCount = Math.max(64, Math.floor(maxSamples));
  if (n <= targetCount) {
    return {
      values: [...values],
      dt,
      metadata: {
        applied: false,
        method: 'none',
        inputSamples: n,
        computedSamples: n,
        inputDtSeconds: dt,
        effectiveDtSeconds: dt,
      },
    };
  }

  const duration = (n - 1) * dt;
  const nextDt = duration / (targetCount - 1);
  const output = Array(targetCount).fill(0);
  const rateRatio = (targetCount - 1) / (n - 1);
  const cutoffCyclesPerInputSample = 0.45 * rateRatio;
  const halfWidth = Math.max(8, Math.ceil(32 / rateRatio));
  const besselDenominator = modifiedBesselI0(KAISER_BETA);

  for (let i = 0; i < targetCount; i += 1) {
    const sourcePosition = (i * (n - 1)) / (targetCount - 1);
    const centre = Math.floor(sourcePosition);
    let weightedSum = 0;
    let weightSum = 0;
    for (let sourceIndex = centre - halfWidth; sourceIndex <= centre + halfWidth; sourceIndex += 1) {
      const distance = sourcePosition - sourceIndex;
      const normalizedDistance = distance / halfWidth;
      if (Math.abs(normalizedDistance) > 1) continue;
      const window = modifiedBesselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - normalizedDistance ** 2)))
        / besselDenominator;
      const weight = 2 * cutoffCyclesPerInputSample
        * sinc(2 * cutoffCyclesPerInputSample * distance)
        * window;
      weightedSum += values[reflectedIndex(sourceIndex, n)] * weight;
      weightSum += weight;
    }
    output[i] = Math.abs(weightSum) > 1e-15 ? weightedSum / weightSum : values[reflectedIndex(Math.round(sourcePosition), n)];
  }

  const targetNyquistHz = 0.5 / nextDt;
  return {
    values: output,
    dt: nextDt,
    metadata: {
      applied: true,
      method: 'Kaiser-windowed sinc polyphase anti-alias resampling',
      inputSamples: n,
      computedSamples: targetCount,
      inputDtSeconds: dt,
      effectiveDtSeconds: nextDt,
      passbandEndHz: 0.8 * targetNyquistHz,
      stopbandStartHz: targetNyquistHz,
      kaiserBeta: KAISER_BETA,
      kernelHalfWidthInputSamples: halfWidth,
    },
  };
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
  const coefficientUnit = cwtCoefficientUnit(unit);

  if (values.length === 0 || dt <= 0) {
    const inputSamples = values.length;
    return {
      time: [],
      frequency: [],
      amplitude: [],
      inputUnit: unit,
      unit: coefficientUnit,
      normalization: 'L2',
      effectiveDt: dt,
      inputSamples,
      computedSamples: 0,
      resampling: {
        applied: false,
        method: 'none',
        inputSamples,
        computedSamples: 0,
        inputDtSeconds: dt,
        effectiveDtSeconds: dt,
      },
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
  const antiAliasPassbandEndHz = working.metadata.applied
    ? working.metadata.passbandEndHz ?? nyquist * 0.8
    : nyquist * 0.98;
  const maxFrequency = Math.min(requestedMaxFrequency, nyquist * 0.98, antiAliasPassbandEndHz);
  const frequency = logSpace(minFrequency, maxFrequency, settings.frequencyCount);

  if (frequency.length === 0) {
    return {
      time: [],
      frequency: [],
      amplitude: [],
      inputUnit: unit,
      unit: coefficientUnit,
      normalization: 'L2',
      effectiveDt: working.dt,
      inputSamples: values.length,
      computedSamples: n,
      resampling: working.metadata,
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
    inputUnit: unit,
    unit: coefficientUnit,
    normalization: 'L2',
    effectiveDt: working.dt,
    inputSamples: values.length,
    computedSamples: n,
    resampling: working.metadata,
  };
}
