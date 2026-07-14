import { useId, useMemo, useRef } from 'react';
import { downloadPng, downloadSvg } from '../export/exportImage';
import { safeFileName } from '../utils/file';
import { publicationSeriesStyle, type PublicationSeriesStyle } from '../visualization/chartStyle';
import { downsampleSegments } from '../visualization/downsample';
import { computePlotGeometry } from '../visualization/plotGeometry';

type AxisScale = 'linear' | 'log';

export interface ChartSeries {
  id?: string;
  name: string;
  x: number[];
  y: number[];
  style?: PublicationSeriesStyle;
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
  showEndpoints?: boolean;
  equalAspect?: boolean;
}

interface Domain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
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
  for (let value = start; value <= max + step * 0.5; value += step) ticks.push(Number(value.toPrecision(12)));
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

function logMinorValues(min: number, max: number): number[] {
  if (!finitePositive(min) || !finitePositive(max)) return [];
  const values: number[] = [];
  const startExp = Math.floor(Math.log10(min));
  const endExp = Math.ceil(Math.log10(max));
  for (let exp = startExp; exp <= endExp; exp += 1) {
    for (let multiplier = 1; multiplier < 10; multiplier += 1) {
      const value = multiplier * 10 ** exp;
      if (value >= min * 0.999 && value <= max * 1.001) values.push(value);
    }
  }
  return values;
}

