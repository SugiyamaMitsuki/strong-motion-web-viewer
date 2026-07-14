import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  computeDominantWaveletRidge,
  computeMorletWavelet,
  defaultWaveletOptions,
  MORLET_CWT_NORMALIZATION,
  waveletMagnitudeToDecibels,
  type WaveletResult,
} from '../analysis/wavelet';
import { downloadFigureMetadata } from '../export/figureMetadata';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { safeFileName } from '../utils/file';
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

interface WaveletPanelProps {
  waveforms: DerivedWaveform[];
}

type WaveletResolution = 'fast' | 'standard' | 'detailed' | 'publication';
type WaveletYAxis = 'frequency' | 'period';
type WaveletColorMode = 'fixed-db' | 'record-percentile';

interface DisplayGrid {
  columns: number;
  values: number[][];
  colorMin: number;
  colorMax: number;
}

interface ActiveColorScale {
  mode: WaveletColorMode;
  minimum: number;
  maximum: number;
  comparable: boolean;
  label: string;
  referenceNote?: string;
  summary: string;
  transform: (magnitude: number) => number;
  ticks: Array<{ value: number; label: string }>;
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
  const t = Number.isFinite(rawPosition) ? Math.max(0, Math.min(1, rawPosition)) : 0;
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

function buildDisplayGrid(result: WaveletResult, maxColumns = 360): DisplayGrid {
  const timeCount = result.time.length;
  const columns = Math.max(1, Math.min(maxColumns, timeCount));
  const stride = Math.max(1, Math.ceil(timeCount / columns));
  const values = result.amplitude.map((row) => {
    const nextRow: number[] = [];
    for (let start = 0; start < timeCount; start += stride) {
      const end = Math.min(timeCount, start + stride);
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i += 1) {
        const value = row[i];
        if (Number.isFinite(value) && value >= 0) {
          sum += value;
          count += 1;
        }
      }
      nextRow.push(count > 0 ? sum / count : 0);
    }
    return nextRow;
  });

  const positives = values.flat().filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const colorMin = percentile(positives, 0.05);
  const colorMax = percentile(positives, 0.98);

  return {
    columns: values[0]?.length ?? columns,
    values,
    colorMin: colorMin > 0 ? colorMin : 1e-12,
    colorMax: colorMax > colorMin ? colorMax : colorMin * 10 || 1,
  };
}

