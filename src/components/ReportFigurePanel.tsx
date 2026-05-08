import { useMemo, useRef, useState } from 'react';
import { computeStationDistanceRows, type StationDistanceRow } from '../analysis/distance';
import { computeJmaIntensity } from '../analysis/jmaIntensity';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, PeakSummary, Quantity, ResponseSpectrumSettings } from '../types/waveform';
import { formatNumber, safeFileName } from '../utils/file';

interface ReportFigurePanelProps {
  waveforms: DerivedWaveform[];
  peaks: PeakSummary[];
  responseSettings: ResponseSpectrumSettings;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReportStation {
  id: string;
  label: string;
  row?: StationDistanceRow;
  waveforms: DerivedWaveform[];
  peaks: PeakSummary[];
}

interface SeriesSpec {
  name: string;
  x: number[];
  y: number[];
  color: string;
}

const WIDTH = 1120;
const HEIGHT = 1584;
const FONT_FAMILY = 'Arial, Helvetica, sans-serif';
const COLORS: Record<string, string> = {
  NS: '#D55E00',
  EW: '#0072B2',
  UD: '#009E73',
  OTHER: '#CC79A7',
};
const LOG_SNAP_STEP = 0.25;

interface LogRange {
  minLog: number;
  maxLog: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function componentRank(component: string): number {
  if (component === 'NS') return 0;
  if (component === 'EW') return 1;
  if (component === 'UD') return 2;
  return 3;
}

function quantityValues(waveform: DerivedWaveform, quantity: Quantity): number[] {
  if (quantity === 'acceleration') return waveform.acceleration;
  if (quantity === 'velocity') return waveform.velocity;
  return waveform.displacement;
}

function quantityUnit(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s2';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function maxAbsWithTime(values: readonly number[], times: readonly number[]): { value: number; time: number } {
  let max = 0;
  let index = 0;
  for (let i = 0; i < values.length; i += 1) {
    const abs = Math.abs(values[i]);
    if (Number.isFinite(abs) && abs > max) {
      max = abs;
      index = i;
    }
  }
  return { value: max, time: times[index] ?? 0 };
}

function metricPeak(peaks: readonly PeakSummary[], key: 'pga' | 'pgv' | 'pgd'): { value: number; component: string } | undefined {
  let best: { value: number; component: string } | undefined;
  for (const peak of peaks) {
    const value = peak[key];
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value) best = { value, component: peak.componentLabel };
  }
  return best;
}

function stationLabelFromWaveform(waveform: DerivedWaveform): string {
  const { stationCode, stationLat, stationLon } = waveform.metadata;
  if (stationCode) return stationCode;
  if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) return `${stationLat.toFixed(5)}, ${stationLon.toFixed(5)}`;
  return 'Loaded waveform set';
}

function buildReportStations(waveforms: readonly DerivedWaveform[], peaks: readonly PeakSummary[]): ReportStation[] {
  const rows = computeStationDistanceRows(waveforms.map((waveform) => ({
    id: waveform.sourceRecordId,
    fileName: waveform.fileName,
    sourceType: 'unknown',
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    quantity: 'acceleration',
    unit: 'cm/s2',
    values: [],
    dt: waveform.dt,
    samplingHz: waveform.samplingHz,
    metadata: waveform.metadata,
  })));

  if (rows.length === 0 && waveforms.length > 0) {
    return [{
      id: 'all',
      label: stationLabelFromWaveform(waveforms[0]),
      waveforms: [...waveforms],
      peaks: [...peaks],
    }];
  }

  return rows.map((row) => {
    const ids = new Set(row.recordIds);
    return {
      id: row.id,
      label: row.label,
      row,
      waveforms: waveforms.filter((waveform) => ids.has(waveform.sourceRecordId)),
      peaks: peaks.filter((peak) => ids.has(peak.sourceRecordId)),
    };
  });
}

