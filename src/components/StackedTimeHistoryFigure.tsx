import { useMemo, useRef, useState } from 'react';
import { downloadPng, downloadSvg } from '../export/exportImage';
import type { DerivedWaveform } from '../types/waveform';
import { formatNumber, safeFileName } from '../utils/file';
import { downsampleSegments } from '../visualization/downsample';
import {
  JOURNAL_AXIS_FONT_PT,
  JOURNAL_DATA_LINE_PT,
  JOURNAL_LINE_ART_DPI,
  JOURNAL_MIN_LINE_PT,
  JOURNAL_PANEL_FONT_PT,
  pointsToUserUnits,
} from '../visualization/journal';
import { waveformSeriesLabel } from '../visualization/labels';
import { alignWaveformTimes } from '../visualization/waveformGroups';

export type JournalTimeHistoryQuantity = 'acceleration' | 'velocity' | 'displacement';

interface StackedTimeHistoryFigureProps {
  waveforms: DerivedWaveform[];
  quantity: JournalTimeHistoryQuantity;
  label: string;
  shortLabel: string;
  unit: string;
  fileNameBase: string;
  contextLabel?: string;
}

interface PeakValue {
  magnitude: number;
  time: number;
}

const WIDTH = 1000;
const PRINT_WIDTH_MM = 180;
const LEFT = 116;
const RIGHT = 24;
const TOP = 36;
const PANEL_HEIGHT = 132;
const PANEL_GAP = 27;
const BOTTOM = 66;

