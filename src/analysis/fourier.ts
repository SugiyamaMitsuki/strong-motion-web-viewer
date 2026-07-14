import type { FourierSpectrum } from '../types/waveform';
import { buildFrequencyCosineTaper, referenceFftLength } from './calculus';
import { fftComplex } from './fft';
import { subtractMean } from './statistics';

export interface FourierOptions {
  applyFrequencyTaper: boolean;
  applyTimeTaper?: boolean;
  timeTaperFraction?: number;
}

export interface FourierComputationMetadata {
  sampleCount: number;
  fftLength: number;
  recordDurationSec: number;
  fftBinSpacingHz: number;
  independentResolutionHz: number;
  firstPositiveFrequencyHz: number;
  nyquistFrequencyHz: number;
  timeWindow: 'rectangular' | 'cosine-edge-taper';
  timeTaperFraction: number;
  windowCoherentGain: number;
  windowGainCorrected: false;
  frequencyTaperApplied: boolean;
  sidedness: 'positive-frequency-half-spectrum';
  amplitudeNormalization: 'absolute-dft-times-dt';
  oneSidedFactor: 1;
  /** DC amplitude on the same |DFT| * dt scale; retained for edge-correct smoothing. */
  dcAmplitude: number;
}

export interface FourierAnalysisResult {
  spectrum: FourierSpectrum;
  metadata: FourierComputationMetadata;
}

export interface KonnoOhmachiOptions {
  /** Standard seismological bandwidth; 40 is the conventional default. */
  bandwidth?: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Logarithmically spaced output ordinates. */
  outputCount?: number;
  /** Number of kernel zero crossings retained on each side. */
  halfWindowCycles?: number;
}

export const DEFAULT_PARZEN_BANDWIDTH_HZ = 0.1;

export interface ParzenOptions {
  /** Parzen bandwidth B in Hz. Zero returns the unsmoothed spectrum. */
  bandwidthHz?: number;
  /** DC amplitude on the same |DFT| * dt scale as the supplied ordinates. */
  dcAmplitude?: number;
}

export interface ParzenSmoothedFourierSpectrum extends FourierSpectrum {
  smoothing: {
    method: 'Parzen';
    applied: boolean;
    bandwidthHz: number;
    bandwidthParameterUSeconds: number;
    firstZeroOffsetHz: number;
    fftBinSpacingHz: number;
    binsPerBandwidth: number;
    domain: 'squared-amplitude-power';
    amplitudeRecovery: 'square-root-after-power-smoothing';
    kernel: '3u/4 * [sin(pi*u*deltaF/2)/(pi*u*deltaF/2)]^4';
    kernelNormalization: 'unit-sum-on-two-sided-fft-grid';
    boundaryTreatment: 'circular-convolution-of-hermitian-two-sided-spectrum';
    outputGrid: 'original-positive-fft-bin-grid';
    dcAmplitude: number;
    smoothedDcAmplitude: number;
    inputTwoSidedPowerSum: number;
    outputTwoSidedPowerSum: number;
    relativePowerConservationError: number;
  };
}

export interface SmoothedFourierSpectrum extends FourierSpectrum {
  smoothing: {
    method: 'Konno-Ohmachi';
    bandwidth: number;
    outputCount: number;
    halfWindowCycles: number;
    minFrequencyHz: number;
    maxFrequencyHz: number;
  };
}

export const defaultFourierOptions: FourierOptions = {
  applyFrequencyTaper: false,
  applyTimeTaper: false,
  timeTaperFraction: 0.05,
};

function cosineTimeTaper(values: readonly number[], fraction: number): number[] {
  const n = values.length;
  if (n < 3 || fraction <= 0) return values.slice();

  const edge = Math.max(1, Math.min(Math.floor(n / 2), Math.floor(n * fraction)));
  return values.map((value, index) => {
    if (index < edge) {
      return value * 0.5 * (1 - Math.cos(Math.PI * index / edge));
    }
    if (index >= n - edge) {
      return value * 0.5 * (1 - Math.cos(Math.PI * (n - 1 - index) / edge));
    }
    return value;
  });
}

