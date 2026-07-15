import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  computeDominantWaveletRidge,
  computeMorletWavelet,
  defaultWaveletOptions,
  isWaveletPointInsideConeOfInfluence,
  MORLET_CWT_NORMALIZATION,
  waveletQuantityUnit,
  waveletRow,
  waveletMagnitudeToDecibels,
  type WaveletQuantity,
  type WaveletResult,
} from '../analysis/wavelet';
import { downloadFigureMetadata } from '../export/figureMetadata';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { safeFileName } from '../utils/file';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { downsampleSegments } from '../visualization/downsample';
import {
  JOURNAL_DATA_LINE_PT,
  JOURNAL_AXIS_FONT_PT,
  JOURNAL_LINE_ART_DPI,
  JOURNAL_MIN_LINE_PT,
  JOURNAL_PANEL_FONT_PT,
  pointsToUserUnits,
} from '../visualization/journal';
import { buildFigureProvenance, datasetLabel, preprocessingLabel } from '../visualization/provenance';
import { alignWaveformTimes, buildWaveformRecordSets } from '../visualization/waveformGroups';

interface WaveletPanelProps {
  waveforms: DerivedWaveform[];
  /** Optional deterministic initial state for embedded figures and SSR regression tests. */
  initialDisplayQuantity?: WaveletQuantity;
  initialColorMode?: WaveletColorMode;
}

type WaveletResolution = 'fast' | 'standard' | 'detailed' | 'publication';
type WaveletYAxis = 'frequency' | 'period';
type WaveletColorMode = 'fixed-db' | 'coi-percentile';
type WaveletLayout = 'single' | 'three-component';
type MorletPreset = 6 | 8;

interface DisplayGrid {
  columns: number;
  values: number[][];
  /** One aggregated positive value per displayed bin that contains COI-valid samples. */
  coiValues: number[];
  invalidRows: number;
  aggregation: 'RMS of quantity' | 'mean power';
}

interface ActiveColorScale {
  mode: WaveletColorMode;
  minimum: number;
  maximum: number;
  comparable: boolean;
  label: string;
  referenceNote?: string;
  summary: string;
  transform: (value: number) => number;
  ticks: Array<{ value: number; label: string }>;
  clippedLowPercent: number;
  clippedHighPercent: number;
}

const WIDTH = 980;
const HEIGHT = 620;
const PRINT_WIDTH_MM = 180;
const PANEL_FONT = pointsToUserUnits(JOURNAL_PANEL_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const AXIS_FONT = pointsToUserUnits(JOURNAL_AXIS_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const SMALL_FONT = pointsToUserUnits(8, WIDTH, PRINT_WIDTH_MM);
const DATA_LINE = pointsToUserUnits(JOURNAL_DATA_LINE_PT, WIDTH, PRINT_WIDTH_MM);
const AXIS_LINE = pointsToUserUnits(0.6, WIDTH, PRINT_WIDTH_MM);
const GUIDE_LINE = pointsToUserUnits(JOURNAL_MIN_LINE_PT, WIDTH, PRINT_WIDTH_MM);
const MARGIN = { left: 84, right: 154, top: 40, bottom: 58 };
const WAVEFORM_TOP = 56;
const WAVEFORM_HEIGHT = 132;
const HEATMAP_TOP = 250;
const HEATMAP_HEIGHT = 292;
const COLORBAR_X = WIDTH - 90;
const COLORBAR_WIDTH = 14;
const COLORBAR_LABEL_X = COLORBAR_X - 18;
const COLORBAR_TICK_X = COLORBAR_X + COLORBAR_WIDTH + 8;
const COLOR_STOPS = [
  { t: 0, color: '#440154' },
  { t: 0.2, color: '#414487' },
  { t: 0.4, color: '#2A788E' },
  { t: 0.6, color: '#22A884' },
  { t: 0.8, color: '#7AD151' },
  { t: 1, color: '#FDE725' },
];
const MAX_HEATMAP_COLOURS = 256;

const RESOLUTION_OPTIONS: Record<WaveletResolution, { label: string; frequencyCount: number; maxSamples: number; displayColumns: number }> = {
  fast: { label: 'Fast', frequencyCount: 48, maxSamples: 4096, displayColumns: 360 },
  standard: { label: 'Standard', frequencyCount: 96, maxSamples: 6144, displayColumns: 520 },
  detailed: { label: 'Detailed', frequencyCount: 128, maxSamples: 8192, displayColumns: 640 },
  publication: { label: 'Publication', frequencyCount: 160, maxSamples: 8192, displayColumns: 760 },
};

function quantityLabel(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'Acceleration';
  if (quantity === 'velocity') return 'Velocity';
  return 'Displacement';
}

function unitForQuantity(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function valuesForQuantity(waveform: DerivedWaveform, quantity: Quantity): number[] {
  if (quantity === 'acceleration') return waveform.acceleration;
  if (quantity === 'velocity') return waveform.velocity;
  return waveform.displacement;
}

function waveletQuantityLabel(quantity: WaveletQuantity): string {
  if (quantity === 'scale-corrected-amplitude') return 'Corrected amplitude';
  if (quantity === 'rectified-power') return 'Rectified power';
  return 'Raw L2 magnitude';
}

function waveletQuantityDefinition(quantity: WaveletQuantity): string {
  if (quantity === 'scale-corrected-amplitude') return 'C(ω₀) |W| / √scale; calibrated to the carrier-sinusoid amplitude';
  if (quantity === 'rectified-power') return 'C(ω₀)² |W|² / scale; scale-bias-rectified power';
  return '|W| from the L2-normalized CWT; frequency dependent for equal-amplitude sinusoids';
}

function effectiveComputationDt(waveform: DerivedWaveform, quantity: Quantity, maxSamples: number): number {
  const count = valuesForQuantity(waveform, quantity).length;
  if (count <= maxSamples || count <= 1) return waveform.dt;
  return ((count - 1) * waveform.dt) / (maxSamples - 1);
}

function sharedFrequencyBounds(
  waveforms: readonly DerivedWaveform[],
  quantity: Quantity,
  requestedMin: number,
  requestedMax: number,
  maxSamples: number,
): [number, number] | undefined {
  let minimum = Number.isFinite(requestedMin) && requestedMin > 0 ? requestedMin : defaultWaveletOptions.minFrequency;
  let maximum = Number.isFinite(requestedMax) && requestedMax > minimum ? requestedMax : defaultWaveletOptions.maxFrequency;
  for (const waveform of waveforms) {
    const count = valuesForQuantity(waveform, quantity).length;
    if (count < 2 || !Number.isFinite(waveform.dt) || waveform.dt <= 0) return undefined;
    const dt = effectiveComputationDt(waveform, quantity, maxSamples);
    const computedCount = Math.min(count, maxSamples);
    minimum = Math.max(minimum, 1 / (computedCount * dt));
    maximum = Math.min(maximum, 0.4 / dt);
    if (waveform.preprocessing?.applyHighpass) minimum = Math.max(minimum, waveform.preprocessing.highpassHz);
    if (waveform.preprocessing?.applyLowpass) maximum = Math.min(maximum, waveform.preprocessing.lowpassHz);
  }
  return minimum < maximum ? [minimum, maximum] : undefined;
}

function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs < 0.01 || abs >= 10000) return value.toExponential(1);
  if (abs < 1) return Number(value.toFixed(3)).toString();
  if (abs < 10) return Number(value.toFixed(2)).toString();
  if (abs < 100) return Number(value.toFixed(1)).toString();
  return Number(value.toFixed(0)).toString();
}

function niceTicks(min: number, max: number, count = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
  const span = max - min;
  const rawStep = span / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(Math.abs(rawStep)));
  const error = Math.abs(rawStep) / power;
  const factor = error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1;
  const step = factor * power;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 0.5; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

function logTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) return [];
  const ticks: number[] = [];
  const startExp = Math.floor(Math.log10(min));
  const endExp = Math.ceil(Math.log10(max));
  for (let exp = startExp; exp <= endExp; exp += 1) {
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * 10 ** exp;
      if (value >= min * 0.999 && value <= max * 1.001) ticks.push(value);
    }
  }
  return ticks;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function interpolateColor(left: string, right: string, ratio: number): string {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const values = a.map((channel, index) => Math.round(channel * (1 - ratio) + b[index] * ratio));
  return `rgb(${values[0]}, ${values[1]}, ${values[2]})`;
}

