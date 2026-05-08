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

const WIDTH = 1600;
const HEIGHT = 1140;
const COLORS: Record<string, string> = {
  NS: '#dc2626',
  EW: '#2563eb',
  UD: '#16a34a',
  OTHER: '#7c3aed',
};

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

function responseYDomain(series: readonly SeriesSpec[]): [number, number] {
  let max = 0;
  for (const entry of series) {
    for (const value of entry.y) {
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  const upper = niceLogCeil(max * 1.2, 10);
  return [upper / 1000, upper];
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
      <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="12" fill="#ffffff" stroke="#d5dbe7" />
      <text x={rect.x + 18} y={rect.y + 30} fontSize="18" fontWeight="800" fill="#172033">{title}</text>
      {children}
    </g>
  );
}

function textRows(x: number, y: number, rows: Array<[string, string]>, rowHeight = 27): JSX.Element {
  return (
    <g>
      {rows.map(([label, value], index) => (
        <g key={label} transform={`translate(${x} ${y + index * rowHeight})`}>
          <text x="0" y="0" fontSize="13" fontWeight="800" fill="#667085">{label}</text>
          <text x="170" y="0" fontSize="14" fontWeight="700" fill="#172033">{value}</text>
        </g>
      ))}
    </g>
  );
}

function renderLocationPlot(rect: Rect, station: ReportStation): JSX.Element {
  const row = station.row;
  const points = [
    isFiniteNumber(row?.eventLat) && isFiniteNumber(row?.eventLon)
      ? { kind: 'event', label: 'Epicenter', lat: row.eventLat, lon: row.eventLon, color: '#f97316' }
      : undefined,
    isFiniteNumber(row?.stationLat) && isFiniteNumber(row?.stationLon)
      ? { kind: 'station', label: 'Station', lat: row.stationLat, lon: row.stationLon, color: '#dc2626' }
      : undefined,
  ].filter((point): point is { kind: string; label: string; lat: number; lon: number; color: string } => point !== undefined);

  const plot: Rect = { x: rect.x + 24, y: rect.y + 52, width: rect.width - 48, height: rect.height - 82 };
  if (points.length === 0) {
    return (
      <g>
        <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} rx="8" fill="#f8fafc" stroke="#d5dbe7" />
        <text x={plot.x + plot.width / 2} y={plot.y + plot.height / 2} textAnchor="middle" fontSize="15" fontWeight="700" fill="#667085">Location data unavailable</text>
      </g>
    );
  }

  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const latSpan = Math.max(0.01, Math.max(...lats) - Math.min(...lats));
  const lonSpan = Math.max(0.01, Math.max(...lons) - Math.min(...lons));
  const latMin = Math.min(...lats) - latSpan * 0.28;
  const latMax = Math.max(...lats) + latSpan * 0.28;
  const lonMin = Math.min(...lons) - lonSpan * 0.28;
  const lonMax = Math.max(...lons) + lonSpan * 0.28;
  const rendered = points.map((point) => ({
    ...point,
    x: scaleLinear(point.lon, lonMin, lonMax, plot.x + 26, plot.x + plot.width - 26),
    y: scaleLinear(point.lat, latMin, latMax, plot.y + plot.height - 26, plot.y + 26),
  }));
  const event = rendered.find((point) => point.kind === 'event');
  const stationPoint = rendered.find((point) => point.kind === 'station');

  return (
    <g>
      <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} rx="8" fill="#f8fafc" stroke="#d5dbe7" />
      {[0.25, 0.5, 0.75].map((ratio) => (
        <g key={ratio}>
          <line x1={plot.x} y1={plot.y + plot.height * ratio} x2={plot.x + plot.width} y2={plot.y + plot.height * ratio} stroke="#e5e7eb" />
          <line x1={plot.x + plot.width * ratio} y1={plot.y} x2={plot.x + plot.width * ratio} y2={plot.y + plot.height} stroke="#e5e7eb" />
        </g>
      ))}
      {event && stationPoint && (
        <>
          <line x1={event.x} y1={event.y} x2={stationPoint.x} y2={stationPoint.y} stroke="#334155" strokeDasharray="7 7" strokeWidth="2" />
          <text x={(event.x + stationPoint.x) / 2} y={(event.y + stationPoint.y) / 2 - 8} textAnchor="middle" fontSize="12" fontWeight="800" fill="#334155">
            {fmt(row?.epicentralDistanceKm, 2, ' km')}
          </text>
        </>
      )}
      {rendered.map((point) => (
        <g key={point.kind} transform={`translate(${point.x} ${point.y})`}>
          {point.kind === 'event' ? (
            <path d="M0 -13L13 0L0 13L-13 0Z" fill={point.color} stroke="#ffffff" strokeWidth="3" />
          ) : (
            <>
              <path d="M0 -20C-12 -20 -20 -12 -20 -1C-20 14 0 28 0 28C0 28 20 14 20 -1C20 -12 12 -20 0 -20Z" fill={point.color} stroke="#ffffff" strokeWidth="3" />
              <circle r="6" fill="#ffffff" stroke="#991b1b" strokeWidth="2" />
            </>
          )}
          <text y={point.kind === 'event' ? -21 : -28} textAnchor="middle" fontSize="13" fontWeight="900" fill="#172033" stroke="#ffffff" strokeWidth="4" paintOrder="stroke">{point.label}</text>
        </g>
      ))}
      <text x={plot.x + 10} y={plot.y + plot.height - 10} fontSize="11" fontWeight="700" fill="#667085">Lon {fmt(lonMin, 3)} to {fmt(lonMax, 3)}</text>
      <text x={plot.x + plot.width - 10} y={plot.y + plot.height - 10} textAnchor="end" fontSize="11" fontWeight="700" fill="#667085">Lat {fmt(latMin, 3)} to {fmt(latMax, 3)}</text>
    </g>
  );
}

