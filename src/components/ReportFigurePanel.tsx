import { useMemo, useRef, useState } from 'react';
import { computeStationDistanceRows, type StationDistanceRow } from '../analysis/distance';
import {
  computeFourierAnalysis,
  DEFAULT_PARZEN_BANDWIDTH_HZ,
  smoothFourierSpectrumParzen,
  type FourierAnalysisResult,
  type ParzenSmoothedFourierSpectrum,
} from '../analysis/fourier';
import { computeJmaIntensity } from '../analysis/jmaIntensity';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import { downloadFigureMetadata } from '../export/figureMetadata';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type {
  DerivedWaveform,
  PeakSummary,
  Quantity,
  ResponseSpectrumResult,
  ResponseSpectrumSettings,
  WaveformMetadata,
} from '../types/waveform';
import { formatNumber, safeFileName } from '../utils/file';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { downsampleSegments } from '../visualization/downsample';
import { pointsToUserUnits } from '../visualization/journal';
import { publicationSymmetricLimit } from '../visualization/publicationContext';
import { buildFigureProvenance } from '../visualization/provenance';

interface ReportFigurePanelProps {
  waveforms: DerivedWaveform[];
  jmaWaveforms: DerivedWaveform[];
  peaks: PeakSummary[];
  responseSettings: ResponseSpectrumSettings;
  initialPage?: ReportPage;
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
  dashArray?: string;
}

interface ReportFourierEntry {
  waveform: DerivedWaveform;
  analysis: FourierAnalysisResult;
  smoothing: ParzenSmoothedFourierSpectrum['smoothing'];
  series: SeriesSpec;
}

interface LogRange {
  minLog: number;
  maxLog: number;
}

interface ReportTimeAxis {
  label: string;
  reference: string;
  offsetsByRecordId: Map<string, number>;
}

interface ComponentConsistency {
  completeThreeComponentSet: boolean;
  observedComponents: string[];
  consistentFields: string[];
  inconsistentFields: string[];
  status: 'consistent' | 'review-required';
}

type ReportPage = 'integrated' | 'summary' | 'technical';

const WIDTH = 1120;
const HEIGHT = 1584;
const PRINT_WIDTH_MM = 210;
const FONT_FAMILY = 'Arial, Helvetica, sans-serif';
const REPORT_DAMPING_RATIO = 0.05;
const REPORT_PARZEN_BANDWIDTH_HZ = DEFAULT_PARZEN_BANDWIDTH_HZ;
const LOG_SNAP_STEP = 0.25;

// At 210 mm output width these remain at or above 7.5 pt. Lines remain at or
// above 0.5 pt, including light guide lines.
const SUPPORT_FONT = pointsToUserUnits(7.6, WIDTH, PRINT_WIDTH_MM);
const BODY_FONT = pointsToUserUnits(8.2, WIDTH, PRINT_WIDTH_MM);
const AXIS_FONT = pointsToUserUnits(8.0, WIDTH, PRINT_WIDTH_MM);
const SECTION_FONT = pointsToUserUnits(10.2, WIDTH, PRINT_WIDTH_MM);
const TITLE_FONT = pointsToUserUnits(15, WIDTH, PRINT_WIDTH_MM);
const MIN_LINE = pointsToUserUnits(0.5, WIDTH, PRINT_WIDTH_MM);
const AXIS_LINE = pointsToUserUnits(0.65, WIDTH, PRINT_WIDTH_MM);
const DATA_LINE = pointsToUserUnits(0.9, WIDTH, PRINT_WIDTH_MM);

// The integrated report follows the component convention in the supplied
// reference plate. Independent dash patterns keep the mapping legible in
// greyscale and for readers with colour-vision deficiencies.
const REPORT_COMPONENT_STYLES: Readonly<Record<string, { color: string; dashArray?: string }>> = {
  NS: { color: '#D55E00' },
  EW: { color: '#0072B2', dashArray: '10 4' },
  UD: { color: '#AA3377', dashArray: '2.5 3' },
  OTHER: { color: '#555555', dashArray: '8 3 2 3' },
};

function reportComponentStyle(component: string, fallbackIndex = 0): { color: string; dashArray?: string } {
  return REPORT_COMPONENT_STYLES[component] ?? componentSeriesStyle(component, fallbackIndex);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function parseRecordTimeMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, secondText] = match;
  const second = Number(secondText);
  if (!Number.isFinite(second)) return undefined;
  const wholeSecond = Math.floor(second);
  const milliseconds = Math.round((second - wholeSecond) * 1000);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), wholeSecond, milliseconds);
}

function reportTimeAxis(waveforms: readonly DerivedWaveform[]): ReportTimeAxis {
  const offsetsByRecordId = new Map<string, number>();
  const recordTimes = waveforms.map((waveform) => waveform.metadata.recordTime?.trim());
  const parsedTimes = recordTimes.map((value) => value ? parseRecordTimeMs(value) : undefined);

  if (parsedTimes.length > 0 && parsedTimes.every((value): value is number => value !== undefined)) {
    const earliest = Math.min(...parsedTimes);
    waveforms.forEach((waveform, index) => {
      offsetsByRecordId.set(waveform.sourceRecordId, (parsedTimes[index] - earliest) / 1000);
    });
    const hasOffset = parsedTimes.some((value) => value !== earliest);
    return {
      label: hasOffset ? 'Elapsed time from earliest record start [s]' : 'Time from record start [s]',
      reference: hasOffset ? `earliest record start (${recordTimes[parsedTimes.indexOf(earliest)]})` : `record start (${recordTimes[0]})`,
      offsetsByRecordId,
    };
  }

  waveforms.forEach((waveform) => offsetsByRecordId.set(waveform.sourceRecordId, 0));
  const nonEmptyTimes = recordTimes.filter((value): value is string => Boolean(value));
  const commonStart = nonEmptyTimes.length === waveforms.length && new Set(nonEmptyTimes).size === 1;
  return {
    label: commonStart ? 'Time from record start [s]' : 'Time from each component start [s]',
    reference: commonStart ? `record start (${nonEmptyTimes[0]})` : 'each component record start (absolute alignment unavailable)',
    offsetsByRecordId,
  };
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
  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function formatSignificant(value: number | undefined, digits = 3): string {
  if (!isFiniteNumber(value)) return '-';
  return Number(value.toPrecision(digits)).toString();
}

function formatCoordinate(value: number | undefined): string {
  return isFiniteNumber(value) ? value.toFixed(4) : '-';
}

function formatFixed(value: number | undefined, digits: number, suffix = ''): string {
  return isFiniteNumber(value) ? `${value.toFixed(digits)}${suffix}` : '-';
}

function sampleTimeDigits(dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 2;
  return Math.max(0, Math.min(3, Math.ceil(-Math.log10(dt) - 1e-10)));
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
  if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) return `${stationLat.toFixed(4)}, ${stationLon.toFixed(4)}`;
  return 'Loaded waveform set';
}

function componentSuffix(waveform: DerivedWaveform): string {
  const component = waveform.component;
  if (component !== 'NS' && component !== 'EW' && component !== 'UD') return '';
  const match = waveform.componentLabel.toUpperCase().match(new RegExp(`^${component}(.*)$`));
  return match?.[1] ?? '';
}

