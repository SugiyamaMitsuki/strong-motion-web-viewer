export type Quantity = 'acceleration' | 'velocity' | 'displacement';

export type ComponentCode = 'NS' | 'EW' | 'UD' | 'OTHER';

export type SourceType = 'knet' | 'kiknet' | 'jma' | 'csv' | 'custom' | 'unknown';

export interface WaveformMetadata {
  originTime?: string;
  recordTime?: string;
  stationCode?: string;
  stationLat?: number;
  stationLon?: number;
  stationHeightM?: number;
  eventLat?: number;
  eventLon?: number;
  depthKm?: number;
  magnitude?: number;
  durationSec?: number;
  direction?: string;
  scaleFactorText?: string;
  maxAccelerationGalHeader?: number;
  lastCorrection?: string;
  memo?: string;
  [key: string]: string | number | undefined;
}

export interface WaveformRecord {
  id: string;
  fileName: string;
  sourceType: SourceType;
  component: ComponentCode;
  componentLabel: string;
  quantity: Quantity;
  unit: string;
  values: number[];
  dt: number;
  samplingHz: number;
  metadata: WaveformMetadata;
  notes?: string[];
}

export interface DerivedWaveform {
  sourceRecordId: string;
  fileName: string;
  component: ComponentCode;
  componentLabel: string;
  dt: number;
  samplingHz: number;
  time: number[];
  acceleration: number[];
  velocity: number[];
  displacement: number[];
  metadata: WaveformMetadata;
}

export interface CsvParseOptions {
  defaultSamplingHz: number;
  defaultQuantity: Quantity;
}

export interface PreprocessSettings {
  removeMean: boolean;
  detrend: boolean;
  applyHighpass: boolean;
  highpassHz: number;
  applyLowpass: boolean;
  lowpassHz: number;
  correctIntegrationDrift: boolean;
}

export interface ResponseSpectrumSettings {
  dampingRatio: number;
  minPeriod: number;
  maxPeriod: number;
  periodCount: number;
}

export interface AppSettings {
  csv: CsvParseOptions;
  preprocess: PreprocessSettings;
  responseSpectrum: ResponseSpectrumSettings;
}

export interface FourierSpectrum {
  frequency: number[];
  amplitude: number[];
  unit: string;
}

export interface ResponseSpectrumPoint {
  period: number;
  sd: number;
  psv: number;
  psa: number;
}

export interface ResponseSpectrumResult {
  component: ComponentCode;
  componentLabel: string;
  points: ResponseSpectrumPoint[];
}

export interface HorizontalVerticalRatioResult {
  id: string;
  label: string;
  quantity: Quantity;
  frequency: number[];
  ratio: number[];
  horizontalComponents: string[];
  verticalComponent: string;
  peakFrequency?: number;
  peakPeriod?: number;
  peakRatio?: number;
}

export interface PeakSummary {
  sourceRecordId: string;
  fileName: string;
  component: ComponentCode;
  componentLabel: string;
  pga: number;
  pgv: number;
  pgd: number;
}

export interface JmaIntensityResult {
  intensity: number;
  classLabel: string;
  thresholdAcceleration: number;
  durationAboveThreshold: number;
  usedSamples: number;
  available: boolean;
  message?: string;
}

export interface ParseResult {
  records: WaveformRecord[];
  warnings: string[];
}