function buildActiveColorScale(
  grid: DisplayGrid,
  mode: WaveletColorMode,
  dbMinimum: number,
  dbMaximum: number,
  dbReference: number,
  unit: string,
): ActiveColorScale {
  if (mode === 'fixed-db') {
    const safeMinimum = Number.isFinite(dbMinimum) ? dbMinimum : -60;
    const requestedMaximum = Number.isFinite(dbMaximum) ? dbMaximum : 20;
    const safeMaximum = requestedMaximum > safeMinimum ? requestedMaximum : safeMinimum + 10;
    const safeReference = Number.isFinite(dbReference) && dbReference > 0 ? dbReference : 1;
    const midpoint = (safeMinimum + safeMaximum) / 2;
    return {
      mode,
      minimum: safeMinimum,
      maximum: safeMaximum,
      comparable: true,
      label: 'CWT magnitude [dB]',
      referenceNote: `re ${formatTick(safeReference)} ${unit}`,
      summary: `Fixed ${formatTick(safeMinimum)} to ${formatTick(safeMaximum)} dB re ${formatTick(safeReference)} ${unit}; comparable only when unit, reference, frequency grid, resampling, CWT normalization, and preprocessing match.`,
      transform: (magnitude) => waveletMagnitudeToDecibels(magnitude, safeReference),
      ticks: [safeMinimum, midpoint, safeMaximum].map((value) => ({ value, label: `${formatTick(value)}` })),
    };
  }

  const minimum = Math.log10(grid.colorMin);
  const maximum = Math.log10(grid.colorMax);
  const middle = Math.sqrt(grid.colorMin * grid.colorMax);
  return {
    mode,
    minimum,
    maximum,
    comparable: false,
    label: `CWT magnitude [${unit}]`,
    summary: 'Record-specific 5th–98th percentile log10 range; colours are not comparable across records.',
    transform: (magnitude) => magnitude > 0 ? Math.log10(magnitude) : Number.NEGATIVE_INFINITY,
    ticks: [grid.colorMin, middle, grid.colorMax].map((value) => ({
      value: Math.log10(value),
      label: formatTick(value),
    })),
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

export function WaveletPanel({ waveforms }: WaveletPanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reactId = useId().replace(/:/g, '');
  const gradientId = `wavelet-gradient-${reactId}`;
  const coiPatternId = `wavelet-coi-${reactId}`;
  const titleId = `wavelet-title-${reactId}`;
  const descriptionId = `wavelet-description-${reactId}`;
  const colorNoteId = `wavelet-colour-note-${reactId}`;
  const [selectedWaveformId, setSelectedWaveformId] = useState('');
  const [quantity, setQuantity] = useState<Quantity>('acceleration');
  const [yAxis, setYAxis] = useState<WaveletYAxis>('frequency');
  const [resolution, setResolution] = useState<WaveletResolution>('detailed');
  const [minFrequency, setMinFrequency] = useState(defaultWaveletOptions.minFrequency);
  const [maxFrequency, setMaxFrequency] = useState(defaultWaveletOptions.maxFrequency);
  const [colorMode, setColorMode] = useState<WaveletColorMode>('fixed-db');
  const [dbMinimum, setDbMinimum] = useState(-60);
  const [dbMaximum, setDbMaximum] = useState(20);
  const [dbReference, setDbReference] = useState(1);
  const [showRidge, setShowRidge] = useState(false);
  const [grayscale, setGrayscale] = useState(false);

  const selectedWaveform = useMemo(() => {
    if (waveforms.length === 0) return undefined;
    return waveforms.find((waveform) => waveform.sourceRecordId === selectedWaveformId) ?? waveforms[0];
  }, [selectedWaveformId, waveforms]);

  const resolutionSettings = RESOLUTION_OPTIONS[resolution];
  const values = selectedWaveform ? valuesForQuantity(selectedWaveform, quantity) : [];

  const result = useMemo(() => {
    if (!selectedWaveform) return undefined;
    return computeMorletWavelet(values, selectedWaveform.dt, unitForQuantity(quantity), {
      minFrequency,
      maxFrequency,
      frequencyCount: resolutionSettings.frequencyCount,
      maxSamples: resolutionSettings.maxSamples,
    });
  }, [maxFrequency, minFrequency, quantity, resolutionSettings.frequencyCount, resolutionSettings.maxSamples, selectedWaveform, values]);

  const displayGrid = useMemo(() => (
    result ? buildDisplayGrid(result, resolutionSettings.displayColumns) : undefined
  ), [resolutionSettings.displayColumns, result]);
  const dominantRidge = useMemo(() => (
    result && showRidge
      ? computeDominantWaveletRidge(result, { morletOmega0: defaultWaveletOptions.morletOmega0, excludeOutsideConeOfInfluence: true })
      : undefined
  ), [result, showRidge]);

  if (waveforms.length === 0) return <p className="empty-state">No data is available for wavelet analysis.</p>;
  if (!selectedWaveform || !result || !displayGrid || result.time.length === 0 || result.frequency.length === 0) {
    return <p className="empty-state">Wavelet analysis is not available for the selected data.</p>;
  }

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const timeMin = result.time[0] ?? 0;
  const timeMax = result.time[result.time.length - 1] ?? 1;
  const xScale = (value: number): number => MARGIN.left + ((value - timeMin) / Math.max(timeMax - timeMin, Number.EPSILON)) * plotWidth;
  // Panel (a) retains the original samples and peak-preserving path decimation;
  // only the CWT input is anti-alias resampled when its computation cap is hit.
  const waveformValues = values;
  const waveformTime = values.map((_, index) => index * selectedWaveform.dt);
  const finiteWaveValues = waveformValues.filter((value) => Number.isFinite(value));
  const waveAbsMax = Math.max(...finiteWaveValues.map((value) => Math.abs(value)), 1);
  const waveDomainMax = waveAbsMax * 1.08;
  const waveYScale = (value: number): number => WAVEFORM_TOP + WAVEFORM_HEIGHT / 2 - (value / waveDomainMax) * (WAVEFORM_HEIGHT / 2);
  const waveformPath = buildWaveformPath(waveformTime, waveformValues, xScale, waveYScale);
  const xTicks = niceTicks(timeMin, timeMax, 7);
  const waveYTicks = niceTicks(-waveDomainMax, waveDomainMax, 5);
  const boundaries = frequencyBoundaries(result.frequency);
  const yMin = yAxis === 'frequency' ? boundaries[0] : 1 / boundaries[boundaries.length - 1];
  const yMax = yAxis === 'frequency' ? boundaries[boundaries.length - 1] : 1 / boundaries[0];
  const heatYScale = (value: number): number => (
    HEATMAP_TOP
    + HEATMAP_HEIGHT
    - ((Math.log10(value) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * HEATMAP_HEIGHT
  );
  const yTicks = logTicks(yMin, yMax);
  const colorScale = buildActiveColorScale(displayGrid, colorMode, dbMinimum, dbMaximum, dbReference, result.unit);
  const cellWidth = plotWidth / displayGrid.columns;
  const title = `Morlet Wavelet Scalogram: ${selectedWaveform.componentLabel} ${quantityLabel(quantity)}`;
  const fileNameBase = safeFileName(`wavelet_${selectedWaveform.componentLabel}_${quantity}`);
  const colourScaleMethods = colorMode === 'fixed-db'
    ? {
      mode: 'fixed-db',
      transform: '20*log10(magnitude/reference)',
      boundsDb: [colorScale.minimum, colorScale.maximum],
      reference: Number.isFinite(dbReference) && dbReference > 0 ? dbReference : 1,
      referenceUnit: result.unit,
      comparableAcrossRecords: true,
      comparabilityCondition: 'same coefficient unit, reference, colour bounds, frequency grid, resampling, CWT normalization, and preprocessing',
    }
    : {
      mode: 'record-percentile',
      transform: 'log10(magnitude)',
      percentileRange: [5, 98],
      magnitudeBounds: [displayGrid.colorMin, displayGrid.colorMax],
      magnitudeUnit: result.unit,
      comparableAcrossRecords: false,
    };
  const waveletMethods = {
    schema: 'strong-motion-wavelet-methods/1.0',
    provenance: buildFigureProvenance([selectedWaveform]),
    analysis: {
      transform: 'Morlet continuous wavelet transform',
      morletOmega0: defaultWaveletOptions.morletOmega0,
      normalization: MORLET_CWT_NORMALIZATION,
      inputQuantity: quantity,
      inputUnit: result.inputUnit,
      coefficientUnit: result.unit,
      requestedFrequencyRangeHz: [minFrequency, maxFrequency],
      realizedFrequencyRangeHz: [result.frequency[0], result.frequency[result.frequency.length - 1]],
      logarithmicFrequencyCount: result.frequency.length,
      inputSamples: result.inputSamples,
      computedSamples: result.computedSamples,
      effectiveDtSeconds: result.effectiveDt,
      resampling: result.resampling,
    },
    colourScale: colourScaleMethods,
    display: {
      resolutionPreset: resolution,
      displayedTimeBins: displayGrid.columns,
      timeHistoryPanel: 'original samples with peak-preserving path decimation',
      timeBinAggregation: {
        method: 'arithmetic mean of coefficient magnitude in contiguous computed-time bins',
        strideSamples: Math.max(1, Math.ceil(result.time.length / Math.min(result.time.length, resolutionSettings.displayColumns))),
      },
      yAxis,
      coneOfInfluence: 'sqrt(2) * scale',
      ridge: {
        displayed: showRidge,
        definition: 'per-time maximum CWT magnitude inside the cone of influence; values below the displayed colour floor are omitted',
        interpretation: 'descriptive only; not a phase pick, modal estimate, or uncertainty interval',
      },
      finalWidthMm: PRINT_WIDTH_MM,
      rasterDpi: JOURNAL_LINE_ART_DPI,
    },
  };
  const preprocessingSummary = selectedWaveform.preprocessing
    ? preprocessingLabel(selectedWaveform.preprocessing)
    : 'exact preprocessing settings unavailable';
  const dataSummary = datasetLabel([selectedWaveform]);
  const resamplingSummary = result.resampling.applied
    ? `Anti-alias resampling: ${result.resampling.method}, ${result.resampling.inputSamples.toLocaleString()} to ${result.resampling.computedSamples.toLocaleString()} samples, passband ≤ ${formatTick(result.resampling.passbandEndHz ?? 0)} Hz.`
    : 'No time resampling was applied.';
  const timeSpan = Math.max(0, timeMax - timeMin);
  const ridgePath = dominantRidge
    ? buildRidgePath(
      dominantRidge.time,
      dominantRidge.frequency.map((frequency, index) => (
        colorScale.transform(dominantRidge.amplitude[index]) >= colorScale.minimum ? frequency : Number.NaN
      )),
      yAxis,
      xScale,
      heatYScale,
      displayGrid.columns,
    )
    : '';
  const coiPoints = result.frequency
    .map((frequency) => {
      const value = yAxis === 'frequency' ? frequency : 1 / frequency;
      const halfWidth = Math.min(timeSpan / 2, (Math.SQRT2 * 8) / (2 * Math.PI * frequency));
      return {
        y: heatYScale(value),
        leftX: xScale(timeMin + halfWidth),
        rightX: xScale(timeMax - halfWidth),
      };
    })
    .filter((point) => Number.isFinite(point.y) && Number.isFinite(point.leftX) && Number.isFinite(point.rightX))
    .sort((a, b) => a.y - b.y);
  const coiWithEdges = coiPoints.length > 0
    ? [
      { ...coiPoints[0], y: HEATMAP_TOP },
      ...coiPoints,
      { ...coiPoints[coiPoints.length - 1], y: HEATMAP_TOP + HEATMAP_HEIGHT },
    ]
    : [];
  const leftCoiPath = coiWithEdges.length > 0
    ? `M${MARGIN.left},${HEATMAP_TOP} ${coiWithEdges.map((point) => `L${point.leftX.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} L${MARGIN.left},${HEATMAP_TOP + HEATMAP_HEIGHT} Z`
    : '';
  const rightEdge = MARGIN.left + plotWidth;
  const rightCoiPath = coiWithEdges.length > 0
    ? `M${rightEdge},${HEATMAP_TOP} ${coiWithEdges.map((point) => `L${point.rightX.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} L${rightEdge},${HEATMAP_TOP + HEATMAP_HEIGHT} Z`
    : '';
  const leftCoiBoundary = coiWithEdges.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.leftX.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const rightCoiBoundary = coiWithEdges.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.rightX.toFixed(2)},${point.y.toFixed(2)}`).join(' ');

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        <label>
          Component
          <select value={selectedWaveform.sourceRecordId} onChange={(event) => setSelectedWaveformId(event.target.value)}>
            {waveforms.map((waveform) => (
              <option key={waveform.sourceRecordId} value={waveform.sourceRecordId}>
                {waveform.componentLabel} - {waveform.fileName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <select value={quantity} onChange={(event) => setQuantity(event.target.value as Quantity)}>
            <option value="acceleration">Acceleration</option>
            <option value="velocity">Velocity</option>
            <option value="displacement">Displacement</option>
          </select>
        </label>
        <label>
          Y Axis
          <select value={yAxis} onChange={(event) => setYAxis(event.target.value as WaveletYAxis)}>
            <option value="frequency">Frequency</option>
            <option value="period">Period</option>
          </select>
        </label>
        <label>
          Resolution
          <select value={resolution} onChange={(event) => setResolution(event.target.value as WaveletResolution)}>
            {Object.entries(RESOLUTION_OPTIONS).map(([key, option]) => (
              <option key={key} value={key}>{option.label} ({option.frequencyCount} frequencies)</option>
            ))}
          </select>
        </label>
        <label>
          Colour Range
          <select value={colorMode} aria-describedby={colorNoteId} onChange={(event) => setColorMode(event.target.value as WaveletColorMode)}>
            <option value="fixed-db">Fixed dB (shared/comparable)</option>
            <option value="record-percentile">Record percentile (not comparable)</option>
          </select>
        </label>
        {colorMode === 'fixed-db' && (
          <>
            <label>
              dB Minimum
              <input type="number" step="5" value={dbMinimum} onChange={(event) => setDbMinimum(Number(event.target.value))} />
            </label>
            <label>
              dB Maximum
              <input type="number" step="5" value={dbMaximum} onChange={(event) => setDbMaximum(Number(event.target.value))} />
            </label>
            <label>
              Reference [{result.unit}]
              <input type="number" min="1e-15" step="any" value={dbReference} onChange={(event) => setDbReference(Number(event.target.value))} />
            </label>
          </>
        )}
        <label>
          Descriptive Ridge
          <input type="checkbox" checked={showRidge} onChange={(event) => setShowRidge(event.target.checked)} />
        </label>
        <label>
          Min Frequency [Hz]
          <input type="number" min="0.001" step="0.01" value={minFrequency} onChange={(event) => setMinFrequency(Number(event.target.value))} />
        </label>
        <label>
          Max Frequency [Hz]
          <input type="number" min="0.01" step="0.1" value={maxFrequency} onChange={(event) => setMaxFrequency(Number(event.target.value))} />
        </label>
        <span id={colorNoteId} className="note">{colorScale.summary}</span>
      </div>

      <figure className={`chart-card publication-figure journal-figure${grayscale ? ' grayscale-preview' : ''}`} tabIndex={0} aria-label={`${title} figure; horizontally scrollable on narrow screens`}>
        <div className="chart-toolbar journal-toolbar">
          <div className="figure-toolbar-label">
            <span className="figure-kicker">Journal mixed artwork</span>
            <strong>{title}</strong>
            <span className="note">Morlet ω₀ = 8 · {result.computedSamples.toLocaleString()} samples · {result.frequency.length} frequencies · {displayGrid.columns} displayed time bins</span>
            <span className="note">180 mm · 800 dpi · {colorScale.comparable ? 'shared dB range' : 'record-specific range'} · COI mask{showRidge ? ' · descriptive ridge' : ''}</span>
          </div>
          <div className="button-row compact">
            <button type="button" className="secondary" aria-pressed={grayscale} onClick={() => setGrayscale((value) => !value)}>{grayscale ? 'Colour preview' : 'Grayscale check'}</button>
            <button type="button" className="secondary" aria-label={`Download reproducible methods and provenance for ${title}`} onClick={() => downloadFigureMetadata(`${fileNameBase}_methods`, waveletMethods)}>Methods JSON</button>
            <button type="button" className="secondary" aria-label={`Download ${title} as a portable SVG using system fonts`} onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`, { widthMm: PRINT_WIDTH_MM })}>SVG · vector</button>
            <button type="button" className="secondary" aria-label={`Download ${title} as an ${JOURNAL_LINE_ART_DPI} dpi PNG`} onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, { dpi: JOURNAL_LINE_ART_DPI, widthMm: PRINT_WIDTH_MM })}>PNG · 800 dpi</button>
          </div>
        </div>

        <span className="mobile-scroll-hint" aria-hidden="true">Swipe horizontally to inspect the full figure →</span>
        <svg
          ref={svgRef}
          className="publication-chart journal-chart"
          style={{
            '--journal-axis-font': `${AXIS_FONT}px`,
            '--journal-supplemental-font': `${SMALL_FONT}px`,
          } as CSSProperties}
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <title id={titleId}>{title}</title>
          <desc id={descriptionId}>Morlet wavelet figure with a time history and log-scaled scalogram. {colorScale.summary} Muted edge regions fall outside the cone of influence.{showRidge ? ' The thin ridge is the descriptive maximum-magnitude frequency above the displayed colour floor at each valid time and is not a phase pick or uncertainty estimate.' : ''}</desc>
          <metadata>{JSON.stringify(waveletMethods)}</metadata>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="1" y2="0">
              {COLOR_STOPS.map((stop) => <stop key={stop.t} offset={`${stop.t * 100}%`} stopColor={stop.color} />)}
            </linearGradient>
            <pattern id={coiPatternId} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
              <line x1="0" y1="0" x2="0" y2="14" stroke="#354651" strokeWidth={GUIDE_LINE} opacity="0.22" />
            </pattern>
          </defs>
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="#ffffff" />

          <g>
            <text x={MARGIN.left} y={WAVEFORM_TOP - 10} className="wavelet-panel-label" fontSize={PANEL_FONT} fontWeight="700" fill="#111820">(a)</text>
            <rect x={MARGIN.left} y={WAVEFORM_TOP} width={plotWidth} height={WAVEFORM_HEIGHT} fill="#ffffff" stroke="#3f474d" strokeWidth={AXIS_LINE} />
            {waveYTicks.map((tick) => {
              const y = waveYScale(tick);
              return (
                <g key={`wave-y-${tick}`}>
                  <line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke="#d3d6d8" strokeWidth={GUIDE_LINE} opacity="0.62" />
                  <text x={MARGIN.left - 9} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}
            <path d={waveformPath} fill="none" stroke="#111820" strokeWidth={DATA_LINE} strokeLinecap="round" strokeLinejoin="round" />
            <text x="18" y={WAVEFORM_TOP + WAVEFORM_HEIGHT / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 18 ${WAVEFORM_TOP + WAVEFORM_HEIGHT / 2})`}>
              {quantityLabel(quantity)} [{unitForQuantity(quantity)}]
            </text>
          </g>

          <g>
            <text x={MARGIN.left} y={HEATMAP_TOP - 10} className="wavelet-panel-label" fontSize={PANEL_FONT} fontWeight="700" fill="#111820">(b)</text>
            {leftCoiPath && (
              <text x={MARGIN.left + plotWidth} y={HEATMAP_TOP - 10} textAnchor="end" fontSize={SMALL_FONT} fontWeight="400" fill="#334155">
                Hatching: outside COI
              </text>
            )}
            <rect x={MARGIN.left} y={HEATMAP_TOP} width={plotWidth} height={HEATMAP_HEIGHT} fill="#ffffff" stroke="#3f474d" strokeWidth={AXIS_LINE} />
            {displayGrid.values.map((row, frequencyIndex) => {
              const lowerFrequency = boundaries[frequencyIndex];
              const upperFrequency = boundaries[frequencyIndex + 1];
              const lowerYValue = yAxis === 'frequency' ? lowerFrequency : 1 / upperFrequency;
              const upperYValue = yAxis === 'frequency' ? upperFrequency : 1 / lowerFrequency;
              const y1 = heatYScale(upperYValue);
              const y2 = heatYScale(lowerYValue);
              const y = Math.min(y1, y2);
              const height = Math.abs(y2 - y1) + 0.5;
              return row.map((value, columnIndex) => (
                <rect
                  key={`cell-${frequencyIndex}-${columnIndex}`}
                  x={MARGIN.left + columnIndex * cellWidth}
                  y={y}
                  width={cellWidth + 0.4}
                  height={height}
                  fill={colorForValue(value, colorScale)}
                />
              ));
            })}

            {ridgePath && (
              <g aria-label="Descriptive per-time maximum CWT magnitude ridge inside the cone of influence">
                <path d={ridgePath} fill="none" stroke="#17212b" strokeWidth={GUIDE_LINE} strokeDasharray="3 2" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" />
              </g>
            )}

            {xTicks.map((tick) => {
              const x = xScale(tick);
              return (
                <g key={`heat-x-${tick}`}>
                  <line x1={x} y1={HEATMAP_TOP} x2={x} y2={HEATMAP_TOP + HEATMAP_HEIGHT} stroke="#ffffff" strokeWidth={GUIDE_LINE} opacity="0.38" />
                  <text x={x} y={HEATMAP_TOP + HEATMAP_HEIGHT + 20} textAnchor="middle" className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}

            {yTicks.map((tick) => {
              const y = heatYScale(tick);
              return (
                <g key={`heat-y-${tick}`}>
                  <line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke="#ffffff" strokeWidth={GUIDE_LINE} opacity="0.38" />
                  <text x={MARGIN.left - 9} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}

            {leftCoiPath && (
              <g aria-label="Cone of influence mask">
                <path d={leftCoiPath} fill="#ffffff" opacity="0.36" />
                <path d={rightCoiPath} fill="#ffffff" opacity="0.36" />
                <path d={leftCoiPath} fill={`url(#${coiPatternId})`} />
                <path d={rightCoiPath} fill={`url(#${coiPatternId})`} />
                <path d={leftCoiBoundary} fill="none" stroke="#354651" strokeWidth={GUIDE_LINE} strokeDasharray="4 4" opacity="0.55" />
                <path d={rightCoiBoundary} fill="none" stroke="#354651" strokeWidth={GUIDE_LINE} strokeDasharray="4 4" opacity="0.55" />
              </g>
            )}
            <rect x={MARGIN.left} y={HEATMAP_TOP} width={plotWidth} height={HEATMAP_HEIGHT} fill="none" stroke="#3f474d" strokeWidth={AXIS_LINE} />
            <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 18} textAnchor="middle" className="axis-label">Time [s]</text>
            <text x="18" y={HEATMAP_TOP + HEATMAP_HEIGHT / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 18 ${HEATMAP_TOP + HEATMAP_HEIGHT / 2})`}>
              {yAxis === 'frequency' ? 'Frequency [Hz]' : 'Period [s]'}
            </text>
          </g>

          <g>
            {colorScale.referenceNote && (
              <text x={COLORBAR_X + COLORBAR_WIDTH / 2} y={HEATMAP_TOP - 10} textAnchor="middle" fontSize={SMALL_FONT} fill="#334155">{colorScale.referenceNote}</text>
            )}
            <rect x={COLORBAR_X} y={HEATMAP_TOP} width={COLORBAR_WIDTH} height={HEATMAP_HEIGHT} fill={`url(#${gradientId})`} stroke="#64748b" strokeWidth={GUIDE_LINE} />
            {colorScale.ticks.map((tick) => {
              const y = HEATMAP_TOP + HEATMAP_HEIGHT - ((tick.value - colorScale.minimum) / (colorScale.maximum - colorScale.minimum)) * HEATMAP_HEIGHT;
              return (
                <g key={`color-${tick.value}`}>
                  <line x1={COLORBAR_X + COLORBAR_WIDTH} y1={y} x2={COLORBAR_TICK_X - 3} y2={y} stroke="#334155" strokeWidth={GUIDE_LINE} />
                  <text x={COLORBAR_TICK_X} y={y + 4} className="tick-label">{tick.label}</text>
                </g>
              );
            })}
            <text x={COLORBAR_LABEL_X} y={HEATMAP_TOP + HEATMAP_HEIGHT / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 ${COLORBAR_LABEL_X} ${HEATMAP_TOP + HEATMAP_HEIGHT / 2})`}>
              {colorScale.label}
            </text>
          </g>
        </svg>
        <figcaption className="chart-caption journal-caption">
          Data: {dataSummary}. Preprocessing: {preprocessingSummary}. {resamplingSummary} {colorScale.summary} The Morlet CWT uses ω₀ = 8 and L2 scale normalization (ψ<sub>s</sub> = ψ(t/s)/√s), so coefficient units are input units × √s ({result.unit}). The transform used {result.computedSamples.toLocaleString()} samples at Δt = {formatTick(result.effectiveDt)} s and {result.frequency.length} logarithmically spaced frequencies from {formatTick(result.frequency[0])} to {formatTick(result.frequency[result.frequency.length - 1])} Hz. Displayed time bins are contiguous arithmetic means of coefficient magnitude. Muted regions are outside the cone of influence and should not be interpreted.{showRidge ? ' The thin line is the per-time maximum CWT magnitude inside the COI, with values below the displayed colour floor omitted; it is descriptive and is not a phase pick or uncertainty estimate.' : ''}
        </figcaption>
      </figure>
    </div>
  );
}
