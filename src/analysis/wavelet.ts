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
  /** Exact Morlet scales corresponding to `frequency`, in seconds. */
  scaleSeconds: number[];
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
  /** Morlet e-folding half-width, sqrt(2) * scale, for every frequency row. */
  coneOfInfluenceHalfWidthSeconds: number[];
  /** Whether at least one computed time sample in the row lies inside the COI. */
  frequencyHasValidCone: boolean[];
  metadata: WaveletTransformMetadata;
}

export type WaveletQuantity = 'raw-l2' | 'scale-corrected-amplitude' | 'rectified-power';

export interface WaveletTransformMetadata {
  motherWavelet: 'complex Morlet';
  morletOmega0: number;
  minimumAdmissibleOmega0: number;
  admissibility: 'uncorrected Morlet restricted to omega0 >= 5';
  /** Torrence-Compo Fourier factor, f = factor / scale. */
  morletFourierFactor: number;
  scaleFrequencyRelation: 'f = (omega0 + sqrt(omega0^2 + 2)) / (4*pi*scale)';
  meanRemoved: boolean;
  removedMean: number | null;
  meanRemovalStage: 'after anti-alias resampling and before CWT';
  requestedFrequencyBoundsHz: [number, number];
  effectiveFrequencyBoundsHz: [number, number] | null;
  nyquistFrequencyHz: number;
  /** Maximum reported equivalent-Fourier frequency as a fraction of Nyquist. */
  highFrequencyLimitFractionOfNyquist: number;
  highFrequencyLimitHz: number;
  paddedSignalSamples: number;
  fftLength: number;
  padding: 'zero';
  kernelCentering: 'integer-sample centre aligned to output samples';
  coneOfInfluenceDefinition: 'sqrt(2) * scale (Morlet power e-folding time)';
  quantityDefinitions: {
    rawL2: '|W|';
    scaleCorrectedAmplitude: 'C(omega0) * |W| / sqrt(scale)';
    rectifiedPower: 'C(omega0)^2 * |W|^2 / scale';
  };
  sinusoidAmplitudeCalibration: number;
  sinusoidAmplitudeCalibrationDefinition: 'C(omega0) = sqrt(2)/pi^(1/4) * exp(((omega0 + sqrt(omega0^2 + 2))/2 - omega0)^2 / 2)';
  scaleCorrectedAmplitudeInterpretation: 'carrier-sinusoid-calibrated, frequency-comparable Morlet amplitude; not an instantaneous signal envelope';
}

export interface WaveletResamplingMetadata {
  applied: boolean;
  method: 'none' | 'Kaiser-windowed sinc anti-alias resampling';
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
  boundaryTreatment?: 'symmetric reflection at both input edges';
}

export interface DominantWaveletRidgeOptions {
  /** Morlet non-dimensional central frequency used by the transform. */
  morletOmega0?: number;
  /** Quantity used both to compare rows and to report ridge amplitude. */
  quantity?: WaveletQuantity;
  /** Omit coefficient maxima where the wavelet support intersects a record edge. */
  excludeOutsideConeOfInfluence?: boolean;
}

export interface DominantWaveletRidge {
  time: number[];
  /** Per-time maximum-coefficient frequency. NaN denotes no valid value inside the COI. */
  frequency: number[];
  /** Ridge ordinate in `quantity`; NaN denotes no finite positive maximum. */
  amplitude: number[];
  quantity: WaveletQuantity;
  unit: string;
}

export const defaultWaveletOptions: WaveletOptions = {
  minFrequency: 0.1,
  maxFrequency: 10,
  frequencyCount: 80,
  morletOmega0: 6,
  maxSamples: 6144,
};

export const MIN_MORLET_OMEGA0 = 5;
export const MORLET_NYQUIST_FREQUENCY_FRACTION = 0.8;
export const MORLET_CWT_NORMALIZATION = 'L2-normalized: psi_scale(t) = psi(t / scale) / sqrt(scale)';

