import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { downloadPng, downloadSvg } from '../export/exportImage';
import { downloadFigureMetadata } from '../export/figureMetadata';
import { safeFileName } from '../utils/file';
import { publicationSeriesStyle, type PublicationSeriesStyle } from '../visualization/chartStyle';
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
import { computePlotGeometry } from '../visualization/plotGeometry';

type AxisScale = 'linear' | 'log';

export interface ChartSeries {
  id?: string;
  name: string;
  x: number[];
  y: number[];
  style?: PublicationSeriesStyle;
  /** Hide auxiliary/raw series from the compact journal legend. */
  showInLegend?: boolean;
  /** Optional final printed line width for reference/raw series. */
  lineWidthPt?: number;
  opacity?: number;
}

interface SvgChartProps {
  title: string;
  xLabel: string;
  yLabel: string;
  series: ChartSeries[];
  xScale?: AxisScale;
  yScale?: AxisScale;
  width?: number;
  height?: number;
  fileNameBase?: string;
  domainX?: [number, number];
  domainY?: [number, number];
  tripartite?: boolean;
  showToolbarTitle?: boolean;
  annotations?: string[];
  description?: string;
  printWidthMm?: number;
  rasterDpi?: number;
  showEndpoints?: boolean;
  equalAspect?: boolean;
  showFigureTitle?: boolean;
  panelLabel?: string;
  showLegend?: boolean;
  cornerNote?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
}

interface Domain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

interface TripartiteGuideLabel {
  value: number;
  x: number;
  y: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
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

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(Math.abs(rawStep)));
  const error = Math.abs(rawStep) / power;
  const factor = error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1;
  const step = factor * power;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 0.5; value += step) {
    const rounded = Number(value.toPrecision(12));
    ticks.push(Math.abs(rounded) < step * 1e-10 ? 0 : rounded);
  }
  return ticks;
}