function cosineTimeTaperWeights(length: number, fraction: number): number[] {
  if (length < 3 || fraction <= 0) return Array(length).fill(1);
  return cosineTimeTaper(Array(length).fill(1), fraction);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Computes the positive-frequency Fourier amplitude spectrum and records every
 * scaling decision needed to reproduce it. The amplitude is |DFT| * dt, which
 * approximates the continuous Fourier transform. Positive frequencies are
 * retained without the signal-processing factor of two; the DC ordinate is
 * omitted and the Nyquist ordinate is retained.
 */
export function computeFourierAnalysis(
  values: readonly number[],
  dt: number,
  unit: string,
  options: FourierOptions = defaultFourierOptions,
): FourierAnalysisResult {
  const nOriginal = values.length;
  if (nOriginal === 0 || dt <= 0) {
    return {
      spectrum: { frequency: [], amplitude: [], unit },
      metadata: {
        sampleCount: nOriginal,
        fftLength: 0,
        recordDurationSec: 0,
        fftBinSpacingHz: 0,
        independentResolutionHz: 0,
        firstPositiveFrequencyHz: 0,
        nyquistFrequencyHz: 0,
        timeWindow: 'rectangular',
        timeTaperFraction: 0,
        windowCoherentGain: 1,
        windowGainCorrected: false,
        frequencyTaperApplied: false,
        sidedness: 'positive-frequency-half-spectrum',
        amplitudeNormalization: 'absolute-dft-times-dt',
        oneSidedFactor: 1,
        dcAmplitude: 0,
      },
    };
  }

  const nFft = referenceFftLength(nOriginal);
  const requestedTaperFraction = options.timeTaperFraction
    ?? defaultFourierOptions.timeTaperFraction
    ?? 0.05;
  const taperFraction = options.applyTimeTaper
    ? Math.max(0, Math.min(0.5, requestedTaperFraction))
    : 0;
  const centered = subtractMean(values);
  const windowWeights = cosineTimeTaperWeights(nOriginal, taperFraction);
  const prepared = taperFraction > 0
    ? centered.map((value, index) => value * windowWeights[index])
    : centered;
  const taper = options.applyFrequencyTaper ? buildFrequencyCosineTaper(nFft, dt) : Array(nFft).fill(1);

  const re = Array(nFft).fill(0);
  for (let i = 0; i < nOriginal; i += 1) re[i] = prepared[i];

  const { re: fftRe, im: fftIm } = fftComplex(re);
  const half = Math.floor(nFft / 2);
  const frequency: number[] = [];
  const amplitude: number[] = [];

  for (let k = 1; k <= half; k += 1) {
    const f = k / (nFft * dt);
    const amp = Math.hypot(fftRe[k], fftIm[k]) * dt * taper[k];
    frequency.push(f);
    amplitude.push(amp);
  }

  const fftBinSpacingHz = 1 / (nFft * dt);
  const dcAmplitude = Math.hypot(fftRe[0], fftIm[0]) * dt * taper[0];
  return {
    spectrum: { frequency, amplitude, unit },
    metadata: {
      sampleCount: nOriginal,
      fftLength: nFft,
      recordDurationSec: nOriginal * dt,
      fftBinSpacingHz,
      independentResolutionHz: 1 / (nOriginal * dt),
      firstPositiveFrequencyHz: fftBinSpacingHz,
      nyquistFrequencyHz: 1 / (2 * dt),
      timeWindow: taperFraction > 0 ? 'cosine-edge-taper' : 'rectangular',
      timeTaperFraction: taperFraction,
      windowCoherentGain: mean(windowWeights),
      windowGainCorrected: false,
      frequencyTaperApplied: options.applyFrequencyTaper,
      sidedness: 'positive-frequency-half-spectrum',
      amplitudeNormalization: 'absolute-dft-times-dt',
      oneSidedFactor: 1,
      dcAmplitude,
    },
  };
}

export function computeFourierSpectrum(
  values: readonly number[],
  dt: number,
  unit: string,
  options: FourierOptions = defaultFourierOptions,
): FourierSpectrum {
  return computeFourierAnalysis(values, dt, unit, options).spectrum;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function logarithmicGrid(minimum: number, maximum: number, count: number): number[] {
  if (!(minimum > 0) || !(maximum >= minimum) || count <= 0) return [];
  if (count === 1 || minimum === maximum) return [minimum];
  const logMin = Math.log(minimum);
  const logSpan = Math.log(maximum) - logMin;
  return Array.from({ length: count }, (_, index) => (
    Math.exp(logMin + (logSpan * index) / (count - 1))
  ));
}

/**
 * Parzen spectral window used by ViewWave and common Japanese strong-motion
 * workflows. B is specified in Hz and u = 280 / (151 B).
 */
export function parzenWindowWeight(deltaFrequencyHz: number, bandwidthHz: number): number {
  if (!Number.isFinite(deltaFrequencyHz) || !Number.isFinite(bandwidthHz) || bandwidthHz <= 0) return 0;
  const u = 280 / (151 * bandwidthHz);
  const argument = Math.PI * u * Math.abs(deltaFrequencyHz) / 2;
  const ratio = argument < 1e-12 ? 1 : Math.sin(argument) / argument;
  return (3 * u / 4) * ratio ** 4;
}

function twoSidedPowerSum(power: readonly number[]): number {
  return power.reduce((sum, value) => sum + value, 0);
}

/**
 * Smooths squared Fourier amplitudes with the Parzen spectral window, then
 * takes the square root to recover amplitude. This follows ViewWave's stated
 * power -> Parzen convolution -> amplitude sequence; it does not average
 * amplitude ordinates directly.
 *
 * The input must be the complete, uniformly spaced positive FFT half-spectrum
 * (k = 1..N/2, including Nyquist). The original FFT-bin grid is retained.
 */
export function smoothFourierSpectrumParzen(
  spectrum: FourierSpectrum,
  options: ParzenOptions = {},
): ParzenSmoothedFourierSpectrum {
  const requestedBandwidth = options.bandwidthHz;
  const bandwidthHz = requestedBandwidth === 0
    ? 0
    : Number.isFinite(requestedBandwidth) && (requestedBandwidth ?? 0) > 0
      ? requestedBandwidth as number
      : DEFAULT_PARZEN_BANDWIDTH_HZ;
  const count = Math.min(spectrum.frequency.length, spectrum.amplitude.length);
  const frequency = spectrum.frequency.slice(0, count);
  const rawAmplitude = spectrum.amplitude.slice(0, count);
  const fftBinSpacingHz = frequency[0] ?? 0;
  const u = bandwidthHz > 0 ? 280 / (151 * bandwidthHz) : 0;
  const firstZeroOffsetHz = u > 0 ? 2 / u : 0;
  const dcAmplitude = Number.isFinite(options.dcAmplitude) && (options.dcAmplitude ?? 0) >= 0
    ? options.dcAmplitude as number
    : 0;

  const baseSmoothing = {
    method: 'Parzen' as const,
    bandwidthHz,
    bandwidthParameterUSeconds: u,
    firstZeroOffsetHz,
    fftBinSpacingHz,
    binsPerBandwidth: fftBinSpacingHz > 0 ? bandwidthHz / fftBinSpacingHz : 0,
    domain: 'squared-amplitude-power' as const,
    amplitudeRecovery: 'square-root-after-power-smoothing' as const,
    kernel: '3u/4 * [sin(pi*u*deltaF/2)/(pi*u*deltaF/2)]^4' as const,
    kernelNormalization: 'unit-sum-on-two-sided-fft-grid' as const,
    boundaryTreatment: 'circular-convolution-of-hermitian-two-sided-spectrum' as const,
    outputGrid: 'original-positive-fft-bin-grid' as const,
    dcAmplitude,
  };

  if (count === 0 || bandwidthHz === 0) {
    const inputPower = dcAmplitude ** 2
      + rawAmplitude.reduce((sum, value, index) => (
        sum + (index === count - 1 ? 1 : 2) * (Number.isFinite(value) ? Math.max(0, value) ** 2 : 0)
      ), 0);
    return {
      frequency,
      amplitude: rawAmplitude,
      unit: spectrum.unit,
      smoothing: {
        ...baseSmoothing,
        applied: false,
        smoothedDcAmplitude: dcAmplitude,
        inputTwoSidedPowerSum: inputPower,
        outputTwoSidedPowerSum: inputPower,
        relativePowerConservationError: 0,
      },
    };
  }

  if (!(fftBinSpacingHz > 0)) {
    throw new RangeError('Parzen smoothing requires positive, uniformly spaced FFT frequencies.');
  }
  for (let index = 0; index < count; index += 1) {
    const expected = (index + 1) * fftBinSpacingHz;
    const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-8);
    if (!Number.isFinite(frequency[index]) || Math.abs(frequency[index] - expected) > tolerance) {
      throw new RangeError('Parzen smoothing requires the complete positive FFT-bin grid including Nyquist.');
    }
    if (!Number.isFinite(rawAmplitude[index]) || rawAmplitude[index] < 0) {
      throw new RangeError('Parzen smoothing requires finite, non-negative amplitudes.');
    }
  }

  const fftLength = count * 2;
  if ((fftLength & (fftLength - 1)) !== 0) {
    throw new RangeError('Parzen smoothing requires a power-of-two full FFT length.');
  }

  // Reconstruct the complete Hermitian power spectrum. The Nyquist bin occurs
  // once; every other positive-frequency bin has a conjugate partner.
  const twoSidedPower = Array(fftLength).fill(0);
  twoSidedPower[0] = dcAmplitude ** 2;
  for (let k = 1; k < count; k += 1) {
    const power = rawAmplitude[k - 1] ** 2;
    twoSidedPower[k] = power;
    twoSidedPower[fftLength - k] = power;
  }
  twoSidedPower[count] = rawAmplitude[count - 1] ** 2;

  // Sample the continuous window on the same periodic frequency grid and make
  // the discrete weights sum exactly to one. Circular convolution then treats
  // DC and Nyquist without truncating the window at either boundary.
  const kernel = Array.from({ length: fftLength }, (_, index) => {
    const signedBin = index <= count ? index : index - fftLength;
    return parzenWindowWeight(signedBin * fftBinSpacingHz, bandwidthHz) * fftBinSpacingHz;
  });
  const kernelSum = kernel.reduce((sum, value) => sum + value, 0);
  if (!(kernelSum > 0) || !Number.isFinite(kernelSum)) {
    throw new RangeError('Parzen smoothing could not construct a finite spectral window.');
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= kernelSum;

  const powerFft = fftComplex(twoSidedPower);
  const kernelFft = fftComplex(kernel);
  const productRe = Array(fftLength).fill(0);
  const productIm = Array(fftLength).fill(0);
  for (let index = 0; index < fftLength; index += 1) {
    productRe[index] = powerFft.re[index] * kernelFft.re[index]
      - powerFft.im[index] * kernelFft.im[index];
    productIm[index] = powerFft.re[index] * kernelFft.im[index]
      + powerFft.im[index] * kernelFft.re[index];
  }
  const smoothedPower = fftComplex(productRe, productIm, true).re
    .map((value) => Math.max(0, value));
  const amplitude = Array.from({ length: count }, (_, index) => Math.sqrt(smoothedPower[index + 1]));
  const inputTwoSidedPowerSum = twoSidedPowerSum(twoSidedPower);
  const outputTwoSidedPowerSum = twoSidedPowerSum(smoothedPower);
  const relativePowerConservationError = inputTwoSidedPowerSum > 0
    ? Math.abs(outputTwoSidedPowerSum - inputTwoSidedPowerSum) / inputTwoSidedPowerSum
    : 0;

  return {
    frequency,
    amplitude,
    unit: spectrum.unit,
    smoothing: {
      ...baseSmoothing,
      applied: true,
      smoothedDcAmplitude: Math.sqrt(smoothedPower[0]),
      inputTwoSidedPowerSum,
      outputTwoSidedPowerSum,
      relativePowerConservationError,
    },
  };
}

/**
 * Konno-Ohmachi smoothing on logarithmically spaced output frequencies.
 *
 * The normalized kernel is [sin(b log10(f/fc)) / (b log10(f/fc))]^4.
 * Four zero crossings on either side are retained by default; more distant
 * sidelobes are negligible and omitting them keeps long records interactive.
 */
export function smoothFourierSpectrumKonnoOhmachi(
  spectrum: FourierSpectrum,
  options: KonnoOhmachiOptions = {},
): SmoothedFourierSpectrum {
  const bandwidth = Number.isFinite(options.bandwidth) && (options.bandwidth ?? 0) >= 1
    ? options.bandwidth as number
    : 40;
  const outputCount = Number.isFinite(options.outputCount) && (options.outputCount ?? 0) >= 2
    ? Math.min(2000, Math.round(options.outputCount as number))
    : 360;
  const halfWindowCycles = Number.isFinite(options.halfWindowCycles) && (options.halfWindowCycles ?? 0) > 0
    ? options.halfWindowCycles as number
    : 4;
  const count = Math.min(spectrum.frequency.length, spectrum.amplitude.length);
  const validFrequency: number[] = [];
  const validAmplitude: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const frequency = spectrum.frequency[index];
    const amplitude = spectrum.amplitude[index];
    if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(amplitude) || amplitude < 0) continue;
    validFrequency.push(frequency);
    validAmplitude.push(amplitude);
  }

  const availableMin = validFrequency[0] ?? 0;
  const availableMax = validFrequency[validFrequency.length - 1] ?? 0;
  const minFrequencyHz = Math.max(availableMin, options.minFrequencyHz ?? availableMin);
  const maxFrequencyHz = Math.min(availableMax, options.maxFrequencyHz ?? availableMax);
  const centres = logarithmicGrid(minFrequencyHz, maxFrequencyHz, outputCount);
  const amplitude = centres.map((centre) => {
    const logHalfWidth = (halfWindowCycles * Math.PI) / bandwidth;
    const lowerFrequency = centre * 10 ** (-logHalfWidth);
    const upperFrequency = centre * 10 ** logHalfWidth;
    const start = lowerBound(validFrequency, lowerFrequency);
    const end = lowerBound(validFrequency, upperFrequency * (1 + Number.EPSILON));
    let weightedSum = 0;
    let weightSum = 0;

    for (let index = start; index < end; index += 1) {
      const argument = bandwidth * Math.log10(validFrequency[index] / centre);
      const ratio = Math.abs(argument) < 1e-12 ? 1 : Math.sin(argument) / argument;
      const weight = ratio ** 4;
      weightedSum += validAmplitude[index] * weight;
      weightSum += weight;
    }

    if (weightSum > 0) return weightedSum / weightSum;
    const nearest = Math.min(validFrequency.length - 1, Math.max(0, lowerBound(validFrequency, centre)));
    return validAmplitude[nearest] ?? 0;
  });

  return {
    frequency: centres,
    amplitude,
    unit: spectrum.unit,
    smoothing: {
      method: 'Konno-Ohmachi',
      bandwidth,
      outputCount: centres.length,
      halfWindowCycles,
      minFrequencyHz,
      maxFrequencyHz,
    },
  };
}