function powerLabel(exponent: number): string {
  return `10^${exponent}`;
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
  showToolbarTitle = false,
  annotations = [],
  description,
  printWidthMm = 183,
  showEndpoints = false,
  equalAspect = false,
}: SvgChartProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reactId = useId().replace(/:/g, '');
  const clipId = `plot-clip-${reactId}`;
  const titleId = `chart-title-${reactId}`;
  const descriptionId = `chart-description-${reactId}`;
  const domain = useMemo(
    () => computeDomain(series, xScale, yScale, domainX, domainY),
    [series, xScale, yScale, domainX, domainY],
  );

  const visibleAnnotations = annotations;
  const legendColumns = Math.max(1, Math.min(series.length, width >= 820 ? 4 : width >= 620 ? 3 : 2));
  const legendRows = Math.max(1, Math.ceil(series.length / legendColumns));
  const basePadding = {
    left: 82,
    right: 28,
    top: 54 + legendRows * 19,
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
  const tripartiteScaleValues = showTripartite ? logMinorValues(domain.yMin / 1000, domain.yMax * 1000) : [];
  const tripartitePeriodValues = showTripartite ? logMinorValues(domain.xMin, domain.xMax) : [];
  const accelerationLabelExponents = showTripartite
    ? Array.from(
      { length: Math.max(0, Math.ceil(Math.log10(domain.yMax)) + 2 - Math.floor(Math.log10(domain.yMin)) + 1) },
      (_, index) => Math.floor(Math.log10(domain.yMin)) + index,
    )
    : [];
  const displacementLabelExponents = showTripartite
    ? Array.from(
      { length: Math.max(0, Math.ceil(Math.log10(domain.yMax)) - 1 - (Math.floor(Math.log10(domain.yMin)) - 2) + 1) },
      (_, index) => Math.floor(Math.log10(domain.yMin)) - 2 + index,
    )
    : [];

  const guidePath = (points: Array<[number, number]>): string => points
    .filter(([x, y]) => finitePositive(x) && finitePositive(y))
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${scaleX(x).toFixed(2)},${scaleY(y).toFixed(2)}`)
    .join(' ');
  const insideDomain = (x: number, y: number): boolean => (
    x >= domain.xMin && x <= domain.xMax && y >= domain.yMin && y <= domain.yMax
  );

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
    return { id: entry.id, name: entry.name, d: parts.join(' '), style: entry.style ?? publicationSeriesStyle(seriesIndex), first, last };
  });

  const base = safeFileName(fileNameBase || title || 'chart');
  const accessibleDescription = description
    ?? `${title}. X axis: ${xLabel}. Y axis: ${yLabel}. Series: ${series.map((entry) => entry.name).join(', ') || 'none'}.`;

  return (
    <figure className="chart-card publication-figure" tabIndex={0} aria-label={`${title} figure; horizontally scrollable on narrow screens`}>
      <div className="chart-toolbar">
        <div className="figure-toolbar-label">
          <span className="figure-kicker">Publication figure</span>
          {showToolbarTitle && <strong>{title}</strong>}
        </div>
        <div className="button-row compact">
          <button
            type="button"
            className="secondary export-button"
            aria-label={`Download ${title} as a self-contained SVG`}
            onClick={() => svgRef.current && downloadSvg(svgRef.current, `${base}.svg`, { widthMm: printWidthMm })}
          >
            SVG · vector
          </button>
          <button
            type="button"
            className="secondary export-button"
            aria-label={`Download ${title} as a 300 dpi PNG`}
            onClick={() => svgRef.current && void downloadPng(svgRef.current, `${base}.png`, { dpi: 300, widthMm: printWidthMm })}
          >
            PNG · 300 dpi
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="publication-chart"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{title}</title>
        <desc id={descriptionId}>{accessibleDescription}</desc>
        <metadata>{JSON.stringify({
          title,
          axes: { x: xLabel, y: yLabel, xScale, yScale },
          domain,
          equalAspect,
          series: series.map((entry) => entry.name),
          intendedPrintWidthMm: printWidthMm,
          pngDpi: 300,
        })}</metadata>
        <defs>
          <clipPath id={clipId}>
            <rect x={padding.left} y={padding.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={width} height={height} className="chart-background" />
        <text x={width / 2} y="24" textAnchor="middle" className="chart-title">{title}</text>

        <g transform={`translate(${padding.left}, 46)`} aria-label="Legend">
          {series.map((entry, index) => {
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
        </g>

        {showTripartite && (
          <g clipPath={`url(#${clipId})`}>
            {tripartiteScaleValues.map((value) => (
              <g key={`trip-${value}`}>
                <path d={guidePath([[domain.xMin, (value * domain.xMin) / (2 * Math.PI)], [domain.xMax, (value * domain.xMax) / (2 * Math.PI)]])} className="tripartite-grid-line" />
                <path d={guidePath([[domain.xMin, (value * 2 * Math.PI) / domain.xMin], [domain.xMax, (value * 2 * Math.PI) / domain.xMax]])} className="tripartite-grid-line" />
                <path d={guidePath([[domain.xMin, value], [domain.xMax, value]])} className="tripartite-grid-line" />
              </g>
            ))}
            {tripartitePeriodValues.map((period) => (
              <line
                key={`trip-period-${period}`}
                x1={scaleX(period)}
                y1={padding.top}
                x2={scaleX(period)}
                y2={plotBottom}
                className="tripartite-grid-line"
              />
            ))}
          </g>
        )}

        {showTripartite && (
          <g>
            {accelerationLabelExponents.map((exponent) => {
              const acceleration = 10 ** exponent;
              let x = domain.xMax;
              let y = (acceleration * x) / (2 * Math.PI);
              if (y > domain.yMax) {
                y = domain.yMax / 1.08;
                x = (2 * Math.PI * y) / acceleration;
              }
              if (!insideDomain(x, y)) return null;
              const px = scaleX(x);
              const py = scaleY(y);
              return (
                <text key={`acc-label-${exponent}`} x={px} y={py} className="tripartite-label" textAnchor="middle" transform={`rotate(-38 ${px} ${py})`}>
                  {exponent === accelerationLabelExponents[accelerationLabelExponents.length - 1] ? `${powerLabel(exponent)} cm/s²` : powerLabel(exponent)}
                </text>
              );
            })}
            {displacementLabelExponents.map((exponent) => {
              const displacement = 10 ** exponent;
              let x = domain.xMin;
              let y = (displacement * 2 * Math.PI) / x;
              if (y > domain.yMax) {
                y = domain.yMax / 1.06;
                x = (2 * Math.PI * displacement) / y;
              }
              if (!insideDomain(x, y)) return null;
              const px = scaleX(x);
              const py = scaleY(y);
              return (
                <text key={`disp-label-${exponent}`} x={px} y={py} className="tripartite-label" textAnchor="middle" transform={`rotate(38 ${px} ${py})`}>
                  {exponent === displacementLabelExponents[displacementLabelExponents.length - 1] ? `${powerLabel(exponent)} cm` : powerLabel(exponent)}
                </text>
              );
            })}
          </g>
        )}

        {xTicks.map((tick) => {
          const x = scaleX(tick);
          const major = xScale === 'linear' || isLogDecade(tick);
          return (
            <g key={`x-${tick}`}>
              {!showTripartite && <line x1={x} y1={padding.top} x2={x} y2={plotBottom} className={`grid-line ${major ? 'major' : 'minor'}`} />}
              <line x1={x} y1={plotBottom} x2={x} y2={plotBottom + 5} className="axis-tick" />
              <text x={x} y={plotBottom + 21} textAnchor="middle" className="tick-label">{formatTick(tick)}</text>
            </g>
          );
        })}
        {yTicks.map((tick) => {
          const y = scaleY(tick);
          const major = yScale === 'linear' || isLogDecade(tick);
          const zero = yScale === 'linear' && Math.abs(tick) < Number.EPSILON;
          return (
            <g key={`y-${tick}`}>
              {!showTripartite && <line x1={padding.left} y1={y} x2={padding.left + plotWidth} y2={y} className={`grid-line ${major ? 'major' : 'minor'} ${zero ? 'zero' : ''}`} />}
              <line x1={padding.left - 5} y1={y} x2={padding.left} y2={y} className="axis-tick" />
              <text x={padding.left - 10} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>
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
            />
          ))}
          {showEndpoints && paths.map((path, index) => (
            <g key={`endpoints-${path.id ?? `${path.name}-${index}`}`}>
              {path.first && <circle cx={path.first.x} cy={path.first.y} r="4" fill="#ffffff" stroke={path.style.color} strokeWidth="1.5" />}
              {path.last && <circle cx={path.last.x} cy={path.last.y} r="4" fill={path.style.color} stroke="#ffffff" strokeWidth="1" />}
            </g>
          ))}
        </g>

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
        Self-contained vector SVG and {printWidthMm} mm-wide, 300 dpi PNG. Series use both colour and line pattern.
      </figcaption>
    </figure>
  );
}