function requireMorletOmega0(value: number): number {
  if (!Number.isFinite(value) || value < MIN_MORLET_OMEGA0) {
    throw new RangeError(`Morlet omega0 must be finite and >= ${MIN_MORLET_OMEGA0}.`);
  }
  return value;
}

/** Exact Torrence-Compo equivalent-Fourier-frequency factor, f = factor / scale. */
export function morletFourierFactor(morletOmega0 = defaultWaveletOptions.morletOmega0): number {
  const omega0 = requireMorletOmega0(morletOmega0);
  return (omega0 + Math.sqrt(omega0 ** 2 + 2)) / (4 * Math.PI);
}

export function morletScaleFromFrequency(
  frequencyHz: number,
  morletOmega0 = defaultWaveletOptions.morletOmega0,
): number {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    throw new RangeError('Morlet equivalent Fourier frequency must be finite and > 0.');
  }
  return morletFourierFactor(morletOmega0) / frequencyHz;
}

export function morletFrequencyFromScale(
  scaleSeconds: number,
  morletOmega0 = defaultWaveletOptions.morletOmega0,
): number {
  if (!Number.isFinite(scaleSeconds) || scaleSeconds <= 0) {
    throw new RangeError('Morlet scale must be finite and > 0.');
  }
  return morletFourierFactor(morletOmega0) / scaleSeconds;
}

/**
 * Calibration from |W| / sqrt(scale) to the peak amplitude of a matching
 * stationary sinusoid on the exact equivalent-Fourier-frequency scale.
 */
export function morletSinusoidAmplitudeCalibration(
  morletOmega0 = defaultWaveletOptions.morletOmega0,
): number {
  const omega0 = requireMorletOmega0(morletOmega0);
  const q = 2 * Math.PI * morletFourierFactor(omega0);
  return (Math.SQRT2 / (Math.PI ** 0.25)) * Math.exp(0.5 * (q - omega0) ** 2);
}

/** Exact sinusoid-amplitude calibration at the default Morlet omega0. */
export const MORLET_SINUSOID_AMPLITUDE_CALIBRATION = morletSinusoidAmplitudeCalibration();

export function waveletQuantityUnit(inputUnit: string, quantity: WaveletQuantity): string {
  const normalized = inputUnit.trim();
  if (quantity === 'raw-l2') return cwtCoefficientUnit(inputUnit);
  if (quantity === 'rectified-power') return normalized ? `(${normalized})²` : 'input²';
  return normalized || 'input';
}

/**
 * Derive a display quantity from one raw L2 coefficient magnitude without retaining
 * additional CWT-sized matrices. The corrected amplitude includes the exact
 * complex-Morlet sinusoid calibration on the equivalent-Fourier-frequency scale.
 */
export function waveletValue(
  rawL2Magnitude: number,
  scaleSeconds: number,
  quantity: WaveletQuantity,
  morletOmega0 = defaultWaveletOptions.morletOmega0,
): number {
  if (!Number.isFinite(rawL2Magnitude) || rawL2Magnitude < 0) return Number.NaN;
  if (quantity === 'raw-l2') return rawL2Magnitude;
  if (!Number.isFinite(scaleSeconds) || scaleSeconds <= 0) return Number.NaN;
  const correctedAmplitude = morletSinusoidAmplitudeCalibration(morletOmega0)
    * rawL2Magnitude / Math.sqrt(scaleSeconds);
  return quantity === 'rectified-power' ? correctedAmplitude ** 2 : correctedAmplitude;
}

/** Derive one frequency row in the requested quantity; raw L2 rows are returned without copying. */
export function waveletRow(
  result: WaveletResult,
  frequencyIndex: number,
  quantity: WaveletQuantity,
): number[] {
  const rawRow = result.amplitude[frequencyIndex];
  if (!rawRow) return [];
  if (quantity === 'raw-l2') return rawRow;
  const scale = result.scaleSeconds[frequencyIndex];
  const omega0 = result.metadata?.morletOmega0 ?? defaultWaveletOptions.morletOmega0;
  return rawRow.map((value) => waveletValue(value, scale, quantity, omega0));
}

