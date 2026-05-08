import { useId, useMemo, useRef } from 'react';
import { downloadPng, downloadSvg } from '../export/exportImage';
import { safeFileName } from '../utils/file';

type AxisScale = 'linear' | 'log';

export interface ChartSeries {
  name: string;
  x: number[];
  y: number[];
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
}

interface Domain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

const PADDING = { left: 74, right: 26, top: 42, bottom: 58 };

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
    ticks.push(Number(value.toPrecision(12)));
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
  const xs: number[] = [];
  const ys: number[] = [];

  for (const s of series) {
    const n = Math.min(s.x.length, s.y.length);
    for (let i = 0; i < n; i += 1) {
      const x = s.x[i];
      const y = s.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (xScale === 'log' && x <= 0) continue;
      if (yScale === 'log' && y <= 0) continue;
      xs.push(x);
      ys.push(y);
    }
  }

  const xMin = domainX?.[0] ?? (xs.length ? Math.min(...xs) : xScale === 'log' ? 0.1 : 0);
  const xMax = domainX?.[1] ?? (xs.length ? Math.max(...xs) : 1);
  let yMin = domainY?.[0] ?? (ys.length ? Math.min(...ys) : yScale === 'log' ? 0.1 : -1);
  let yMax = domainY?.[1] ?? (ys.length ? Math.max(...ys) : 1);

  if (yScale === 'linear' && domainY === undefined) {
    const span = yMax - yMin || Math.max(Math.abs(yMax), 1);
    yMin -= span * 0.08;
    yMax += span * 0.08;
    if (yMin > 0) yMin = 0;
    if (yMax < 0) yMax = 0;
  }

  let finalXMin = xMin;
  let finalXMax = xMax;
  if (finalXMin === finalXMax) {
    finalXMin -= 1;
    finalXMax += 1;
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }

  return { xMin: finalXMin, xMax: finalXMax, yMin, yMax };
}

function downsample(x: number[], y: number[], maxPoints = 2400): { x: number[]; y: number[] } {
  const n = Math.min(x.length, y.length);
  if (n <= maxPoints) return { x: x.slice(0, n), y: y.slice(0, n) };
  const step = Math.ceil(n / maxPoints);
  const outX: number[] = [];
  const outY: number[] = [];
  for (let i = 0; i < n; i += step) {
    outX.push(x[i]);
    outY.push(y[i]);
  }
  if (outX[outX.length - 1] !== x[n - 1]) {
    outX.push(x[n - 1]);
    outY.push(y[n - 1]);
  }
  return { x: outX, y: outY };
}

