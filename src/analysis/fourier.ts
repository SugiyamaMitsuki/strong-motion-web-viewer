import type { FourierSpectrum } from '../types/waveform';
import { buildFrequencyCosineTaper, referenceFftLength } from './calculus';
import { fftComplex } from './fft';
import { subtractMean } from './statistics';

export interface FourierOptions {
  applyFrequencyTaper: boolean;
  applyTimeTaper?: boolean;
  timeTaperFraction?: number;
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

export function computeFourierSpectrum(
  values: readonly number[],
  dt: number,
  unit: string,
  options: FourierOptions = defaultFourierOptions,
): FourierSpectrum {
  const nOriginal = values.length;
  if (nOriginal === 0 || dt <= 0) return { frequency: [], amplitude: [], unit };

  const nFft = referenceFftLength(nOriginal);
  const centered = subtractMean(values);
  const prepared = options.applyTimeTaper
    ? cosineTimeTaper(centered, options.timeTaperFraction ?? defaultFourierOptions.timeTaperFraction ?? 0.05)
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

  return { frequency, amplitude, unit };
}