export function isInsideWaveletConeOfInfluence(
  timeSeconds: number,
  recordStartSeconds: number,
  recordEndSeconds: number,
  coiHalfWidthSeconds: number,
): boolean {
  if (![timeSeconds, recordStartSeconds, recordEndSeconds, coiHalfWidthSeconds].every(Number.isFinite)
    || recordEndSeconds < recordStartSeconds || coiHalfWidthSeconds < 0) return false;
  const edgeDistance = Math.min(timeSeconds - recordStartSeconds, recordEndSeconds - timeSeconds);
  return edgeDistance + Number.EPSILON * Math.max(1, Math.abs(timeSeconds)) >= coiHalfWidthSeconds;
}

export function isWaveletPointInsideConeOfInfluence(
  result: WaveletResult,
  frequencyIndex: number,
  timeIndex: number,
): boolean {
  const time = result.time[timeIndex];
  const halfWidth = result.coneOfInfluenceHalfWidthSeconds[frequencyIndex];
  if (!Number.isFinite(time) || !Number.isFinite(halfWidth)) return false;
  const start = result.time[0];
  const end = result.time[result.time.length - 1];
  return isInsideWaveletConeOfInfluence(time, start, end, halfWidth);
}

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
  const omega0 = requireMorletOmega0(
    options.morletOmega0 ?? result.metadata?.morletOmega0 ?? defaultWaveletOptions.morletOmega0,
  );
  const quantity = options.quantity ?? 'scale-corrected-amplitude';
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
      const scale = result.scaleSeconds?.[frequencyIndex]
        ?? morletScaleFromFrequency(currentFrequency, omega0);
      if (excludeOutsideConeOfInfluence) {
        const halfWidth = result.coneOfInfluenceHalfWidthSeconds?.[frequencyIndex]
          ?? Math.SQRT2 * scale;
        if (edgeDistance < halfWidth) continue;
      }

      const rawMagnitude = result.amplitude[frequencyIndex]?.[timeIndex];
      const currentAmplitude = waveletValue(rawMagnitude, scale, quantity, omega0);
      if (!Number.isFinite(currentAmplitude) || currentAmplitude < 0 || currentAmplitude <= bestAmplitude) continue;
      bestAmplitude = currentAmplitude;
      bestFrequency = currentFrequency;
    }

    if (Number.isFinite(bestFrequency) && bestAmplitude > 0) {
      frequency[timeIndex] = bestFrequency;
      amplitude[timeIndex] = bestAmplitude;
    }
  }

  return {
    time: [...result.time],
    frequency,
    amplitude,
    quantity,
    unit: waveletQuantityUnit(result.inputUnit, quantity),
  };
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
      method: 'Kaiser-windowed sinc anti-alias resampling',
      inputSamples: n,
      computedSamples: targetCount,
      inputDtSeconds: dt,
      effectiveDtSeconds: nextDt,
      passbandEndHz: 0.8 * targetNyquistHz,
      stopbandStartHz: targetNyquistHz,
      kaiserBeta: KAISER_BETA,
      kernelHalfWidthInputSamples: halfWidth,
      boundaryTreatment: 'symmetric reflection at both input edges',
    },
  };
}

interface WaveletMetadataArguments {
  omega0: number;
  removedMean: number | null;
  requestedFrequencyBoundsHz: [number, number];
  effectiveFrequencyBoundsHz: [number, number] | null;
  nyquistFrequencyHz: number;
  highFrequencyLimitHz: number;
  paddedSignalSamples: number;
  fftLength: number;
}