const AXIS_FONT = pointsToUserUnits(JOURNAL_AXIS_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const SMALL_FONT = pointsToUserUnits(7, WIDTH, PRINT_WIDTH_MM);
const PANEL_FONT = pointsToUserUnits(JOURNAL_PANEL_FONT_PT, WIDTH, PRINT_WIDTH_MM);
const DATA_LINE = pointsToUserUnits(JOURNAL_DATA_LINE_PT, WIDTH, PRINT_WIDTH_MM);
const AXIS_LINE = pointsToUserUnits(0.7, WIDTH, PRINT_WIDTH_MM);
const GUIDE_LINE = pointsToUserUnits(JOURNAL_MIN_LINE_PT, WIDTH, PRINT_WIDTH_MM);

function peakValue(times: readonly number[], values: readonly number[]): PeakValue {
  let magnitude = 0;
  let time = times[0] ?? 0;
  const count = Math.min(times.length, values.length);
  for (let index = 0; index < count; index += 1) {
    if (!Number.isFinite(times[index]) || !Number.isFinite(values[index])) continue;
    const candidate = Math.abs(values[index]);
    if (candidate > magnitude) {
      magnitude = candidate;
      time = times[index];
    }
  }
  return { magnitude, time };
}

function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

function linearTicks(min: number, max: number, count = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const rawStep = (max - min) / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = multiplier * power;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

function scaleLinear(value: number, domain: [number, number], range: [number, number]): number {
  if (domain[0] === domain[1]) return (range[0] + range[1]) / 2;
  return range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
}

function panelLetter(index: number): string {
  return `(${String.fromCharCode(97 + (index % 26))})`;
}

export function StackedTimeHistoryFigure({
  waveforms,
  quantity,
  label,
  shortLabel,
  unit,
  fileNameBase,
  contextLabel,
}: StackedTimeHistoryFigureProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [grayscale, setGrayscale] = useState(false);
  const alignment = useMemo(() => alignWaveformTimes(waveforms), [waveforms]);
  const plotWidth = WIDTH - LEFT - RIGHT;
  const height = TOP + waveforms.length * PANEL_HEIGHT + Math.max(0, waveforms.length - 1) * PANEL_GAP + BOTTOM;

  let timeMin = Infinity;
  let timeMax = -Infinity;
  let absoluteMaximum = 0;
  waveforms.forEach((waveform) => {
    const times = alignment.values.get(waveform.sourceRecordId) ?? waveform.time;
    const values = waveform[quantity];
    const count = Math.min(times.length, values.length);
    for (let index = 0; index < count; index += 1) {
      if (!Number.isFinite(times[index]) || !Number.isFinite(values[index])) continue;
      timeMin = Math.min(timeMin, times[index]);
      timeMax = Math.max(timeMax, times[index]);
      absoluteMaximum = Math.max(absoluteMaximum, Math.abs(values[index]));
    }
  });
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) [timeMin, timeMax] = [0, 1];
  if (timeMin === timeMax) timeMax = timeMin + 1;
  const amplitudeLimit = niceCeil(Math.max(absoluteMaximum, 1e-12));
  const timeDomain: [number, number] = [timeMin, timeMax];
  const amplitudeDomain: [number, number] = [-amplitudeLimit, amplitudeLimit];
  const xTicks = linearTicks(timeMin, timeMax, 6);
  const baseName = safeFileName(fileNameBase);

  return (
    <figure className={`chart-card publication-figure journal-figure${grayscale ? ' grayscale-preview' : ''}`} tabIndex={0} aria-label={`${label} stacked journal figure`}>
      <div className="chart-toolbar journal-toolbar">
        <div className="figure-toolbar-label">
          <span className="figure-kicker">Journal line-art figure</span>
          <strong>{label}{contextLabel ? ` · ${contextLabel}` : ''}</strong>
          <span className="note">180 mm · 800 dpi · final text 7–12 pt · shared ordinate</span>
        </div>
        <div className="button-row compact">
          <button type="button" className="secondary" aria-pressed={grayscale} onClick={() => setGrayscale((value) => !value)}>
            {grayscale ? 'Colour preview' : 'Grayscale check'}
          </button>
          <button type="button" className="secondary" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${baseName}.svg`, { widthMm: PRINT_WIDTH_MM })}>SVG · vector</button>
          <button type="button" className="secondary" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${baseName}.png`, { widthMm: PRINT_WIDTH_MM, dpi: JOURNAL_LINE_ART_DPI })}>PNG · 800 dpi</button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="publication-chart journal-chart"
        width={WIDTH}
        height={height}
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-labelledby={`${baseName}-title ${baseName}-description`}
        preserveAspectRatio="xMidYMid meet"
        style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}
      >
        <title id={`${baseName}-title`}>{label} time histories</title>
        <desc id={`${baseName}-description`}>{waveforms.length} vertically stacked time histories on a shared ordinate. {alignment.reference}.</desc>
        <metadata>{JSON.stringify({
          figureType: 'stacked-time-history',
          quantity,
          unit,
          finalWidthMm: PRINT_WIDTH_MM,
          rasterDpi: JOURNAL_LINE_ART_DPI,
          timeReference: alignment.reference,
          sharedOrdinate: amplitudeDomain,
          sourceFiles: waveforms.map((waveform) => waveform.fileName),
        })}</metadata>
        <rect width={WIDTH} height={height} fill="#ffffff" />

        {waveforms.map((waveform, panelIndex) => {
          const panelTop = TOP + panelIndex * (PANEL_HEIGHT + PANEL_GAP);
          const panelBottom = panelTop + PANEL_HEIGHT;
          const times = alignment.values.get(waveform.sourceRecordId) ?? waveform.time;
          const values = waveform[quantity];
          const peak = peakValue(times, values);
          const pathParts: string[] = [];
          downsampleSegments(times, values, 2600).forEach((segment) => {
            segment.x.forEach((time, index) => {
              const x = scaleLinear(time, timeDomain, [LEFT, LEFT + plotWidth]);
              const y = scaleLinear(segment.y[index], amplitudeDomain, [panelBottom, panelTop]);
              pathParts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
            });
          });
          const zeroY = scaleLinear(0, amplitudeDomain, [panelBottom, panelTop]);
          return (
            <g key={waveform.sourceRecordId}>
              <line x1={LEFT} y1={panelTop} x2={LEFT + plotWidth} y2={panelTop} stroke="#9aa1a7" strokeWidth={GUIDE_LINE} />
              <line x1={LEFT} y1={zeroY} x2={LEFT + plotWidth} y2={zeroY} stroke="#737b82" strokeWidth={GUIDE_LINE} />
              <line x1={LEFT} y1={panelBottom} x2={LEFT + plotWidth} y2={panelBottom} stroke="#9aa1a7" strokeWidth={GUIDE_LINE} />
              <line x1={LEFT} y1={panelTop} x2={LEFT} y2={panelBottom} stroke="#1f2933" strokeWidth={AXIS_LINE} />
              <path d={pathParts.join(' ')} fill="none" stroke="#111820" strokeWidth={DATA_LINE} strokeLinecap="round" strokeLinejoin="round" />

              {[amplitudeLimit, 0, -amplitudeLimit].map((tick) => {
                const y = scaleLinear(tick, amplitudeDomain, [panelBottom, panelTop]);
                return (
                  <g key={`${waveform.sourceRecordId}-${tick}`}>
                    <line x1={LEFT - 5} y1={y} x2={LEFT} y2={y} stroke="#1f2933" strokeWidth={AXIS_LINE} />
                    <text x={LEFT - 10} y={y + AXIS_FONT * 0.34} textAnchor="end" fontSize={AXIS_FONT} fill="#1f2933">{formatNumber(tick, 4)}</text>
                  </g>
                );
              })}

              <text x={LEFT + 4} y={panelTop - 8} fontSize={PANEL_FONT} fontWeight="700" fill="#111820">
                {panelLetter(panelIndex)} {waveformSeriesLabel(waveform)}
              </text>
              <text x={LEFT + plotWidth} y={panelTop - 8} textAnchor="end" fontSize={SMALL_FONT} fill="#36414a">
                {shortLabel} = {formatNumber(peak.magnitude, 5)} {unit} at {formatNumber(peak.time, 4)} s
              </text>

              {panelIndex === waveforms.length - 1 && xTicks.map((tick) => {
                const x = scaleLinear(tick, timeDomain, [LEFT, LEFT + plotWidth]);
                return (
                  <g key={`time-${tick}`}>
                    <line x1={x} y1={panelBottom} x2={x} y2={panelBottom + 6} stroke="#1f2933" strokeWidth={AXIS_LINE} />
                    <text x={x} y={panelBottom + 25} textAnchor="middle" fontSize={AXIS_FONT} fill="#1f2933">{formatNumber(tick, 4)}</text>
                  </g>
                );
              })}
            </g>
          );
        })}

        <text x={22} y={(height - BOTTOM + TOP) / 2} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820" transform={`rotate(-90 22 ${(height - BOTTOM + TOP) / 2})`}>
          {label} [{unit}]
        </text>
        <text x={LEFT + plotWidth / 2} y={height - 18} textAnchor="middle" fontSize={AXIS_FONT} fontWeight="700" fill="#111820">Time [s]</text>
      </svg>
      <figcaption className="chart-caption journal-caption">
        Stacked components use one ordinate and direct labels; no figure title or legend is embedded in the artwork. Time reference: {alignment.reference}.
      </figcaption>
    </figure>
  );
}