function colorForValue(value: number, scale: ActiveColorScale): string {
  if (!Number.isFinite(value)) return '#f2f2f2';
  const transformed = scale.transform(value);
  const rawPosition = (transformed - scale.minimum) / (scale.maximum - scale.minimum);
  const unclipped = Number.isFinite(rawPosition) ? Math.max(0, Math.min(1, rawPosition)) : 0;
  // Quantise to a 256-entry perceptual LUT. This keeps the colour mapping
  // deterministic and lets thousands of cells share a small number of paths.
  const t = Math.round(unclipped * (MAX_HEATMAP_COLOURS - 1)) / (MAX_HEATMAP_COLOURS - 1);
  for (let i = 0; i < COLOR_STOPS.length - 1; i += 1) {
    const left = COLOR_STOPS[i];
    const right = COLOR_STOPS[i + 1];
    if (t >= left.t && t <= right.t) {
      return interpolateColor(left.color, right.color, (t - left.t) / (right.t - left.t));
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].color;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * p)));
  return sortedValues[index];
}

function buildDisplayGrid(result: WaveletResult, quantity: WaveletQuantity, maxColumns = 360): DisplayGrid {
  const timeCount = result.time.length;
  const columns = Math.max(1, Math.min(maxColumns, timeCount));
  const stride = Math.max(1, Math.ceil(timeCount / columns));
  const coiValues: number[] = [];
  let invalidRows = 0;
  const values = result.amplitude.map((_, frequencyIndex) => {
    if (!result.frequencyHasValidCone[frequencyIndex]) {
      invalidRows += 1;
      return Array(Math.ceil(timeCount / stride)).fill(Number.NaN);
    }
    const row = waveletRow(result, frequencyIndex, quantity);
    const nextRow: number[] = [];
    for (let start = 0; start < timeCount; start += stride) {
      const end = Math.min(timeCount, start + stride);
      let sum = 0;
      let count = 0;
      let coiSum = 0;
      let coiCount = 0;
      for (let i = start; i < end; i += 1) {
        const value = row[i];
        if (Number.isFinite(value) && value >= 0) {
          const aggregationValue = quantity === 'rectified-power' ? value : value * value;
          sum += aggregationValue;
          count += 1;
          if (value > 0 && isWaveletPointInsideConeOfInfluence(result, frequencyIndex, i)) {
            coiSum += aggregationValue;
            coiCount += 1;
          }
        }
      }
      const aggregate = count > 0
        ? quantity === 'rectified-power' ? sum / count : Math.sqrt(sum / count)
        : Number.NaN;
      nextRow.push(aggregate);
      if (coiCount > 0) {
        const coiAggregate = quantity === 'rectified-power'
          ? coiSum / coiCount
          : Math.sqrt(coiSum / coiCount);
        if (Number.isFinite(coiAggregate) && coiAggregate > 0) coiValues.push(coiAggregate);
      }
    }
    return nextRow;
  });

  return {
    columns: values[0]?.length ?? columns,
    values,
    coiValues,
    invalidRows,
    aggregation: quantity === 'rectified-power' ? 'mean power' : 'RMS of quantity',
  };
}

