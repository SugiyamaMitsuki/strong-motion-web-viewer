import type { DerivedWaveform, PreprocessSettings, WaveformRecord } from '../types/waveform';
import { frequencyDomainDerivative, type FrequencyTaperSettings } from './calculus';
import { applyPreprocess, frequencyTaperSettingsFromPreprocess } from './preprocess';
import { removeLinearTrend, subtractMean } from './statistics';

function driftCorrect(values: number[], settings: PreprocessSettings): number[] {
  if (!settings.correctIntegrationDrift) return values;
  return subtractMean(removeLinearTrend(values));
}

function quantityOrder(quantity: WaveformRecord['quantity']): number {
  if (quantity === 'acceleration') return 2;
  if (quantity === 'velocity') return 1;
  return 0;
}

function deriveQuantity(
  input: readonly number[],
  dt: number,
  sourceQuantity: WaveformRecord['quantity'],
  targetQuantity: WaveformRecord['quantity'],
  taperSettings: FrequencyTaperSettings,
  settings: PreprocessSettings,
): number[] {
  const derivativeOrder = quantityOrder(targetQuantity) - quantityOrder(sourceQuantity);
  const transformed = derivativeOrder === 0 && !taperSettings.enabled
    ? [...input]
    : frequencyDomainDerivative(input, dt, derivativeOrder, taperSettings);

  return derivativeOrder < 0 ? driftCorrect(transformed, settings) : transformed;
}

export function buildDerivedWaveform(record: WaveformRecord, settings: PreprocessSettings): DerivedWaveform {
  const dt = record.dt;
  const input = applyPreprocess(record.values, dt, settings);
  const taperSettings = frequencyTaperSettingsFromPreprocess(settings, dt);
  const acceleration = deriveQuantity(input, dt, record.quantity, 'acceleration', taperSettings, settings);
  const velocity = deriveQuantity(input, dt, record.quantity, 'velocity', taperSettings, settings);
  const displacement = deriveQuantity(input, dt, record.quantity, 'displacement', taperSettings, settings);

  const time = Array.from({ length: record.values.length }, (_, i) => i * dt);

  return {
    sourceRecordId: record.id,
    fileName: record.fileName,
    component: record.component,
    componentLabel: record.componentLabel,
    dt,
    samplingHz: record.samplingHz,
    time,
    acceleration,
    velocity,
    displacement,
    metadata: record.metadata,
  };
}

export function buildDerivedWaveforms(records: WaveformRecord[], settings: PreprocessSettings): DerivedWaveform[] {
  return records.map((record) => buildDerivedWaveform(record, settings));
}