function buildWaveletMetadata(arguments_: WaveletMetadataArguments): WaveletTransformMetadata {
  return {
    motherWavelet: 'complex Morlet',
    morletOmega0: arguments_.omega0,
    minimumAdmissibleOmega0: MIN_MORLET_OMEGA0,
    admissibility: 'uncorrected Morlet restricted to omega0 >= 5',
    morletFourierFactor: morletFourierFactor(arguments_.omega0),
    scaleFrequencyRelation: 'f = (omega0 + sqrt(omega0^2 + 2)) / (4*pi*scale)',
    meanRemoved: arguments_.removedMean !== null,
    removedMean: arguments_.removedMean,
    meanRemovalStage: 'after anti-alias resampling and before CWT',
    requestedFrequencyBoundsHz: arguments_.requestedFrequencyBoundsHz,
    effectiveFrequencyBoundsHz: arguments_.effectiveFrequencyBoundsHz,
    nyquistFrequencyHz: arguments_.nyquistFrequencyHz,
    highFrequencyLimitFractionOfNyquist: MORLET_NYQUIST_FREQUENCY_FRACTION,
    highFrequencyLimitHz: arguments_.highFrequencyLimitHz,
    paddedSignalSamples: arguments_.paddedSignalSamples,
    fftLength: arguments_.fftLength,
    padding: 'zero',
    kernelCentering: 'integer-sample centre aligned to output samples',
    coneOfInfluenceDefinition: 'sqrt(2) * scale (Morlet power e-folding time)',
    quantityDefinitions: {
      rawL2: '|W|',
      scaleCorrectedAmplitude: 'C(omega0) * |W| / sqrt(scale)',
      rectifiedPower: 'C(omega0)^2 * |W|^2 / scale',
    },
    sinusoidAmplitudeCalibration: morletSinusoidAmplitudeCalibration(arguments_.omega0),
    sinusoidAmplitudeCalibrationDefinition: 'C(omega0) = sqrt(2)/pi^(1/4) * exp(((omega0 + sqrt(omega0^2 + 2))/2 - omega0)^2 / 2)',
    scaleCorrectedAmplitudeInterpretation: 'carrier-sinusoid-calibrated, frequency-comparable Morlet amplitude; not an instantaneous signal envelope',
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
  const omega0 = requireMorletOmega0(settings.morletOmega0 ?? defaultWaveletOptions.morletOmega0);
  const requestedMinFrequency = isFiniteNumber(settings.minFrequency) && settings.minFrequency > 0
    ? settings.minFrequency
    : defaultWaveletOptions.minFrequency;
  const requestedMaxFrequency = isFiniteNumber(settings.maxFrequency) && settings.maxFrequency > requestedMinFrequency
    ? settings.maxFrequency
    : Math.max(defaultWaveletOptions.maxFrequency, requestedMinFrequency * 10);
  const requestedFrequencyBoundsHz: [number, number] = [requestedMinFrequency, requestedMaxFrequency];

  if (values.length === 0 || !isFiniteNumber(dt) || dt <= 0) {
    const inputSamples = values.length;
    const nyquist = dt > 0 ? 0.5 / dt : 0;
    const highFrequencyLimitHz = nyquist * MORLET_NYQUIST_FREQUENCY_FRACTION;
    return {
      time: [],
      frequency: [],
      scaleSeconds: [],
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
      coneOfInfluenceHalfWidthSeconds: [],
      frequencyHasValidCone: [],
      metadata: buildWaveletMetadata({
        omega0,
        removedMean: null,
        requestedFrequencyBoundsHz,
        effectiveFrequencyBoundsHz: null,
        nyquistFrequencyHz: nyquist,
        highFrequencyLimitHz,
        paddedSignalSamples: 0,
        fftLength: 0,
      }),
    };
  }

  const maxSamples = isFiniteNumber(settings.maxSamples) && settings.maxSamples >= 64
    ? Math.floor(settings.maxSamples)
    : defaultWaveletOptions.maxSamples;
  const working = resampleEvenly(values, dt, maxSamples);
  const removedMean = working.values.reduce((sum, value) => sum + value, 0) / working.values.length;
  const signal = subtractMean(working.values);
  const n = signal.length;
  const nyquist = 0.5 / working.dt;
  const minFrequency = Math.max(requestedMinFrequency, 1 / Math.max(n * working.dt, working.dt));
  const morletSafeLimitHz = nyquist * MORLET_NYQUIST_FREQUENCY_FRACTION;
  const antiAliasPassbandEndHz = working.metadata.passbandEndHz ?? morletSafeLimitHz;
  const highFrequencyLimitHz = Math.min(morletSafeLimitHz, antiAliasPassbandEndHz);
  const maxFrequency = Math.min(requestedMaxFrequency, highFrequencyLimitHz);
  const frequencyCount = isFiniteNumber(settings.frequencyCount)
    ? Math.max(2, Math.floor(settings.frequencyCount))
    : defaultWaveletOptions.frequencyCount;
  const frequency = logSpace(minFrequency, maxFrequency, frequencyCount);

  if (frequency.length === 0) {
    return {
      time: [],
      frequency: [],
      scaleSeconds: [],
      amplitude: [],
      inputUnit: unit,
      unit: coefficientUnit,
      normalization: 'L2',
      effectiveDt: working.dt,
      inputSamples: values.length,
      computedSamples: n,
      resampling: working.metadata,
      coneOfInfluenceHalfWidthSeconds: [],
      frequencyHasValidCone: [],
      metadata: buildWaveletMetadata({
        omega0,
        removedMean,
        requestedFrequencyBoundsHz,
        effectiveFrequencyBoundsHz: null,
        nyquistFrequencyHz: nyquist,
        highFrequencyLimitHz,
        paddedSignalSamples: 0,
        fftLength: 0,
      }),
    };
  }

  const paddedPointCount = n * 2;
  const fftLength = nextPowerOfTwo(paddedPointCount) * 2;
  const input = Array(fftLength).fill(0);
  for (let i = 0; i < n; i += 1) input[i] = signal[i];

  const signalSpectrum = fftComplex(input);
  const time = Array.from({ length: n }, (_, index) => index * working.dt);
  const scaleSeconds = frequency.map((value) => morletScaleFromFrequency(value, omega0));
  const coneOfInfluenceHalfWidthSeconds = scaleSeconds.map((scale) => Math.SQRT2 * scale);
  const recordEndTime = time[time.length - 1] ?? 0;
  const middleIndex = Math.floor((time.length - 1) / 2);
  const maximumSampledEdgeDistance = Math.min(
    time[middleIndex] ?? 0,
    recordEndTime - (time[middleIndex] ?? 0),
  );
  const frequencyHasValidCone = coneOfInfluenceHalfWidthSeconds.map(
    (halfWidth) => halfWidth <= maximumSampledEdgeDistance + Number.EPSILON * Math.max(1, recordEndTime),
  );
  const amplitude: number[][] = [];
  // Centre the discrete kernel on an integer sample. A half-sample kernel
  // centre shifts impulse maxima by one displayed sample after convolution.
  const centerIndex = Math.floor(paddedPointCount / 2);
  const centerTime = centerIndex * working.dt;
  const startIndex = centerIndex;
  const morletNorm = Math.PI ** -0.25;

  for (let frequencyIndex = 0; frequencyIndex < frequency.length; frequencyIndex += 1) {
    const scale = scaleSeconds[frequencyIndex];
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
    scaleSeconds,
    amplitude,
    inputUnit: unit,
    unit: coefficientUnit,
    normalization: 'L2',
    effectiveDt: working.dt,
    inputSamples: values.length,
    computedSamples: n,
    resampling: working.metadata,
    coneOfInfluenceHalfWidthSeconds,
    frequencyHasValidCone,
    metadata: buildWaveletMetadata({
      omega0,
      removedMean,
      requestedFrequencyBoundsHz,
      effectiveFrequencyBoundsHz: [frequency[0], frequency[frequency.length - 1]],
      nyquistFrequencyHz: nyquist,
      highFrequencyLimitHz,
      paddedSignalSamples: paddedPointCount,
      fftLength,
    }),
  };
}