function renderWaveformPanel(rect: Rect, title: string, waveforms: readonly DerivedWaveform[], quantity: Quantity): JSX.Element {
  const ordered = [...waveforms].sort((a, b) => componentRank(a.component) - componentRank(b.component));
  const plotTop = rect.y + 58;
  const rowHeight = (rect.height - 92) / Math.max(1, ordered.length);
  const plotWidth = rect.width - 106;

  return card(rect, title, (
    <g>
      {ordered.length === 0 ? (
        <text x={rect.x + rect.width / 2} y={rect.y + rect.height / 2} textAnchor="middle" fontSize="15" fontWeight="700" fill="#667085">No waveform data</text>
      ) : ordered.map((waveform, index) => {
        const rowRect: Rect = {
          x: rect.x + 70,
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
            <text x={rect.x + 20} y={rowRect.y + rowRect.height / 2 + 5} fontSize="14" fontWeight="900" fill={color}>{waveform.componentLabel}</text>
            <rect x={rowRect.x} y={rowRect.y} width={rowRect.width} height={rowRect.height} fill="#f8fafc" stroke="#e5e7eb" />
            <line x1={rowRect.x} y1={rowRect.y + rowRect.height / 2} x2={rowRect.x + rowRect.width} y2={rowRect.y + rowRect.height / 2} stroke="#cbd5e1" />
            <path d={timePath(waveform.time, values, rowRect, maxAbs)} fill="none" stroke={color} strokeWidth="1.4" />
            <text x={rowRect.x + rowRect.width - 8} y={rowRect.y + 15} textAnchor="end" fontSize="12" fontWeight="700" fill="#334155">
              Max {formatNumber(peak.value, 4)} {quantityUnit(quantity)} at {formatNumber(peak.time, 3)} s
            </text>
          </g>
        );
      })}
      <text x={rect.x + rect.width / 2} y={rect.y + rect.height - 18} textAnchor="middle" fontSize="12" fontWeight="800" fill="#667085">Time [s]</text>
    </g>
  ));
}