function logTicks(min: number, max: number): number[] {
  if (!finitePositive(min) || !finitePositive(max)) return [];
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

function isLogDecade(value: number): boolean {
  if (!finitePositive(value)) return false;
  const exponent = Math.round(Math.log10(value));
  return Math.abs(value / (10 ** exponent) - 1) < 1e-9;
}

function showLogTickLabel(value: number, min: number, max: number, availablePixels: number): boolean {
  if (!finitePositive(value) || !finitePositive(min) || !finitePositive(max)) return false;
  const spanDecades = Math.log10(max) - Math.log10(min);
  if (spanDecades <= 3.2) return true;
  if (!isLogDecade(value)) return false;
  const firstExponent = Math.ceil(Math.log10(min));
  const lastExponent = Math.floor(Math.log10(max));
  const exponentCount = Math.max(1, lastExponent - firstExponent + 1);
  const maximumLabels = Math.max(2, Math.floor(availablePixels / 42));
  const stride = Math.max(1, Math.ceil(exponentCount / maximumLabels));
  return (Math.round(Math.log10(value)) - firstExponent) % stride === 0;
}

function logDecadeValues(min: number, max: number): number[] {
  if (!finitePositive(min) || !finitePositive(max) || max < min) return [];
  const values: number[] = [];
  for (let exponent = Math.ceil(Math.log10(min)); exponent <= Math.floor(Math.log10(max)); exponent += 1) {
    values.push(10 ** exponent);
  }
  return values;
}

function computeDomain(
  series: ChartSeries[],
  xScale: AxisScale,
  yScale: AxisScale,
  domainX?: [number, number],
  domainY?: [number, number],
): Domain {
  let dataXMin = Infinity;
  let dataXMax = -Infinity;
  let dataYMin = Infinity;
  let dataYMax = -Infinity;

  for (const entry of series) {
    const count = Math.min(entry.x.length, entry.y.length);
    for (let index = 0; index < count; index += 1) {
      const x = entry.x[index];
      const y = entry.y[index];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (xScale === 'log' && x <= 0) continue;
      if (yScale === 'log' && y <= 0) continue;
      dataXMin = Math.min(dataXMin, x);
      dataXMax = Math.max(dataXMax, x);
      dataYMin = Math.min(dataYMin, y);
      dataYMax = Math.max(dataYMax, y);
    }
  }

  let xMin = domainX?.[0] ?? (Number.isFinite(dataXMin) ? dataXMin : xScale === 'log' ? 0.1 : 0);
  let xMax = domainX?.[1] ?? (Number.isFinite(dataXMax) ? dataXMax : 1);
  let yMin = domainY?.[0] ?? (Number.isFinite(dataYMin) ? dataYMin : yScale === 'log' ? 0.1 : -1);
  let yMax = domainY?.[1] ?? (Number.isFinite(dataYMax) ? dataYMax : 1);

  if (xScale === 'log' && (!finitePositive(xMin) || xMax <= xMin)) [xMin, xMax] = [0.1, 1];
  if (yScale === 'log' && (!finitePositive(yMin) || yMax <= yMin)) [yMin, yMax] = [0.1, 1];
  if (yScale === 'linear' && domainY === undefined) {
    const span = yMax - yMin || Math.max(Math.abs(yMax), 1);
    yMin -= span * 0.08;
    yMax += span * 0.08;
    if (yMin > 0) yMin = 0;
    if (yMax < 0) yMax = 0;
  }
  if (xMin === xMax) [xMin, xMax] = [xMin - 1, xMax + 1];
  if (yMin === yMax) [yMin, yMax] = [yMin - 1, yMax + 1];
  return { xMin, xMax, yMin, yMax };
}

export function SvgChart({
  title,
  xLabel,
  yLabel,
  series,
  xScale = 'linear',
  yScale = 'linear',
  width = 900,
  height = 430,
  fileNameBase,
  domainX,
  domainY,
  tripartite = false,
  showToolbarTitle = true,
  annotations = [],
  description,
  printWidthMm = 180,
  rasterDpi = JOURNAL_LINE_ART_DPI,
  showEndpoints = false,
  equalAspect = false,
  showFigureTitle = false,
  panelLabel,
  showLegend = true,
  cornerNote,
  caption,
  metadata,
}: SvgChartProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [grayscale, setGrayscale] = useState(false);
  const reactId = useId().replace(/:/g, '');
  const clipId = `plot-clip-${reactId}`;
  const titleId = `chart-title-${reactId}`;
  const descriptionId = `chart-description-${reactId}`;
  const domain = useMemo(
    () => computeDomain(series, xScale, yScale, domainX, domainY),
    [series, xScale, yScale, domainX, domainY],
  );

  const visibleAnnotations = annotations;
  const legendSeries = showLegend ? series.filter((entry) => entry.showInLegend !== false) : [];
  const legendColumns = Math.max(1, Math.min(legendSeries.length || 1, width >= 820 ? 4 : width >= 620 ? 3 : 2));
  const legendRows = legendSeries.length > 0 ? Math.ceil(legendSeries.length / legendColumns) : 0;
  const legendTop = showFigureTitle ? 46 : panelLabel ? 36 : 22;
  const basePadding = {
    left: 82,
    right: 28,
    top: legendTop + legendRows * 22 + (legendRows > 0 ? 8 : 0),
    bottom: visibleAnnotations.length > 0 ? 92 + (visibleAnnotations.length - 1) * 17 : 66,
  };
  const geometry = computePlotGeometry(width, height, basePadding, equalAspect);
  const plotWidth = geometry.width;
  const plotHeight = geometry.height;
  const padding = {
    ...basePadding,
    left: geometry.left,
    top: geometry.top,
  };
  const plotBottom = padding.top + plotHeight;

  const scaleX = (value: number): number => {
    if (xScale === 'log') {
      return padding.left + ((Math.log10(value) - Math.log10(domain.xMin)) / (Math.log10(domain.xMax) - Math.log10(domain.xMin))) * plotWidth;
    }
    return padding.left + ((value - domain.xMin) / (domain.xMax - domain.xMin)) * plotWidth;
  };
  const scaleY = (value: number): number => {
    if (yScale === 'log') {
      return padding.top + plotHeight - ((Math.log10(value) - Math.log10(domain.yMin)) / (Math.log10(domain.yMax) - Math.log10(domain.yMin))) * plotHeight;
    }
    return padding.top + plotHeight - ((value - domain.yMin) / (domain.yMax - domain.yMin)) * plotHeight;
  };

  const xTicks = xScale === 'log' ? logTicks(domain.xMin, domain.xMax) : niceTicks(domain.xMin, domain.xMax, 7);
  const yTicks = yScale === 'log' ? logTicks(domain.yMin, domain.yMax) : niceTicks(domain.yMin, domain.yMax, 6);
  const showTripartite = tripartite && xScale === 'log' && yScale === 'log';
  const accelerationGuides = showTripartite
    ? logDecadeValues((2 * Math.PI * domain.yMin) / domain.xMax, (2 * Math.PI * domain.yMax) / domain.xMin)
    : [];
  const displacementGuides = showTripartite
    ? logDecadeValues((domain.yMin * domain.xMin) / (2 * Math.PI), (domain.yMax * domain.xMax) / (2 * Math.PI))
    : [];

  const guidePath = (points: Array<[number, number]>): string => points
    .filter(([x, y]) => finitePositive(x) && finitePositive(y))
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${scaleX(x).toFixed(2)},${scaleY(y).toFixed(2)}`)
    .join(' ');
  const insideDomain = (x: number, y: number): boolean => (
    x >= domain.xMin && x <= domain.xMax && y >= domain.yMin && y <= domain.yMax
  );
  const logXAtFraction = (fraction: number): number => (
    10 ** (Math.log10(domain.xMin) + fraction * Math.log10(domain.xMax / domain.xMin))
  );
  const safeTripartiteLabels = (
    values: readonly number[],
    yFor: (value: number, x: number) => number,
    fractions: readonly number[],
  ): TripartiteGuideLabel[] => values.flatMap((value) => {
    for (const fraction of fractions) {
      const x = logXAtFraction(fraction);
      const y = yFor(value, x);
      if (!insideDomain(x, y)) continue;
      const px = scaleX(x);
      const py = scaleY(y);
      if (
        px >= padding.left + 44
        && px <= padding.left + plotWidth - 44
        && py >= padding.top + 22
        && py <= plotBottom - 22
      ) return [{ value, x: px, y: py }];
    }
    return [];
  });
  const accelerationLabels = showTripartite
    ? safeTripartiteLabels(accelerationGuides, (value, x) => (value * x) / (2 * Math.PI), [0.2, 0.35, 0.5, 0.65, 0.8])
    : [];
  const unfilteredDisplacementLabels = showTripartite
    ? safeTripartiteLabels(displacementGuides, (value, x) => (value * 2 * Math.PI) / x, [0.8, 0.65, 0.5, 0.35, 0.2])
    : [];
  const displacementLabels = unfilteredDisplacementLabels.filter((candidate) => (
    !accelerationLabels.some((occupied) => {
      const dx = candidate.x - occupied.x;
      const dy = candidate.y - occupied.y;
      return dx * dx + dy * dy < 72 * 72;
    })
  ));

  const paths = series.map((entry, seriesIndex) => {
    const parts: string[] = [];
    const segments = downsampleSegments(entry.x, entry.y, 2400, (x, y) => (
      Number.isFinite(x) && Number.isFinite(y)
      && (xScale !== 'log' || x > 0)
      && (yScale !== 'log' || y > 0)
    ));
    segments.forEach((sampled) => {
      for (let index = 0; index < sampled.x.length; index += 1) {
        parts.push(`${index === 0 ? 'M' : 'L'}${scaleX(sampled.x[index]).toFixed(2)},${scaleY(sampled.y[index]).toFixed(2)}`);
      }
    });
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    const first = firstSegment && firstSegment.x.length > 0
      ? { x: scaleX(firstSegment.x[0]), y: scaleY(firstSegment.y[0]) }
      : undefined;
    const lastIndex = lastSegment ? lastSegment.x.length - 1 : -1;
    const last = lastSegment && lastIndex >= 0
      ? { x: scaleX(lastSegment.x[lastIndex]), y: scaleY(lastSegment.y[lastIndex]) }
      : undefined;
    return {
      id: entry.id,
      name: entry.name,
      d: parts.join(' '),
      style: entry.style ?? publicationSeriesStyle(seriesIndex),
      first,
      last,
      opacity: entry.opacity,
      lineWidthPt: entry.lineWidthPt,
    };
  });

  const base = safeFileName(fileNameBase || title || 'chart');
  const panelLabelFont = pointsToUserUnits(JOURNAL_PANEL_FONT_PT, width, printWidthMm);
  const axisFont = pointsToUserUnits(JOURNAL_AXIS_FONT_PT, width, printWidthMm);
  const supplementalFont = pointsToUserUnits(JOURNAL_SUPPORT_FONT_PT, width, printWidthMm);
  const titleFont = pointsToUserUnits(12, width, printWidthMm);
  const superscriptFont = pointsToUserUnits(7, width, printWidthMm);
  const guideLine = pointsToUserUnits(JOURNAL_MIN_LINE_PT, width, printWidthMm);
  const axisLine = pointsToUserUnits(0.6, width, printWidthMm);
  const dataLine = pointsToUserUnits(JOURNAL_DATA_LINE_PT, width, printWidthMm);
  const journalStyle = {
    '--journal-axis-font': `${axisFont}px`,
    '--journal-supplemental-font': `${supplementalFont}px`,
    '--journal-title-font': `${titleFont}px`,
    '--journal-guide-line': `${guideLine}px`,
    '--journal-axis-line': `${axisLine}px`,
    '--journal-data-line': `${dataLine}px`,
  } as CSSProperties;
  const accessibleDescription = description
    ?? `${title}. X axis: ${xLabel}. Y axis: ${yLabel}. Series: ${series.map((entry) => entry.name).join(', ') || 'none'}.`;
  const exportMetadata = {
    schema: 'strong-motion-figure-export/1.0',
    title,
    description: accessibleDescription,
    caption,
    axes: { x: xLabel, y: yLabel, xScale, yScale },
    domain,
    equalAspect,
    series: series.map((entry) => ({ name: entry.name, shownInLegend: entry.showInLegend !== false })),
    intendedPrintWidthMm: printWidthMm,
    pngDpi: rasterDpi,
    annotations: visibleAnnotations,
    analysis: metadata,
  };

  return (
    <figure className={`chart-card publication-figure journal-figure${grayscale ? ' grayscale-preview' : ''}`} data-export-base={base} tabIndex={0} aria-label={`${title} figure; horizontally scrollable on narrow screens`}>
      <div className="chart-toolbar">
        <div className="figure-toolbar-label">
          <span className="figure-kicker">Publication figure</span>
          {showToolbarTitle && <strong>{title}</strong>}
        </div>
        <div className="button-row compact">
          <button
            type="button"
            className="secondary export-button"
            aria-pressed={grayscale}
            onClick={() => setGrayscale((value) => !value)}
          >
            {grayscale ? 'Colour preview' : 'Grayscale check'}
          </button>
          <button
            type="button"
            className="secondary export-button"
            aria-label={`Download ${title} as a portable SVG using system fonts`}
            onClick={() => svgRef.current && downloadSvg(svgRef.current, `${base}.svg`, { widthMm: printWidthMm })}
          >
            SVG · vector
          </button>
          <button
            type="button"
            className="secondary export-button"
            aria-label={`Download ${title} as a ${rasterDpi} dpi PNG`}
            onClick={() => svgRef.current && void downloadPng(svgRef.current, `${base}.png`, { dpi: rasterDpi, widthMm: printWidthMm })}
          >
            PNG · {rasterDpi} dpi
          </button>
          {metadata && (
            <button
              type="button"
              className="secondary export-button"
              aria-label={`Download reproducibility metadata for ${title}`}
              onClick={() => downloadFigureMetadata(base, exportMetadata)}
            >
              Methods · JSON
            </button>
          )}
        </div>
      </div>
      <span className="mobile-scroll-hint" aria-hidden="true">Swipe horizontally to inspect the full figure →</span>
      <svg
        ref={svgRef}
        className="publication-chart"
        style={journalStyle}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{title}</title>
        <desc id={descriptionId}>{accessibleDescription}</desc>
        <metadata>{JSON.stringify(exportMetadata)}</metadata>
        <defs>
          <clipPath id={clipId}>
            <rect x={padding.left} y={padding.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={width} height={height} className="chart-background" />
        {showFigureTitle && <text x={width / 2} y="24" textAnchor="middle" className="chart-title">{title}</text>}
        {panelLabel && (
          <text x={padding.left} y="24" className="journal-panel-label" fontSize={panelLabelFont} fontWeight="700">{panelLabel}</text>
        )}

        {legendSeries.length > 0 && <g transform={`translate(${padding.left}, ${legendTop})`} aria-label="Legend">
          {legendSeries.map((entry, index) => {
            const row = Math.floor(index / legendColumns);
            const column = index % legendColumns;
            const columnWidth = plotWidth / legendColumns;
            const style = entry.style ?? publicationSeriesStyle(index);
            return (
              <g key={entry.id ?? `${entry.name}-${index}`} transform={`translate(${column * columnWidth}, ${row * 19})`}>
                <line
                  x1="0"
                  y1="0"
                  x2="27"
                  y2="0"
                  className="series-line"
                  stroke={style.color}
                  strokeDasharray={style.dashArray}
                />
                <text x="34" y="4" className="legend-label">{entry.name}</text>
              </g>
            );
          })}
        </g>}

        {showTripartite && (
          <g clipPath={`url(#${clipId})`}>
            {xTicks.map((period) => (
              <line
                key={`trip-period-${period}`}
                x1={scaleX(period)}
                y1={padding.top}
                x2={scaleX(period)}
                y2={plotBottom}
                className="tripartite-axis-grid"
              />
            ))}
            {yTicks.map((velocity) => (
              <line
                key={`trip-velocity-${velocity}`}
                x1={padding.left}
                y1={scaleY(velocity)}
                x2={padding.left + plotWidth}
                y2={scaleY(velocity)}
                className="tripartite-axis-grid"
              />
            ))}
            {accelerationGuides.map((acceleration) => (
              <path
                key={`trip-acceleration-${acceleration}`}
                d={guidePath([[domain.xMin, (acceleration * domain.xMin) / (2 * Math.PI)], [domain.xMax, (acceleration * domain.xMax) / (2 * Math.PI)]])}
                className="tripartite-grid-line"
              />
            ))}
            {displacementGuides.map((displacement) => (
              <path
                key={`trip-displacement-${displacement}`}
                d={guidePath([[domain.xMin, (displacement * 2 * Math.PI) / domain.xMin], [domain.xMax, (displacement * 2 * Math.PI) / domain.xMax]])}
                className="tripartite-grid-line"
              />
            ))}
          </g>
        )}

        {showTripartite && (
          <g>
            {accelerationLabels.map((guide, guideIndex) => {
              const exponent = Math.round(Math.log10(guide.value));
              return (
                <text key={`acc-label-${exponent}`} x={guide.x} y={guide.y} className="tripartite-label" textAnchor="middle" transform={`rotate(-38 ${guide.x} ${guide.y})`}>
                  10<tspan baselineShift="super" fontSize={superscriptFont}>{exponent}</tspan>{guideIndex === Math.floor(accelerationLabels.length / 2) ? ' cm/s²' : ''}
                </text>
              );
            })}
            {displacementLabels.map((guide, guideIndex) => {
              const exponent = Math.round(Math.log10(guide.value));
              return (
                <text key={`disp-label-${exponent}`} x={guide.x} y={guide.y} className="tripartite-label" textAnchor="middle" transform={`rotate(38 ${guide.x} ${guide.y})`}>
                  10<tspan baselineShift="super" fontSize={superscriptFont}>{exponent}</tspan>{guideIndex === Math.floor(displacementLabels.length / 2) ? ' cm' : ''}
                </text>
              );
            })}
          </g>
        )}

        {xTicks.map((tick) => {
          const x = scaleX(tick);
          const major = xScale === 'linear' || isLogDecade(tick);
          const showGrid = xScale === 'linear' || Math.log10(domain.xMax / domain.xMin) <= 6 || major;
          const showLabel = xScale === 'linear' || showLogTickLabel(tick, domain.xMin, domain.xMax, plotWidth);
          return (
            <g key={`x-${tick}`}>
              {!showTripartite && showGrid && <line x1={x} y1={padding.top} x2={x} y2={plotBottom} className={`grid-line ${major ? 'major' : 'minor'}`} />}
              {showGrid && <line x1={x} y1={plotBottom} x2={x} y2={plotBottom + 5} className="axis-tick" />}
              {showLabel && <text x={x} y={plotBottom + 21} textAnchor="middle" className="tick-label">{formatTick(tick)}</text>}
            </g>
          );
        })}
        {yTicks.map((tick) => {
          const y = scaleY(tick);
          const major = yScale === 'linear' || isLogDecade(tick);
          const zero = yScale === 'linear' && Math.abs(tick) < Number.EPSILON;
          const showGrid = yScale === 'linear' || Math.log10(domain.yMax / domain.yMin) <= 6 || major;
          const showLabel = yScale === 'linear' || showLogTickLabel(tick, domain.yMin, domain.yMax, plotHeight);
          return (
            <g key={`y-${tick}`}>
              {!showTripartite && showGrid && <line x1={padding.left} y1={y} x2={padding.left + plotWidth} y2={y} className={`grid-line ${major ? 'major' : 'minor'} ${zero ? 'zero' : ''}`} />}
              {showGrid && <line x1={padding.left - 5} y1={y} x2={padding.left} y2={y} className="axis-tick" />}
              {showLabel && <text x={padding.left - 10} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>}
            </g>
          );
        })}

        <rect x={padding.left} y={padding.top} width={plotWidth} height={plotHeight} className="plot-border" />
        <g clipPath={`url(#${clipId})`}>
          {paths.map((path, index) => (
            <path
              key={path.id ?? `${path.name}-${index}`}
              d={path.d}
              className="series-line"
              stroke={path.style.color}
              strokeDasharray={path.style.dashArray}
              style={{
                strokeOpacity: path.opacity,
                // Inline style intentionally overrides the shared CSS default;
                // raw/reference traces can therefore retain their stated final-size width.
                strokeWidth: path.lineWidthPt ? pointsToUserUnits(path.lineWidthPt, width, printWidthMm) : undefined,
              }}
            />
          ))}
          {showEndpoints && paths.map((path, index) => (
            <g key={`endpoints-${path.id ?? `${path.name}-${index}`}`}>
              {path.first && <circle cx={path.first.x} cy={path.first.y} r="4" fill="#ffffff" stroke={path.style.color} strokeWidth="1.5" />}
              {path.last && <circle cx={path.last.x} cy={path.last.y} r="4" fill={path.style.color} stroke="#ffffff" strokeWidth="1" />}
            </g>
          ))}
        </g>

        {cornerNote && (
          <text
            x={padding.left + plotWidth - 8}
            y={padding.top + supplementalFont + 5}
            textAnchor="end"
            className="chart-corner-note"
          >
            {cornerNote}
          </text>
        )}

        <text x={padding.left + plotWidth / 2} y={plotBottom + 48} textAnchor="middle" className="axis-label">{xLabel}</text>
        <text x="19" y={padding.top + plotHeight / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 19 ${padding.top + plotHeight / 2})`}>{yLabel}</text>

        {visibleAnnotations.length > 0 && (
          <g transform={`translate(${padding.left}, ${plotBottom + 72})`}>
            {visibleAnnotations.map((annotation, index) => {
              const style = series[index]?.style ?? publicationSeriesStyle(index);
              return (
                <g key={`${annotation}-${index}`} transform={`translate(0, ${index * 17})`}>
                  <line x1="0" y1="-4" x2="24" y2="-4" className="series-line" stroke={style.color} strokeDasharray={style.dashArray} />
                  <text x="32" y="0" className="chart-annotation">{annotation}</text>
                </g>
              );
            })}
          </g>
        )}
      </svg>
      <figcaption className="chart-caption">
        {caption ?? `Journal working size: ${printWidthMm} mm. Vector SVG and true-size ${rasterDpi} dpi PNG; series use both colour and line pattern.`}
      </figcaption>
    </figure>
  );
}
