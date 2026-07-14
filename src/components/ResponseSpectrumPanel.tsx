import { useMemo, useState } from 'react';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import type {
  DerivedWaveform,
  PreprocessSettings,
  ResponseSpectrumPoint,
  ResponseSpectrumSettings,
} from '../types/waveform';
import { formatNumber } from '../utils/file';
import { componentSeriesStyle } from '../visualization/chartStyle';
import {
  buildPublicationFigureContext,
  publicationContextCaption,
} from '../visualization/publicationContext';
import { buildFigureProvenance, preprocessingLabel } from '../visualization/provenance';
import { buildWaveformRecordSets } from '../visualization/waveformGroups';
import { SvgChart, type ChartSeries } from './SvgChart';

interface ResponseSpectrumPanelProps {
  waveforms: DerivedWaveform[];
  settings: ResponseSpectrumSettings;
  preprocessSettings?: PreprocessSettings;
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

interface ResponsePeak {
  period: number;
  value: number;
}

function ordinateLabel(ordinate: Ordinate): string {
  if (ordinate === 'psv') return 'Pseudo Velocity Response pSv [cm/s]';
  if (ordinate === 'psa') return 'Absolute Acceleration Response Sa [cm/s²]';
  return 'Displacement Response Sd [cm]';
}

function ordinateShortLabel(ordinate: Ordinate): string {
  if (ordinate === 'psv') return 'pSv';
  if (ordinate === 'psa') return 'Sa';
  return 'Sd';
}

function ordinateUnit(ordinate: Ordinate): string {
  if (ordinate === 'psv') return 'cm/s';
  if (ordinate === 'psa') return 'cm/s²';
  return 'cm';
}

function formatSignificant(value: number, significantDigits = 3): string {
  if (!Number.isFinite(value)) return '';
  return value.toPrecision(significantDigits);
}

function compactSeriesNames(waveforms: readonly DerivedWaveform[]): string[] {
  const componentCounts = new Map<string, number>();
  waveforms.forEach((waveform) => {
    componentCounts.set(waveform.componentLabel, (componentCounts.get(waveform.componentLabel) ?? 0) + 1);
  });
  const provisional = waveforms.map((waveform) => {
    if ((componentCounts.get(waveform.componentLabel) ?? 0) === 1) return waveform.componentLabel;
    const station = waveform.metadata.stationCode?.trim();
    return `${station || waveform.fileName} · ${waveform.componentLabel}`;
  });
  const labelCounts = new Map<string, number>();
  provisional.forEach((label) => labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1));
  return provisional.map((label, index) => {
    if ((labelCounts.get(label) ?? 0) === 1) return label;
    const event = waveforms[index].metadata.originTime?.trim();
    return event ? `${label} · ${event}` : `${label} · ${index + 1}`;
  });
}

function responsePeak(points: readonly ResponseSpectrumPoint[], ordinate: Ordinate): ResponsePeak | undefined {
  let peak: ResponsePeak | undefined;
  points.forEach((point) => {
    const value = point[ordinate];
    if (!Number.isFinite(point.period) || point.period <= 0 || !Number.isFinite(value) || value < 0) return;
    if (!peak || value > peak.value) peak = { period: point.period, value };
  });
  return peak;
}

function log10(value: number): number {
  return Math.log(value) / Math.LN10;
}

function niceLogCeil(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return 10 ** Math.ceil(log10(value));
}