function buildActiveColorScale(
  grids: readonly DisplayGrid[],
  mode: WaveletColorMode,
  dbMinimum: number,
  dbMaximum: number,
  dbReference: number,
  unit: string,
  quantity: WaveletQuantity,
): ActiveColorScale {
  const dbFactor = quantity === 'rectified-power' ? 10 : 20;
  if (mode === 'fixed-db') {
    const safeMinimum = Number.isFinite(dbMinimum) ? dbMinimum : -60;
    const requestedMaximum = Number.isFinite(dbMaximum) ? dbMaximum : 20;
    const safeMaximum = requestedMaximum > safeMinimum ? requestedMaximum : safeMinimum + 10;
    const safeReference = Number.isFinite(dbReference) && dbReference > 0 ? dbReference : 1;
    const transform = (value: number): number => quantity === 'rectified-power'
      ? value > 0 ? 10 * Math.log10(value / safeReference) : Number.NEGATIVE_INFINITY
      : waveletMagnitudeToDecibels(value, safeReference);
    let validCount = 0;
    let clippedLow = 0;
    let clippedHigh = 0;
    grids.forEach((grid) => grid.coiValues.forEach((value) => {
      if (!Number.isFinite(value) || value <= 0) return;
      validCount += 1;
      const transformed = transform(value);
      if (transformed < safeMinimum) clippedLow += 1;
      if (transformed > safeMaximum) clippedHigh += 1;
    }));
    return {
      mode,
      minimum: safeMinimum,
      maximum: safeMaximum,
      comparable: true,
      label: `${waveletQuantityLabel(quantity)} [dB]`,
      referenceNote: `re ${formatTick(safeReference)} ${unit}`,
      summary: `Fixed ${formatTick(safeMinimum)} to ${formatTick(safeMaximum)} dB re ${formatTick(safeReference)} ${unit}; ${dbFactor} log10 transform.`,
      transform,
      ticks: Array.from({ length: 5 }, (_, index) => {
        const value = safeMinimum + ((safeMaximum - safeMinimum) * index) / 4;
        return { value, label: formatTick(value) };
      }),
      clippedLowPercent: validCount > 0 ? (100 * clippedLow) / validCount : 0,
      clippedHighPercent: validCount > 0 ? (100 * clippedHigh) / validCount : 0,
    };
  }

  const sortedValues: number[] = [];
  grids.forEach((grid) => grid.coiValues.forEach((value) => {
    if (Number.isFinite(value) && value > 0) sortedValues.push(value);
  }));
  sortedValues.sort((a, b) => a - b);
  const low = percentile(sortedValues, 0.02) || 1e-12;
  const highCandidate = percentile(sortedValues, 0.98);
  const high = highCandidate > low ? highCandidate : low * 10;
  const minimum = Math.log10(low);
  const maximum = Math.log10(high);
  let clippedLow = 0;
  let clippedHigh = 0;
  sortedValues.forEach((value) => {
    if (value < low) clippedLow += 1;
    if (value > high) clippedHigh += 1;
  });
  return {
    mode,
    minimum,
    maximum,
    comparable: false,
    label: `${waveletQuantityLabel(quantity)} [${unit}]`,
    summary: 'Shared 2nd–98th percentile log range from COI-valid coefficients only; colours are not comparable across separate exports.',
    transform: (value) => value > 0 ? Math.log10(value) : Number.NEGATIVE_INFINITY,
    ticks: Array.from({ length: 5 }, (_, index) => {
      const transformed = minimum + ((maximum - minimum) * index) / 4;
      return { value: transformed, label: formatTick(10 ** transformed) };
    }),
    clippedLowPercent: sortedValues.length > 0 ? (100 * clippedLow) / sortedValues.length : 0,
    clippedHighPercent: sortedValues.length > 0 ? (100 * clippedHigh) / sortedValues.length : 0,
  };
}

function frequencyBoundaries(frequency: readonly number[]): number[] {
  if (frequency.length === 0) return [];
  if (frequency.length === 1) return [frequency[0] / Math.SQRT2, frequency[0] * Math.SQRT2];

  const boundaries = Array(frequency.length + 1).fill(0);
  for (let i = 1; i < frequency.length; i += 1) boundaries[i] = Math.sqrt(frequency[i - 1] * frequency[i]);
  const firstRatio = frequency[1] / frequency[0];
  const lastRatio = frequency[frequency.length - 1] / frequency[frequency.length - 2];
  boundaries[0] = frequency[0] / Math.sqrt(firstRatio);
  boundaries[frequency.length] = frequency[frequency.length - 1] * Math.sqrt(lastRatio);
  return boundaries;
}

function buildWaveformPath(time: readonly number[], values: readonly number[], xScale: (value: number) => number, yScale: (value: number) => number): string {
  const parts: string[] = [];
  downsampleSegments(time, values, 1600).forEach((segment) => {
    segment.x.forEach((timeValue, index) => {
      parts.push(`${index === 0 ? 'M' : 'L'}${xScale(timeValue).toFixed(2)},${yScale(segment.y[index]).toFixed(2)}`);
    });
  });
  return parts.join(' ');
}

function buildRidgePath(
  time: readonly number[],
  frequency: readonly number[],
  yAxis: WaveletYAxis,
  xScale: (value: number) => number,
  yScale: (value: number) => number,
  maxPoints: number,
): string {
  const ordinate = frequency.map((value) => (
    Number.isFinite(value) && value > 0
      ? yAxis === 'frequency' ? value : 1 / value
      : Number.NaN
  ));
  const parts: string[] = [];
  downsampleSegments(time, ordinate, maxPoints).forEach((segment) => {
    segment.x.forEach((timeValue, index) => {
      parts.push(`${index === 0 ? 'M' : 'L'}${xScale(timeValue).toFixed(2)},${yScale(segment.y[index]).toFixed(2)}`);
    });
  });
  return parts.join(' ');
}

interface WaveletPanelEntry {
  waveform: DerivedWaveform;
  result: WaveletResult;
  grid: DisplayGrid;
  timeOffset: number;
}

interface HeatmapPathSpec {
  color: string;
  path: string;
}

interface CoiPathSpec {
  leftMask: string;
  rightMask: string;
  leftBoundary: string;
  rightBoundary: string;
}

function buildHeatmapPaths(
  entry: WaveletPanelEntry,
  yAxis: WaveletYAxis,
  colorScale: ActiveColorScale,
  xScale: (value: number) => number,
  yScale: (value: number) => number,
): HeatmapPathSpec[] {
  const boundaries = frequencyBoundaries(entry.result.frequency);
  const timeStart = entry.timeOffset + (entry.result.time[0] ?? 0);
  const timeEnd = entry.timeOffset + (entry.result.time[entry.result.time.length - 1] ?? 0);
  const buckets = new Map<string, string[]>();

  entry.grid.values.forEach((row, frequencyIndex) => {
    const lowerFrequency = boundaries[frequencyIndex];
    const upperFrequency = boundaries[frequencyIndex + 1];
    if (!(lowerFrequency > 0) || !(upperFrequency > lowerFrequency)) return;
    const lowerValue = yAxis === 'frequency' ? lowerFrequency : 1 / upperFrequency;
    const upperValue = yAxis === 'frequency' ? upperFrequency : 1 / lowerFrequency;
    const y1 = yScale(upperValue);
    const y2 = yScale(lowerValue);
    const y = Math.min(y1, y2);
    const height = Math.abs(y2 - y1) + 0.35;
    let runStart = 0;
    let runColor = row.length > 0 ? colorForValue(row[0], colorScale) : '';
    const flushRun = (endColumn: number): void => {
      if (!runColor || endColumn <= runStart) return;
      const x1 = xScale(timeStart + ((timeEnd - timeStart) * runStart) / Math.max(1, row.length));
      const x2 = xScale(timeStart + ((timeEnd - timeStart) * endColumn) / Math.max(1, row.length));
      const width = Math.max(0.2, x2 - x1 + 0.25);
      const commands = buckets.get(runColor) ?? [];
      commands.push(`M${x1.toFixed(2)},${y.toFixed(2)}h${width.toFixed(2)}v${height.toFixed(2)}h-${width.toFixed(2)}Z`);
      buckets.set(runColor, commands);
    };
    for (let columnIndex = 1; columnIndex <= row.length; columnIndex += 1) {
      const color = columnIndex < row.length ? colorForValue(row[columnIndex], colorScale) : '';
      if (color === runColor) continue;
      flushRun(columnIndex);
      runStart = columnIndex;
      runColor = color;
    }
  });

  return [...buckets.entries()].map(([color, commands]) => ({ color, path: commands.join('') }));
}

