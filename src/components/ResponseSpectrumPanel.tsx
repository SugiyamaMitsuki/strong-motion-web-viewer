import { useMemo, useState } from 'react';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import type { DerivedWaveform, ResponseSpectrumSettings } from '../types/waveform';
import { SvgChart, type ChartSeries } from './SvgChart';

interface ResponseSpectrumPanelProps {
  waveforms: DerivedWaveform[];
  settings: ResponseSpectrumSettings;
}

type Ordinate = 'psv' | 'psa' | 'sd';
type ScaleMode = 'equal' | 'fit';

const FALLBACK_PERIOD_DOMAIN: [number, number] = [0.01, 10];
const LOG_SNAP_STEP = 0.25;

interface SeriesRange {
  min: number;
  max: number;
}

interface LogRange {
  minLog: number;
  maxLog: number;
}

function ordinateLabel(ordinate: Ordinate): string {
  if (ordinate === 'psv') return 'Pseudo Velocity Response pSv [cm/s]';
  if (ordinate === 'psa') return 'Absolute Acceleration Response Sa [cm/s²]';
  return 'Displacement Response Sd [cm]';
}

function log10(value: number): number {
  return Math.log(value) / Math.LN10;
}

function niceLogFloor(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return 10 ** Math.floor(log10(value));
}

function niceLogCeil(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return 10 ** Math.ceil(log10(value));
}

function getSeriesRange(series: ChartSeries[]): SeriesRange | undefined {
  let min = Infinity;
  let max = 0;
  series.forEach((entry) => {
    entry.y.forEach((value) => {
      if (!Number.isFinite(value) || value <= 0) return;
      if (value < min) min = value;
      if (value > max) max = value;
    });
  });
  return max > 0 && Number.isFinite(min) ? { min, max } : undefined;
}

function periodDomain(settings: ResponseSpectrumSettings, mode: ScaleMode): [number, number] {
  const minPeriod = mode === 'equal' ? Math.min(settings.minPeriod, FALLBACK_PERIOD_DOMAIN[0]) : settings.minPeriod;
  const maxPeriod = mode === 'equal' ? Math.max(settings.maxPeriod, FALLBACK_PERIOD_DOMAIN[1]) : settings.maxPeriod;
  const min = niceLogFloor(minPeriod, FALLBACK_PERIOD_DOMAIN[0]);
  const max = niceLogCeil(maxPeriod, FALLBACK_PERIOD_DOMAIN[1]);
  return min < max ? [min, max] : FALLBACK_PERIOD_DOMAIN;
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

function ordinateLogRange(series: ChartSeries[], ordinate: Ordinate): LogRange {
  const range = getSeriesRange(series);
  if (!range) {
    const fallbackMax = ordinate === 'sd' ? 1 : 10;
    return { minLog: log10(fallbackMax) - 3, maxLog: log10(fallbackMax) };
  }

  const minLog = log10(range.min);
  const maxLog = log10(range.max);
  const dataSpan = Math.max(maxLog - minLog, LOG_SNAP_STEP);
  const padding = Math.min(0.3, Math.max(0.08, dataSpan * 0.06));
  return snapLogRange({ minLog: minLog - padding, maxLog: maxLog + padding });
}

function responseDomains(
  series: ChartSeries[],
  settings: ResponseSpectrumSettings,
  ordinate: Ordinate,
  mode: ScaleMode,
): { xDomain: [number, number]; yDomain: [number, number] } {
  const xDomain = periodDomain(settings, mode);
  const range = getSeriesRange(series);
  if (mode === 'fit') {
    const max = niceLogCeil((range?.max ?? 0) * 1.15, ordinate === 'sd' ? 1 : 10);
    return { xDomain, yDomain: [max / 1000, max] };
  }

  const xRange = toLogRange(xDomain);
  const yRange = ordinateLogRange(series, ordinate);
  const targetSpan = Math.max(xRange.maxLog - xRange.minLog, yRange.maxLog - yRange.minLog);
  return {
    xDomain: fromLogRange(expandLogRange(xRange, targetSpan)),
    yDomain: fromLogRange(expandLogRange(yRange, targetSpan)),
  };
}

export function ResponseSpectrumPanel({ waveforms, settings }: ResponseSpectrumPanelProps): JSX.Element {
  const [ordinate, setOrdinate] = useState<Ordinate>('psv');
  const [scaleMode, setScaleMode] = useState<ScaleMode>('equal');
  const spectra = useMemo(() => computeResponseSpectra(waveforms, settings), [waveforms, settings]);
  const isTripartite = ordinate === 'psv' && scaleMode === 'equal';

  const series = useMemo<ChartSeries[]>(() => spectra.map((result) => ({
    name: result.componentLabel,
    x: result.points.map((point) => point.period),
    y: result.points.map((point) => point[ordinate]),
  })), [spectra, ordinate]);

  const { xDomain, yDomain } = useMemo(
    () => responseDomains(series, settings, ordinate, scaleMode),
    [series, settings, ordinate, scaleMode],
  );
  const chartTitle = isTripartite
    ? 'Tripartite Response Spectrum: pSv'
    : `Response Spectrum (${scaleMode === 'equal' ? '1:1 log-log' : 'Fit to data'}): ${ordinateLabel(ordinate)}`;

  if (waveforms.length === 0) return <p className="empty-state">No data is available for response spectra.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        <label>
          Ordinate
          <select value={ordinate} onChange={(event) => setOrdinate(event.target.value as Ordinate)}>
            <option value="psv">Pseudo Velocity pSv</option>
            <option value="psa">Absolute Acceleration Sa</option>
            <option value="sd">Displacement Sd</option>
          </select>
        </label>
        <label>
          Scale
          <select value={scaleMode} onChange={(event) => setScaleMode(event.target.value as ScaleMode)}>
            <option value="equal">1:1 log-log</option>
            <option value="fit">Fit to data</option>
          </select>
        </label>
        <span className="note">Damping h = {(settings.dampingRatio * 100).toFixed(1)}%</span>
        <span className="note">Periods exceeding the safe substep limit are omitted.</span>
      </div>
      <SvgChart
        title={chartTitle}
        xLabel="Period [s]"
        yLabel={ordinateLabel(ordinate)}
        series={series}
        xScale="log"
        yScale="log"
        domainX={xDomain}
        domainY={yDomain}
        width={scaleMode === 'equal' ? 700 : 900}
        height={scaleMode === 'equal' ? 700 : 430}
        tripartite={isTripartite}
        fileNameBase={`response_spectrum_${ordinate}_${scaleMode}`}
      />
    </div>
  );
}