function getSeriesXRange(series: ChartSeries[]): SeriesRange | undefined {
  let min = Infinity;
  let max = 0;
  series.forEach((entry) => {
    const count = Math.min(entry.x.length, entry.y.length);
    for (let index = 0; index < count; index += 1) {
      if (!Number.isFinite(entry.x[index]) || entry.x[index] <= 0) continue;
      if (!Number.isFinite(entry.y[index]) || entry.y[index] < 0) continue;
      min = Math.min(min, entry.x[index]);
      max = Math.max(max, entry.x[index]);
    }
  });
  return max > min && Number.isFinite(min) ? { min, max } : undefined;
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

function periodDomain(series: ChartSeries[], settings: ResponseSpectrumSettings): [number, number] {
  const range = getSeriesXRange(series);
  if (range) return [range.min, range.max];
  const min = Number.isFinite(settings.minPeriod) && settings.minPeriod > 0
    ? settings.minPeriod
    : FALLBACK_PERIOD_DOMAIN[0];
  const max = Number.isFinite(settings.maxPeriod) && settings.maxPeriod > min
    ? settings.maxPeriod
    : Math.max(FALLBACK_PERIOD_DOMAIN[1], min * 10);
  return [min, max];
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

export function responseDomains(
  series: ChartSeries[],
  settings: ResponseSpectrumSettings,
  ordinate: Ordinate,
  mode: ScaleMode,
): { xDomain: [number, number]; yDomain: [number, number]; equalAspect: boolean } {
  const xDomain = periodDomain(series, settings);
  const range = getSeriesRange(series);
  if (mode === 'fit') {
    const max = niceLogCeil((range?.max ?? 0) * 1.15, ordinate === 'sd' ? 1 : 10);
    return { xDomain, yDomain: [max / 1000, max], equalAspect: false };
  }

  const xRange = toLogRange(xDomain);
  const yRange = ordinateLogRange(series, ordinate);
  const xSpan = xRange.maxLog - xRange.minLog;
  const ySpan = yRange.maxLog - yRange.minLog;
  if (ySpan > xSpan + 1e-12) {
    // Do not invent uncomputed period margins merely to force equal decades.
    // The caller must disable the 1:1/tripartite geometry for this case.
    return { xDomain, yDomain: fromLogRange(yRange), equalAspect: false };
  }
  return { xDomain, yDomain: fromLogRange(expandLogRange(yRange, xSpan)), equalAspect: true };
}

export function ResponseSpectrumPanel({ waveforms, settings, preprocessSettings }: ResponseSpectrumPanelProps): JSX.Element {
  const [recordSetId, setRecordSetId] = useState('');
  const [ordinate, setOrdinate] = useState<Ordinate>('psv');
  const [scaleMode, setScaleMode] = useState<ScaleMode>('equal');
  const recordSets = useMemo(() => buildWaveformRecordSets(waveforms), [waveforms]);
  const selectedRecordSet = recordSets.find((set) => set.id === (recordSetId || recordSets[0]?.id)) ?? recordSets[0];
  const selectedWaveforms = selectedRecordSet?.waveforms ?? [];
  const exportRecordSetSuffix = selectedRecordSet?.label ? `_${selectedRecordSet.label}` : '';
  const spectra = useMemo(() => computeResponseSpectra(selectedWaveforms, settings), [selectedWaveforms, settings]);
  const compactNames = useMemo(() => compactSeriesNames(selectedWaveforms), [selectedWaveforms]);

  const series = useMemo<ChartSeries[]>(() => spectra.map((result, index) => {
    const waveform = selectedWaveforms[index];
    return {
      id: waveform?.sourceRecordId ?? `${result.componentLabel}-${index}`,
      name: compactNames[index] ?? result.componentLabel,
      x: result.points.map((point) => point.period),
      y: result.points.map((point) => point[ordinate]),
      style: componentSeriesStyle(result.component),
    };
  }), [compactNames, spectra, ordinate, selectedWaveforms]);

  const { xDomain, yDomain, equalAspect } = useMemo(
    () => responseDomains(series, settings, ordinate, scaleMode),
    [series, settings, ordinate, scaleMode],
  );
  const useEqualAspect = scaleMode === 'equal' && equalAspect;
  const isTripartite = ordinate === 'psv' && useEqualAspect;
  const chartTitle = isTripartite
    ? 'Tripartite Response Spectrum: pSv'
    : `Response Spectrum (${scaleMode === 'equal' ? useEqualAspect ? '1:1 log-log' : 'data-range log-log; 1:1 unavailable' : 'Fit to data'}): ${ordinateLabel(ordinate)}`;
  const peaks = spectra.map((spectrum) => responsePeak(spectrum.points, ordinate));
  const peakAnnotations = peaks.map((peak, index) => (
    peak
      ? `${compactNames[index] ?? spectra[index].componentLabel}: peak ${ordinateShortLabel(ordinate)} = ${formatSignificant(peak.value)} ${ordinateUnit(ordinate)} at T = ${formatSignificant(peak.period)} s`
      : `${compactNames[index] ?? spectra[index].componentLabel}: peak unavailable`
  ));
  const finiteComputedPeriods = spectra.flatMap((spectrum) => spectrum.points
    .filter((point) => Number.isFinite(point.period) && point.period > 0 && Number.isFinite(point[ordinate]) && point[ordinate] >= 0)
    .map((point) => point.period));
  const computedPeriodRange: [number, number] | undefined = finiteComputedPeriods.length > 0
    ? [Math.min(...finiteComputedPeriods), Math.max(...finiteComputedPeriods)]
    : undefined;
  const noFiniteResponseMessage = 'No finite response ordinates were computed for the requested period range.';
  const annotations = computedPeriodRange ? peakAnnotations : [noFiniteResponseMessage];
  const effectivePreprocessSettings = preprocessSettings
    ?? selectedWaveforms.find((waveform) => waveform.preprocessing)?.preprocessing;
  const preprocessing = effectivePreprocessSettings ? preprocessingLabel(effectivePreprocessSettings) : undefined;
  const figureContext = buildPublicationFigureContext(selectedWaveforms, preprocessing);
  const provenance = buildFigureProvenance(selectedWaveforms, effectivePreprocessSettings);
  const method = 'Nigam–Jennings linear-SDOF exact recurrence for linearly interpolated ground acceleration, with adaptive interval substepping and a free-vibration tail.';
  const geometryStatus = useEqualAspect
    ? 'The two logarithmic axes use equal decade scaling.'
    : scaleMode === 'equal'
      ? 'The requested 1:1/tripartite frame was disabled because the ordinate spans more decades than the computed period range; no uncomputed period margin was added.'
      : 'Axes are fitted independently to the data range.';
  const periodStatus = computedPeriodRange
    ? `Computed period range: T = ${formatNumber(computedPeriodRange[0], 4)}–${formatNumber(computedPeriodRange[1], 4)} s.`
    : `${noFiniteResponseMessage} Requested range: T = ${formatNumber(settings.minPeriod, 4)}–${formatNumber(settings.maxPeriod, 4)} s.`;
  const caption = `${publicationContextCaption(figureContext)} ${method} ${periodStatus} ${settings.periodCount} logarithmically spaced periods were requested; numerically unsupported short periods are omitted. Damping h = ${(settings.dampingRatio * 100).toFixed(1)}%. ${geometryStatus}`;
  const figureMetadata = {
    schema: 'strong-motion-response-spectrum/1.0',
    recordSet: selectedRecordSet?.label,
    figureType: isTripartite ? 'tripartite-response-spectrum' : 'response-spectrum',
    ordinate,
    ordinateUnit: ordinateUnit(ordinate),
    dampingRatio: settings.dampingRatio,
    display: {
      requestedScaleMode: scaleMode,
      effectiveScaleMode: useEqualAspect ? '1:1-log-log' : 'data-range-log-log',
      equalLogDecades: useEqualAspect,
      tripartiteGuides: isTripartite,
      fallbackReason: scaleMode === 'equal' && !useEqualAspect
        ? 'ordinate log span exceeds the computed period log span; uncomputed period margins were not added'
        : null,
    },
    calculation: {
      method,
      requestedPeriodRangeSeconds: [settings.minPeriod, settings.maxPeriod],
      computedPeriodRangeSeconds: computedPeriodRange ?? null,
      status: computedPeriodRange ? 'computed' : 'no-finite-response',
      requestedPeriodCount: settings.periodCount,
      periodSpacing: 'logarithmic',
      unsupportedPeriods: 'omitted when the adaptive substep safety limit is exceeded',
    },
    peaks: peaks.map((peak, index) => ({
      component: compactNames[index] ?? spectra[index].componentLabel,
      periodSeconds: peak?.period,
      value: peak?.value,
      unit: ordinateUnit(ordinate),
    })),
    stations: figureContext.stations,
    events: figureContext.events,
    preprocessing: figureContext.preprocessing,
    provenance,
  };

  if (waveforms.length === 0) return <p className="empty-state">No data is available for response spectra.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        {recordSets.length > 1 && selectedRecordSet && (
          <label>
            Record set
            <select value={selectedRecordSet.id} onChange={(event) => setRecordSetId(event.target.value)}>
              {recordSets.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
            </select>
          </label>
        )}
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
            <option value="equal">1:1 log-log when valid</option>
            <option value="fit">Fit to data</option>
          </select>
        </label>
        <span className="note">Damping h = {(settings.dampingRatio * 100).toFixed(1)}%</span>
        <span className="note">Periods exceeding the safe substep limit are omitted.</span>
        {scaleMode === 'equal' && !useEqualAspect && (
          <span className="note warning-text">1:1/tripartite geometry is disabled because the ordinate spans more decades than the computed period range; no uncomputed period margin was added.</span>
        )}
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
        width={useEqualAspect ? 700 : 900}
        height={useEqualAspect
          ? 780 + Math.max(0, annotations.length - 3) * 17
          : 520 + Math.max(0, annotations.length - 3) * 17}
        equalAspect={useEqualAspect}
        tripartite={isTripartite}
        annotations={annotations}
        cornerNote={`h = ${(settings.dampingRatio * 100).toFixed(1)}%`}
        caption={caption}
        metadata={figureMetadata}
        fileNameBase={`response_spectrum_${ordinate}_${scaleMode}${exportRecordSetSuffix}`}
        description={`${chartTitle}. Damping ratio h = ${(settings.dampingRatio * 100).toFixed(1)}%. ${computedPeriodRange ? 'Each component peak period and value is listed below the plot.' : noFiniteResponseMessage} ${method} ${periodStatus} ${geometryStatus} ${publicationContextCaption(figureContext)}`}
      />
    </div>
  );
}
