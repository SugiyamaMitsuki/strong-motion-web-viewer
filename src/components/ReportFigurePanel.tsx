import { useMemo, useRef, useState } from 'react';
import { computeStationDistanceRows, type StationDistanceRow } from '../analysis/distance';
import { computeJmaIntensity } from '../analysis/jmaIntensity';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, PeakSummary, Quantity, ResponseSpectrumSettings } from '../types/waveform';
import { formatNumber, safeFileName } from '../utils/file';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { downsampleSegments } from '../visualization/downsample';

interface ReportFigurePanelProps {
  waveforms: DerivedWaveform[];
  jmaWaveforms: DerivedWaveform[];
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
  dashArray?: string;
}

const WIDTH = 1120;
const HEIGHT = 1584;
const FONT_FAMILY = 'Arial, Helvetica, sans-serif';
const LOG_SNAP_STEP = 0.25;

interface LogRange {
  minLog: number;
  maxLog: number;
}

interface ReportTimeAxis {
  label: string;
  reference: string;
  offsetsByRecordId: Map<string, number>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
  downsampleSegments(time, values, 900).forEach((segment) => {
    segment.x.forEach((timeValue, index) => {
      const x = scaleLinear(timeValue, timeDomain[0], timeDomain[1], rect.x, rect.x + rect.width);
      const y = scaleLinear(segment.y[index], -maxAbs, maxAbs, rect.y + rect.height, rect.y);
      parts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    });
  });
  return parts.join(' ');
}

function linearTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const n = Math.max(2, count);
  return Array.from({ length: n }, (_, index) => min + ((max - min) * index) / (n - 1));
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
    .map((result) => {
      const style = componentSeriesStyle(result.component);
      return {
        name: result.componentLabel,
        x: result.points.map((point) => point.period),
        y: result.points.map((point) => point.psv),
        color: style.color,
        dashArray: style.dashArray,
      };
    });
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
  const parts: string[] = [];
  downsampleSegments(series.x, series.y, 700, (x, y) => Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0)
    .forEach((segment) => {
      segment.x.forEach((xValue, index) => {
        const x = scaleLog(xValue, xDomain[0], xDomain[1], rect.x, rect.x + rect.width);
        const y = scaleLog(segment.y[index], yDomain[0], yDomain[1], rect.y + rect.height, rect.y);
        parts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
      });
    });
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
  const timeAxis = reportTimeAxis(ordered);
  const plotTop = rect.y + 44;
  const rowHeight = (rect.height - 102) / Math.max(1, ordered.length);
  const plotWidth = rect.width - 120;
  let timeMin = Infinity;
  let timeMax = -Infinity;
  let sharedMaxAbs = 0;
  ordered.forEach((waveform) => {
    const values = quantityValues(waveform, quantity);
    const count = Math.min(waveform.time.length, values.length);
    const offset = timeAxis.offsetsByRecordId.get(waveform.sourceRecordId) ?? 0;
    for (let index = 0; index < count; index += 1) {
      const time = waveform.time[index] + offset;
      if (!Number.isFinite(time) || !Number.isFinite(values[index])) continue;
      timeMin = Math.min(timeMin, time);
      timeMax = Math.max(timeMax, time);
      sharedMaxAbs = Math.max(sharedMaxAbs, Math.abs(values[index]));
    }
  });
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) [timeMin, timeMax] = [0, 1];
  if (timeMin === timeMax) timeMax = timeMin + 1;
  sharedMaxAbs = Math.max(sharedMaxAbs, 1e-12);
  const timeDomain: [number, number] = [timeMin, timeMax];
  const axisTicks = linearTicks(timeMin, timeMax, 5);
  const axisX = rect.x + 76;
  const axisY = rect.y + rect.height - 34;

  return card(rect, title, (
    <g>
      {ordered.length > 0 && (
        <text x={rect.x + rect.width - 2} y={rect.y + 18} textAnchor="end" fontSize="11.5" fontWeight="600" fill="#4b5563">
          Shared ordinate ±{formatNumber(sharedMaxAbs, 4)} {quantityUnit(quantity)}
        </text>
      )}
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
        const offset = timeAxis.offsetsByRecordId.get(waveform.sourceRecordId) ?? 0;
        const alignedTime = offset === 0 ? waveform.time : waveform.time.map((value) => value + offset);
        const peak = maxAbsWithTime(values, alignedTime);
        const style = componentSeriesStyle(waveform.component);
        return (
          <g key={`${quantity}-${waveform.sourceRecordId}`}>
            <text x={rect.x + 2} y={rowRect.y + rowRect.height / 2 + 5} fontSize="12.5" fontWeight="700" fill="#263640">{waveform.componentLabel}</text>
            <line x1={rowRect.x} y1={rowRect.y + rowRect.height / 2} x2={rowRect.x + rowRect.width} y2={rowRect.y + rowRect.height / 2} stroke="#9ca3af" strokeWidth="0.55" />
            <path
              d={timePath(alignedTime, values, rowRect, sharedMaxAbs, timeDomain)}
              fill="none"
              stroke={style.color}
              strokeWidth="1.2"
              strokeDasharray={style.dashArray}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text x={rowRect.x + rowRect.width - 7} y={rowRect.y + 14} textAnchor="end" fontSize="11.5" fontWeight="600" fill="#374151">
              Max {formatNumber(peak.value, 4)} {quantityUnit(quantity)} at {formatNumber(peak.time, 3)} s
            </text>
          </g>
        );
      })}
      {axisTicks.length > 0 && (
        <g>
          <line x1={axisX} y1={axisY} x2={axisX + plotWidth} y2={axisY} stroke="#374151" strokeWidth="0.65" />
          {axisTicks.map((tick) => {
            const x = scaleLinear(tick, timeMin, timeMax, axisX, axisX + plotWidth);
            return (
              <g key={`${title}-tick-${tick}`}>
                <line x1={x} y1={axisY} x2={x} y2={axisY + 4} stroke="#374151" strokeWidth="0.65" />
                <text x={x} y={axisY + 15} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="#374151">{formatTick(tick)}</text>
              </g>
            );
          })}
        </g>
      )}
      <text x={rect.x + rect.width / 2} y={rect.y + rect.height - 2} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#374151">{timeAxis.label}</text>
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

  return card(rect, '(c) Tripartite response spectrum: pSv', (
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
            <text x={x} y={plot.y + plot.height + 17} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="#374151">{formatTick(tick)}</text>
          </g>
        );
      })}
      {yTicks.map((tick) => {
        const y = scaleLog(tick, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <g key={`y-${tick}`}>
            <text x={plot.x - 9} y={y + 4} textAnchor="end" fontSize="11.5" fontWeight="600" fill="#374151">{formatTick(tick)}</text>
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
          <path key={entry.name} d={linePath(entry, plot, xDomain, yDomain)} fill="none" stroke={entry.color} strokeWidth="1.8" strokeDasharray={entry.dashArray} strokeLinecap="round" strokeLinejoin="round" />
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
            fontSize="11.5"
            fontWeight="600"
            fill="#667085"
            transform={`rotate(-38 ${x} ${y})`}
          >
            {exponent === accelerationLabelExponents[accelerationLabelExponents.length - 1]
              ? `${powerLabel(exponent)} cm/s²`
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
            fontSize="11.5"
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
      <g transform={`translate(${plot.x + 16} ${rect.y + 36})`}>
        {series.map((entry, index) => (
          <g key={`legend-${entry.name}`} transform={`translate(${index * 120} 0)`}>
            <line x1="0" y1="0" x2="24" y2="0" stroke={entry.color} strokeWidth="1.8" strokeDasharray={entry.dashArray} strokeLinecap="round" />
            <text x="30" y="4" fontSize="11.5" fontWeight="700" fill="#111827">{entry.name}</text>
          </g>
        ))}
      </g>
    </g>
  ));
}

export function ReportFigurePanel({ waveforms, jmaWaveforms, peaks, responseSettings }: ReportFigurePanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stations = useMemo(() => buildReportStations(waveforms, peaks), [waveforms, peaks]);
  const [stationId, setStationId] = useState<string>('');
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
  const response = useMemo(() => responseSeries(selectedWaveforms, responseSettings), [selectedWaveforms, responseSettings]);
  const timeAxis = useMemo(() => reportTimeAxis(selectedWaveforms), [selectedWaveforms]);

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
            Record set
            <select value={selectedStation.id} onChange={(event) => setStationId(event.target.value)}>
              {stations.map((station) => <option key={station.id} value={station.id}>{station.label}</option>)}
            </select>
          </label>
        )}
        <span className="note">A4 portrait overview figure with metadata, intensity, distance, stacked waveforms, and tripartite response spectrum.</span>
      </div>

      <figure className="chart-card publication-figure report-figure" tabIndex={0} aria-label="A4 strong-motion report figure; horizontally scrollable on narrow screens">
        <div className="chart-toolbar">
          <div className="figure-toolbar-label">
            <span className="figure-kicker">A4 publication report</span>
            <span className="note">210 × 297 mm · editable vector or 300 dpi raster</span>
          </div>
          <div className="button-row compact">
            <button type="button" className="secondary" aria-label="Download strong-motion A4 report as a self-contained SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`, { widthMm: 210, heightMm: 297 })}>SVG · vector</button>
            <button type="button" className="secondary" aria-label="Download strong-motion A4 report as a 300 dpi PNG" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, { dpi: 300, widthMm: 210 })}>PNG · 300 dpi</button>
          </div>
        </div>
        <svg
          ref={svgRef}
          className="publication-chart"
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby="report-figure-title report-figure-description"
          preserveAspectRatio="xMidYMid meet"
          style={{ fontFamily: FONT_FAMILY }}
        >
          <title id="report-figure-title">Strong-motion record overview for {selectedStation.label}</title>
          <desc id="report-figure-description">A4 portrait report containing record metadata, coordinates, distances, intensity and peak values, acceleration and velocity time histories on shared axes, and a five-percent-damped tripartite response spectrum.</desc>
          <metadata>{JSON.stringify({
            station: selectedStation.label,
            sourceFiles: selectedWaveforms.map((waveform) => waveform.fileName),
            dampingRatio: responseSettings.dampingRatio,
            reportSizeMm: [210, 297],
            jmaIntensityInput: 'original acceleration',
            waveformInput: 'active preprocessing',
            timeReference: timeAxis.reference,
          })}</metadata>
          <rect width={WIDTH} height={HEIGHT} fill="#ffffff" />
          <text x="60" y="54" fontSize="23" fontWeight="700" fill="#111827">Strong-motion record overview</text>
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
                ['PGA', pga ? `${formatNumber(pga.value, 4)} cm/s² (${pga.component})` : '-'],
                ['PGV', pgv ? `${formatNumber(pgv.value, 4)} cm/s (${pgv.component})` : '-'],
                ['PGD', pgd ? `${formatNumber(pgd.value, 4)} cm (${pgd.component})` : '-'],
              ], 22)}
            </g>
          ))}

          {renderWaveformPanel({ x: 60, y: 310, width: 1000, height: 245 }, '(a) Acceleration waveforms', selectedWaveforms, 'acceleration')}
          {renderWaveformPanel({ x: 60, y: 592, width: 1000, height: 245 }, '(b) Velocity waveforms', selectedWaveforms, 'velocity')}
          {renderResponsePanel({ x: 175, y: 875, width: 770, height: 650 }, response, responseSettings)}
          <line x1="60" y1="1544" x2={WIDTH - 60} y2="1544" stroke="#9ca3af" strokeWidth="0.65" />
          <text x="60" y="1564" fontSize="11.5" fontWeight="600" fill="#4b5563">
            Displayed waveforms use active preprocessing; JMA intensity uses original acceleration. Response spectrum damping h = {(responseSettings.dampingRatio * 100).toFixed(1)}%.
          </text>
        </svg>
        <figcaption className="chart-caption">A4 portrait report. Component traces use a shared ordinate; the time reference is {timeAxis.reference}. Colour is reinforced by line pattern.</figcaption>
      </figure>
    </div>
  );
}
