import { useMemo, useRef, useState } from 'react';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform, ResponseSpectrumSettings } from '../types/waveform';
import { formatNumber, safeFileName } from '../utils/file';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { downsampleSegments } from '../visualization/downsample';
import {
  JOURNAL_AXIS_FONT_PT,
  JOURNAL_DATA_LINE_PT,
  JOURNAL_LINE_ART_DPI,
  JOURNAL_MIN_LINE_PT,
  JOURNAL_PANEL_FONT_PT,
  pointsToUserUnits,
} from '../visualization/journal';
import { alignWaveformTimes, buildWaveformRecordSets } from '../visualization/waveformGroups';

interface JournalPlatePanelProps {
  waveforms: DerivedWaveform[];
  responseSettings: ResponseSpectrumSettings;
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
const SMALL_FONT = pointsToUserUnits(7, WIDTH, PRINT_WIDTH_MM);
const PANEL_FONT = pointsToUserUnits(JOURNAL_PANEL_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const DATA_LINE = pointsToUserUnits(JOURNAL_DATA_LINE_PT, WIDTH, PRINT_WIDTH_MM);
const AXIS_LINE = pointsToUserUnits(0.7, WIDTH, PRINT_WIDTH_MM);
const GUIDE_LINE = pointsToUserUnits(JOURNAL_MIN_LINE_PT, WIDTH, PRINT_WIDTH_MM);

const WAVEFORM_RECT: Rect = { x: 96, y: 58, width: 580, height: 560 };
const SPECTRUM_RECT: Rect = { x: 760, y: 86, width: 340, height: 480 };

function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

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

export function JournalPlatePanel({ waveforms, responseSettings }: JournalPlatePanelProps): JSX.Element {
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
  const amplitude = niceCeil(Math.max(accelerationMax, 1e-12));
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
  const periodDomain: [number, number] = Number.isFinite(computedPeriodMin) && computedPeriodMax > computedPeriodMin
    ? [computedPeriodMin, computedPeriodMax]
    : [0.02, 10];
  let responseMax = 0;
  spectra.forEach((spectrum) => spectrum.points.forEach((point) => { if (Number.isFinite(point.psa)) responseMax = Math.max(responseMax, point.psa); }));
  const responseDomain: [number, number] = [0, niceCeil(Math.max(responseMax * 1.05, 1))];
  const spectrumPeriodTicks = periodTicks(periodDomain);
  const responseTicks = niceTicks(0, responseDomain[1], 6);
  const fileNameBase = safeFileName(`journal_plate_${selected.label}`);

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
          </div>
        </div>

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
          <title id="journal-plate-title">Acceleration time histories and response spectrum for {selected.label}</title>
          <desc id="journal-plate-description">Panel a contains stacked acceleration components on a shared ordinate. Panel b contains {(responseSettings.dampingRatio * 100).toFixed(1)}-percent-damped acceleration response spectra.</desc>
          <metadata>{JSON.stringify({
            figureType: 'waveform-response-composite',
            recordSet: selected.label,
            sourceFiles: selectedWaveforms.map((waveform) => waveform.fileName),
            finalWidthMm: PRINT_WIDTH_MM,
            rasterDpi: JOURNAL_LINE_ART_DPI,
            dampingRatio: responseSettings.dampingRatio,
            sharedWaveformOrdinate: [-amplitude, amplitude],
            timeReference: alignment.reference,
          })}</metadata>
          <rect width={WIDTH} height={HEIGHT} fill="#ffffff" />

          <text x={WAVEFORM_RECT.x} y="29" fontSize={PANEL_FONT} fontWeight="700" fill="#111820">(a)</text>
          <text x={SPECTRUM_RECT.x} y="57" fontSize={PANEL_FONT} fontWeight="700" fill="#111820">(b)</text>

          {selectedWaveforms.map((waveform, index) => {
            const times = alignment.values.get(waveform.sourceRecordId) ?? waveform.time;
            const rect: Rect = {
              x: WAVEFORM_RECT.x,
              y: WAVEFORM_RECT.y + index * (waveformHeight + waveformGap),
              width: WAVEFORM_RECT.width,
              height: waveformHeight,
            };
            const zeroY = rect.y + rect.height / 2;
            return (
              <g key={waveform.sourceRecordId}>
                <line x1={rect.x} y1={rect.y} x2={rect.x + rect.width} y2={rect.y} stroke="#a1a8ad" strokeWidth={GUIDE_LINE} />
                <line x1={rect.x} y1={zeroY} x2={rect.x + rect.width} y2={zeroY} stroke="#6f777d" strokeWidth={GUIDE_LINE} />
                <line x1={rect.x} y1={rect.y + rect.height} x2={rect.x + rect.width} y2={rect.y + rect.height} stroke="#a1a8ad" strokeWidth={GUIDE_LINE} />
                <line x1={rect.x} y1={rect.y} x2={rect.x} y2={rect.y + rect.height} stroke="#111820" strokeWidth={AXIS_LINE} />
                <path d={timePath(times, waveform.acceleration, rect, timeDomain, amplitude)} fill="none" stroke="#111820" strokeWidth={DATA_LINE} strokeLinecap="round" strokeLinejoin="round" />
                <text x={rect.x + 7} y={rect.y + SMALL_FONT + 3} fontSize={SMALL_FONT} fontWeight="700" fill="#111820">{waveform.componentLabel}</text>
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
          {spectra.map((spectrum, index) => {
            const style = componentSeriesStyle(spectrum.component, index);
            return (
              <path
                key={`${spectrum.componentLabel}-${index}`}
                d={spectrumPath(spectrum.points.map((point) => point.period), spectrum.points.map((point) => point.psa), periodDomain, responseDomain)}
                fill="none"
                stroke={style.color}
                strokeWidth={DATA_LINE * 1.15}
                strokeDasharray={style.dashArray}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          <text x={SPECTRUM_RECT.x + SPECTRUM_RECT.width / 2} y={SPECTRUM_RECT.y + SPECTRUM_RECT.height + 55} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820">Period [s]</text>
          <text x={SPECTRUM_RECT.x - 64} y={SPECTRUM_RECT.y + SPECTRUM_RECT.height / 2} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820" transform={`rotate(-90 ${SPECTRUM_RECT.x - 64} ${SPECTRUM_RECT.y + SPECTRUM_RECT.height / 2})`}>Sa [cm/s²]</text>
          <text x={SPECTRUM_RECT.x + SPECTRUM_RECT.width - 3} y={SPECTRUM_RECT.y + 17} textAnchor="end" fontSize={SMALL_FONT} fill="#1f2933">h = {(responseSettings.dampingRatio * 100).toFixed(1)}%</text>
          <g transform={`translate(${SPECTRUM_RECT.x + 12} ${SPECTRUM_RECT.y + 24})`}>
            {spectra.map((spectrum, index) => {
              const style = componentSeriesStyle(spectrum.component, index);
              return (
                <g key={`legend-${spectrum.componentLabel}-${index}`} transform={`translate(0 ${index * 24})`}>
                  <line x1="0" y1="0" x2="29" y2="0" stroke={style.color} strokeWidth={DATA_LINE * 1.15} strokeDasharray={style.dashArray} />
                  <text x="38" y={SMALL_FONT * 0.34} fontSize={SMALL_FONT} fontWeight="700" fill="#111820">{spectrum.componentLabel}</text>
                </g>
              );
            })}
          </g>
        </svg>
        <figcaption className="chart-caption journal-caption">
          Compact manuscript plate: stacked components share one ordinate; spectra use a logarithmic period axis. The figure title and explanatory caption remain outside the artwork.
        </figcaption>
      </figure>
    </div>
  );
}
