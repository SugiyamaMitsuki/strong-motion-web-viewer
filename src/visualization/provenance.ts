import type { DerivedWaveform, PreprocessSettings } from '../types/waveform';

declare const __APP_VERSION__: string;
declare const __BUILD_REVISION__: string;

export interface FigureProvenance {
  schema: 'strong-motion-figure-provenance/1.0';
  software: {
    name: 'Strong Motion Web Viewer';
    version: string;
    buildRevision: string;
  };
  records: {
    sourceFiles: string[];
    stationCodes: string[];
    originTimes: string[];
    recordTimes: string[];
    components: string[];
    samplingRatesHz: number[];
    durationsSec: number[];
  };
  preprocessing?: PreprocessSettings;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function nonEmpty(values: Array<string | undefined>): string[] {
  return unique(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)));
}

function buildVersion(): { version: string; buildRevision: string } {
  return {
    version: typeof __APP_VERSION__ === 'undefined' ? 'test' : __APP_VERSION__,
    buildRevision: typeof __BUILD_REVISION__ === 'undefined' ? 'test' : __BUILD_REVISION__,
  };
}

export function buildFigureProvenance(
  waveforms: readonly DerivedWaveform[],
  preprocessing?: PreprocessSettings,
): FigureProvenance {
  const effectivePreprocessing = preprocessing ?? waveforms.find((waveform) => waveform.preprocessing)?.preprocessing;
  return {
    schema: 'strong-motion-figure-provenance/1.0',
    software: {
      name: 'Strong Motion Web Viewer',
      ...buildVersion(),
    },
    records: {
      sourceFiles: unique(waveforms.map((waveform) => waveform.fileName)),
      stationCodes: nonEmpty(waveforms.map((waveform) => waveform.metadata.stationCode)),
      originTimes: nonEmpty(waveforms.map((waveform) => waveform.metadata.originTime)),
      recordTimes: nonEmpty(waveforms.map((waveform) => waveform.metadata.recordTime)),
      components: unique(waveforms.map((waveform) => waveform.componentLabel)),
      samplingRatesHz: unique(waveforms.map((waveform) => Number(waveform.samplingHz.toPrecision(10)))),
      durationsSec: unique(waveforms.map((waveform) => Number((((waveform.time[waveform.time.length - 1] ?? 0) - (waveform.time[0] ?? 0))).toPrecision(10)))),
    },
    ...(effectivePreprocessing ? { preprocessing: { ...effectivePreprocessing } } : {}),
  };
}

export function preprocessingLabel(settings: PreprocessSettings): string {
  const concise = (value: number): string => Number(value.toPrecision(6)).toString();
  const operations = [
    settings.removeMean && 'mean removed',
    settings.detrend && 'linear trend removed',
    settings.applyHighpass && `FFT cosine HP ${concise(settings.highpassHz)} Hz`,
    settings.applyLowpass && `FFT cosine LP ${concise(settings.lowpassHz)} Hz`,
    settings.correctIntegrationDrift && 'integration drift corrected',
  ].filter((value): value is string => Boolean(value));
  return operations.length > 0 ? operations.join('; ') : 'no preprocessing';
}

export function datasetLabel(waveforms: readonly DerivedWaveform[]): string {
  const stations = nonEmpty(waveforms.map((waveform) => waveform.metadata.stationCode));
  const recordTimes = nonEmpty(waveforms.map((waveform) => waveform.metadata.recordTime));
  const samplingRates = unique(waveforms.map((waveform) => Number(waveform.samplingHz.toPrecision(10))));
  return [
    stations.length === 1 ? `station ${stations[0]}` : `${stations.length || 'unknown'} stations`,
    recordTimes.length === 1 ? `record ${recordTimes[0]}` : `${recordTimes.length || 'unknown'} record times`,
    samplingRates.length === 1 ? `${samplingRates[0]} Hz` : `${samplingRates.length} sampling rates`,
  ].join('; ');
}