export function SvgChart({
  title,
  xLabel,
  yLabel,
  series,
  xScale = 'linear',
  yScale = 'linear',
  width = 900,
  height = 340,
  fileNameBase,
  domainX,
  domainY,
  tripartite = false,
  showToolbarTitle = false,
  annotations = [],
}: SvgChartProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reactId = useId();
  const clipId = `plot-clip-${reactId.replace(/:/g, '')}`;
  const domain = useMemo(() => computeDomain(series, xScale, yScale, domainX, domainY), [series, xScale, yScale, domainX, domainY]);

  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;

  const scaleX = (value: number): number => {
    if (xScale === 'log') {
      return PADDING.left + ((Math.log10(value) - Math.log10(domain.xMin)) / (Math.log10(domain.xMax) - Math.log10(domain.xMin))) * plotWidth;
    }
    return PADDING.left + ((value - domain.xMin) / (domain.xMax - domain.xMin)) * plotWidth;
  };

  const scaleY = (value: number): number => {
    if (yScale === 'log') {
      return PADDING.top + plotHeight - ((Math.log10(value) - Math.log10(domain.yMin)) / (Math.log10(domain.yMax) - Math.log10(domain.yMin))) * plotHeight;
    }
    return PADDING.top + plotHeight - ((value - domain.yMin) / (domain.yMax - domain.yMin)) * plotHeight;
  };

  const xTicks = xScale === 'log' ? logTicks(domain.xMin, domain.xMax) : niceTicks(domain.xMin, domain.xMax, 7);
  const yTicks = yScale === 'log' ? logTicks(domain.yMin, domain.yMax) : niceTicks(domain.yMin, domain.yMax, 6);
  const showTripartite = tripartite && xScale === 'log' && yScale === 'log';
  const tripartiteScaleValues = showTripartite
    ? logMinorValues(domain.yMin / 1000, domain.yMax * 1000)
    : [];
  const tripartitePeriodValues = showTripartite
    ? logMinorValues(domain.xMin, domain.xMax)
    : [];
  const accelerationLabelExponents = showTripartite
    ? Array.from(
      { length: Math.max(0, Math.ceil(Math.log10(domain.yMax)) + 2 - Math.floor(Math.log10(domain.yMin)) + 1) },
      (_, i) => Math.floor(Math.log10(domain.yMin)) + i,
    )
    : [];
  const displacementLabelExponents = showTripartite
    ? Array.from(
      { length: Math.max(0, Math.ceil(Math.log10(domain.yMax)) - 1 - (Math.floor(Math.log10(domain.yMin)) - 2) + 1) },
      (_, i) => Math.floor(Math.log10(domain.yMin)) - 2 + i,
    )
    : [];

  const linePath = (points: Array<[number, number]>): string => points
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0)
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${scaleX(x).toFixed(2)},${scaleY(y).toFixed(2)}`)
    .join(' ');

  const insideDomain = (x: number, y: number): boolean => (
    x >= domain.xMin
    && x <= domain.xMax
    && y >= domain.yMin
    && y <= domain.yMax
  );

  const paths = series.map((s, seriesIndex) => {
    const sampled = downsample(s.x, s.y);
    const parts: string[] = [];
    let started = false;

    for (let i = 0; i < sampled.x.length; i += 1) {
      const x = sampled.x[i];
      const y = sampled.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (xScale === 'log' && x <= 0) continue;
      if (yScale === 'log' && y <= 0) continue;
      const px = scaleX(x);
      const py = scaleY(y);
      parts.push(`${started ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`);
      started = true;
    }

    return { name: s.name, d: parts.join(' '), className: `series-line series-${seriesIndex % 8}` };
  });

  const base = safeFileName(fileNameBase || title || 'chart');
  const visibleAnnotations = annotations.slice(0, 6);

  return (
    <div className="chart-card">
      <div className="chart-toolbar">
        {showToolbarTitle ? <strong>{title}</strong> : <span aria-hidden="true" />}
        <div className="button-row compact">
          <button type="button" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${base}.svg`)}>SVG</button>
          <button type="button" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${base}.png`)}>PNG</button>
        </div>
      </div>
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PADDING.left} y={PADDING.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={width} height={height} className="chart-background" />
        <text x={width / 2} y="22" textAnchor="middle" className="chart-title">{title}</text>

        {showTripartite && (
          <g clipPath={`url(#${clipId})`}>
            {tripartiteScaleValues.map((value) => {
              const accelerationPath = linePath([
                [domain.xMin, (value * domain.xMin) / (2 * Math.PI)],
                [domain.xMax, (value * domain.xMax) / (2 * Math.PI)],
              ]);
              const displacementPath = linePath([
                [domain.xMin, (value * 2 * Math.PI) / domain.xMin],
                [domain.xMax, (value * 2 * Math.PI) / domain.xMax],
              ]);
              const velocityPath = linePath([
                [domain.xMin, value],
                [domain.xMax, value],
              ]);

              return (
                <g key={`trip-${value}`}>
                  <path d={accelerationPath} className="tripartite-grid-line" />
                  <path d={displacementPath} className="tripartite-grid-line" />
                  <path d={velocityPath} className="tripartite-grid-line" />
                </g>
              );
            })}

            {tripartitePeriodValues.map((period) => (
              <line
                key={`trip-period-${period}`}
                x1={scaleX(period)}
                y1={PADDING.top}
                x2={scaleX(period)}
                y2={PADDING.top + plotHeight}
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
                <text
                  key={`acc-label-${exponent}`}
                  x={px}
                  y={py}
                  className="tripartite-label"
                  textAnchor="middle"
                  transform={`rotate(-38 ${px} ${py})`}
                >
                  {exponent === accelerationLabelExponents[accelerationLabelExponents.length - 1]
                    ? `${powerLabel(exponent)} cm/s^2`
                    : powerLabel(exponent)}
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
                <text
                  key={`disp-label-${exponent}`}
                  x={px}
                  y={py}
                  className="tripartite-label"
                  textAnchor="middle"
                  transform={`rotate(38 ${px} ${py})`}
                >
                  {exponent === displacementLabelExponents[displacementLabelExponents.length - 1]
                    ? `${powerLabel(exponent)} cm`
                    : powerLabel(exponent)}
                </text>
              );
            })}
          </g>
        )}

        {xTicks.map((tick) => {
          const x = scaleX(tick);
          return (
            <g key={`x-${tick}`}>
              {!showTripartite && <line x1={x} y1={PADDING.top} x2={x} y2={PADDING.top + plotHeight} className="grid-line" />}
              <text x={x} y={PADDING.top + plotHeight + 20} textAnchor="middle" className="tick-label">{formatTick(tick)}</text>
            </g>
          );
        })}

        {yTicks.map((tick) => {
          const y = scaleY(tick);
          return (
            <g key={`y-${tick}`}>
              {!showTripartite && <line x1={PADDING.left} y1={y} x2={PADDING.left + plotWidth} y2={y} className="grid-line" />}
              <text x={PADDING.left - 10} y={y + 4} textAnchor="end" className="tick-label">{formatTick(tick)}</text>
            </g>
          );
        })}

        <rect x={PADDING.left} y={PADDING.top} width={plotWidth} height={plotHeight} className="plot-border" />
        <g clipPath={`url(#${clipId})`}>
          {paths.map((path) => <path key={path.name} d={path.d} className={path.className} />)}
        </g>

        {visibleAnnotations.length > 0 && (
          <g>
            {visibleAnnotations.map((annotation, index) => (
              <text
                key={annotation}
                x={PADDING.left + plotWidth - 10}
                y={PADDING.top + 18 + index * 16}
                textAnchor="end"
                className="chart-annotation"
              >
                {annotation}
              </text>
            ))}
          </g>
        )}

        <text x={PADDING.left + plotWidth / 2} y={height - 16} textAnchor="middle" className="axis-label">{xLabel}</text>
        <text x="18" y={PADDING.top + plotHeight / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 18 ${PADDING.top + plotHeight / 2})`}>{yLabel}</text>

        <g transform={`translate(${PADDING.left + 12}, ${PADDING.top + 12})`}>
          {series.map((s, i) => (
            <g key={s.name} transform={`translate(0, ${i * 18})`}>
              <line x1="0" y1="0" x2="22" y2="0" className={`series-line series-${i % 8}`} />
              <text x="28" y="4" className="legend-label">{s.name}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
