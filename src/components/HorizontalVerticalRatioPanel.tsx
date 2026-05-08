import { useMemo, useState } from 'react';
import { computeHorizontalVerticalRatios } from '../analysis/horizontalVerticalRatio';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { formatNumber } from '../utils/file';
import { SvgChart, type ChartSeries } from './SvgChart';

interface HorizontalVerticalRatioPanelProps {
  waveforms: DerivedWaveform[];
}

type SmoothingLevel = 'none' | 'light' | 'standard' | 'strong';
type HorizontalMergeMethod = 'geometric' | 'rms';
type FrequencyResolution = 'fast' | 'standard' | 'detailed';
type YRangeMode = 'robust' | 'full';

const SMOOTHING_BANDWIDTH: Record<SmoothingLevel, number> = {
  none: 0,
  light: 60,
  standard: 40,
  strong: 25,
};

const FREQUENCY_COUNT: Record<FrequencyResolution, number> = {
  fast: 120,
  standard: 240,
  detailed: 480,
};

function quantityLabel(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'Acceleration';
  if (quantity === 'velocity') return 'Velocity';
  return 'Displacement';
}

function niceLinearCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  const multiplier = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

function quantile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.round((sortedValues.length - 1) * q)));
  return sortedValues[index];
}

function hvsrYDomain(series: ChartSeries[], mode: YRangeMode): [number, number] {
  const values: number[] = [];
  series.forEach((entry) => {
    entry.y.forEach((value) => {
      if (Number.isFinite(value) && value > 0) values.push(value);
    });
  });
  values.sort((a, b) => a - b);
  const max = values[values.length - 1] ?? 0;
  const robustMax = quantile(values, 0.98);
  const displayMax = mode === 'robust' && max > robustMax * 2.5 ? robustMax * 1.35 : max;
  return [0, niceLinearCeil(Math.max(2, displayMax * 1.12))];
}

export function HorizontalVerticalRatioPanel({ waveforms }: HorizontalVerticalRatioPanelProps): JSX.Element {
  const [quantity, setQuantity] = useState<Quantity>('acceleration');
  const [smoothing, setSmoothing] = useState<SmoothingLevel>('standard');
  const [horizontalMerge, setHorizontalMerge] = useState<HorizontalMergeMethod>('geometric');
  const [resolution, setResolution] = useState<FrequencyResolution>('standard');
  const [yRangeMode, setYRangeMode] = useState<YRangeMode>('robust');

  const results = useMemo(
    () => computeHorizontalVerticalRatios(waveforms, quantity, {
      minFrequency: 0.05,
      maxFrequency: 50,
      frequencyCount: FREQUENCY_COUNT[resolution],
      smoothingBandwidth: SMOOTHING_BANDWIDTH[smoothing],
      horizontalMerge,
    }),
    [waveforms, quantity, smoothing, horizontalMerge, resolution],
  );
  const availableResults = results.filter((result) => result.frequency.length > 0);
  const series = useMemo<ChartSeries[]>(() => availableResults.map((result) => ({
    name: result.label,
    x: result.frequency,
    y: result.ratio,
  })), [availableResults]);
  const yDomain = useMemo(() => hvsrYDomain(series, yRangeMode), [series, yRangeMode]);

  if (waveforms.length === 0) return <p className="empty-state">No data is available for H/V spectral ratios.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        <label>
          Quantity
          <select value={quantity} onChange={(event) => setQuantity(event.target.value as Quantity)}>
            <option value="acceleration">Acceleration</option>
            <option value="velocity">Velocity</option>
            <option value="displacement">Displacement</option>
          </select>
        </label>
        <label>
          Smoothing
          <select value={smoothing} onChange={(event) => setSmoothing(event.target.value as SmoothingLevel)}>
            <option value="none">None</option>
            <option value="light">Light</option>
            <option value="standard">Standard</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <label>
          Horizontal
          <select value={horizontalMerge} onChange={(event) => setHorizontalMerge(event.target.value as HorizontalMergeMethod)}>
            <option value="geometric">Geometric mean</option>
            <option value="rms">RMS</option>
          </select>
        </label>
        <label>
          Resolution
          <select value={resolution} onChange={(event) => setResolution(event.target.value as FrequencyResolution)}>
            <option value="fast">Fast</option>
            <option value="standard">Standard</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label>
          Y Range
          <select value={yRangeMode} onChange={(event) => setYRangeMode(event.target.value as YRangeMode)}>
            <option value="robust">Robust</option>
            <option value="full">Full</option>
          </select>
        </label>
        <span className="note">5% time taper, Konno-Ohmachi smoothing, log-frequency grid.</span>
      </div>

      {availableResults.length > 0 ? (
        <>
          <SvgChart
            title={`Horizontal-to-Vertical Spectral Ratio: ${quantityLabel(quantity)}`}
            xLabel="Frequency [Hz]"
            yLabel="H/V Ratio"
            series={series}
            xScale="log"
            yScale="linear"
            domainX={[0.05, 50]}
            domainY={yDomain}
            fileNameBase={`horizontal_vertical_ratio_${quantity}`}
            height={430}
          />

          <section className="panel summary-card">
            <h2>H/V Peak Values</h2>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Horizontal</th>
                    <th>Vertical</th>
                    <th>Peak Frequency [Hz]</th>
                    <th>Peak Period [s]</th>
                    <th>Peak H/V</th>
                  </tr>
                </thead>
                <tbody>
                  {availableResults.map((result) => (
                    <tr key={result.id}>
                      <td>{result.label}</td>
                      <td>{result.horizontalComponents.join(' / ')}</td>
                      <td>{result.verticalComponent}</td>
                      <td>{result.peakFrequency !== undefined ? formatNumber(result.peakFrequency, 5) : '-'}</td>
                      <td>{result.peakPeriod !== undefined ? formatNumber(result.peakPeriod, 5) : '-'}</td>
                      <td>{result.peakRatio !== undefined ? formatNumber(result.peakRatio, 5) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <p className="empty-state">H/V ratio requires a vertical component (UD) and at least one horizontal component (NS or EW) for the same station/channel.</p>
      )}
    </div>
  );
}