function buildCoiPathSpec(
  entry: WaveletPanelEntry,
  yAxis: WaveletYAxis,
  xScale: (value: number) => number,
  yScale: (value: number) => number,
  heatTop: number,
  heatHeight: number,
): CoiPathSpec {
  const start = entry.timeOffset + (entry.result.time[0] ?? 0);
  const end = entry.timeOffset + (entry.result.time[entry.result.time.length - 1] ?? 0);
  const halfSpan = Math.max(0, (end - start) / 2);
  const points = entry.result.frequency.map((frequency, index) => {
    const ordinate = yAxis === 'frequency' ? frequency : 1 / frequency;
    const halfWidth = Math.min(halfSpan, entry.result.coneOfInfluenceHalfWidthSeconds[index] ?? halfSpan);
    return {
      y: yScale(ordinate),
      leftX: xScale(start + halfWidth),
      rightX: xScale(end - halfWidth),
    };
  }).filter((point) => [point.y, point.leftX, point.rightX].every(Number.isFinite))
    .sort((left, right) => left.y - right.y);
  if (points.length === 0) return { leftMask: '', rightMask: '', leftBoundary: '', rightBoundary: '' };
  const extended = [
    { ...points[0], y: heatTop },
    ...points,
    { ...points[points.length - 1], y: heatTop + heatHeight },
  ];
  const plotLeft = xScale(start);
  const plotRight = xScale(end);
  return {
    leftMask: `M${plotLeft},${heatTop} ${extended.map((point) => `L${point.leftX.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} L${plotLeft},${heatTop + heatHeight} Z`,
    rightMask: `M${plotRight},${heatTop} ${extended.map((point) => `L${point.rightX.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} L${plotRight},${heatTop + heatHeight} Z`,
    leftBoundary: extended.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.leftX.toFixed(2)},${point.y.toFixed(2)}`).join(' '),
    rightBoundary: extended.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.rightX.toFixed(2)},${point.y.toFixed(2)}`).join(' '),
  };
}