function buildReportStations(waveforms: readonly DerivedWaveform[], peaks: readonly PeakSummary[]): ReportStation[] {
  const rows = computeStationDistanceRows(waveforms.map((waveform) => ({
    id: waveform.sourceRecordId,
    fileName: waveform.fileName,
    sourceType: 'unknown',
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    quantity: 'acceleration',
    unit: 'cm/s²',
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

  return rows.flatMap((row) => {
    const ids = new Set(row.recordIds);
    const rowWaveforms = waveforms.filter((waveform) => ids.has(waveform.sourceRecordId));
    const channels = new Map<string, DerivedWaveform[]>();
    rowWaveforms.forEach((waveform) => {
      const suffix = componentSuffix(waveform);
      channels.set(suffix, [...(channels.get(suffix) ?? []), waveform]);
    });
    return Array.from(channels.entries()).map(([suffix, channelWaveforms]) => {
      const channelIds = new Set(channelWaveforms.map((waveform) => waveform.sourceRecordId));
      return {
        id: `${row.id}|channel:${suffix || 'default'}`,
        label: suffix ? `${row.label} channel ${suffix}` : row.label,
        row,
        waveforms: channelWaveforms,
        peaks: peaks.filter((peak) => channelIds.has(peak.sourceRecordId)),
      };
    });
  });
}

function sharedMetadataText(waveforms: readonly DerivedWaveform[], key: keyof WaveformMetadata): string {
  const values = unique(waveforms.map((waveform) => waveform.metadata[key])
    .filter((value): value is string | number => typeof value === 'string' ? Boolean(value.trim()) : isFiniteNumber(value))
    .map((value) => typeof value === 'number' ? Number(value.toPrecision(10)).toString() : value.trim()));
  if (values.length === 0) return '-';
  return values.length === 1 ? values[0] : `Mixed (${values.length} values)`;
}

function sharedMetadataNumber(waveforms: readonly DerivedWaveform[], key: keyof WaveformMetadata): number | undefined {
  const values = unique(waveforms.map((waveform) => waveform.metadata[key])
    .filter(isFiniteNumber)
    .map((value) => Number(value.toPrecision(10))));
  return values.length === 1 ? values[0] : undefined;
}

function recordDurationSeconds(waveforms: readonly DerivedWaveform[]): number | undefined {
  const durations = waveforms.map((waveform) => {
    const first = waveform.time[0];
    const last = waveform.time[waveform.time.length - 1];
    return isFiniteNumber(first) && isFiniteNumber(last) && last >= first ? last - first : undefined;
  }).filter(isFiniteNumber);
  return durations.length > 0 ? Math.max(...durations) : sharedMetadataNumber(waveforms, 'durationSec');
}

function componentConsistency(waveforms: readonly DerivedWaveform[]): ComponentConsistency {
  const components = unique(waveforms.map((waveform) => waveform.component));
  const fields: Array<[string, string[]]> = [
    ['station code', waveforms.map((waveform) => waveform.metadata.stationCode?.trim() ?? '')],
    ['station coordinates', waveforms.map((waveform) => `${waveform.metadata.stationLat ?? ''}|${waveform.metadata.stationLon ?? ''}`)],
    ['event coordinates/depth', waveforms.map((waveform) => `${waveform.metadata.eventLat ?? ''}|${waveform.metadata.eventLon ?? ''}|${waveform.metadata.depthKm ?? ''}`)],
    ['origin time', waveforms.map((waveform) => waveform.metadata.originTime?.trim() ?? '')],
    ['sampling rate', waveforms.map((waveform) => Number(waveform.samplingHz.toPrecision(10)).toString())],
    ['preprocessing', waveforms.map((waveform) => JSON.stringify(waveform.preprocessing ?? null))],
  ];
  const consistentFields = fields.filter(([, values]) => new Set(values).size <= 1).map(([label]) => label);
  const inconsistentFields = fields.filter(([, values]) => new Set(values).size > 1).map(([label]) => label);
  const completeThreeComponentSet = ['NS', 'EW', 'UD'].every((component) => components.includes(component as DerivedWaveform['component']));
  return {
    completeThreeComponentSet,
    observedComponents: components,
    consistentFields,
    inconsistentFields,
    status: inconsistentFields.length === 0 ? 'consistent' : 'review-required',
  };
}

function scaleLinear(value: number, domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): number {
  if (domainMax === domainMin) return (rangeMin + rangeMax) / 2;
  return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

function scaleLog(value: number, domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): number {
  if (value <= 0 || domainMin <= 0 || domainMax <= domainMin) return rangeMin;
  return rangeMin + ((Math.log10(value) - Math.log10(domainMin)) / (Math.log10(domainMax) - Math.log10(domainMin))) * (rangeMax - rangeMin);
}

function timePath(
  time: readonly number[],
  values: readonly number[],
  rect: Rect,
  maxAbs: number,
  timeDomain: [number, number],
): string {
  if (maxAbs <= 0) return '';
  const parts: string[] = [];
  downsampleSegments(time, values, 1200).forEach((segment) => {
    segment.x.forEach((timeValue, index) => {
      const x = scaleLinear(timeValue, timeDomain[0], timeDomain[1], rect.x, rect.x + rect.width);
      const y = scaleLinear(segment.y[index], -maxAbs, maxAbs, rect.y + rect.height, rect.y);
      parts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    });
  });
  return parts.join(' ');
}

function linearTicks(min: number, max: number, targetCount: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const rawStep = (max - min) / Math.max(1, targetCount - 1);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = multiplier * power;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
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

function decadeTicks(min: number, max: number): number[] {
  if (min <= 0 || max <= min) return [];
  const ticks: number[] = [];
  for (let exp = Math.ceil(Math.log10(min)); exp <= Math.floor(Math.log10(max)); exp += 1) ticks.push(10 ** exp);
  return ticks;
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

function niceLogFloor(value: number, fallback: number): number {
  if (!isFiniteNumber(value) || value <= 0) return fallback;
  return 10 ** Math.floor(Math.log10(value));
}

function niceLogCeil(value: number, fallback: number): number {
  if (!isFiniteNumber(value) || value <= 0) return fallback;
  return 10 ** Math.ceil(Math.log10(value));
}

function toLogRange(domain: [number, number]): LogRange {
  return { minLog: Math.log10(domain[0]), maxLog: Math.log10(domain[1]) };
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
  return { minLog: range.minLog - missing / 2, maxLog: range.maxLog + missing / 2 };
}

function responseSeries(
  results: readonly ResponseSpectrumResult[],
  ordinate: 'psv' | 'psa',
): SeriesSpec[] {
  return [...results]
    .sort((a, b) => componentRank(a.component) - componentRank(b.component))
    .map((result, index) => {
      const style = reportComponentStyle(result.component, index);
      return {
        name: result.componentLabel,
        x: result.points.map((point) => point.period),
        y: result.points.map((point) => point[ordinate]),
        color: style.color,
        dashArray: style.dashArray,
      };
    });
}

function responseSeriesRange(series: readonly SeriesSpec[]): { min: number; max: number } | undefined {
  const finite = series.flatMap((entry) => entry.y.filter((value) => Number.isFinite(value) && value > 0));
  if (finite.length === 0) return undefined;
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

function tripartiteDomains(series: readonly SeriesSpec[], settings: ResponseSpectrumSettings): { xDomain: [number, number]; yDomain: [number, number] } {
  const finitePeriods = series.flatMap((entry) => entry.x.filter((value, index) => value > 0 && Number.isFinite(entry.y[index]) && entry.y[index] > 0));
  const finitePeriodMinimum = finitePeriods.length > 0 ? Math.min(...finitePeriods) : Number.NaN;
  const finitePeriodMaximum = finitePeriods.length > 0 ? Math.max(...finitePeriods) : Number.NaN;
  const xDomain: [number, number] = Number.isFinite(finitePeriodMinimum)
    && Number.isFinite(finitePeriodMaximum)
    && finitePeriodMaximum > finitePeriodMinimum
    ? [finitePeriodMinimum, finitePeriodMaximum]
    : [settings.minPeriod, settings.maxPeriod];
  const range = responseSeriesRange(series);
  const yRange = range
    ? snapLogRange({ minLog: Math.log10(range.min) - 0.08, maxLog: Math.log10(range.max) + 0.08 })
    : { minLog: -2, maxLog: 1 };
  const xRange = toLogRange(xDomain);
  const xSpan = xRange.maxLog - xRange.minLog;
  return {
    // Never invent periods outside the finite response calculation. Instead,
    // expand only the pSv ordinate when it needs more decades; render geometry
    // compensates if the data itself spans more pSv decades than period decades.
    xDomain,
    yDomain: fromLogRange(expandLogRange(yRange, xSpan)),
  };
}

function seriesPath(
  series: SeriesSpec,
  rect: Rect,
  xDomain: [number, number],
  yDomain: [number, number],
  yScale: 'linear' | 'log',
): string {
  let firstInside = series.x.findIndex((value) => Number.isFinite(value) && value >= xDomain[0]);
  if (firstInside < 0) return '';
  let lastInside = series.x.length - 1;
  while (lastInside >= 0 && (!Number.isFinite(series.x[lastInside]) || series.x[lastInside] > xDomain[1])) lastInside -= 1;
  if (lastInside < firstInside) return '';
  // Keep one neighbour outside each boundary so the clipped path reaches the
  // exact plotting edge before display downsampling.
  const sliceStart = Math.max(0, firstInside - 1);
  const sliceEnd = Math.min(series.x.length, lastInside + 2);
  const parts: string[] = [];
  downsampleSegments(series.x.slice(sliceStart, sliceEnd), series.y.slice(sliceStart, sliceEnd), 900, (x, y) => (
    Number.isFinite(x) && Number.isFinite(y) && x > 0 && (yScale === 'log' ? y > 0 : y >= 0)
  )).forEach((segment) => {
    let segmentStarted = false;
    segment.x.forEach((xValue, index) => {
      const x = scaleLog(xValue, xDomain[0], xDomain[1], rect.x, rect.x + rect.width);
      const y = yScale === 'log'
        ? scaleLog(segment.y[index], yDomain[0], yDomain[1], rect.y + rect.height, rect.y)
        : scaleLinear(segment.y[index], yDomain[0], yDomain[1], rect.y + rect.height, rect.y);
      parts.push(`${segmentStarted ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
      segmentStarted = true;
    });
  });
  return parts.join(' ');
}

function card(rect: Rect, title: string, children: JSX.Element): JSX.Element {
  return (
    <g>
      <text x={rect.x} y={rect.y + SECTION_FONT} fontSize={SECTION_FONT} fontWeight="700" fill="#17212b">{title}</text>
      <line x1={rect.x} y1={rect.y + 34} x2={rect.x + rect.width} y2={rect.y + 34} stroke="#17212b" strokeWidth={AXIS_LINE} />
      {children}
    </g>
  );
}

function textRows(x: number, y: number, rows: Array<[string, string]>, rowHeight = 27, valueOffset = 132): JSX.Element {
  return (
    <g>
      {rows.map(([label, value], index) => (
        <g key={`${label}-${index}`} transform={`translate(${x} ${y + index * rowHeight})`}>
          <text x="0" y="0" fontSize={SUPPORT_FONT} fontWeight="700" fill="#52606d">{label}</text>
          <text x={valueOffset} y="0" fontSize={BODY_FONT} fontWeight="600" fill="#17212b">{value}</text>
        </g>
      ))}
    </g>
  );
}

function renderWaveformPanel(rect: Rect, title: string, waveforms: readonly DerivedWaveform[], quantity: Quantity): JSX.Element {
  const ordered = [...waveforms].sort((a, b) => componentRank(a.component) - componentRank(b.component));
  const timeAxis = reportTimeAxis(ordered);
  const plotTop = rect.y + 56;
  const rowHeight = (rect.height - 116) / Math.max(1, ordered.length);
  const annotationWidth = 168;
  const plotWidth = rect.width - 82 - annotationWidth;
  let timeMin = Infinity;
  let timeMax = -Infinity;
  let sharedMaxAbs = 0;
  ordered.forEach((waveform) => {
    const values = quantityValues(waveform, quantity);
    const offset = timeAxis.offsetsByRecordId.get(waveform.sourceRecordId) ?? 0;
    for (let index = 0; index < waveform.time.length; index += 1) {
      const time = waveform.time[index] + offset;
      if (Number.isFinite(time)) {
        timeMin = Math.min(timeMin, time);
        timeMax = Math.max(timeMax, time);
      }
      if (Number.isFinite(values[index])) sharedMaxAbs = Math.max(sharedMaxAbs, Math.abs(values[index]));
    }
  });
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) [timeMin, timeMax] = [0, 1];
  if (timeMin === timeMax) timeMax = timeMin + 1;
  sharedMaxAbs = publicationSymmetricLimit(Math.max(sharedMaxAbs, 1e-12));
  const timeDomain: [number, number] = [timeMin, timeMax];
  const axisTicks = linearTicks(timeMin, timeMax, 9);
  const axisX = rect.x + 82;
  const axisY = rect.y + rect.height - 48;

  return card(rect, title, (
    <g
      data-report-waveform-quantity={quantity}
      data-report-time-min={Number(timeDomain[0].toPrecision(12))}
      data-report-time-max={Number(timeDomain[1].toPrecision(12))}
      data-report-symmetric-limit={Number(sharedMaxAbs.toPrecision(12))}
    >
      {ordered.length > 0 && (
        <text x={rect.x + rect.width} y={rect.y + SECTION_FONT} textAnchor="end" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
          Shared ordinate ±{formatSignificant(sharedMaxAbs)} {quantityUnit(quantity)}
        </text>
      )}
      {ordered.length === 0 ? (
        <text x={rect.x + rect.width / 2} y={rect.y + rect.height / 2} textAnchor="middle" fontSize={BODY_FONT} fontWeight="600" fill="#6b7280">No waveform data</text>
      ) : ordered.map((waveform, index) => {
        const rowRect: Rect = {
          x: axisX,
          y: plotTop + index * rowHeight + 7,
          width: plotWidth,
          height: Math.max(32, rowHeight - 16),
        };
        const values = quantityValues(waveform, quantity);
        const offset = timeAxis.offsetsByRecordId.get(waveform.sourceRecordId) ?? 0;
        const alignedTime = offset === 0 ? waveform.time : waveform.time.map((value) => value + offset);
        const peak = maxAbsWithTime(values, alignedTime);
        const style = reportComponentStyle(waveform.component, index);
        const quantitySymbol = quantity === 'acceleration' ? 'a' : quantity === 'velocity' ? 'v' : 'd';
        return (
          <g key={`${quantity}-${waveform.sourceRecordId}`} data-report-waveform-component={waveform.component} data-report-waveform-row-quantity={quantity}>
            <text x={rect.x + 2} y={rowRect.y + rowRect.height / 2 + BODY_FONT * 0.35} fontSize={BODY_FONT} fontWeight="700" fill="#263640">{waveform.componentLabel}</text>
            {axisTicks.slice(1, -1).map((tick) => {
              const x = scaleLinear(tick, timeMin, timeMax, rowRect.x, rowRect.x + rowRect.width);
              return <line key={`${waveform.sourceRecordId}-grid-${tick}`} x1={x} y1={rowRect.y} x2={x} y2={rowRect.y + rowRect.height} stroke="#d9dee3" strokeWidth={MIN_LINE} />;
            })}
            <line x1={rowRect.x} y1={rowRect.y + rowRect.height / 2} x2={rowRect.x + rowRect.width} y2={rowRect.y + rowRect.height / 2} stroke="#8b959e" strokeWidth={MIN_LINE} />
            <line x1={rowRect.x} y1={rowRect.y} x2={rowRect.x} y2={rowRect.y + rowRect.height} stroke="#263640" strokeWidth={AXIS_LINE} />
            {[rowRect.y, rowRect.y + rowRect.height / 2, rowRect.y + rowRect.height].map((y, tickIndex) => (
              <g key={`${waveform.sourceRecordId}-y-tick-${tickIndex}`}>
                <line x1={rowRect.x - 5} y1={y} x2={rowRect.x} y2={y} stroke="#263640" strokeWidth={AXIS_LINE} />
                <text
                  x={rowRect.x - 9}
                  y={y + SUPPORT_FONT * (tickIndex === 0 ? 0.92 : tickIndex === 1 ? 0.34 : -0.12)}
                  textAnchor="end"
                  fontSize={SUPPORT_FONT}
                  fill="#52606d"
                  data-report-waveform-ordinate-label={tickIndex === 0 ? 'positive-limit' : tickIndex === 1 ? 'zero' : 'negative-limit'}
                >
                  {formatTick(tickIndex === 0 ? sharedMaxAbs : tickIndex === 1 ? 0 : -sharedMaxAbs)}
                </text>
              </g>
            ))}
            <path
              d={timePath(alignedTime, values, rowRect, sharedMaxAbs, timeDomain)}
              fill="none"
              stroke={style.color}
              strokeWidth={DATA_LINE}
              strokeDasharray={style.dashArray}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text x={rowRect.x + rowRect.width + 14} y={rowRect.y + rowRect.height / 2 - 2} fontSize={SUPPORT_FONT} fontWeight="700" fill="#374151">
              max |{quantitySymbol}| = {formatSignificant(peak.value)} {quantityUnit(quantity)}
            </text>
            <text x={rowRect.x + rowRect.width + 14} y={rowRect.y + rowRect.height / 2 + SUPPORT_FONT + 4} fontSize={SUPPORT_FONT} fill="#52606d">
              at t = {formatNumber(peak.time, sampleTimeDigits(waveform.dt))} s
            </text>
          </g>
        );
      })}
      {axisTicks.length > 0 && (
        <g>
          <line x1={axisX} y1={axisY} x2={axisX + plotWidth} y2={axisY} stroke="#263640" strokeWidth={AXIS_LINE} />
          {axisTicks.map((tick) => {
            const x = scaleLinear(tick, timeMin, timeMax, axisX, axisX + plotWidth);
            return (
              <g key={`${title}-tick-${tick}`}>
                <line x1={x} y1={axisY} x2={x} y2={axisY + 6} stroke="#263640" strokeWidth={AXIS_LINE} />
                <text x={x} y={axisY + 22} textAnchor="middle" fontSize={AXIS_FONT} fill="#374151">{formatTick(tick)}</text>
              </g>
            );
          })}
        </g>
      )}
      <text x={axisX + plotWidth / 2} y={rect.y + rect.height - 3} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#374151">{timeAxis.label}</text>
    </g>
  ));
}

function renderSpectrumPanel(
  rect: Rect,
  title: string,
  subtitle: string,
  series: readonly SeriesSpec[],
  xDomain: [number, number],
  yDomain: [number, number],
  xLabel: string,
  yLabel: string,
  yScale: 'linear' | 'log',
  clipId: string,
  geometry: 'fill' | 'square' = 'fill',
): JSX.Element {
  const squareSize = Math.min(rect.width - 132, rect.height - 156);
  const plot: Rect = geometry === 'square'
    ? { x: rect.x + 92, y: rect.y + 84, width: squareSize, height: squareSize }
    : { x: rect.x + 82, y: rect.y + 96, width: rect.width - 108, height: rect.height - 170 };
  const xTicks = logTicks(xDomain[0], xDomain[1]);
  const xMajorTicks = decadeTicks(xDomain[0], xDomain[1]);
  const yTicks = yScale === 'log' ? decadeTicks(yDomain[0], yDomain[1]) : linearTicks(yDomain[0], yDomain[1], 5);
  const visiblePositiveValues = series.flatMap((entry) => entry.y.filter((value, index) => (
    Number.isFinite(value) && value > 0 && entry.x[index] >= xDomain[0] && entry.x[index] <= xDomain[1]
  )));
  const visiblePositiveMinimum = visiblePositiveValues.length > 0 ? Math.min(...visiblePositiveValues) : undefined;
  const visiblePositiveMaximum = visiblePositiveValues.length > 0 ? Math.max(...visiblePositiveValues) : undefined;
  const yDomainIncludesVisibleRange = visiblePositiveMinimum === undefined || visiblePositiveMaximum === undefined
    || (yDomain[0] <= visiblePositiveMinimum && yDomain[1] >= visiblePositiveMaximum);
  return card(rect, title, (
    <g
      data-spectrum-panel={clipId}
      data-spectrum-y-min={Number(yDomain[0].toPrecision(12))}
      data-spectrum-y-max={Number(yDomain[1].toPrecision(12))}
      data-spectrum-positive-min={visiblePositiveMinimum === undefined ? undefined : Number(visiblePositiveMinimum.toPrecision(12))}
      data-spectrum-positive-max={visiblePositiveMaximum === undefined ? undefined : Number(visiblePositiveMaximum.toPrecision(12))}
      data-spectrum-y-domain-includes-positive-range={yDomainIncludesVisibleRange ? 'true' : 'false'}
    >
      <defs><clipPath id={clipId}><rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} /></clipPath></defs>
      <text x={rect.x + rect.width} y={rect.y + SECTION_FONT} textAnchor="end" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">{subtitle}</text>
      <g transform={`translate(${plot.x} ${rect.y + 63})`}>
        {series.map((entry, index) => (
          <g key={`${clipId}-legend-${entry.name}`} transform={`translate(${index * 112} 0)`}>
            <line x1="0" y1="0" x2="28" y2="0" stroke={entry.color} strokeWidth={DATA_LINE} strokeDasharray={entry.dashArray} />
            <text x="35" y={SUPPORT_FONT * 0.32} fontSize={SUPPORT_FONT} fontWeight="700" fill="#17212b">{entry.name}</text>
          </g>
        ))}
      </g>
      <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="#ffffff" stroke="#263640" strokeWidth={AXIS_LINE} />
      {xMajorTicks.map((tick) => {
        const x = scaleLog(tick, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        return <line key={`${clipId}-xgrid-${tick}`} x1={x} y1={plot.y} x2={x} y2={plot.y + plot.height} stroke="#d4dae0" strokeWidth={MIN_LINE} />;
      })}
      {yTicks.map((tick) => {
        const y = yScale === 'log'
          ? scaleLog(tick, yDomain[0], yDomain[1], plot.y + plot.height, plot.y)
          : scaleLinear(tick, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <g key={`${clipId}-y-${tick}`}>
            {tick !== yDomain[0] && <line x1={plot.x} y1={y} x2={plot.x + plot.width} y2={y} stroke="#d4dae0" strokeWidth={MIN_LINE} />}
            <line x1={plot.x - 6} y1={y} x2={plot.x} y2={y} stroke="#263640" strokeWidth={AXIS_LINE} />
            <text x={plot.x - 11} y={y + AXIS_FONT * 0.34} textAnchor="end" fontSize={AXIS_FONT} fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}
      {xTicks.map((tick) => {
        const x = scaleLog(tick, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        return (
          <g key={`${clipId}-x-${tick}`}>
            <line x1={x} y1={plot.y + plot.height} x2={x} y2={plot.y + plot.height + 6} stroke="#263640" strokeWidth={AXIS_LINE} />
            <text x={x} y={plot.y + plot.height + 23} textAnchor="middle" fontSize={AXIS_FONT} fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}
      <g clipPath={`url(#${clipId})`}>
        {series.map((entry) => (
          <path key={`${clipId}-${entry.name}`} d={seriesPath(entry, plot, xDomain, yDomain, yScale)} fill="none" stroke={entry.color} strokeWidth={DATA_LINE} strokeDasharray={entry.dashArray} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>
      <text x={plot.x + plot.width / 2} y={geometry === 'square' ? plot.y + plot.height + 55 : rect.y + rect.height - 8} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#263640">{xLabel}</text>
      <text x={geometry === 'square' ? rect.x + 22 : rect.x + 18} y={plot.y + plot.height / 2} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#263640" transform={`rotate(-90 ${geometry === 'square' ? rect.x + 22 : rect.x + 18} ${plot.y + plot.height / 2})`}>{yLabel}</text>
    </g>
  ));
}

function starPoints(cx: number, cy: number, outerRadius: number, innerRadius: number): string {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    return `${(cx + Math.cos(angle) * radius).toFixed(1)},${(cy + Math.sin(angle) * radius).toFixed(1)}`;
  }).join(' ');
}

function niceScaleDistance(maximumKm: number): number {
  if (!Number.isFinite(maximumKm) || maximumKm <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(maximumKm));
  const normalized = maximumKm / power;
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return factor * power;
}

function renderLocator(rect: Rect, row: StationDistanceRow | undefined): JSX.Element {
  const hasCoordinates = isFiniteNumber(row?.eventLat) && isFiniteNumber(row?.eventLon)
    && isFiniteNumber(row?.stationLat) && isFiniteNumber(row?.stationLon);
  const map: Rect = { x: rect.x + 8, y: rect.y + 47, width: rect.width - 16, height: rect.height - 62 };
  if (!hasCoordinates) {
    return card(rect, 'Source–station locator', (
      <g>
        <rect x={map.x} y={map.y} width={map.width} height={map.height} fill="#f5f7f8" stroke="#aab3bb" strokeWidth={MIN_LINE} />
        <text x={map.x + map.width / 2} y={map.y + map.height / 2} textAnchor="middle" fontSize={BODY_FONT} fill="#52606d">Coordinates unavailable</text>
      </g>
    ));
  }
  const eventLat = row.eventLat as number;
  const eventLon = row.eventLon as number;
  const stationLat = row.stationLat as number;
  const stationLon = row.stationLon as number;
  const meanLatRadians = ((eventLat + stationLat) / 2) * Math.PI / 180;
  const kilometresPerDegreeLat = 111.32;
  const kilometresPerDegreeLon = 111.32 * Math.max(0.05, Math.cos(meanLatRadians));
  const deltaXKm = (stationLon - eventLon) * kilometresPerDegreeLon;
  const deltaYKm = (stationLat - eventLat) * kilometresPerDegreeLat;
  const separationKm = Math.hypot(deltaXKm, deltaYKm);
  const paddingKm = Math.max(3, separationKm * 0.22);
  const usableWidth = map.width - 54;
  const usableHeight = map.height - 42;
  const scalePxPerKm = Math.min(
    usableWidth / Math.max(2 * paddingKm, Math.abs(deltaXKm) + 2 * paddingKm),
    usableHeight / Math.max(2 * paddingKm, Math.abs(deltaYKm) + 2 * paddingKm),
  );
  const centreX = map.x + map.width / 2;
  const centreY = map.y + map.height / 2;
  const eventX = centreX - deltaXKm * scalePxPerKm / 2;
  const eventY = centreY + deltaYKm * scalePxPerKm / 2;
  const stationX = centreX + deltaXKm * scalePxPerKm / 2;
  const stationY = centreY - deltaYKm * scalePxPerKm / 2;
  const scaleBarKm = niceScaleDistance((map.width * 0.24) / scalePxPerKm);
  const scaleBarPx = scaleBarKm * scalePxPerKm;
  return card(rect, 'Source–station locator', (
    <g>
      <rect x={map.x} y={map.y} width={map.width} height={map.height} rx="4" fill="#f7f9fa" stroke="#8e99a3" strokeWidth={AXIS_LINE} />
      {[0.25, 0.5, 0.75].map((ratio) => (
        <g key={`locator-grid-${ratio}`}>
          <line x1={map.x + map.width * ratio} y1={map.y} x2={map.x + map.width * ratio} y2={map.y + map.height} stroke="#d7dde2" strokeWidth={MIN_LINE} />
          <line x1={map.x} y1={map.y + map.height * ratio} x2={map.x + map.width} y2={map.y + map.height * ratio} stroke="#d7dde2" strokeWidth={MIN_LINE} />
        </g>
      ))}
      <line x1={eventX} y1={eventY} x2={stationX} y2={stationY} stroke="#61707c" strokeWidth={AXIS_LINE} strokeDasharray="5 4" />
      <polygon points={starPoints(eventX, eventY, 10, 4.5)} fill="#b42318" stroke="#7a271a" strokeWidth={MIN_LINE} />
      <polygon points={`${stationX},${stationY - 8} ${stationX - 7},${stationY + 6} ${stationX + 7},${stationY + 6}`} fill="#166a8f" stroke="#0d4660" strokeWidth={MIN_LINE} />
      <text x={eventX + 12} y={eventY - 7} fontSize={SUPPORT_FONT} fontWeight="700" fill="#7a271a">Source</text>
      <text x={stationX + 11} y={stationY + 15} fontSize={SUPPORT_FONT} fontWeight="700" fill="#0d4660">Station</text>
      <text x={map.x + 7} y={map.y + SUPPORT_FONT + 3} fontSize={SUPPORT_FONT} fill="#52606d">Local km grid · equal scale</text>
      <line x1={map.x + 10} y1={map.y + map.height - 13} x2={map.x + 10 + scaleBarPx} y2={map.y + map.height - 13} stroke="#263640" strokeWidth={AXIS_LINE} />
      <line x1={map.x + 10} y1={map.y + map.height - 17} x2={map.x + 10} y2={map.y + map.height - 9} stroke="#263640" strokeWidth={AXIS_LINE} />
      <line x1={map.x + 10 + scaleBarPx} y1={map.y + map.height - 17} x2={map.x + 10 + scaleBarPx} y2={map.y + map.height - 9} stroke="#263640" strokeWidth={AXIS_LINE} />
      <text x={map.x + 10 + scaleBarPx / 2} y={map.y + map.height - 20} textAnchor="middle" fontSize={SUPPORT_FONT} fill="#263640">{formatSignificant(scaleBarKm)} km</text>
      <text x={map.x + map.width - 11} y={map.y + SUPPORT_FONT + 3} textAnchor="end" fontSize={SUPPORT_FONT} fontWeight="700" fill="#52606d">N ↑</text>
    </g>
  ));
}

function renderMetricStrip(
  rect: Rect,
  intensity: ReturnType<typeof computeJmaIntensity>,
  pga: ReturnType<typeof metricPeak>,
  pgv: ReturnType<typeof metricPeak>,
  pgd: ReturnType<typeof metricPeak>,
  duration: number | undefined,
): JSX.Element {
  const metrics: Array<{ label: string; value: string; detail: string }> = [
    { label: 'JMA instrumental intensity', value: intensity.available ? formatNumber(intensity.intensity, 1) : '–', detail: intensity.available ? intensity.classLabel : 'original acceleration unavailable' },
    { label: 'PGA', value: pga ? `${formatSignificant(pga.value)} cm/s²` : '–', detail: pga?.component ?? '' },
    { label: 'PGV', value: pgv ? `${formatSignificant(pgv.value)} cm/s` : '–', detail: pgv?.component ?? '' },
    { label: 'PGD', value: pgd ? `${formatSignificant(pgd.value)} cm` : '–', detail: pgd?.component ?? '' },
    { label: 'Displayed duration', value: isFiniteNumber(duration) ? `${formatSignificant(duration)} s` : '–', detail: 'longest component' },
  ];
  const columnWidth = rect.width / metrics.length;
  return (
    <g>
      <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="5" fill="#f4f7f8" stroke="#9aa5ae" strokeWidth={AXIS_LINE} />
      {metrics.map((metric, index) => {
        const x = rect.x + index * columnWidth;
        return (
          <g key={metric.label}>
            {index > 0 && <line x1={x} y1={rect.y + 13} x2={x} y2={rect.y + rect.height - 13} stroke="#c9d0d5" strokeWidth={MIN_LINE} />}
            <text x={x + columnWidth / 2} y={rect.y + 25} textAnchor="middle" fontSize={SUPPORT_FONT} fontWeight="700" fill="#52606d">{metric.label}</text>
            <text x={x + columnWidth / 2} y={rect.y + 57} textAnchor="middle" fontSize={SECTION_FONT} fontWeight="700" fill="#17212b">{metric.value}</text>
            <text x={x + columnWidth / 2} y={rect.y + 82} textAnchor="middle" fontSize={SUPPORT_FONT} fill="#52606d">{metric.detail}</text>
          </g>
        );
      })}
    </g>
  );
}

function renderTripartitePanel(
  rect: Rect,
  series: readonly SeriesSpec[],
  settings: ResponseSpectrumSettings,
  title = '(b) Tripartite response spectrum: pSv',
  subtitle = `h = ${(settings.dampingRatio * 100).toFixed(1)}% · major-decade guides`,
): JSX.Element {
  const { xDomain, yDomain } = tripartiteDomains(series, settings);
  const plotSize = Math.min(rect.width - 132, rect.height - 156);
  const xDecades = Math.log10(xDomain[1] / xDomain[0]);
  const yDecades = Math.log10(yDomain[1] / yDomain[0]);
  const exactPlotWidth = plotSize * Math.min(1, xDecades / Math.max(xDecades, yDecades));
  const geometryPreserved = exactPlotWidth >= plotSize * 0.55;
  const plotWidth = geometryPreserved ? exactPlotWidth : plotSize;
  const plot: Rect = {
    x: rect.x + 92 + (plotSize - plotWidth) / 2,
    y: rect.y + 84,
    width: plotWidth,
    height: plotSize,
  };
  const xTicks = logTicks(xDomain[0], xDomain[1]);
  const yTicks = logTicks(yDomain[0], yDomain[1]);
  const majorPeriods = decadeTicks(xDomain[0], xDomain[1]);
  const psvGuides = decadeTicks(yDomain[0], yDomain[1]);
  const diagonalValues = decadeTicks(yDomain[0] / 100, yDomain[1] * 100);
  const accelerationLabelPsv = yDomain[1] / 1.35;
  const displacementLabelPsv = yDomain[0] * 1.35;
  const accelerationGuideCandidates = geometryPreserved ? diagonalValues.map((value) => ({
    value,
    period: (2 * Math.PI * accelerationLabelPsv) / value,
    psv: accelerationLabelPsv,
  })).filter((label) => label.period >= xDomain[0] && label.period <= xDomain[1]).slice(0, 3) : [];
  const displacementGuideCandidates = geometryPreserved ? diagonalValues.map((value) => ({
    value,
    period: (2 * Math.PI * value) / displacementLabelPsv,
    psv: displacementLabelPsv,
  })).filter((label) => label.period >= xDomain[0] && label.period <= xDomain[1]).slice(0, 3) : [];
  // Keep labels on their physical guide lines while stepping them away from a
  // shared edge. The stagger avoids collisions in an A4 export without adding
  // leader lines or obscuring response curves.
  const accelerationGuideLabels = accelerationGuideCandidates.map((label, index) => {
    const psv = accelerationLabelPsv / (10 ** (index * 0.13));
    return { ...label, period: (2 * Math.PI * psv) / label.value, psv };
  }).filter((label) => label.period >= xDomain[0] && label.period <= xDomain[1]);
  const displacementGuideLabels = displacementGuideCandidates.map((label, index) => {
    const psv = displacementLabelPsv * (10 ** (index * 0.13));
    return { ...label, period: (2 * Math.PI * label.value) / psv, psv };
  }).filter((label) => label.period >= xDomain[0] && label.period <= xDomain[1]);
  const clipId = 'report-tripartite-clip';
  const guidePath = (points: Array<[number, number]>): string => points.map(([xValue, yValue], index) => {
    const x = scaleLog(xValue, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
    const y = scaleLog(yValue, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return card(rect, title, (
    <g
      data-tripartite-equal-log-decades={geometryPreserved ? 'true' : 'false'}
      data-tripartite-geometry-preserved={geometryPreserved ? 'true' : 'false'}
      data-tripartite-guide-units="Sa:cm/s²;Sd:cm"
      data-tripartite-sa-guide-labels={accelerationGuideLabels.length}
      data-tripartite-sd-guide-labels={displacementGuideLabels.length}
      data-tripartite-period-min={Number(xDomain[0].toPrecision(12))}
      data-tripartite-period-max={Number(xDomain[1].toPrecision(12))}
    >
      <defs><clipPath id={clipId}><rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} /></clipPath></defs>
      <text x={rect.x + rect.width} y={rect.y + SECTION_FONT} textAnchor="end" fontSize={SUPPORT_FONT} fontWeight="700" fill="#52606d">{subtitle}</text>
      <g transform={`translate(${plot.x} ${rect.y + 56})`}>
        {series.map((entry, index) => (
          <g key={`trip-legend-${entry.name}`} transform={`translate(${index * 130} 0)`}>
            <line x1="0" y1="0" x2="30" y2="0" stroke={entry.color} strokeWidth={DATA_LINE} strokeDasharray={entry.dashArray} />
            <text x="38" y={SUPPORT_FONT * 0.32} fontSize={SUPPORT_FONT} fontWeight="700" fill="#17212b">{entry.name}</text>
          </g>
        ))}
      </g>
      <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="#ffffff" stroke="#263640" strokeWidth={AXIS_LINE} />
      <g clipPath={`url(#${clipId})`}>
        {majorPeriods.map((period) => {
          const x = scaleLog(period, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
          return <line key={`trip-period-${period}`} x1={x} y1={plot.y} x2={x} y2={plot.y + plot.height} stroke="#d0d6db" strokeWidth={MIN_LINE} />;
        })}
        {psvGuides.map((value) => {
          const y = scaleLog(value, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
          return <line key={`trip-psv-${value}`} x1={plot.x} y1={y} x2={plot.x + plot.width} y2={y} stroke="#d0d6db" strokeWidth={MIN_LINE} />;
        })}
        {geometryPreserved && diagonalValues.map((value) => (
          <g key={`trip-diagonal-${value}`}>
            <path d={guidePath([[xDomain[0], (value * xDomain[0]) / (2 * Math.PI)], [xDomain[1], (value * xDomain[1]) / (2 * Math.PI)]])} fill="none" stroke="#e0e4e7" strokeWidth={MIN_LINE} strokeDasharray="5 5" />
            <path d={guidePath([[xDomain[0], (value * 2 * Math.PI) / xDomain[0]], [xDomain[1], (value * 2 * Math.PI) / xDomain[1]]])} fill="none" stroke="#e0e4e7" strokeWidth={MIN_LINE} strokeDasharray="5 5" />
          </g>
        ))}
        {series.map((entry) => (
          <path key={`trip-series-${entry.name}`} d={seriesPath(entry, plot, xDomain, yDomain, 'log')} fill="none" stroke={entry.color} strokeWidth={DATA_LINE * 1.18} strokeDasharray={entry.dashArray} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>
      {accelerationGuideLabels.map((label) => {
        const x = scaleLog(label.period, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        const y = scaleLog(label.psv, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <text key={`trip-sa-label-${label.value}`} x={x} y={y} textAnchor="middle" fontSize={SUPPORT_FONT} fontWeight="700" fill="#7a858e" stroke="#ffffff" strokeWidth={MIN_LINE * 2.5} paintOrder="stroke" transform={`rotate(-45 ${x} ${y})`}>
            Sa {formatTick(label.value)}
          </text>
        );
      })}
      {displacementGuideLabels.map((label) => {
        const x = scaleLog(label.period, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        const y = scaleLog(label.psv, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <text key={`trip-sd-label-${label.value}`} x={x} y={y} textAnchor="middle" fontSize={SUPPORT_FONT} fontWeight="700" fill="#7a858e" stroke="#ffffff" strokeWidth={MIN_LINE * 2.5} paintOrder="stroke" transform={`rotate(45 ${x} ${y})`}>
            Sd {formatTick(label.value)}
          </text>
        );
      })}
      {xTicks.map((tick) => {
        const x = scaleLog(tick, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        return (
          <g key={`trip-x-${tick}`}>
            <line x1={x} y1={plot.y + plot.height} x2={x} y2={plot.y + plot.height + 7} stroke="#263640" strokeWidth={AXIS_LINE} />
            <text x={x} y={plot.y + plot.height + 25} textAnchor="middle" fontSize={AXIS_FONT} fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}
      {yTicks.map((tick) => {
        const y = scaleLog(tick, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <g key={`trip-y-${tick}`}>
            <line x1={plot.x - 7} y1={y} x2={plot.x} y2={y} stroke="#263640" strokeWidth={AXIS_LINE} />
            <text x={plot.x - 12} y={y + AXIS_FONT * 0.34} textAnchor="end" fontSize={AXIS_FONT} fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}
      <text x={plot.x + plot.width / 2} y={plot.y + plot.height + 55} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#263640">Period [s]</text>
      <text x={rect.x + 22} y={plot.y + plot.height / 2} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#263640" transform={`rotate(-90 ${rect.x + 22} ${plot.y + plot.height / 2})`}>pSv [cm/s]</text>
      <text x={rect.x + rect.width} y={rect.y + rect.height - 8} textAnchor="end" fontSize={SUPPORT_FONT} fill="#6b7280">{geometryPreserved ? 'Guide labels: Sa [cm/s²] / Sd [cm]' : 'Sa/Sd guides omitted: pSv span exceeds equal-decade geometry'}</text>
    </g>
  ));
}

function reportFourierEntries(waveforms: readonly DerivedWaveform[]): ReportFourierEntry[] {
  return [...waveforms].sort((a, b) => componentRank(a.component) - componentRank(b.component)).map((waveform, index) => {
    const analysis = computeFourierAnalysis(waveform.acceleration, waveform.dt, 'cm/s²·s', {
      applyFrequencyTaper: false,
      applyTimeTaper: true,
      timeTaperFraction: 0.05,
    });
    const smoothed = smoothFourierSpectrumParzen(analysis.spectrum, {
      bandwidthHz: REPORT_PARZEN_BANDWIDTH_HZ,
      dcAmplitude: analysis.metadata.dcAmplitude,
    });
    const style = reportComponentStyle(waveform.component, index);
    return {
      waveform,
      analysis,
      smoothing: smoothed.smoothing,
      series: {
        name: waveform.componentLabel,
        x: smoothed.frequency,
        y: smoothed.amplitude,
        color: style.color,
        dashArray: style.dashArray,
      },
    };
  });
}

function commonFourierBand(entries: readonly ReportFourierEntry[]): [number, number] {
  const lower = Math.max(1e-3, ...entries.map((entry) => Math.max(
    entry.analysis.metadata.firstPositiveFrequencyHz,
    entry.analysis.metadata.independentResolutionHz,
    entry.waveform.preprocessing?.applyHighpass ? entry.waveform.preprocessing.highpassHz : 0,
  )));
  const upper = Math.min(20, ...entries.map((entry) => Math.min(
    entry.analysis.metadata.nyquistFrequencyHz,
    entry.waveform.preprocessing?.applyLowpass ? entry.waveform.preprocessing.lowpassHz : Number.POSITIVE_INFINITY,
  )));
  if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) return [lower, upper];
  const fallbackUpper = Math.min(...entries.map((entry) => entry.analysis.metadata.nyquistFrequencyHz));
  return [Math.max(1e-3, Math.min(lower, fallbackUpper / 10)), Math.max(1e-2, fallbackUpper)];
}

function logYDomain(series: readonly SeriesSpec[], xDomain: [number, number]): [number, number] {
  const values = series.flatMap((entry) => entry.y.filter((value, index) => (
    Number.isFinite(value) && value > 0 && entry.x[index] >= xDomain[0] && entry.x[index] <= xDomain[1]
  )));
  if (values.length === 0) return [1e-4, 1];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return [niceLogFloor(Math.min(minimum, maximum / 1e4), 1e-4), niceLogCeil(maximum * 1.05, 1)];
}

function linearYDomain(series: readonly SeriesSpec[]): [number, number] {
  const values = series.flatMap((entry) => entry.y.filter((value) => Number.isFinite(value) && value >= 0));
  const maximum = values.length > 0 ? Math.max(...values) : 1;
  const ticks = linearTicks(0, maximum * 1.08, 5);
  return [0, Math.max(maximum * 1.08, ticks[ticks.length - 1] ?? 1)];
}

function finiteXDomain(series: readonly SeriesSpec[]): [number, number] | undefined {
  const values = series.flatMap((entry) => entry.x.filter((value, index) => Number.isFinite(value) && value > 0 && Number.isFinite(entry.y[index])));
  return values.length > 1 ? [Math.min(...values), Math.max(...values)] : undefined;
}

export function ReportFigurePanel({ waveforms, jmaWaveforms, peaks, responseSettings, initialPage = 'integrated' }: ReportFigurePanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stations = useMemo(() => buildReportStations(waveforms, peaks), [waveforms, peaks]);
  const [stationId, setStationId] = useState<string>('');
  const [page, setPage] = useState<ReportPage>(initialPage);
  const [grayscale, setGrayscale] = useState(false);
  const selectedStation = stations.find((station) => station.id === (stationId || stations[0]?.id)) ?? stations[0];
  const selectedWaveforms = useMemo(
    () => selectedStation?.waveforms.slice().sort((a, b) => componentRank(a.component) - componentRank(b.component)) ?? [],
    [selectedStation],
  );
  const selectedPeaks = selectedStation?.peaks ?? [];
  const selectedJmaWaveforms = useMemo(() => {
    const selectedIds = new Set(selectedWaveforms.map((waveform) => waveform.sourceRecordId));
    return jmaWaveforms.filter((waveform) => selectedIds.has(waveform.sourceRecordId));
  }, [jmaWaveforms, selectedWaveforms]);
  const selectedIntensity = useMemo(() => computeJmaIntensity(selectedJmaWaveforms), [selectedJmaWaveforms]);
  const reportResponseSettings = useMemo<ResponseSpectrumSettings>(() => ({
    ...responseSettings,
    dampingRatio: REPORT_DAMPING_RATIO,
  }), [responseSettings]);
  const responseResults = useMemo(
    () => computeResponseSpectra(selectedWaveforms, reportResponseSettings),
    [selectedWaveforms, reportResponseSettings],
  );
  const psvResponse = useMemo(() => responseSeries(responseResults, 'psv'), [responseResults]);
  const saResponse = useMemo(() => responseSeries(responseResults, 'psa'), [responseResults]);
  const fourierEntries = useMemo(() => reportFourierEntries(selectedWaveforms), [selectedWaveforms]);
  const fourierSeries = useMemo(() => fourierEntries.map((entry) => entry.series), [fourierEntries]);
  const fourierBand = useMemo(() => commonFourierBand(fourierEntries), [fourierEntries]);
  const fourierYDomain = useMemo(() => logYDomain(fourierSeries, fourierBand), [fourierBand, fourierSeries]);
  const saComputedPeriodDomain = useMemo(() => finiteXDomain(saResponse), [saResponse]);
  const saPeriodDomain = saComputedPeriodDomain ?? [responseSettings.minPeriod, responseSettings.maxPeriod] as [number, number];
  const saYDomain = useMemo(() => linearYDomain(saResponse), [saResponse]);
  const psvTripartiteDomains = useMemo(
    () => tripartiteDomains(psvResponse, reportResponseSettings),
    [psvResponse, reportResponseSettings],
  );
  const psvTripartiteGeometryPreserved = useMemo(() => {
    const xDecades = Math.log10(psvTripartiteDomains.xDomain[1] / psvTripartiteDomains.xDomain[0]);
    const yDecades = Math.log10(psvTripartiteDomains.yDomain[1] / psvTripartiteDomains.yDomain[0]);
    return xDecades / Math.max(xDecades, yDecades) >= 0.55;
  }, [psvTripartiteDomains]);
  const timeAxis = useMemo(() => reportTimeAxis(selectedWaveforms), [selectedWaveforms]);
  const consistency = useMemo(() => componentConsistency(selectedWaveforms), [selectedWaveforms]);
  const provenance = useMemo(() => buildFigureProvenance(selectedWaveforms), [selectedWaveforms]);

  if (waveforms.length === 0 || !selectedStation || fourierEntries.length === 0) {
    return <p className="empty-state">No data is available for the report figure.</p>;
  }

  const row = selectedStation.row;
  const pga = metricPeak(selectedPeaks, 'pga');
  const pgv = metricPeak(selectedPeaks, 'pgv');
  const pgd = metricPeak(selectedPeaks, 'pgd');
  const duration = recordDurationSeconds(selectedWaveforms);
  const componentDurations = unique(selectedWaveforms.map((waveform) => {
    const first = waveform.time[0];
    const last = waveform.time[waveform.time.length - 1];
    return isFiniteNumber(first) && isFiniteNumber(last) && last >= first
      ? Number((last - first).toPrecision(8))
      : undefined;
  }).filter(isFiniteNumber));
  const fasIntervalLabel = componentDurations.length === 1
    ? `0–${formatSignificant(componentDurations[0])} s`
    : 'full records · durations vary';
  const stationHeight = sharedMetadataNumber(selectedWaveforms, 'stationHeightM');
  const magnitude = sharedMetadataNumber(selectedWaveforms, 'magnitude');
  const originTime = sharedMetadataText(selectedWaveforms, 'originTime');
  const recordTime = sharedMetadataText(selectedWaveforms, 'recordTime');
  const componentLabel = consistency.completeThreeComponentSet
    ? 'NS / EW / UD complete'
    : `${consistency.observedComponents.join(' / ') || 'Unlabelled'} (${consistency.observedComponents.length})`;
  const consistencyLabel = `${componentLabel} · ${consistency.status === 'consistent' ? 'metadata consistent' : `review ${consistency.inconsistentFields.length} metadata field(s)`}`;
  const accelerationPanelTitle = consistency.completeThreeComponentSet
    ? '(a) Three-component acceleration'
    : `(a) Acceleration · ${consistency.observedComponents.join(' / ') || 'unlabelled'}`;
  const velocityPanelTitle = consistency.completeThreeComponentSet
    ? '(a) Three-component velocity'
    : `(a) Velocity · ${consistency.observedComponents.join(' / ') || 'unlabelled'}`;
  const integratedVelocityPanelTitle = consistency.completeThreeComponentSet
    ? '(b) Three-component velocity'
    : `(b) Velocity · ${consistency.observedComponents.join(' / ') || 'unlabelled'}`;
  const pageTitle = page === 'integrated'
    ? 'Integrated strong-motion report'
    : page === 'summary'
      ? 'Strong-motion engineering summary'
      : 'Strong-motion technical detail';
  const pageToolbarLabel = page === 'integrated'
    ? 'Integrated analysis plate'
    : page === 'summary'
      ? 'Executive summary'
      : 'Technical detail';
  const pageDescription = page === 'integrated'
    ? 'Single-page A4 report with aligned three-component acceleration and velocity histories above side-by-side Parzen-smoothed Fourier amplitude and five-percent-damped tripartite pseudo-velocity response spectra.'
    : page === 'summary'
      ? 'A4 executive report with event and station metadata, a source-station locator, key ground-motion metrics, three-component acceleration, Parzen-smoothed Fourier amplitude spectra, and five-percent-damped acceleration response spectra.'
      : 'A4 technical appendix with three-component velocity and a large five-percent-damped tripartite pseudo-spectral velocity response spectrum.';
  const fileNameBase = safeFileName(`report_${page}_${selectedStation.label}`);
  const accelerationProcessingLabels = unique(selectedWaveforms.map((waveform) => {
    const settings = waveform.preprocessing;
    if (!settings) return 'settings unavailable';
    const operations: string[] = [];
    if (settings.removeMean) operations.push('mean removed');
    if (settings.detrend) operations.push('detrended');
    if (settings.applyHighpass) operations.push(`HP ${formatSignificant(settings.highpassHz)} Hz`);
    if (settings.applyLowpass) operations.push(`LP ${formatSignificant(settings.lowpassHz)} Hz`);
    return operations.length > 0 ? operations.join('; ') : 'no mean/trend/frequency filter';
  }));
  const accelerationProcessingFooter = accelerationProcessingLabels.length === 1
    ? accelerationProcessingLabels[0]
    : 'varies by component; see Methods JSON';
  const velocityProcessingLabels = unique(selectedWaveforms.map((waveform) => waveform.preprocessing
    ? `derived quantity; integration drift correction ${waveform.preprocessing.correctIntegrationDrift ? 'enabled' : 'disabled'}`
    : 'derived quantity; drift setting unavailable'));
  const velocityProcessingFooter = velocityProcessingLabels.length === 1
    ? velocityProcessingLabels[0]
    : 'varies by component; see Methods JSON';
  const reportMetadata = {
    schema: 'strong-motion-engineering-report/3.0',
    pageDesign: {
      availablePlates: ['integrated', 'summary', 'technical'],
      selectedPlate: page,
      defaultPlate: 'integrated',
      reportSizeMm: [210, 297],
      minimumTypographyPt: 7.5,
      minimumLineWeightPt: 0.5,
      integratedPanelOrder: ['acceleration', 'velocity', 'Parzen Fourier amplitude spectrum', 'tripartite pSv response spectrum'],
      renderedPanels: page === 'integrated'
        ? ['acceleration', 'velocity', 'Parzen Fourier amplitude spectrum', 'tripartite pSv response spectrum']
        : page === 'summary'
          ? ['event/station metadata', 'source-station locator', 'ground-motion metrics', 'acceleration', 'Parzen Fourier amplitude spectrum', 'acceleration response spectrum Sa']
          : ['velocity', 'tripartite pSv response spectrum'],
    },
    recordSet: selectedStation.label,
    sourceFiles: selectedWaveforms.map((waveform) => waveform.fileName),
    componentConsistency: consistency,
    provenance,
    metadataByComponent: selectedWaveforms.map((waveform) => ({
      sourceRecordId: waveform.sourceRecordId,
      fileName: waveform.fileName,
      component: waveform.componentLabel,
      samplingHz: waveform.samplingHz,
      dtSeconds: waveform.dt,
      durationSeconds: (waveform.time[waveform.time.length - 1] ?? 0) - (waveform.time[0] ?? 0),
      metadata: waveform.metadata,
      preprocessing: waveform.preprocessing ?? null,
    })),
    timeReference: timeAxis.reference,
    jmaIntensity: {
      input: 'original acceleration',
      available: selectedIntensity.available,
      value: selectedIntensity.available ? selectedIntensity.intensity : null,
      classLabel: selectedIntensity.available ? selectedIntensity.classLabel : null,
    },
    waveformPanels: {
      input: 'active preprocessing',
      sharedOrdinateWithinPanel: true,
      sharedTimeAxisAcrossAccelerationAndVelocity: true,
      peakDefinition: 'maximum absolute sample magnitude; the displayed value is non-negative and its occurrence time is reported',
      peakLabelsOutsideDataRegion: true,
    },
    componentEncoding: {
      NS: { colour: REPORT_COMPONENT_STYLES.NS.color, line: 'solid' },
      EW: { colour: REPORT_COMPONENT_STYLES.EW.color, line: REPORT_COMPONENT_STYLES.EW.dashArray },
      UD: { colour: REPORT_COMPONENT_STYLES.UD.color, line: REPORT_COMPONENT_STYLES.UD.dashArray },
      identificationDoesNotDependOnColourAlone: true,
    },
    fourierAmplitudeSpectrum: {
      input: 'active preprocessed acceleration',
      displayYAxisLabel: 'Acceleration FAS |A(f)| [cm/s]',
      displayUnitEquivalence: 'cm/s = cm/s²·s',
      displayedRecordInterval: fasIntervalLabel,
      componentDurationsSeconds: componentDurations,
      meanRemoved: true,
      timeWindow: '5% cosine edge taper',
      amplitudeDefinition: '|DFT| * dt; positive-frequency half-spectrum; one-sided factor 1; no record-length or window-gain normalization',
      smoothing: {
        method: 'Parzen',
        bandwidthHz: REPORT_PARZEN_BANDWIDTH_HZ,
        domain: 'squared-amplitude power',
        amplitudeRecovery: 'square root after smoothing',
        boundaryTreatment: 'circular convolution of Hermitian two-sided spectrum',
      },
      displayBandHz: fourierBand,
      records: fourierEntries.map((entry) => ({
        component: entry.waveform.componentLabel,
        ...entry.analysis.metadata,
        parzenSmoothing: entry.smoothing,
      })),
    },
    responseSpectrum: {
      method: 'Nigam–Jennings linear-SDOF exact recurrence for linearly interpolated acceleration with adaptive substepping and free-vibration tail',
      input: 'active preprocessed acceleration',
      dampingRatio: REPORT_DAMPING_RATIO,
      requestedPeriodRangeSeconds: [responseSettings.minPeriod, responseSettings.maxPeriod],
      computedPeriodRangeSeconds: saComputedPeriodDomain ?? null,
      displayPeriodRangeSeconds: saPeriodDomain,
      status: saComputedPeriodDomain ? 'computed' : 'no-plottable-finite-range',
      requestedPeriodCount: responseSettings.periodCount,
      generatedPeriodCount: responseResults[0]?.points.length ?? 0,
      periodGrid: 'natural-logarithmic spacing after bounded period validation',
      finitePointsByComponent: responseResults.map((result) => ({
        component: result.componentLabel,
        finiteSa: result.points.filter((point) => Number.isFinite(point.psa)).length,
        finitePsv: result.points.filter((point) => Number.isFinite(point.psv)).length,
        unsupported: result.points.filter((point) => !Number.isFinite(point.psa) || !Number.isFinite(point.psv)).length,
      })),
      summaryOrdinate: 'absolute acceleration response Sa [cm/s²]',
      technicalOrdinate: 'pseudo-spectral velocity pSv [cm/s]',
      technicalTripartiteDisplayDomains: psvTripartiteDomains,
      tripartiteEqualDecadeGeometryPreserved: psvTripartiteGeometryPreserved,
    },
    locator: {
      visibleOnSelectedPlate: page === 'summary',
      type: 'tile-independent source-station schematic',
      projection: 'local equirectangular; x=(longitude-longitude0)*111.32*cos(mean latitude) km; y=(latitude-latitude0)*111.32 km',
      equalKilometreScale: true,
      externalTiles: false,
    },
  };

  return (
    <div className="chart-stack">
      <div className="inline-controls report-controls">
        {stations.length > 1 && (
          <label>
            Record set
            <select value={selectedStation.id} onChange={(event) => setStationId(event.target.value)}>
              {stations.map((station) => <option key={station.id} value={station.id}>{station.label}</option>)}
            </select>
          </label>
        )}
        <label>
          Report plate
          <select value={page} onChange={(event) => setPage(event.target.value as ReportPage)}>
            <option value="integrated">Integrated plate · Acc / Vel / FAS / pSv</option>
            <option value="summary">Page 1 · Executive summary</option>
            <option value="technical">Page 2 · Technical detail</option>
          </select>
        </label>
        <span className="note">The integrated plate follows the reference layout on one A4 page. The original executive and technical plates remain available for presentation-specific exports.</span>
        {consistency.status === 'review-required' && <span className="note warning-text">Component metadata differs: {consistency.inconsistentFields.join(', ')}. The export records every component separately.</span>}
      </div>

      <figure className={`chart-card publication-figure report-figure${grayscale ? ' grayscale-preview' : ''}`} data-report-page={page} tabIndex={0} aria-label={`A4 strong-motion report ${page} plate; horizontally scrollable on narrow screens`}>
        <div className="chart-toolbar report-toolbar">
          <div className="figure-toolbar-label">
            <span className="figure-kicker">A4 engineering report · {page === 'integrated' ? 'Integrated plate' : page === 'summary' ? 'Page 1' : 'Page 2'}</span>
            <strong>{pageToolbarLabel} · {selectedStation.label}</strong>
            <span className="note">210 × 297 mm · vector-first · minimum type 7.5 pt · minimum rule 0.5 pt</span>
          </div>
          <div className="button-row compact">
            <button type="button" className="secondary" onClick={() => setGrayscale((value) => !value)}>{grayscale ? 'Colour view' : 'Grayscale check'}</button>
            <button type="button" className="secondary" aria-label="Download the selected A4 report plate as SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`, { widthMm: 210, heightMm: 297 })}>SVG · vector</button>
            <button type="button" className="secondary" aria-label="Download the selected A4 report plate as a 300 dpi PNG" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, { dpi: 300, widthMm: 210, heightMm: 297 })}>PNG · 300 dpi</button>
            <button type="button" className="secondary" onClick={() => downloadFigureMetadata(`report_methods_${page}_${selectedStation.label}`, reportMetadata)}>Methods · JSON</button>
          </div>
        </div>
        <span className="mobile-scroll-hint" aria-hidden="true">Swipe horizontally to inspect the complete A4 plate →</span>
        <svg
          ref={svgRef}
          className="publication-chart report-chart"
          data-min-font-pt="7.6"
          data-min-line-pt="0.5"
          data-report-layout={page === 'integrated' ? 'acceleration-velocity-fas-tripartite' : page}
          data-report-shared-time-axis={page === 'integrated' ? 'true' : undefined}
          data-report-acceleration-shared-ordinate={page === 'integrated' ? 'true' : undefined}
          data-report-velocity-shared-ordinate={page === 'integrated' ? 'true' : undefined}
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby="report-figure-title report-figure-description"
          preserveAspectRatio="xMidYMid meet"
          style={{ fontFamily: FONT_FAMILY }}
        >
          <title id="report-figure-title">{`${pageTitle} for ${selectedStation.label}`}</title>
          <desc id="report-figure-description">{pageDescription}</desc>
          <metadata>{JSON.stringify(reportMetadata)}</metadata>
          <rect width={WIDTH} height={HEIGHT} fill="#ffffff" />
          <text x="58" y="53" fontSize={TITLE_FONT} fontWeight="700" fill="#17212b">{pageTitle}</text>
          <text x={WIDTH - 58} y="52" textAnchor="end" fontSize={BODY_FONT} fontWeight="700" fill="#374151">{selectedStation.label}</text>
          <line x1="58" y1="75" x2={WIDTH - 58} y2="75" stroke="#17212b" strokeWidth={AXIS_LINE} />

          {page === 'integrated' ? (
            <g
              data-report-panel-order="acceleration velocity Fourier-amplitude tripartite-pSv"
              data-report-component-encoding="NS-vermillion-solid EW-blue-dashed UD-purple-dotted"
            >
              <text x="58" y="101" fontSize={BODY_FONT} fontWeight="700" fill="#17212b">
                Origin {originTime} · station {selectedStation.label} · M {isFiniteNumber(magnitude) ? magnitude.toFixed(1) : '–'} · depth {formatFixed(row?.depthKm, 1, ' km')} · Rₕᵧₚ {formatFixed(row?.hypocentralDistanceKm, 1, ' km')}
              </text>
              <text x="58" y="122" fontSize={SUPPORT_FONT} fontWeight="700" fill="#52606d">
                JMA {selectedIntensity.available ? `${formatNumber(selectedIntensity.intensity, 1)} (${selectedIntensity.classLabel})` : '–'} · PGA {pga ? `${formatSignificant(pga.value)} cm/s²` : '–'} · PGV {pgv ? `${formatSignificant(pgv.value)} cm/s` : '–'} · duration {isFiniteNumber(duration) ? `${formatSignificant(duration)} s` : '–'} · {consistencyLabel}
              </text>
              {renderWaveformPanel({ x: 58, y: 142, width: 1004, height: 338 }, accelerationPanelTitle, selectedWaveforms, 'acceleration')}
              {renderWaveformPanel({ x: 58, y: 516, width: 1004, height: 354 }, integratedVelocityPanelTitle, selectedWaveforms, 'velocity')}
              {renderSpectrumPanel(
                { x: 58, y: 910, width: 486, height: 530 },
                '(c) Fourier amplitude',
                `Parzen B=${REPORT_PARZEN_BANDWIDTH_HZ.toFixed(2)} Hz · ${fasIntervalLabel}`,
                fourierSeries,
                fourierBand,
                fourierYDomain,
                'Frequency [Hz]',
                'Acceleration FAS |A(f)| [cm/s]',
                'log',
                'report-integrated-fas-clip',
                'square',
              )}
              {renderTripartitePanel(
                { x: 576, y: 910, width: 486, height: 530 },
                psvResponse,
                reportResponseSettings,
                '(d) Tripartite pSv response',
                'h = 5.0% · Sa/Sd guides',
              )}
              <line x1="58" y1="1465" x2={WIDTH - 58} y2="1465" stroke="#7b8790" strokeWidth={MIN_LINE} />
              <text x="58" y="1487" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                Acceleration: {accelerationProcessingFooter}.
              </text>
              <text x="58" y="1506" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                Velocity: {velocityProcessingFooter}.
              </text>
              <text x="58" y="1525" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                Common time axis: {timeAxis.reference}. FAS: mean removed; 5% cosine taper; |DFT|Δt; Parzen B=0.10 Hz.
              </text>
              <text x="58" y="1544" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                JMA: original acceleration. Response: Nigam–Jennings pSv, h=5.0%; {psvTripartiteGeometryPreserved ? 'equal-decade Sa/Sd guides.' : 'Sa/Sd guides omitted.'}
              </text>
              <text x={WIDTH - 58} y="1544" textAnchor="end" fontSize={SUPPORT_FONT} fill="#6b7280">1 / 1</text>
            </g>
          ) : page === 'summary' ? (
            <g>
              {card({ x: 58, y: 92, width: 646, height: 194 }, 'Event / station', (
                <g>
                  {textRows(58, 148, [
                    ['Origin time', originTime],
                    ['Magnitude', isFiniteNumber(magnitude) ? `M ${magnitude.toFixed(1)}` : '-'],
                    ['Source lat/lon', `${formatCoordinate(row?.eventLat)}, ${formatCoordinate(row?.eventLon)}`],
                    ['Depth', formatFixed(row?.depthKm, 1, ' km')],
                    ['Duration', formatFixed(duration, 1, ' s')],
                  ], 26, 112)}
                  {textRows(382, 148, [
                    ['Record time', recordTime],
                    ['Station', selectedStation.label],
                    ['Sta. lat/lon', `${formatCoordinate(row?.stationLat)}, ${formatCoordinate(row?.stationLon)}`],
                    ['Elevation', formatFixed(stationHeight, 0, ' m')],
                    ['Rₑₚᵢ / Rₕᵧₚ', `${formatFixed(row?.epicentralDistanceKm, 1, ' km')} / ${formatFixed(row?.hypocentralDistanceKm, 1, ' km')}`],
                  ], 26, 108)}
                  <text x="58" y="279" fontSize={SUPPORT_FONT} fontWeight="700" fill={consistency.status === 'consistent' ? '#246b45' : '#a15c00'}>{consistencyLabel}</text>
                </g>
              ))}
              {renderLocator({ x: 730, y: 92, width: 332, height: 194 }, row)}
              {renderMetricStrip({ x: 58, y: 310, width: 1004, height: 100 }, selectedIntensity, pga, pgv, pgd, duration)}
              {renderWaveformPanel({ x: 58, y: 444, width: 1004, height: 360 }, accelerationPanelTitle, selectedWaveforms, 'acceleration')}
              {renderSpectrumPanel(
                { x: 58, y: 838, width: 486, height: 590 },
                '(b) Fourier amplitude spectrum',
                `Parzen B=${REPORT_PARZEN_BANDWIDTH_HZ.toFixed(2)} Hz`,
                fourierSeries,
                fourierBand,
                fourierYDomain,
                'Frequency [Hz]',
                'FAS [cm/s²·s]',
                'log',
                'report-fas-clip',
              )}
              {renderSpectrumPanel(
                { x: 576, y: 838, width: 486, height: 590 },
                '(c) Acceleration response spectrum',
                'Sa · h = 5.0%',
                saResponse,
                saPeriodDomain,
                saYDomain,
                'Period [s]',
                'Sa [cm/s²]',
                'linear',
                'report-sa-clip',
              )}
              <line x1="58" y1="1471" x2={WIDTH - 58} y2="1471" stroke="#7b8790" strokeWidth={MIN_LINE} />
              <text x="58" y="1496" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                Acceleration: {accelerationProcessingFooter}. FAS: mean removed; 5% cosine taper; |DFT|Δt; Parzen B=0.10 Hz.
              </text>
              <text x="58" y="1519" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                JMA: original acceleration. Sa: Nigam–Jennings, h=5.0%. Exact settings and source files: Methods JSON / SVG metadata.
              </text>
              <text x={WIDTH - 58} y="1547" textAnchor="end" fontSize={SUPPORT_FONT} fill="#6b7280">1 / 2</text>
            </g>
          ) : (
            <g>
              <text x="58" y="108" fontSize={BODY_FONT} fontWeight="700" fill="#17212b">{originTime} · {selectedStation.label} · M {isFiniteNumber(magnitude) ? magnitude.toFixed(1) : '–'} · Rₕᵧₚ {formatFixed(row?.hypocentralDistanceKm, 1, ' km')}</text>
              <text x={WIDTH - 58} y="108" textAnchor="end" fontSize={SUPPORT_FONT} fill="#52606d">{consistencyLabel}</text>
              {renderWaveformPanel({ x: 58, y: 135, width: 1004, height: 365 }, velocityPanelTitle, selectedWaveforms, 'velocity')}
              {renderTripartitePanel({ x: 130, y: 540, width: 860, height: 850 }, psvResponse, reportResponseSettings)}
              <line x1="58" y1="1471" x2={WIDTH - 58} y2="1471" stroke="#7b8790" strokeWidth={MIN_LINE} />
              <text x="58" y="1496" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                Velocity: {velocityProcessingFooter}. Tripartite: Nigam–Jennings response, h=5.0%; major-decade guides only.
              </text>
              <text x="58" y="1519" fontSize={SUPPORT_FONT} fontWeight="600" fill="#52606d">
                Time: {timeAxis.reference}. Exact settings, source files, and consistency audit: Methods JSON / SVG metadata.
              </text>
              <text x={WIDTH - 58} y="1547" textAnchor="end" fontSize={SUPPORT_FONT} fill="#6b7280">2 / 2</text>
            </g>
          )}
        </svg>
        <figcaption className="chart-caption">{page === 'integrated'
          ? `Integrated A4 plate: aligned acceleration and velocity histories above equal-width Parzen FAS and 5%-damped tripartite pSv panels. The time reference is ${timeAxis.reference}.`
          : page === 'summary'
            ? 'Executive A4 plate: metadata and locator, key metrics, acceleration, Parzen-smoothed FAS, and 5%-damped Sa. Velocity and tripartite detail are intentionally separated onto Page 2.'
            : `Technical A4 plate: velocity and a large, hierarchy-controlled tripartite response spectrum. The time reference is ${timeAxis.reference}.`}</figcaption>
      </figure>
    </div>
  );
}
