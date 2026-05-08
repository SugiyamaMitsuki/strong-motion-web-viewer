import type { PreprocessSettings } from '../types/waveform';
import type { FrequencyTaperSettings } from './calculus';
import { removeLinearTrend, subtractMean } from './statistics';

const TAPER_EDGE_RATIO = 0.1;

function validCutoff(value: number, nyquistHz: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0 || value >= nyquistHz) return undefined;
  return value;
}

export function frequencyTaperSettingsFromPreprocess(settings: PreprocessSettings, dt: number): FrequencyTaperSettings {
  if (dt <= 0) return { enabled: false, leftHz: 0, startHz: 0, endHz: 0, rightHz: 0 };

  const nyquistHz = 0.5 / dt;
  const highpassHz = settings.applyHighpass ? validCutoff(settings.highpassHz, nyquistHz) : undefined;
  const lowpassHz = settings.applyLowpass ? validCutoff(settings.lowpassHz, nyquistHz) : undefined;

  if (highpassHz === undefined && lowpassHz === undefined) {
    return { enabled: false, leftHz: 0, startHz: 0, endHz: nyquistHz, rightHz: nyquistHz };
  }

  if (highpassHz !== undefined && lowpassHz !== undefined && highpassHz >= lowpassHz) {
    return { enabled: false, leftHz: 0, startHz: 0, endHz: nyquistHz, rightHz: nyquistHz };
  }

  const startHz = highpassHz ?? 0;
  const leftHz = highpassHz !== undefined ? Math.max(0, highpassHz * (1 - TAPER_EDGE_RATIO)) : 0;
  const endHz = lowpassHz ?? nyquistHz;
  const rightHz = lowpassHz !== undefined ? Math.min(nyquistHz, lowpassHz * (1 + TAPER_EDGE_RATIO)) : nyquistHz;

  return { enabled: true, leftHz, startHz, endHz, rightHz };
}

export function applyPreprocess(values: readonly number[], _dt: number, settings: PreprocessSettings): number[] {
  let output = [...values];

  if (settings.removeMean) output = subtractMean(output);
  if (settings.detrend) output = removeLinearTrend(output);

  return output;
}

export function integrateTrapezoid(values: readonly number[], dt: number): number[] {
  const output = new Array<number>(values.length);
  if (values.length === 0) return [];
  output[0] = 0;

  for (let i = 1; i < values.length; i += 1) {
    output[i] = output[i - 1] + 0.5 * (values[i - 1] + values[i]) * dt;
  }

  return output;
}

export function differentiate(values: readonly number[], dt: number): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1 || dt <= 0) return Array(n).fill(0);

  const output = new Array<number>(n);
  output[0] = (values[1] - values[0]) / dt;
  output[n - 1] = (values[n - 1] - values[n - 2]) / dt;

  for (let i = 1; i < n - 1; i += 1) {
    output[i] = (values[i + 1] - values[i - 1]) / (2 * dt);
  }

  return output;
}