/** Publication-oriented Wavelet view with scale-corrected, shared three-component plates. */
export function WaveletPanel({
  waveforms,
  initialDisplayQuantity = 'scale-corrected-amplitude',
  initialColorMode = 'coi-percentile',
}: WaveletPanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reactId = useId().replace(/:/g, '');
  const gradientId = `wavelet-publication-gradient-${reactId}`;
  const coiPatternId = `wavelet-publication-coi-${reactId}`;
  const titleId = `wavelet-publication-title-${reactId}`;
  const descriptionId = `wavelet-publication-description-${reactId}`;
  const [recordSetId, setRecordSetId] = useState('');
  const [selectedWaveformId, setSelectedWaveformId] = useState('');
  const [layout, setLayout] = useState<WaveletLayout>('three-component');
  const [inputQuantity, setInputQuantity] = useState<Quantity>('acceleration');
  const [displayQuantity, setDisplayQuantity] = useState<WaveletQuantity>(initialDisplayQuantity);
  const [morletOmega0, setMorletOmega0] = useState<MorletPreset>(6);
  const [yAxis, setYAxis] = useState<WaveletYAxis>('frequency');
  const [resolution, setResolution] = useState<WaveletResolution>('publication');
  const [minFrequency, setMinFrequency] = useState(defaultWaveletOptions.minFrequency);
  const [maxFrequency, setMaxFrequency] = useState(defaultWaveletOptions.maxFrequency);
  const [colorMode, setColorMode] = useState<WaveletColorMode>(initialColorMode);
  const [dbMinimum, setDbMinimum] = useState(-40);
  const [dbMaximum, setDbMaximum] = useState(60);
  const [dbReference, setDbReference] = useState(1);
  const [showDominantFrequency, setShowDominantFrequency] = useState(false);
  const [grayscale, setGrayscale] = useState(false);

  const recordSets = useMemo(() => buildWaveformRecordSets(waveforms), [waveforms]);
  const selectedRecordSet = recordSets.find((set) => set.id === (recordSetId || recordSets[0]?.id)) ?? recordSets[0];
  const singleWaveform = selectedRecordSet?.waveforms.find((waveform) => waveform.sourceRecordId === selectedWaveformId)
    ?? selectedRecordSet?.waveforms[0];
  const activeWaveforms = useMemo(() => {
    if (!selectedRecordSet) return [];
    if (layout === 'single') return singleWaveform ? [singleWaveform] : [];
    const canonical = (['NS', 'EW', 'UD'] as const).flatMap((component) => {
      const waveform = selectedRecordSet.waveforms.find((candidate) => candidate.component === component);
      return waveform ? [waveform] : [];
    });
    return (canonical.length > 0 ? canonical : selectedRecordSet.waveforms).slice(0, 3);
  }, [layout, selectedRecordSet, singleWaveform]);
  const alignment = useMemo(() => alignWaveformTimes(activeWaveforms), [activeWaveforms]);
  const resolutionSettings = RESOLUTION_OPTIONS[resolution];
  const frequencyBounds = useMemo(() => sharedFrequencyBounds(
    activeWaveforms,
    inputQuantity,
    minFrequency,
    maxFrequency,
    resolutionSettings.maxSamples,
  ), [activeWaveforms, inputQuantity, maxFrequency, minFrequency, resolutionSettings.maxSamples]);
  const displayUnit = waveletQuantityUnit(unitForQuantity(inputQuantity), displayQuantity);

  const entries = useMemo<WaveletPanelEntry[]>(() => {
    if (!frequencyBounds) return [];
    return activeWaveforms.map((waveform) => {
      const result = computeMorletWavelet(
        valuesForQuantity(waveform, inputQuantity),
        waveform.dt,
        unitForQuantity(inputQuantity),
        {
          minFrequency: frequencyBounds[0],
          maxFrequency: frequencyBounds[1],
          frequencyCount: resolutionSettings.frequencyCount,
          maxSamples: resolutionSettings.maxSamples,
          morletOmega0,
        },
      );
      const alignedTime = alignment.values.get(waveform.sourceRecordId);
      const timeOffset = alignedTime?.[0] ?? waveform.time[0] ?? 0;
      return {
        waveform,
        result,
        grid: buildDisplayGrid(result, displayQuantity, resolutionSettings.displayColumns),
        timeOffset,
      };
    });
  }, [activeWaveforms, alignment.values, displayQuantity, frequencyBounds, inputQuantity, morletOmega0, resolutionSettings.displayColumns, resolutionSettings.frequencyCount, resolutionSettings.maxSamples]);

  const colorScale = useMemo(() => buildActiveColorScale(
    entries.map((entry) => entry.grid),
    colorMode,
    dbMinimum,
    dbMaximum,
    dbReference,
    displayUnit,
    displayQuantity,
  ), [colorMode, dbMaximum, dbMinimum, dbReference, displayQuantity, displayUnit, entries]);

  if (waveforms.length === 0) return <p className="empty-state">No data is available for wavelet analysis.</p>;
  if (!selectedRecordSet || activeWaveforms.length === 0 || !frequencyBounds || entries.some((entry) => (
    entry.result.time.length === 0
    || entry.result.frequency.length === 0
    || entry.grid.values.length !== entry.result.frequency.length
  ))) {
    return <p className="empty-state">Wavelet analysis is not available for the selected record set and frequency range.</p>;
  }

  const multiPanel = layout === 'three-component' && entries.length > 1;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const timeStarts = entries.map((entry) => entry.timeOffset + (entry.result.time[0] ?? 0));
  const timeEnds = entries.map((entry) => entry.timeOffset + (entry.result.time[entry.result.time.length - 1] ?? 0));
  const timeMin = Math.min(...timeStarts);
  const timeMax = Math.max(...timeEnds);
  const xScale = (value: number): number => MARGIN.left
    + ((value - timeMin) / Math.max(Number.EPSILON, timeMax - timeMin)) * plotWidth;
  const xTicks = niceTicks(timeMin, timeMax, 7);
  let sharedWaveAbsMax = 1e-12;
  activeWaveforms.forEach((waveform) => valuesForQuantity(waveform, inputQuantity).forEach((value) => {
    if (Number.isFinite(value)) sharedWaveAbsMax = Math.max(sharedWaveAbsMax, Math.abs(value));
  }));
  const waveDomainMax = sharedWaveAbsMax * 1.12;
  const waveYTicks = multiPanel ? [-waveDomainMax, 0, waveDomainMax] : niceTicks(-waveDomainMax, waveDomainMax, 5);
  const firstResult = entries[0].result;
  const boundaries = frequencyBoundaries(firstResult.frequency);
  const yMin = yAxis === 'frequency' ? boundaries[0] : 1 / boundaries[boundaries.length - 1];
  const yMax = yAxis === 'frequency' ? boundaries[boundaries.length - 1] : 1 / boundaries[0];
  const yTicks = logTicks(yMin, yMax);
  const waveHeight = multiPanel ? 50 : WAVEFORM_HEIGHT;
  const heatHeight = multiPanel ? 118 : HEATMAP_HEIGHT;
  const firstWaveTop = multiPanel ? 44 : WAVEFORM_TOP;
  const firstHeatTop = multiPanel ? 112 : HEATMAP_TOP;
  const blockStride = multiPanel ? 212 : 0;
  const lastHeatBottom = firstHeatTop + (entries.length - 1) * blockStride + heatHeight;
  const svgHeight = multiPanel ? lastHeatBottom + 58 : HEIGHT;
  const colorbarTop = firstHeatTop;
  const colorbarHeight = lastHeatBottom - firstHeatTop;
  const title = `${multiPanel ? 'Three-component' : entries[0].waveform.componentLabel} Morlet wavelet plate · ${quantityLabel(inputQuantity)}`;
  const safeRecordLabel = selectedRecordSet.label.replace(/\s+/g, '_');
  const fileNameBase = safeFileName([
    'wavelet', safeRecordLabel, layout, inputQuantity, displayQuantity,
    `morlet${morletOmega0}`, `${formatTick(frequencyBounds[0])}-${formatTick(frequencyBounds[1])}hz`, resolution,
  ].join('_'));
  const colourMetadata = colorMode === 'fixed-db'
    ? {
      mode: 'absolute-fixed-db',
      transform: displayQuantity === 'rectified-power' ? '10*log10(power/reference)' : '20*log10(amplitude/reference)',
      decibelFactor: displayQuantity === 'rectified-power' ? 10 : 20,
      boundsDb: [colorScale.minimum, colorScale.maximum],
      reference: dbReference,
      referenceUnit: displayUnit,
      comparableAcrossExports: true,
    }
    : {
      mode: 'plate-relative-coi-percentile',
      transform: 'log10(display quantity)',
      percentileRange: [2, 98],
      comparableAcrossExports: false,
    };
  const methods = {
    schema: 'strong-motion-wavelet-methods/2.0',
    recordSet: selectedRecordSet.label,
    provenance: buildFigureProvenance(activeWaveforms),
    alignment: alignment.reference,
    analysis: {
      transform: 'complex Morlet continuous wavelet transform',
      preset: morletOmega0 === 6 ? 'Morlet-6 Balanced' : 'Morlet-8 Frequency-resolved',
      morletOmega0,
      normalization: MORLET_CWT_NORMALIZATION,
      displayedQuantity: displayQuantity,
      displayedQuantityDefinition: waveletQuantityDefinition(displayQuantity),
      displayedUnit: displayUnit,
      inputQuantity,
      requestedFrequencyRangeHz: [minFrequency, maxFrequency],
      sharedEffectiveFrequencyRangeHz: [firstResult.frequency[0], firstResult.frequency[firstResult.frequency.length - 1]],
      records: entries.map((entry) => ({
        sourceRecordId: entry.waveform.sourceRecordId,
        component: entry.waveform.componentLabel,
        preprocessing: entry.waveform.preprocessing ?? null,
        transformMetadata: entry.result.metadata,
        resampling: entry.result.resampling,
        inputSamples: entry.result.inputSamples,
        computedSamples: entry.result.computedSamples,
        effectiveDtSeconds: entry.result.effectiveDt,
        invalidFrequencyRowsOutsideCoi: entry.grid.invalidRows,
      })),
    },
    colourScale: {
      ...colourMetadata,
      clippedLowPercent: colorScale.clippedLowPercent,
      clippedHighPercent: colorScale.clippedHighPercent,
      statisticsDomain: 'finite positive coefficients inside the cone of influence across every displayed component',
    },
    display: {
      layout,
      commonTimeAxis: [timeMin, timeMax],
      commonFrequencyAxis: true,
      commonColourScale: true,
      yAxis,
      resolutionPreset: resolution,
      frequencyRows: firstResult.frequency.length,
      displayedTimeBinsByComponent: entries.map((entry) => ({ component: entry.waveform.componentLabel, bins: entry.grid.columns })),
      timeBinAggregation: entries[0].grid.aggregation,
      colourStatisticsSampling: 'one aggregate per displayed time-frequency bin containing one or more COI-valid samples',
      heatmapRendering: `${MAX_HEATMAP_COLOURS}-colour path-grouped raster-like layer with vector axes, text, COI and traces`,
      maximumHeatmapPathsPerComponent: MAX_HEATMAP_COLOURS + 1,
      coneOfInfluence: firstResult.metadata.coneOfInfluenceDefinition,
      dominantFrequencyTrace: {
        displayed: showDominantFrequency,
        quantity: displayQuantity,
        definition: 'per-time global maximum of the displayed quantity inside the COI',
        interpretation: 'descriptive only; not a mathematical local wavelet ridge, phase pick, modal estimate, or uncertainty interval',
      },
      finalWidthMm: PRINT_WIDTH_MM,
      rasterDpi: JOURNAL_LINE_ART_DPI,
    },
  };
  const preprocessingSummary = [...new Set(activeWaveforms.map((waveform) => (
    waveform.preprocessing ? preprocessingLabel(waveform.preprocessing) : 'preprocessing unavailable'
  )))].join(' / ');
  const resamplingSummary = entries.some((entry) => entry.result.resampling.applied)
    ? 'Long records were anti-alias resampled as documented per component in Methods JSON.'
    : 'No CWT input resampling was required.';

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        {recordSets.length > 1 && (
          <label>
            Record set
            <select value={selectedRecordSet.id} onChange={(event) => setRecordSetId(event.target.value)}>
              {recordSets.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
            </select>
          </label>
        )}
        <label>
          Figure layout
          <select value={layout} onChange={(event) => setLayout(event.target.value as WaveletLayout)}>
            <option value="three-component">Shared NS / EW / UD plate</option>
            <option value="single">Single-component detail</option>
          </select>
        </label>
        {layout === 'single' && (
          <label>
            Component
            <select value={singleWaveform?.sourceRecordId ?? ''} onChange={(event) => setSelectedWaveformId(event.target.value)}>
              {selectedRecordSet.waveforms.map((waveform) => <option key={waveform.sourceRecordId} value={waveform.sourceRecordId}>{waveform.componentLabel} · {waveform.fileName}</option>)}
            </select>
          </label>
        )}
        <label>
          Input
          <select value={inputQuantity} onChange={(event) => setInputQuantity(event.target.value as Quantity)}>
            <option value="acceleration">Acceleration</option>
            <option value="velocity">Velocity</option>
            <option value="displacement">Displacement</option>
          </select>
        </label>
        <label>
          Wavelet ordinate
          <select value={displayQuantity} onChange={(event) => setDisplayQuantity(event.target.value as WaveletQuantity)}>
            <option value="scale-corrected-amplitude">Corrected amplitude · input unit</option>
            <option value="rectified-power">Rectified power · input unit²</option>
            <option value="raw-l2">Raw L2 coefficient · expert</option>
          </select>
        </label>
        <label>
          Morlet preset
          <select value={morletOmega0} onChange={(event) => setMorletOmega0(Number(event.target.value) as MorletPreset)}>
            <option value={6}>ω₀=6 · Balanced</option>
            <option value={8}>ω₀=8 · Frequency-resolved</option>
          </select>
        </label>
        <label>
          Y axis
          <select value={yAxis} onChange={(event) => setYAxis(event.target.value as WaveletYAxis)}>
            <option value="frequency">Frequency</option>
            <option value="period">Period</option>
          </select>
        </label>
        <label>
          Resolution
          <select value={resolution} onChange={(event) => setResolution(event.target.value as WaveletResolution)}>
            {Object.entries(RESOLUTION_OPTIONS).map(([key, option]) => <option key={key} value={key}>{option.label} · {option.frequencyCount} rows</option>)}
          </select>
        </label>
        <label>
          Colour normalization
          <select value={colorMode} onChange={(event) => setColorMode(event.target.value as WaveletColorMode)}>
            <option value="coi-percentile">COI-relative morphology · shared plate</option>
            <option value="fixed-db">Absolute fixed dB · record comparison</option>
          </select>
        </label>
        {colorMode === 'fixed-db' && (
          <>
            <label>dB min<input type="number" step="5" value={dbMinimum} onChange={(event) => setDbMinimum(Number(event.target.value))} /></label>
            <label>dB max<input type="number" step="5" value={dbMaximum} onChange={(event) => setDbMaximum(Number(event.target.value))} /></label>
            <label>Reference [{displayUnit}]<input type="number" min="1e-15" step="any" value={dbReference} onChange={(event) => setDbReference(Number(event.target.value))} /></label>
          </>
        )}
        <label>Min frequency [Hz]<input type="number" min="0.001" step="0.01" value={minFrequency} onChange={(event) => setMinFrequency(Number(event.target.value))} /></label>
        <label>Max frequency [Hz]<input type="number" min="0.01" step="0.1" value={maxFrequency} onChange={(event) => setMaxFrequency(Number(event.target.value))} /></label>
        <label>Dominant-frequency trace<input type="checkbox" checked={showDominantFrequency} onChange={(event) => setShowDominantFrequency(event.target.checked)} /></label>
        <span className="note">{colorScale.summary} Clipped: {colorScale.clippedLowPercent.toFixed(1)}% low / {colorScale.clippedHighPercent.toFixed(1)}% high.</span>
      </div>

      <figure
        className={`chart-card publication-figure journal-figure${grayscale ? ' grayscale-preview' : ''}`}
        data-wavelet-layout={layout}
        data-wavelet-quantity={displayQuantity}
        data-wavelet-component-count={entries.length}
        data-wavelet-shared-time-axis="true"
        data-wavelet-shared-frequency-axis="true"
        data-wavelet-shared-colour-scale="true"
        data-wavelet-morlet-omega0={morletOmega0}
        data-wavelet-decibel-factor={colorMode === 'fixed-db' ? (displayQuantity === 'rectified-power' ? 10 : 20) : undefined}
        tabIndex={0}
        aria-label={`${title}; horizontally scrollable on narrow screens`}
      >
        <div className="chart-toolbar journal-toolbar">
          <div className="figure-toolbar-label">
            <span className="figure-kicker">Publication Wavelet plate</span>
            <strong>{title}</strong>
            <span className="note">{morletOmega0 === 6 ? 'Morlet-6 Balanced' : 'Morlet-8 Frequency-resolved'} · exact Fourier mapping · {waveletQuantityLabel(displayQuantity)} [{displayUnit}]</span>
            <span className="note">Shared axes/colour · {resolutionSettings.frequencyCount} frequency rows · {resolution} · COI-valid statistics · {entries[0].grid.aggregation}</span>
          </div>
          <div className="button-row compact">
            <button type="button" className="secondary" aria-pressed={grayscale} onClick={() => setGrayscale((value) => !value)}>{grayscale ? 'Colour preview' : 'Grayscale check'}</button>
            <button type="button" className="secondary" onClick={() => downloadFigureMetadata(`${fileNameBase}_methods`, methods)}>Methods · JSON</button>
            <button type="button" className="secondary" disabled={resolution !== 'publication'} title={resolution !== 'publication' ? 'Select Publication resolution before final export.' : undefined} onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`, { widthMm: PRINT_WIDTH_MM })}>SVG · publication</button>
            <button type="button" className="secondary" disabled={resolution !== 'publication'} title={resolution !== 'publication' ? 'Select Publication resolution before final export.' : undefined} onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, { dpi: JOURNAL_LINE_ART_DPI, widthMm: PRINT_WIDTH_MM })}>PNG · 800 dpi</button>
          </div>
        </div>
        <span className="mobile-scroll-hint" aria-hidden="true">Swipe horizontally to inspect the full plate →</span>
        <svg
          ref={svgRef}
          className="publication-chart journal-chart wavelet-publication-chart"
          style={{ '--journal-axis-font': `${AXIS_FONT}px`, '--journal-supplemental-font': `${SMALL_FONT}px` } as CSSProperties}
          width={WIDTH}
          height={svgHeight}
          viewBox={`0 0 ${WIDTH} ${svgHeight}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <title id={titleId}>{title}</title>
          <desc id={descriptionId}>{waveletQuantityDefinition(displayQuantity)}. All displayed components share time, frequency, and colour limits. Pale edge regions are outside the cone of influence. The optional dominant-frequency trace is descriptive and is not a mathematical wavelet ridge.</desc>
          <metadata>{JSON.stringify(methods)}</metadata>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="1" y2="0">
              {COLOR_STOPS.map((stop) => <stop key={stop.t} offset={`${stop.t * 100}%`} stopColor={stop.color} />)}
            </linearGradient>
            <pattern id={coiPatternId} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
              <line x1="0" y1="0" x2="0" y2="14" stroke="#354651" strokeWidth={GUIDE_LINE} opacity="0.28" />
            </pattern>
          </defs>
          <rect x="0" y="0" width={WIDTH} height={svgHeight} fill="#ffffff" />

          {entries.map((entry, panelIndex) => {
            const waveTop = firstWaveTop + panelIndex * blockStride;
            const heatTop = firstHeatTop + panelIndex * blockStride;
            const heatYScale = (value: number): number => heatTop + heatHeight
              - ((Math.log10(value) - Math.log10(yMin)) / Math.max(Number.EPSILON, Math.log10(yMax) - Math.log10(yMin))) * heatHeight;
            const waveYScale = (value: number): number => waveTop + waveHeight / 2 - (value / waveDomainMax) * (waveHeight / 2);
            const alignedTime = alignment.values.get(entry.waveform.sourceRecordId) ?? entry.waveform.time;
            const waveformPath = buildWaveformPath(alignedTime, valuesForQuantity(entry.waveform, inputQuantity), xScale, waveYScale);
            const heatmapPaths = buildHeatmapPaths(entry, yAxis, colorScale, xScale, heatYScale);
            const coi = buildCoiPathSpec(entry, yAxis, xScale, heatYScale, heatTop, heatHeight);
            const seriesStyle = componentSeriesStyle(entry.waveform.component, panelIndex);
            const ridge = showDominantFrequency ? computeDominantWaveletRidge(entry.result, { quantity: displayQuantity }) : undefined;
            const ridgePath = ridge ? buildRidgePath(
              ridge.time.map((time) => time + entry.timeOffset),
              ridge.frequency.map((frequency, index) => colorScale.transform(ridge.amplitude[index]) >= colorScale.minimum ? frequency : Number.NaN),
              yAxis,
              xScale,
              heatYScale,
              entry.grid.columns,
            ) : '';
            const panelLetter = String.fromCharCode(97 + panelIndex);
            const showXLabels = panelIndex === entries.length - 1;
            return (
              <g
                key={entry.waveform.sourceRecordId}
                data-wavelet-component={entry.waveform.componentLabel}
                data-wavelet-heatmap-paths={heatmapPaths.length}
              >
                <text x={MARGIN.left} y={waveTop - 9} fontSize={PANEL_FONT} fontWeight="700" fill="#111820">({panelLetter}) {entry.waveform.componentLabel}</text>
                <text x={MARGIN.left + plotWidth} y={waveTop - 9} textAnchor="end" fontSize={SMALL_FONT} fill="#475569">{quantityLabel(inputQuantity)} + {waveletQuantityLabel(displayQuantity)}</text>
                <rect x={MARGIN.left} y={waveTop} width={plotWidth} height={waveHeight} fill="#ffffff" stroke="#3f474d" strokeWidth={AXIS_LINE} />
                {waveYTicks.map((tick) => {
                  const y = waveYScale(tick);
                  return <g key={`wave-${panelIndex}-${tick}`}><line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke={tick === 0 ? '#9aa3aa' : '#d7dadd'} strokeWidth={GUIDE_LINE} /><text x={MARGIN.left - 8} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text></g>;
                })}
                <path d={waveformPath} fill="none" stroke={seriesStyle.color} strokeWidth={DATA_LINE} strokeDasharray={seriesStyle.dashArray} strokeLinecap="round" strokeLinejoin="round" />
                <rect x={MARGIN.left} y={heatTop} width={plotWidth} height={heatHeight} fill="#f3f4f6" stroke="#3f474d" strokeWidth={AXIS_LINE} />
                {heatmapPaths.map((path) => <path key={`${entry.waveform.sourceRecordId}-${path.color}`} d={path.path} fill={path.color} shapeRendering="crispEdges" />)}
                {xTicks.map((tick) => {
                  const x = xScale(tick);
                  return <g key={`time-${panelIndex}-${tick}`}><line x1={x} y1={heatTop} x2={x} y2={heatTop + heatHeight} stroke="#ffffff" strokeWidth={GUIDE_LINE} opacity="0.36" />{showXLabels && <text x={x} y={heatTop + heatHeight + 20} textAnchor="middle" className="tick-label">{formatTick(tick)}</text>}</g>;
                })}
                {yTicks.map((tick) => {
                  const y = heatYScale(tick);
                  return <g key={`freq-${panelIndex}-${tick}`}><line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke="#ffffff" strokeWidth={GUIDE_LINE} opacity="0.38" /><text x={MARGIN.left - 8} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text></g>;
                })}
                {coi.leftMask && <g aria-label={`Cone of influence mask for ${entry.waveform.componentLabel}`}><path d={coi.leftMask} fill="#ffffff" opacity="0.48" /><path d={coi.rightMask} fill="#ffffff" opacity="0.48" />{grayscale && <><path d={coi.leftMask} fill={`url(#${coiPatternId})`} /><path d={coi.rightMask} fill={`url(#${coiPatternId})`} /></>}<path d={coi.leftBoundary} fill="none" stroke="#354651" strokeWidth={GUIDE_LINE} strokeDasharray="4 4" opacity="0.64" /><path d={coi.rightBoundary} fill="none" stroke="#354651" strokeWidth={GUIDE_LINE} strokeDasharray="4 4" opacity="0.64" /></g>}
                {ridgePath && <path d={ridgePath} fill="none" stroke="#111820" strokeWidth={GUIDE_LINE} strokeDasharray="3 2" strokeLinecap="round" opacity="0.78" aria-label="Descriptive dominant-frequency trace" />}
                <rect x={MARGIN.left} y={heatTop} width={plotWidth} height={heatHeight} fill="none" stroke="#3f474d" strokeWidth={AXIS_LINE} />
              </g>
            );
          })}

          <text x="18" y={(firstHeatTop + lastHeatBottom) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 18 ${(firstHeatTop + lastHeatBottom) / 2})`}>{yAxis === 'frequency' ? 'Frequency [Hz]' : 'Period [s]'}</text>
          <text x="42" y={(firstWaveTop + firstHeatTop) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 42 ${(firstWaveTop + firstHeatTop) / 2})`}>{quantityLabel(inputQuantity)} [{unitForQuantity(inputQuantity)}]</text>
          <text x={MARGIN.left + plotWidth / 2} y={svgHeight - 17} textAnchor="middle" className="axis-label">{alignment.reference}</text>
          <text x={MARGIN.left + plotWidth} y={firstHeatTop - 8} textAnchor="end" fontSize={SMALL_FONT} fill="#475569">Pale mask: outside COI</text>

          <g>
            {colorScale.referenceNote && <text x={COLORBAR_X + COLORBAR_WIDTH / 2} y={colorbarTop - 9} textAnchor="middle" fontSize={SMALL_FONT} fill="#334155">{colorScale.referenceNote}</text>}
            <rect x={COLORBAR_X} y={colorbarTop} width={COLORBAR_WIDTH} height={colorbarHeight} fill={`url(#${gradientId})`} stroke="#64748b" strokeWidth={GUIDE_LINE} />
            {colorScale.ticks.map((tick) => {
              const y = colorbarTop + colorbarHeight - ((tick.value - colorScale.minimum) / Math.max(Number.EPSILON, colorScale.maximum - colorScale.minimum)) * colorbarHeight;
              return <g key={`colour-${tick.value}`}><line x1={COLORBAR_X + COLORBAR_WIDTH} y1={y} x2={COLORBAR_TICK_X - 3} y2={y} stroke="#334155" strokeWidth={GUIDE_LINE} /><text x={COLORBAR_TICK_X} y={y + 4} className="tick-label">{tick.label}</text></g>;
            })}
            <text x={COLORBAR_LABEL_X} y={colorbarTop + colorbarHeight / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 ${COLORBAR_LABEL_X} ${colorbarTop + colorbarHeight / 2})`}>{colorScale.label}</text>
          </g>
        </svg>
        <figcaption className="chart-caption journal-caption">
          Data: {datasetLabel(activeWaveforms)}. Preprocessing: {preprocessingSummary}. {resamplingSummary} {waveletQuantityDefinition(displayQuantity)}. {colorScale.summary} The CWT uses the exact Morlet scale–Fourier mapping with ω₀={morletOmega0}, an integer-sample kernel centre, and a common {formatTick(firstResult.frequency[0])}–{formatTick(firstResult.frequency[firstResult.frequency.length - 1])} Hz grid. Time bins use {entries[0].grid.aggregation}. Pale edge regions are outside the COI and must not be interpreted.{showDominantFrequency ? ' The dashed trace is only the per-time dominant displayed frequency inside the COI; it is not a local mathematical ridge or phase pick.' : ''}
        </figcaption>
      </figure>
    </div>
  );
}
