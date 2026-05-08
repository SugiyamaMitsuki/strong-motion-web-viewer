import { useId, useMemo, useRef, useState } from 'react';
import { computeMorletWavelet, defaultWaveletOptions, type WaveletResult } from '../analysis/wavelet';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { safeFileName } from '../utils/file';

interface WaveletPanelProps {
  waveforms: DerivedWaveform[];
}

type WaveletResolution = 'fast' | 'standard' | 'detailed';
type WaveletYAxis = 'frequency' | 'period';

interface DisplayGrid {
  columns: number;
  values: number[][];
  colorMin: number;
  colorMax: number;
}

const WIDTH = 980;
const HEIGHT = 620;
const MARGIN = { left: 78, right: 118, top: 40, bottom: 58 };
const WAVEFORM_TOP = 56;
const WAVEFORM_HEIGHT = 132;
const HEATMAP_TOP = 250;
const HEATMAP_HEIGHT = 292;
const COLOR_STOPS = [
  { t: 0, color: '#f8fafc' },
  { t: 0.12, color: '#dbeafe' },
  { t: 0.34, color: '#60a5fa' },
  { t: 0.56, color: '#22c55e' },
  { t: 0.76, color: '#facc15' },
  { t: 1, color: '#dc2626' },
];

const RESOLUTION_OPTIONS: Record<WaveletResolution, { label: string; frequencyCount: number; maxSamples: number }> = {
  fast: { label: 'Fast', frequencyCount: 48, maxSamples: 4096 },
  standard: { label: 'Standard', frequencyCount: 80, maxSamples: 6144 },
  detailed: { label: 'Detailed', frequencyCount: 120, maxSamples: 8192 },
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

function colorForValue(value: number, colorMin: number, colorMax: number): string {
  if (!Number.isFinite(value) || value <= 0 || colorMin <= 0 || colorMax <= colorMin) return '#f8fafc';
  const t = Math.max(0, Math.min(1, (Math.log10(value) - Math.log10(colorMin)) / (Math.log10(colorMax) - Math.log10(colorMin))));
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
  const n = Math.min(time.length, values.length);
  if (n === 0) return '';
  const stride = Math.max(1, Math.ceil(n / 1600));
  const parts: string[] = [];

  for (let i = 0; i < n; i += stride) {
    const x = xScale(time[i]);
    const y = yScale(values[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }

  if ((n - 1) % stride !== 0) {
    const x = xScale(time[n - 1]);
    const y = yScale(values[n - 1]);
    parts.push(`L${x.toFixed(2)},${y.toFixed(2)}`);
  }

  return parts.join(' ');
}

export function WaveletPanel({ waveforms }: WaveletPanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reactId = useId();
  const gradientId = `wavelet-gradient-${reactId.replace(/:/g, '')}`;
  const [selectedWaveformId, setSelectedWaveformId] = useState('');
  const [quantity, setQuantity] = useState<Quantity>('acceleration');
  const [yAxis, setYAxis] = useState<WaveletYAxis>('frequency');
  const [resolution, setResolution] = useState<WaveletResolution>('standard');
  const [minFrequency, setMinFrequency] = useState(defaultWaveletOptions.minFrequency);
  const [maxFrequency, setMaxFrequency] = useState(defaultWaveletOptions.maxFrequency);

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

  const displayGrid = useMemo(() => (result ? buildDisplayGrid(result) : undefined), [result]);

  if (waveforms.length === 0) return <p className="empty-state">No data is available for wavelet analysis.</p>;
  if (!selectedWaveform || !result || !displayGrid || result.time.length === 0 || result.frequency.length === 0) {
    return <p className="empty-state">Wavelet analysis is not available for the selected data.</p>;
  }

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const timeMin = result.time[0] ?? 0;
  const timeMax = result.time[result.time.length - 1] ?? 1;
  const xScale = (value: number): number => MARGIN.left + ((value - timeMin) / Math.max(timeMax - timeMin, Number.EPSILON)) * plotWidth;
  const waveformValues = values.length === result.time.length
    ? values
    : result.time.map((_, index) => values[Math.min(values.length - 1, Math.round((index / Math.max(1, result.time.length - 1)) * (values.length - 1)))] ?? 0);
  const finiteWaveValues = waveformValues.filter((value) => Number.isFinite(value));
  const waveAbsMax = Math.max(...finiteWaveValues.map((value) => Math.abs(value)), 1);
  const waveDomainMax = waveAbsMax * 1.08;
  const waveYScale = (value: number): number => WAVEFORM_TOP + WAVEFORM_HEIGHT / 2 - (value / waveDomainMax) * (WAVEFORM_HEIGHT / 2);
  const waveformPath = buildWaveformPath(result.time, waveformValues, xScale, waveYScale);
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
  const colorTicks = [displayGrid.colorMin, Math.sqrt(displayGrid.colorMin * displayGrid.colorMax), displayGrid.colorMax];
  const cellWidth = plotWidth / displayGrid.columns;
  const title = `Morlet Wavelet Scalogram: ${selectedWaveform.componentLabel} ${quantityLabel(quantity)}`;
  const fileNameBase = safeFileName(`wavelet_${selectedWaveform.componentLabel}_${quantity}`);

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
              <option key={key} value={key}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Min Frequency [Hz]
          <input type="number" min="0.001" step="0.01" value={minFrequency} onChange={(event) => setMinFrequency(Number(event.target.value))} />
        </label>
        <label>
          Max Frequency [Hz]
          <input type="number" min="0.01" step="0.1" value={maxFrequency} onChange={(event) => setMaxFrequency(Number(event.target.value))} />
        </label>
      </div>

      <div className="chart-card">
        <div className="chart-toolbar">
          <span className="note">
            Morlet omega0=8, {result.computedSamples.toLocaleString()} samples, {result.frequency.length} frequencies
          </span>
          <div className="button-row compact">
            <button type="button" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`)}>SVG</button>
            <button type="button" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, 2)}>PNG</button>
          </div>
        </div>

        <svg ref={svgRef} width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="1" y2="0">
              {COLOR_STOPS.map((stop) => <stop key={stop.t} offset={`${stop.t * 100}%`} stopColor={stop.color} />)}
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="#ffffff" />
          <text x={WIDTH / 2} y="25" textAnchor="middle" className="chart-title">{title}</text>

          <g>
            <rect x={MARGIN.left} y={WAVEFORM_TOP} width={plotWidth} height={WAVEFORM_HEIGHT} fill="#ffffff" stroke="#64748b" strokeWidth="0.9" />
            {waveYTicks.map((tick) => {
              const y = waveYScale(tick);
              return (
                <g key={`wave-y-${tick}`}>
                  <line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke="#e2e8f0" strokeWidth="0.8" />
                  <text x={MARGIN.left - 9} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}
            <path d={waveformPath} fill="none" stroke="#1d4ed8" strokeWidth="1.15" vectorEffect="non-scaling-stroke" />
            <text x="18" y={WAVEFORM_TOP + WAVEFORM_HEIGHT / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 18 ${WAVEFORM_TOP + WAVEFORM_HEIGHT / 2})`}>
              {quantityLabel(quantity)} [{unitForQuantity(quantity)}]
            </text>
          </g>

          <g>
            <rect x={MARGIN.left} y={HEATMAP_TOP} width={plotWidth} height={HEATMAP_HEIGHT} fill="#ffffff" stroke="#64748b" strokeWidth="0.9" />
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
                  fill={colorForValue(value, displayGrid.colorMin, displayGrid.colorMax)}
                />
              ));
            })}

            {xTicks.map((tick) => {
              const x = xScale(tick);
              return (
                <g key={`heat-x-${tick}`}>
                  <line x1={x} y1={HEATMAP_TOP} x2={x} y2={HEATMAP_TOP + HEATMAP_HEIGHT} stroke="#e2e8f0" strokeWidth="0.8" />
                  <text x={x} y={HEATMAP_TOP + HEATMAP_HEIGHT + 20} textAnchor="middle" className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}

            {yTicks.map((tick) => {
              const y = heatYScale(tick);
              return (
                <g key={`heat-y-${tick}`}>
                  <line x1={MARGIN.left} y1={y} x2={MARGIN.left + plotWidth} y2={y} stroke="#e2e8f0" strokeWidth="0.8" />
                  <text x={MARGIN.left - 9} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}
            <rect x={MARGIN.left} y={HEATMAP_TOP} width={plotWidth} height={HEATMAP_HEIGHT} fill="none" stroke="#64748b" strokeWidth="0.9" />
            <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 18} textAnchor="middle" className="axis-label">Time [s]</text>
            <text x="18" y={HEATMAP_TOP + HEATMAP_HEIGHT / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 18 ${HEATMAP_TOP + HEATMAP_HEIGHT / 2})`}>
              {yAxis === 'frequency' ? 'Frequency [Hz]' : 'Period [s]'}
            </text>
          </g>

          <g>
            <rect x={WIDTH - 82} y={HEATMAP_TOP} width="16" height={HEATMAP_HEIGHT} fill={`url(#${gradientId})`} stroke="#64748b" strokeWidth="0.8" />
            {colorTicks.map((tick) => {
              const y = HEATMAP_TOP + HEATMAP_HEIGHT - ((Math.log10(tick) - Math.log10(displayGrid.colorMin)) / (Math.log10(displayGrid.colorMax) - Math.log10(displayGrid.colorMin))) * HEATMAP_HEIGHT;
              return (
                <g key={`color-${tick}`}>
                  <line x1={WIDTH - 66} y1={y} x2={WIDTH - 61} y2={y} stroke="#334155" strokeWidth="0.8" />
                  <text x={WIDTH - 57} y={y + 4} className="tick-label">{formatTick(tick)}</text>
                </g>
              );
            })}
            <text x={WIDTH - 24} y={HEATMAP_TOP + HEATMAP_HEIGHT / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 ${WIDTH - 24} ${HEATMAP_TOP + HEATMAP_HEIGHT / 2})`}>
              CWT Magnitude
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}
