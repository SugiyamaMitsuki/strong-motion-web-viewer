import { useMemo, useRef, useState } from 'react';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import { downloadFigureMetadata } from '../export/figureMetadata';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, PreprocessSettings, ResponseSpectrumSettings } from '../types/waveform';
import { formatNumber, safeFileName } from '../utils/file';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { downsampleSegments } from '../visualization/downsample';
import {
  JOURNAL_AXIS_FONT_PT,
  JOURNAL_DATA_LINE_PT,
  JOURNAL_LINE_ART_DPI,
  JOURNAL_MIN_LINE_PT,
  JOURNAL_PANEL_FONT_PT,
  JOURNAL_SUPPORT_FONT_PT,
  pointsToUserUnits,
} from '../visualization/journal';
import {
  buildPublicationFigureContext,
  publicationContextCaption,
  publicationSymmetricLimit,
} from '../visualization/publicationContext';
import { buildFigureProvenance, preprocessingLabel } from '../visualization/provenance';
import { alignWaveformTimes, buildWaveformRecordSets } from '../visualization/waveformGroups';

interface JournalPlatePanelProps {
  waveforms: DerivedWaveform[];
  responseSettings: ResponseSpectrumSettings;
  preprocessSettings?: PreprocessSettings;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WIDTH = 1120;
const HEIGHT = 700;
const PRINT_WIDTH_MM = 180;
const AXIS_FONT = pointsToUserUnits(JOURNAL_AXIS_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const SMALL_FONT = pointsToUserUnits(JOURNAL_SUPPORT_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const PANEL_FONT = pointsToUserUnits(JOURNAL_PANEL_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const DATA_LINE = pointsToUserUnits(JOURNAL_DATA_LINE_PT, WIDTH, PRINT_WIDTH_MM);
const AXIS_LINE = pointsToUserUnits(0.7, WIDTH, PRINT_WIDTH_MM);
const GUIDE_LINE = pointsToUserUnits(JOURNAL_MIN_LINE_PT, WIDTH, PRINT_WIDTH_MM);

// Plot widths are 560:374 (59.96:40.04), leaving a separate gutter for the
// response ordinate without sacrificing the requested journal-plate balance.
const WAVEFORM_RECT: Rect = { x: 90, y: 58, width: 560, height: 560 };
const SPECTRUM_LEGEND_Y = 48;
const SPECTRUM_LEGEND_ROW_GAP = 24;
const SPECTRUM_LEGEND_BOTTOM = SPECTRUM_LEGEND_Y + SPECTRUM_LEGEND_ROW_GAP * 2 + SMALL_FONT;
const SPECTRUM_RECT: Rect = { x: 716, y: 124, width: 374, height: 442 };

function niceTicks(min: number, max: number, targetCount = 6): number[] {
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

function selectJournalWaveforms(waveforms: readonly DerivedWaveform[]): DerivedWaveform[] {
  const selected: DerivedWaveform[] = [];
  const selectedIds = new Set<string>();
  for (const component of ['NS', 'EW', 'UD'] as const) {
    const waveform = waveforms.find((candidate) => candidate.component === component);
    if (!waveform) continue;
    selected.push(waveform);
    selectedIds.add(waveform.sourceRecordId);
  }
  for (const waveform of waveforms) {
    if (selected.length >= 3) break;
    if (selectedIds.has(waveform.sourceRecordId)) continue;
    selected.push(waveform);
    selectedIds.add(waveform.sourceRecordId);
  }
  return selected;
}

function scaleLinear(value: number, domain: [number, number], range: [number, number]): number {
  if (domain[0] === domain[1]) return (range[0] + range[1]) / 2;
  return range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
}

function scaleLog(value: number, domain: [number, number], range: [number, number]): number {
  if (value <= 0 || domain[0] <= 0 || domain[1] <= domain[0]) return range[0];
  return range[0] + ((Math.log10(value) - Math.log10(domain[0])) / (Math.log10(domain[1]) - Math.log10(domain[0]))) * (range[1] - range[0]);
}

function periodTicks(domain: [number, number]): Array<{ value: number; showLabel: boolean }> {
  const [min, max] = domain;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) return [];
  const spanDecades = Math.log10(max) - Math.log10(min);
  const ticks: Array<{ value: number; showLabel: boolean }> = [];
  for (let exponent = Math.floor(Math.log10(min)); exponent <= Math.ceil(Math.log10(max)); exponent += 1) {
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * 10 ** exponent;
      if (value < min * 0.999 || value > max * 1.001) continue;
      ticks.push({ value, showLabel: spanDecades <= 3.2 || multiplier === 1 });
    }
  }
  return ticks;
}

function timePath(time: readonly number[], values: readonly number[], rect: Rect, timeDomain: [number, number], amplitude: number): string {
  const parts: string[] = [];
  downsampleSegments(time, values, 1800).forEach((segment) => {
    segment.x.forEach((timeValue, index) => {
      const x = scaleLinear(timeValue, timeDomain, [rect.x, rect.x + rect.width]);
      const y = scaleLinear(segment.y[index], [-amplitude, amplitude], [rect.y + rect.height, rect.y]);
      parts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
    });
  });
  return parts.join(' ');
}

function spectrumPath(
  periods: readonly number[],
  values: readonly number[],
  xDomain: [number, number],
  yDomain: [number, number],
): string {
  const parts: string[] = [];
  downsampleSegments(periods, values, 900, (x, y) => Number.isFinite(x) && Number.isFinite(y) && x > 0 && y >= 0)
    .forEach((segment) => {
      segment.x.forEach((period, index) => {
        const x = scaleLog(period, xDomain, [SPECTRUM_RECT.x, SPECTRUM_RECT.x + SPECTRUM_RECT.width]);
        const y = scaleLinear(segment.y[index], yDomain, [SPECTRUM_RECT.y + SPECTRUM_RECT.height, SPECTRUM_RECT.y]);
        parts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
      });
    });
  return parts.join(' ');
}

function peakCoordinate(x: readonly number[], y: readonly number[]): { x: number; y: number } | undefined {
  let peak: { x: number; y: number } | undefined;
  const count = Math.min(x.length, y.length);
  for (let index = 0; index < count; index += 1) {
    if (!Number.isFinite(x[index]) || !Number.isFinite(y[index])) continue;
    if (!peak || Math.abs(y[index]) > Math.abs(peak.y)) peak = { x: x[index], y: y[index] };
  }
  return peak;
}

function formatSignificant(value: number, significantDigits = 3): string {
  if (!Number.isFinite(value)) return '';
  return value.toPrecision(significantDigits);
}

export function JournalPlatePanel({ waveforms, responseSettings, preprocessSettings }: JournalPlatePanelProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [recordSetId, setRecordSetId] = useState('');
  const [grayscale, setGrayscale] = useState(false);
  const recordSets = useMemo(() => buildWaveformRecordSets(waveforms), [waveforms]);
  const selected = recordSets.find((set) => set.id === (recordSetId || recordSets[0]?.id)) ?? recordSets[0];
  const allSelectedWaveforms = selected?.waveforms ?? [];
  const selectedWaveforms = useMemo(() => selectJournalWaveforms(selected?.waveforms ?? []), [selected]);
  const omittedWaveformCount = Math.max(0, allSelectedWaveforms.length - selectedWaveforms.length);
  const alignment = useMemo(() => alignWaveformTimes(selectedWaveforms), [selectedWaveforms]);
  const spectra = useMemo(
    () => computeResponseSpectra(selectedWaveforms, responseSettings),
    [selectedWaveforms, responseSettings],
  );
  const effectivePreprocessSettings = preprocessSettings
    ?? selectedWaveforms.find((waveform) => waveform.preprocessing)?.preprocessing;
  const preprocessing = effectivePreprocessSettings ? preprocessingLabel(effectivePreprocessSettings) : undefined;
  const figureContext = useMemo(
    () => buildPublicationFigureContext(selectedWaveforms, preprocessing),
    [preprocessing, selectedWaveforms],
  );
  const provenance = useMemo(
    () => buildFigureProvenance(selectedWaveforms, effectivePreprocessSettings),
    [effectivePreprocessSettings, selectedWaveforms],
  );

  if (!selected || selectedWaveforms.length === 0) return <p className="empty-state">No data is available for a journal composite figure.</p>;

  let timeMin = Infinity;
  let timeMax = -Infinity;
  let accelerationMax = 0;
  selectedWaveforms.forEach((waveform) => {
    const times = alignment.values.get(waveform.sourceRecordId) ?? waveform.time;
    const count = Math.min(waveform.time.length, waveform.acceleration.length);
    for (let index = 0; index < count; index += 1) {
      if (!Number.isFinite(times[index]) || !Number.isFinite(waveform.acceleration[index])) continue;
      timeMin = Math.min(timeMin, times[index]);
      timeMax = Math.max(timeMax, times[index]);
      accelerationMax = Math.max(accelerationMax, Math.abs(waveform.acceleration[index]));
    }
  });
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) [timeMin, timeMax] = [0, 1];
  if (timeMin === timeMax) timeMax = timeMin + 1;
  const amplitude = publicationSymmetricLimit(Math.max(accelerationMax, 1e-12));
  const timeDomain: [number, number] = [timeMin, timeMax];
  const waveformRows = selectedWaveforms.length;
  const waveformGap = 24;
  const waveformHeight = (WAVEFORM_RECT.height - waveformGap * Math.max(0, waveformRows - 1)) / waveformRows;
  const timeTicks = niceTicks(timeMin, timeMax, 6);

  const finitePeriods = spectra.flatMap((spectrum) => spectrum.points
    .filter((point) => Number.isFinite(point.period) && point.period > 0 && Number.isFinite(point.psa) && point.psa >= 0)
    .map((point) => point.period));
  const computedPeriodMin = Math.min(...finitePeriods);
  const computedPeriodMax = Math.max(...finitePeriods);
  const computedPeriodRange: [number, number] | undefined = Number.isFinite(computedPeriodMin)
    ? [computedPeriodMin, computedPeriodMax]
    : undefined;
  const hasPlottableResponseRange = Boolean(computedPeriodRange && computedPeriodRange[1] > computedPeriodRange[0]);
  const requestedPeriodMin = Number.isFinite(responseSettings.minPeriod) && responseSettings.minPeriod > 0
    ? responseSettings.minPeriod
    : 0.02;
  const requestedPeriodMax = Number.isFinite(responseSettings.maxPeriod) && responseSettings.maxPeriod > requestedPeriodMin
    ? responseSettings.maxPeriod
    : requestedPeriodMin * 10;
  const periodDomain: [number, number] = hasPlottableResponseRange
    ? computedPeriodRange as [number, number]
    : [requestedPeriodMin, requestedPeriodMax];
  let responseMax = 0;
  spectra.forEach((spectrum) => spectrum.points.forEach((point) => { if (Number.isFinite(point.psa)) responseMax = Math.max(responseMax, point.psa); }));
  const responseDomain: [number, number] = hasPlottableResponseRange
    ? [0, publicationSymmetricLimit(Math.max(responseMax, 1e-12))]
    : [0, 1];
  const spectrumPeriodTicks = periodTicks(periodDomain);
  const responseTicks = hasPlottableResponseRange ? niceTicks(0, responseDomain[1], 6) : [];
  const spectrumPeaks = spectra.map((spectrum) => peakCoordinate(
    spectrum.points.map((point) => point.period),
    spectrum.points.map((point) => point.psa),
  ));
  const fileNameBase = safeFileName(`journal_plate_${selected.label}`);
  const responseStatus = hasPlottableResponseRange
    ? `Computed response period range: T = ${formatNumber(computedPeriodRange![0], 4)}–${formatNumber(computedPeriodRange![1], 4)} s.`
    : computedPeriodRange
      ? `Only one finite response ordinate was computed at T = ${formatNumber(computedPeriodRange[0], 4)} s; panel (b) has no plottable range.`
      : `No finite response ordinates were computed for requested T = ${formatNumber(requestedPeriodMin, 4)}–${formatNumber(requestedPeriodMax, 4)} s; panel (b) is empty.`;
  const caption = `Compact manuscript plate with a 60:40 waveform-to-response balance. Stacked components share a symmetric ordinate with 10\u201315% headroom; spectra use a logarithmic period axis and mark each component peak. ${publicationContextCaption(figureContext)} Response spectra use the Nigam–Jennings linear-SDOF exact recurrence with linearly interpolated acceleration and h = ${(responseSettings.dampingRatio * 100).toFixed(1)}%. ${responseStatus}`;
  const exportMetadata = {
    schema: 'strong-motion-journal-plate/1.0',
    figureType: 'waveform-response-composite',
    recordSet: selected.label,
    sourceFiles: selectedWaveforms.map((waveform) => waveform.fileName),
    finalWidthMm: PRINT_WIDTH_MM,
    rasterDpi: JOURNAL_LINE_ART_DPI,
    dampingRatio: responseSettings.dampingRatio,
    sharedWaveformOrdinate: [-amplitude, amplitude],
    timeReference: alignment.reference,
    panelWidthRatio: { waveform: 0.6, response: 0.4 },
    stations: figureContext.stations,
    events: figureContext.events,
    preprocessing: figureContext.preprocessing,
    responseCalculation: {
      method: 'Nigam–Jennings linear-SDOF exact recurrence for linearly interpolated acceleration with adaptive substepping and free-vibration tail',
      requestedPeriodRangeSeconds: [responseSettings.minPeriod, responseSettings.maxPeriod],
      computedPeriodRangeSeconds: computedPeriodRange ?? null,
      displayPeriodRangeSeconds: periodDomain,
      status: hasPlottableResponseRange ? 'computed' : computedPeriodRange ? 'single-finite-ordinate' : 'no-finite-response',
      periodCount: responseSettings.periodCount,
    },
    responsePeaks: spectra.map((spectrum, index) => ({
      component: spectrum.componentLabel,
      periodSeconds: spectrumPeaks[index]?.x,
      saGal: spectrumPeaks[index]?.y,
    })),
    caption,
    provenance,
  };

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        {recordSets.length > 1 && (
          <label>
            Record set
            <select value={selected.id} onChange={(event) => setRecordSetId(event.target.value)}>
              {recordSets.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
            </select>
          </label>
        )}
        <span className="note">The artwork omits a title and dashboard metadata; those belong in the manuscript caption.</span>
        {omittedWaveformCount > 0 && <span className="note warning-text">This compact plate shows the first three components; {omittedWaveformCount} additional component(s) remain available in Time History.</span>}
      </div>

      <figure className={`chart-card publication-figure journal-figure${grayscale ? ' grayscale-preview' : ''}`} tabIndex={0} aria-label="Journal composite of acceleration waveforms and response spectrum">
        <div className="chart-toolbar journal-toolbar">
          <div className="figure-toolbar-label">
            <span className="figure-kicker">Manuscript composite</span>
            <strong>{selected.label}</strong>
            <span className="note">180 mm · 800 dpi · h = {(responseSettings.dampingRatio * 100).toFixed(1)}% · shared waveform ordinate</span>
          </div>
          <div className="button-row compact">
            <button type="button" className="secondary" aria-pressed={grayscale} onClick={() => setGrayscale((value) => !value)}>{grayscale ? 'Colour preview' : 'Grayscale check'}</button>
            <button type="button" className="secondary" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`, { widthMm: PRINT_WIDTH_MM })}>SVG · vector</button>
            <button type="button" className="secondary" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, { widthMm: PRINT_WIDTH_MM, dpi: JOURNAL_LINE_ART_DPI })}>PNG · 800 dpi</button>
            <button type="button" className="secondary" onClick={() => downloadFigureMetadata(fileNameBase, exportMetadata)}>Methods · JSON</button>
          </div>
        </div>

        <span className="mobile-scroll-hint" aria-hidden="true">Swipe horizontally to inspect panel (b) →</span>
        <svg
          ref={svgRef}
          className="publication-chart journal-chart"
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby="journal-plate-title journal-plate-description"
          preserveAspectRatio="xMidYMid meet"
          style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}
        >
          <title id="journal-plate-title">{`Acceleration time histories and response spectrum for ${selected.label}`}</title>
          <desc id="journal-plate-description">Panel a contains stacked acceleration components on a shared ordinate with component PGA and occurrence time. Panel b contains {(responseSettings.dampingRatio * 100).toFixed(1)}-percent-damped acceleration response spectra with component peak periods and values. {publicationContextCaption(figureContext)}</desc>
          <metadata>{JSON.stringify(exportMetadata)}</metadata>
          <rect width={WIDTH} height={HEIGHT} fill="#ffffff" />

          <text x={WAVEFORM_RECT.x} y="29" fontSize={PANEL_FONT} fontWeight="700" fill="#111820">(a)</text>
          <text x={SPECTRUM_RECT.x} y="29" fontSize={PANEL_FONT} fontWeight="700" fill="#111820">(b)</text>
          <text x={SPECTRUM_RECT.x + SPECTRUM_RECT.width} y="29" textAnchor="end" fontSize={SMALL_FONT} fill="#1f2933">h = {(responseSettings.dampingRatio * 100).toFixed(1)}%</text>

          {selectedWaveforms.map((waveform, index) => {
            const times = alignment.values.get(waveform.sourceRecordId) ?? waveform.time;
            const rect: Rect = {
              x: WAVEFORM_RECT.x,
              y: WAVEFORM_RECT.y + index * (waveformHeight + waveformGap),
              width: WAVEFORM_RECT.width,
              height: waveformHeight,
            };
            const zeroY = rect.y + rect.height / 2;
            const peak = peakCoordinate(times, waveform.acceleration);
            return (
              <g key={waveform.sourceRecordId}>
                <line x1={rect.x} y1={rect.y} x2={rect.x + rect.width} y2={rect.y} stroke="#a1a8ad" strokeWidth={GUIDE_LINE} />
                <line x1={rect.x} y1={zeroY} x2={rect.x + rect.width} y2={zeroY} stroke="#6f777d" strokeWidth={GUIDE_LINE} />
                <line x1={rect.x} y1={rect.y + rect.height} x2={rect.x + rect.width} y2={rect.y + rect.height} stroke="#a1a8ad" strokeWidth={GUIDE_LINE} />
                <line x1={rect.x} y1={rect.y} x2={rect.x} y2={rect.y + rect.height} stroke="#111820" strokeWidth={AXIS_LINE} />
                <path d={timePath(times, waveform.acceleration, rect, timeDomain, amplitude)} fill="none" stroke="#111820" strokeWidth={DATA_LINE} strokeLinecap="round" strokeLinejoin="round" />
                <text x={rect.x + 7} y={rect.y + SMALL_FONT + 3} fontSize={SMALL_FONT} fontWeight="700" fill="#111820">{waveform.componentLabel}</text>
                {peak && (
                  <text x={rect.x + rect.width - 5} y={rect.y + SMALL_FONT + 3} textAnchor="end" fontSize={SMALL_FONT} fill="#4b5563">
                    PGA = {formatSignificant(Math.abs(peak.y))} cm/s² at t = {formatNumber(peak.x, 2)} s
                  </text>
                )}
                {[amplitude, 0, -amplitude].map((tick) => {
                  const y = scaleLinear(tick, [-amplitude, amplitude], [rect.y + rect.height, rect.y]);
                  return (
                    <g key={`${waveform.sourceRecordId}-${tick}`}>
                      <line x1={rect.x - 5} y1={y} x2={rect.x} y2={y} stroke="#111820" strokeWidth={AXIS_LINE} />
                      <text x={rect.x - 9} y={y + AXIS_FONT * 0.34} textAnchor="end" fontSize={AXIS_FONT} fill="#1f2933">{formatNumber(tick, 4)}</text>
                    </g>
                  );
                })}
                {index === selectedWaveforms.length - 1 && timeTicks.map((tick) => {
                  const x = scaleLinear(tick, timeDomain, [rect.x, rect.x + rect.width]);
                  return (
                    <g key={`wave-time-${tick}`}>
                      <line x1={x} y1={rect.y + rect.height} x2={x} y2={rect.y + rect.height + 6} stroke="#111820" strokeWidth={AXIS_LINE} />
                      <text x={x} y={rect.y + rect.height + 25} textAnchor="middle" fontSize={AXIS_FONT} fill="#1f2933">{formatNumber(tick, 4)}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text x="24" y={WAVEFORM_RECT.y + WAVEFORM_RECT.height / 2} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820" transform={`rotate(-90 24 ${WAVEFORM_RECT.y + WAVEFORM_RECT.height / 2})`}>Acceleration [cm/s²]</text>
          <text x={WAVEFORM_RECT.x + WAVEFORM_RECT.width / 2} y={HEIGHT - 23} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820">Time [s]</text>

          {responseTicks.map((tick) => {
            const y = scaleLinear(tick, responseDomain, [SPECTRUM_RECT.y + SPECTRUM_RECT.height, SPECTRUM_RECT.y]);
            return (
              <g key={`response-y-${tick}`}>
                {tick > 0 && <line x1={SPECTRUM_RECT.x} y1={y} x2={SPECTRUM_RECT.x + SPECTRUM_RECT.width} y2={y} stroke="#c7ccd0" strokeWidth={GUIDE_LINE} />}
                <line x1={SPECTRUM_RECT.x - 5} y1={y} x2={SPECTRUM_RECT.x} y2={y} stroke="#111820" strokeWidth={AXIS_LINE} />
                <text x={SPECTRUM_RECT.x - 9} y={y + AXIS_FONT * 0.34} textAnchor="end" fontSize={AXIS_FONT} fill="#1f2933">{formatNumber(tick, 4)}</text>
              </g>
            );
          })}
          {spectrumPeriodTicks.map((tick) => {
            const x = scaleLog(tick.value, periodDomain, [SPECTRUM_RECT.x, SPECTRUM_RECT.x + SPECTRUM_RECT.width]);
            return (
              <g key={`response-x-${tick.value}`}>
                <line x1={x} y1={SPECTRUM_RECT.y + SPECTRUM_RECT.height} x2={x} y2={SPECTRUM_RECT.y + SPECTRUM_RECT.height + 6} stroke="#111820" strokeWidth={AXIS_LINE} />
                {tick.showLabel && <text x={x} y={SPECTRUM_RECT.y + SPECTRUM_RECT.height + 24} textAnchor="middle" fontSize={AXIS_FONT} fill="#1f2933">{formatNumber(tick.value, 3)}</text>}
              </g>
            );
          })}
          <line x1={SPECTRUM_RECT.x} y1={SPECTRUM_RECT.y} x2={SPECTRUM_RECT.x} y2={SPECTRUM_RECT.y + SPECTRUM_RECT.height} stroke="#111820" strokeWidth={AXIS_LINE} />
          <line x1={SPECTRUM_RECT.x} y1={SPECTRUM_RECT.y + SPECTRUM_RECT.height} x2={SPECTRUM_RECT.x + SPECTRUM_RECT.width} y2={SPECTRUM_RECT.y + SPECTRUM_RECT.height} stroke="#111820" strokeWidth={AXIS_LINE} />
          {!hasPlottableResponseRange && (
            <text x={SPECTRUM_RECT.x + SPECTRUM_RECT.width / 2} y={SPECTRUM_RECT.y + SPECTRUM_RECT.height / 2} textAnchor="middle" fontSize={SMALL_FONT} fill="#4b5563">
              No plottable finite response range
            </text>
          )}
          {spectra.map((spectrum, index) => {
            const style = componentSeriesStyle(spectrum.component, index);
            const peak = spectrumPeaks[index];
            return (
              <g key={`${spectrum.componentLabel}-${index}`}>
                <path
                  d={spectrumPath(spectrum.points.map((point) => point.period), spectrum.points.map((point) => point.psa), periodDomain, responseDomain)}
                  fill="none"
                  stroke={style.color}
                  strokeWidth={DATA_LINE * 1.15}
                  strokeDasharray={style.dashArray}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {peak && (
                  <circle
                    cx={scaleLog(peak.x, periodDomain, [SPECTRUM_RECT.x, SPECTRUM_RECT.x + SPECTRUM_RECT.width])}
                    cy={scaleLinear(peak.y, responseDomain, [SPECTRUM_RECT.y + SPECTRUM_RECT.height, SPECTRUM_RECT.y])}
                    r="4"
                    fill="#ffffff"
                    stroke={style.color}
                    strokeWidth={AXIS_LINE * 1.25}
                  />
                )}
              </g>
            );
          })}
          <text x={SPECTRUM_RECT.x + SPECTRUM_RECT.width / 2} y={SPECTRUM_RECT.y + SPECTRUM_RECT.height + 55} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820">Period [s]</text>
          <text x={SPECTRUM_RECT.x - 50} y={SPECTRUM_RECT.y + SPECTRUM_RECT.height / 2} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820" transform={`rotate(-90 ${SPECTRUM_RECT.x - 50} ${SPECTRUM_RECT.y + SPECTRUM_RECT.height / 2})`}>Sa [cm/s²]</text>
          <g
            aria-label="Response peak legend outside plot area"
            data-response-legend-placement="outside-plot"
            data-response-legend-bottom={SPECTRUM_LEGEND_BOTTOM}
            data-response-plot-top={SPECTRUM_RECT.y}
            transform={`translate(${SPECTRUM_RECT.x} ${SPECTRUM_LEGEND_Y})`}
          >
            {spectra.map((spectrum, index) => {
              const style = componentSeriesStyle(spectrum.component, index);
              const peak = spectrumPeaks[index];
              return (
                <g key={`legend-${spectrum.componentLabel}-${index}`} transform={`translate(0 ${index * SPECTRUM_LEGEND_ROW_GAP})`}>
                  <line x1="0" y1="0" x2="29" y2="0" stroke={style.color} strokeWidth={DATA_LINE * 1.15} strokeDasharray={style.dashArray} />
                  <text x="38" y={SMALL_FONT * 0.34} fontSize={SMALL_FONT} fontWeight="700" fill="#111820">
                    {spectrum.componentLabel}{peak ? `: T = ${formatSignificant(peak.x)} s, Sa = ${formatSignificant(peak.y)}` : ': peak unavailable'}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <figcaption className="chart-caption journal-caption">
          {caption}
        </figcaption>
      </figure>
    </div>
  );
}