function renderResponsePanel(rect: Rect, series: readonly SeriesSpec[], settings: ResponseSpectrumSettings): JSX.Element {
  const plot: Rect = { x: rect.x + 74, y: rect.y + 58, width: rect.width - 106, height: rect.height - 104 };
  const xDomain: [number, number] = [
    niceLogFloor(settings.minPeriod, 0.01),
    niceLogCeil(settings.maxPeriod, 10),
  ];
  const yDomain = responseYDomain(series);
  const xTicks = logTicks(xDomain[0], xDomain[1]);
  const yTicks = logTicks(yDomain[0], yDomain[1]);

  return card(rect, 'Response Spectrum: pSv', (
    <g>
      <text x={rect.x + rect.width - 20} y={rect.y + 30} textAnchor="end" fontSize="13" fontWeight="800" fill="#667085">Damping h = {(settings.dampingRatio * 100).toFixed(1)}%</text>
      <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="#ffffff" stroke="#667085" />
      {xTicks.map((tick) => {
        const x = scaleLog(tick, xDomain[0], xDomain[1], plot.x, plot.x + plot.width);
        return (
          <g key={`x-${tick}`}>
            <line x1={x} y1={plot.y} x2={x} y2={plot.y + plot.height} stroke="#e5e7eb" />
            <text x={x} y={plot.y + plot.height + 18} textAnchor="middle" fontSize="11" fontWeight="700" fill="#667085">{formatNumber(tick, 3)}</text>
          </g>
        );
      })}
      {yTicks.map((tick) => {
        const y = scaleLog(tick, yDomain[0], yDomain[1], plot.y + plot.height, plot.y);
        return (
          <g key={`y-${tick}`}>
            <line x1={plot.x} y1={y} x2={plot.x + plot.width} y2={y} stroke="#e5e7eb" />
            <text x={plot.x - 9} y={y + 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#667085">{formatNumber(tick, 3)}</text>
          </g>
        );
      })}
      {series.map((entry) => (
        <path key={entry.name} d={linePath(entry, plot, xDomain, yDomain)} fill="none" stroke={entry.color} strokeWidth="2" />
      ))}
      <text x={plot.x + plot.width / 2} y={rect.y + rect.height - 16} textAnchor="middle" fontSize="13" fontWeight="800" fill="#334155">Period [s]</text>
      <text x={rect.x + 24} y={plot.y + plot.height / 2} textAnchor="middle" fontSize="13" fontWeight="800" fill="#334155" transform={`rotate(-90 ${rect.x + 24} ${plot.y + plot.height / 2})`}>pSv [cm/s]</text>
      <g transform={`translate(${plot.x + 16} ${plot.y + 20})`}>
        {series.map((entry, index) => (
          <g key={`legend-${entry.name}`} transform={`translate(${index * 120} 0)`}>
            <line x1="0" y1="0" x2="24" y2="0" stroke={entry.color} strokeWidth="2" />
            <text x="30" y="4" fontSize="12" fontWeight="800" fill="#334155">{entry.name}</text>
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
        <span className="note">Report-ready overview figure with location, intensity, distance, waveforms, and response spectrum.</span>
      </div>

      <div className="chart-card">
        <div className="chart-toolbar">
          <span aria-hidden="true" />
          <div className="button-row compact">
            <button type="button" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileNameBase}.svg`)}>SVG</button>
            <button type="button" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileNameBase}.png`, 2)}>PNG</button>
          </div>
        </div>
        <svg ref={svgRef} width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Strong motion report overview">
          <rect width={WIDTH} height={HEIGHT} fill="#f5f7fb" />
          <rect x="0" y="0" width={WIDTH} height="74" fill="#172554" />
          <text x="40" y="46" fontSize="30" fontWeight="900" fill="#ffffff">Strong Motion Report Overview</text>
          <text x={WIDTH - 40} y="44" textAnchor="end" fontSize="16" fontWeight="700" fill="#dbeafe">{selectedStation.label}</text>

          {card({ x: 40, y: 94, width: 510, height: 250 }, 'Station and Event', (
            textRows(58, 146, [
              ['Station', selectedStation.label],
              ['Record Time', firstWaveform.metadata.recordTime ?? '-'],
              ['Origin Time', firstWaveform.metadata.originTime ?? '-'],
              ['Station Lat/Lon', `${fmt(row?.stationLat, 6)}, ${fmt(row?.stationLon, 6)}`],
              ['Source Lat/Lon', `${fmt(row?.eventLat, 6)}, ${fmt(row?.eventLon, 6)}`],
              ['Source Depth', fmt(row?.depthKm, 3, ' km')],
              ['Sampling', `${formatNumber(firstWaveform.samplingHz, 4)} Hz`],
            ])
          ))}

          {card({ x: 575, y: 94, width: 400, height: 250 }, 'Ground Motion Strength', (
            <g>
              {textRows(593, 146, [
                ['JMA Intensity', selectedIntensity.available ? formatNumber(selectedIntensity.intensity, 3) : '-'],
                ['Shindo Class', selectedIntensity.available ? selectedIntensity.classLabel : '-'],
                ['PGA', pga ? `${formatNumber(pga.value, 4)} cm/s2 (${pga.component})` : '-'],
                ['PGV', pgv ? `${formatNumber(pgv.value, 4)} cm/s (${pgv.component})` : '-'],
                ['PGD', pgd ? `${formatNumber(pgd.value, 4)} cm (${pgd.component})` : '-'],
                ['Epicentral Dist.', fmt(row?.epicentralDistanceKm, 3, ' km')],
                ['Hypocentral Dist.', fmt(row?.hypocentralDistanceKm, 3, ' km')],
              ], 27)}
            </g>
          ))}

          {card({ x: 1000, y: 94, width: 560, height: 250 }, 'Observation Location', renderLocationPlot({ x: 1000, y: 94, width: 560, height: 250 }, selectedStation))}

          {renderWaveformPanel({ x: 40, y: 374, width: 730, height: 310 }, 'Acceleration Waveforms', selectedWaveforms, 'acceleration')}
          {renderWaveformPanel({ x: 830, y: 374, width: 730, height: 310 }, 'Velocity Waveforms', selectedWaveforms, 'velocity')}
          {renderResponsePanel({ x: 40, y: 714, width: 1520, height: 380 }, response, responseSettings)}
        </svg>
      </div>
    </div>
  );
}