function scaleLinear(value: number, domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): number {
  if (domainMax === domainMin) return (rangeMin + rangeMax) / 2;
  return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

function scaleLog(value: number, domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): number {
  if (value <= 0 || domainMin <= 0 || domainMax <= domainMin) return rangeMin;
  return rangeMin + ((Math.log10(value) - Math.log10(domainMin)) / (Math.log10(domainMax) - Math.log10(domainMin))) * (rangeMax - rangeMin);
}

function downsampleIndices(length: number, maxPoints: number): number[] {
  if (length <= maxPoints) return Array.from({ length }, (_, index) => index);
  const step = Math.ceil(length / maxPoints);
  const indices: number[] = [];
  for (let i = 0; i < length; i += step) indices.push(i);
  if (indices[indices.length - 1] !== length - 1) indices.push(length - 1);
  return indices;
}

function timePath(time: readonly number[], values: readonly number[], rect: Rect, maxAbs: number): string {
  const n = Math.min(time.length, values.length);
  if (n === 0 || maxAbs <= 0) return '';
  const indices = downsampleIndices(n, 900);
  const xMin = time[0] ?? 0;
  const xMax = time[n - 1] ?? Math.max(1, n - 1);

  return indices.map((index, pathIndex) => {
    const x = scaleLinear(time[index], xMin, xMax, rect.x, rect.x + rect.width);
    const y = scaleLinear(values[index], -maxAbs, maxAbs, rect.y + rect.height, rect.y);
    return `${pathIndex === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function logTicks(min: number, max: number): number[] {
  if (min <= 0 || max <= min) return [];
  const ticks: number[] = [];
  const start = Math.floor(Math.log10(min));
  const end = Math.ceil(Math.log10(max));
  for (let exp = start; exp <= end; exp += 1) {
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * 10 ** exp;
      if (value >= min * 0.999 && value <= max * 1.001) ticks.push(value);
    }
  }
  return ticks;
}

function logMinorValues(min: number, max: number): number[] {
  if (min <= 0 || max <= min) return [];
  const values: number[] = [];
  const start = Math.floor(Math.log10(min));
  const end = Math.ceil(Math.log10(max));
  for (let exp = start; exp <= end; exp += 1) {
    for (let multiplier = 1; multiplier < 10; multiplier += 1) {
      const value = multiplier * 10 ** exp;
      if (value >= min * 0.999 && value <= max * 1.001) values.push(value);
    }
  }
  return values;
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

function powerLabel(exponent: number): string {
  return `10^${exponent}`;
}

function niceLogFloor(value: number, fallback: number): number {
  if (!isFiniteNumber(value) || value <= 0) return fallback;
  return 10 ** Math.floor(Math.log10(value));
}

function niceLogCeil(value: number, fallback: number): number {
  if (!isFiniteNumber(value) || value <= 0) return fallback;
  return 10 ** Math.ceil(Math.log10(value));
}

function responseSeries(waveforms: readonly DerivedWaveform[], settings: ResponseSpectrumSettings): SeriesSpec[] {
  return computeResponseSpectra([...waveforms], settings)
    .sort((a, b) => componentRank(a.component) - componentRank(b.component))
    .map((result) => ({
      name: result.componentLabel,
      x: result.points.map((point) => point.period),
      y: result.points.map((point) => point.psv),
      color: COLORS[result.component] ?? COLORS.OTHER,
    }));
}

function log10(value: number): number {
  return Math.log(value) / Math.LN10;
}

function toLogRange(domain: [number, number]): LogRange {
  return { minLog: log10(domain[0]), maxLog: log10(domain[1]) };
}

function fromLogRange(range: LogRange): [number, number] {
  return [10 ** range.minLog, 10 ** range.maxLog];
}

function snapLogRange(range: LogRange): LogRange {
  return {
    minLog: Math.floor(range.minLog / LOG_SNAP_STEP) * LOG_SNAP_STEP,
    maxLog: Math.ceil(range.maxLog / LOG_SNAP_STEP) * LOG_SNAP_STEP,
  };
}

function expandLogRange(range: LogRange, targetSpan: number): LogRange {
  const span = range.maxLog - range.minLog;
  if (span >= targetSpan) return range;
  const missing = targetSpan - span;
  return {
    minLog: range.minLog - missing / 2,
    maxLog: range.maxLog + missing / 2,
  };
}

function responseSeriesRange(series: readonly SeriesSpec[]): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = 0;
  for (const entry of series) {
    for (const value of entry.y) {
      if (!Number.isFinite(value) || value <= 0) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return max > 0 && Number.isFinite(min) ? { min, max } : undefined;
}

function tripartiteDomains(series: readonly SeriesSpec[], settings: ResponseSpectrumSettings): { xDomain: [number, number]; yDomain: [number, number] } {
  const xDomain: [number, number] = [
    niceLogFloor(Math.min(settings.minPeriod, 0.01), 0.01),
    niceLogCeil(Math.max(settings.maxPeriod, 10), 10),
  ];
  const range = responseSeriesRange(series);
  const yRange = range
    ? snapLogRange({
      minLog: log10(range.min) - 0.08,
      maxLog: log10(range.max) + 0.08,
    })
    : { minLog: -2, maxLog: 1 };
  const xRange = toLogRange(xDomain);
  const targetSpan = Math.max(xRange.maxLog - xRange.minLog, yRange.maxLog - yRange.minLog);

  return {
    xDomain: fromLogRange(expandLogRange(xRange, targetSpan)),
    yDomain: fromLogRange(expandLogRange(yRange, targetSpan)),
  };
}

function linePath(series: SeriesSpec, rect: Rect, xDomain: [number, number], yDomain: [number, number]): string {
  const n = Math.min(series.x.length, series.y.length);
  if (n === 0) return '';
  const indices = downsampleIndices(n, 700);
  const parts: string[] = [];
  for (const index of indices) {
    const xValue = series.x[index];
    const yValue = series.y[index];
    if (!Number.isFinite(xValue) || !Number.isFinite(yValue) || xValue <= 0 || yValue <= 0) continue;
    const x = scaleLog(xValue, xDomain[0], xDomain[1], rect.x, rect.x + rect.width);
    const y = scaleLog(yValue, yDomain[0], yDomain[1], rect.y + rect.height, rect.y);
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return parts.join(' ');
}

function fmt(value: number | undefined, digits = 4, suffix = ''): string {
  return isFiniteNumber(value) ? `${formatNumber(value, digits)}${suffix}` : '-';
}

function card(rect: Rect, title: string, children: JSX.Element): JSX.Element {
  return (
    <g>
      <text x={rect.x} y={rect.y + 18} fontSize="15" fontWeight="700" fill="#111827">{title}</text>
      <line x1={rect.x} y1={rect.y + 30} x2={rect.x + rect.width} y2={rect.y + 30} stroke="#111827" strokeWidth="0.75" />
      {children}
    </g>
  );
}

function textRows(x: number, y: number, rows: Array<[string, string]>, rowHeight = 27): JSX.Element {
  return (
    <g>
      {rows.map(([label, value], index) => (
        <g key={label} transform={`translate(${x} ${y + index * rowHeight})`}>
          <text x="0" y="0" fontSize="11.5" fontWeight="700" fill="#4b5563">{label}</text>
          <text x="132" y="0" fontSize="12" fontWeight="600" fill="#111827">{value}</text>
        </g>
      ))}
    </g>
  );
}

function renderWaveformPanel(rect: Rect, title: string, waveforms: readonly DerivedWaveform[], quantity: Quantity): JSX.Element {
  const ordered = [...waveforms].sort((a, b) => componentRank(a.component) - componentRank(b.component));
  const plotTop = rect.y + 44;
  const rowHeight = (rect.height - 86) / Math.max(1, ordered.length);
  const plotWidth = rect.width - 120;

  return card(rect, title, (
    <g>
      {ordered.length === 0 ? (
        <text x={rect.x + rect.width / 2} y={rect.y + rect.height / 2} textAnchor="middle" fontSize="13" fontWeight="600" fill="#6b7280">No waveform data</text>
      ) : ordered.map((waveform, index) => {
        const rowRect: Rect = {
          x: rect.x + 76,
          y: plotTop + index * rowHeight + 8,
          width: plotWidth,
          height: Math.max(28, rowHeight - 18),
        };
        const values = quantityValues(waveform, quantity);
        const peak = maxAbsWithTime(values, waveform.time);
        const maxAbs = Math.max(peak.value, 1e-12);
        const color = COLORS[waveform.component] ?? COLORS.OTHER;
        return (
          <g key={`${quantity}-${waveform.sourceRecordId}`}>
            <text x={rect.x + 2} y={rowRect.y + rowRect.height / 2 + 5} fontSize="12.5" fontWeight="700" fill={color}>{waveform.componentLabel}</text>
            <line x1={rowRect.x} y1={rowRect.y + rowRect.height / 2} x2={rowRect.x + rowRect.width} y2={rowRect.y + rowRect.height / 2} stroke="#9ca3af" strokeWidth="0.55" />
            <path d={timePath(waveform.time, values, rowRect, maxAbs)} fill="none" stroke={color} strokeWidth="1.05" />
            <text x={rowRect.x + rowRect.width - 7} y={rowRect.y + 14} textAnchor="end" fontSize="10.5" fontWeight="600" fill="#374151">
              Max {formatNumber(peak.value, 4)} {quantityUnit(quantity)} at {formatNumber(peak.time, 3)} s
            </text>
          </g>
        );
      })}
      <text x={rect.x + rect.width / 2} y={rect.y + rect.height - 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#374151">Time [s]</text>
    </g>
  ));
}

function renderResponsePanel(rect: Rect, series: readonly SeriesSpec[], settings: ResponseSpectrumSettings): JSX.Element {
  const leftAxis = 78;
  const rightPad = 30;
  const plotSize = Math.min(rect.width - leftAxis - rightPad, rect.height - 98);
  const plot: Rect = {
    x: rect.x + leftAxis + (rect.width - leftAxis - rightPad - plotSize) / 2,
    y: rect.y + 48,
    width: plotSize,
    height: plotSize,
  };
  const { xDomain, yDomain } = tripartiteDomains(series, settings);
  const xTicks = logTicks(xDomain[0], xDomain[1]);
  const yTicks = logTicks(yDomain[0], yDomain[1]);
  const tripartiteScaleValues = logMinorValues(yDomain[0] / 1000, yDomain[1] * 1000);
  const tripartitePeriodValues = logMinorValues(xDomain[0], xDomain[1]);
  const accelerationLabelExponents = Array.from(
    { length: Math.max(0, Math.ceil(Math.log10(yDomain[1])) + 2 - Math.floor(Math.log10(yDomain[0])) + 1) },
    (_, i) => Math.floor(Math.log10(yDomain[0])) + i,
  );
  const displacementLabelExponents = Array.from(
    { length: Math.max(0, Math.ceil(Math.log10(yDomain[1])) - 1 - (Math.floor(Math.log10(yDomain[0])) - 2) + 1) },
    (_, i) => Math.floor(Math.log10(yDomain[0])) - 2 + i,
  );
  const clipId = 'report-tripartite-clip';

  const guidePath = (points: Array<[number, number]>): string => points
    .filter(([xValue, yValue]) => Number.isFinite(xValue) && Number.isFinite(yValue) && xValue > 0 && yValue > 0)
    .map(([xValue, yValue], index) => {
      const x = scaleLog(xValue, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
      const y = scaleLog(yValue, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const insideDomain = (xValue: number, yValue: number): boolean => (
    xValue >= xDomain[0]
    && xValue <= xDomain[1]
    && yValue >= yDomain[0]
    && yValue <= yDomain[1]
  );

  return card(rect, 'Tripartite Response Spectrum: pSv', (
    <g>
      <defs>
        <clipPath id={clipId}>
          <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} />
        </clipPath>
      </defs>
      <text x={rect.x + rect.width - 2} y={rect.y + 18} textAnchor="end" fontSize="11.5" fontWeight="700" fill="#374151">Damping h = {(settings.dampingRatio * 100).toFixed(1)}%</text>
      <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="#ffffff" stroke="#111827" strokeWidth="1" />
      {xTicks.map((tick) => {
        const x = scaleLog(tick, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        return (
          <g key={`x-${tick}`}>
            <text x={x} y={plot.y + plot.height + 17} textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}
      {yTicks.map((tick) => {
        const y = scaleLog(tick, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <g key={`y-${tick}`}>
            <text x={plot.x - 9} y={y + 4} textAnchor="end" fontSize="10.5" fontWeight="600" fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}

      <g clipPath={`url(#${clipId})`}>
        {tripartiteScaleValues.map((value) => (
          <g key={`trip-${value}`}>
            <path
              d={guidePath([
                [xDomain[0], (value * xDomain[0]) / (2 * Math.PI)],
                [xDomain[1], (value * xDomain[1]) / (2 * Math.PI)],
              ])}
              fill="none"
              stroke="#98a2b3"
              strokeWidth="0.7"
              strokeDasharray="4 4"
            />
            <path
              d={guidePath([
                [xDomain[0], (value * 2 * Math.PI) / xDomain[0]],
                [xDomain[1], (value * 2 * Math.PI) / xDomain[1]],
              ])}
              fill="none"
              stroke="#98a2b3"
              strokeWidth="0.7"
              strokeDasharray="4 4"
            />
            <path
              d={guidePath([
                [xDomain[0], value],
                [xDomain[1], value],
              ])}
              fill="none"
              stroke="#98a2b3"
              strokeWidth="0.7"
              strokeDasharray="4 4"
            />
          </g>
        ))}
        {tripartitePeriodValues.map((period) => (
          <line
            key={`period-${period}`}
            x1={scaleLog(period, xDomain[0], xDomain[1], plot.x, plot.x + plot.width)}
            y1={plot.y}
            x2={scaleLog(period, xDomain[0], xDomain[1], plot.x, plot.x + plot.width)}
            y2={plot.y + plot.height}
            stroke="#98a2b3"
            strokeWidth="0.7"
            strokeDasharray="4 4"
          />
        ))}
        {series.map((entry) => (
          <path key={entry.name} d={linePath(entry, plot, xDomain, yDomain)} fill="none" stroke={entry.color} strokeWidth="1.8" />
        ))}
      </g>

      {accelerationLabelExponents.map((exponent) => {
        const acceleration = 10 ** exponent;
        let xValue = xDomain[1];
        let yValue = (acceleration * xValue) / (2 * Math.PI);
        if (yValue > yDomain[1]) {
          yValue = yDomain[1] / 1.08;
          xValue = (2 * Math.PI * yValue) / acceleration;
        }
        if (!insideDomain(xValue, yValue)) return null;
        const x = scaleLog(xValue, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        const y = scaleLog(yValue, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <text
            key={`acc-label-${exponent}`}
            x={x}
            y={y}
            textAnchor="middle"
            fontSize="9.5"
            fontWeight="600"
            fill="#667085"
            transform={`rotate(-38 ${x} ${y})`}
          >
            {exponent === accelerationLabelExponents[accelerationLabelExponents.length - 1]
              ? `${powerLabel(exponent)} cm/s^2`
              : powerLabel(exponent)}
          </text>
        );
      })}
      {displacementLabelExponents.map((exponent) => {
        const displacement = 10 ** exponent;
        let xValue = xDomain[0];
        let yValue = (displacement * 2 * Math.PI) / xValue;
        if (yValue > yDomain[1]) {
          yValue = yDomain[1] / 1.06;
          xValue = (2 * Math.PI * displacement) / yValue;
        }
        if (!insideDomain(xValue, yValue)) return null;
        const x = scaleLog(xValue, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        const y = scaleLog(yValue, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <text
            key={`disp-label-${exponent}`}
            x={x}
            y={y}
            textAnchor="middle"
            fontSize="9.5"
            fontWeight="600"
            fill="#667085"
            transform={`rotate(38 ${x} ${y})`}
          >
            {exponent === displacementLabelExponents[displacementLabelExponents.length - 1]
              ? `${powerLabel(exponent)} cm`
              : powerLabel(exponent)}
          </text>
        );
      })}

      <text x={plot.x + plot.width / 2} y={rect.y + rect.height - 17} textAnchor="middle" fontSize="12" fontWeight="700" fill="#111827">Period [s]</text>
      <text x={rect.x + 28} y={plot.y + plot.height / 2} textAnchor="middle" fontSize="12" fontWeight="700" fill="#111827" transform={`rotate(-90 ${rect.x + 28} ${plot.y + plot.height / 2})`}>pSv [cm/s]</text>
      <g transform={`translate(${plot.x + 16} ${plot.y + 20})`}>
        {series.map((entry, index) => (
          <g key={`legend-${entry.name}`} transform={`translate(${index * 120} 0)`}>
            <line x1="0" y1="0" x2="24" y2="0" stroke={entry.color} strokeWidth="1.8" />
            <text x="30" y="4" fontSize="11.5" fontWeight="700" fill="#111827">{entry.name}</text>
          </g>
        ))}
      </g>
    </g>
  ));
}

export function ReportFigurePanel({ waveforms, peaks, responseSettings }: ReportFigurePanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stations = useMemo(() => buildReportStations(waveforms, peaks), [waveforms, peaks]);
  const [stationId, setStationId] = useState<string>('');
  const selectedStation = stations.find((station) => station.id === (stationId || stations[0]?.id)) ?? stations[0];
  const selectedWaveforms = useMemo(
    () => selectedStation?.waveforms.slice().sort((a, b) => componentRank(a.component) - componentRank(b.component)) ?? [],
    [selectedStation],
  );
  const selectedPeaks = selectedStation?.peaks ?? [];
  const selectedIntensity = useMemo(() => computeJmaIntensity(selectedWaveforms), [selectedWaveforms]);
  const response = useMemo(() => responseSeries(selectedWaveforms, responseSettings), [selectedWaveforms, responseSettings]);

  if (waveforms.length === 0 || !selectedStation) {
    return <p className="empty-state">No data is available for the report figure.</p>;
  }

  const row = selectedStation.row;
  const firstWaveform = selectedWaveforms[0] ?? waveforms[0];
  const pga = metricPeak(selectedPeaks, 'pga');
  const pgv = metricPeak(selectedPeaks, 'pgv');
  const pgd = metricPeak(selectedPeaks, 'pgd');
  const fileNameBase = safeFileName(`report_overview_${selectedStation.label}`);

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        {stations.length > 1 && (
          <label>
            Station
            <select value={selectedStation.id} onChange={(event) => setStationId(event.target.value)}>
              {stations.map((station) => <option key={station.id} value={station.id}>{station.label}</option>)}
            </select>
          </label>
        )}
        <span className="note">A4 portrait overview figure with metadata, intensity, distance, stacked waveforms, and tripartite response spectrum.</span>
      </div>

      <div className="chart-card">
        <div className="chart-toolbar">
          <span aria-hidden="true" />
          <div className="button-row compact">
            <button type="button" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`)}>SVG</button>
            <button type="button" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, 2)}>PNG</button>
          </div>
        </div>
        <svg
          ref={svgRef}
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="Strong motion report overview"
          style={{ fontFamily: FONT_FAMILY }}
        >
          <rect width={WIDTH} height={HEIGHT} fill="#ffffff" />
          <text x="60" y="54" fontSize="23" fontWeight="700" fill="#111827">Strong Motion Record Overview</text>
          <text x={WIDTH - 60} y="53" textAnchor="end" fontSize="13.5" fontWeight="600" fill="#374151">{selectedStation.label}</text>
          <line x1="60" y1="74" x2={WIDTH - 60} y2="74" stroke="#111827" strokeWidth="0.9" />

          {card({ x: 60, y: 94, width: 310, height: 180 }, 'Record', (
            textRows(60, 148, [
              ['Station', selectedStation.label],
              ['Record Time', firstWaveform.metadata.recordTime ?? '-'],
              ['Origin Time', firstWaveform.metadata.originTime ?? '-'],
              ['Components', selectedWaveforms.map((waveform) => waveform.componentLabel).join(' / ') || '-'],
              ['Sampling', `${formatNumber(firstWaveform.samplingHz, 4)} Hz`],
              ['Files', `${selectedWaveforms.length}`],
            ], 22)
          ))}

          {card({ x: 400, y: 94, width: 360, height: 180 }, 'Coordinates and Distance', (
            textRows(400, 148, [
              ['Station Lat/Lon', `${fmt(row?.stationLat, 6)}, ${fmt(row?.stationLon, 6)}`],
              ['Source Lat/Lon', `${fmt(row?.eventLat, 6)}, ${fmt(row?.eventLon, 6)}`],
              ['Source Depth', fmt(row?.depthKm, 3, ' km')],
              ['Epicentral Dist.', fmt(row?.epicentralDistanceKm, 3, ' km')],
              ['Hypocentral Dist.', fmt(row?.hypocentralDistanceKm, 3, ' km')],
            ], 22)
          ))}

          {card({ x: 790, y: 94, width: 270, height: 180 }, 'Ground Motion Strength', (
            <g>
              {textRows(790, 148, [
                ['JMA Intensity', selectedIntensity.available ? formatNumber(selectedIntensity.intensity, 1) : '-'],
                ['Shindo Class', selectedIntensity.available ? selectedIntensity.classLabel : '-'],
                ['PGA', pga ? `${formatNumber(pga.value, 4)} cm/s2 (${pga.component})` : '-'],
                ['PGV', pgv ? `${formatNumber(pgv.value, 4)} cm/s (${pgv.component})` : '-'],
                ['PGD', pgd ? `${formatNumber(pgd.value, 4)} cm (${pgd.component})` : '-'],
              ], 22)}
            </g>
          ))}

          {renderWaveformPanel({ x: 60, y: 310, width: 1000, height: 245 }, 'Acceleration Waveforms', selectedWaveforms, 'acceleration')}
          {renderWaveformPanel({ x: 60, y: 592, width: 1000, height: 245 }, 'Velocity Waveforms', selectedWaveforms, 'velocity')}
          {renderResponsePanel({ x: 175, y: 875, width: 770, height: 650 }, response, responseSettings)}
        </svg>
      </div>
    </div>
  );
}
