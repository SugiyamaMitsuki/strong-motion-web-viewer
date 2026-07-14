import { useMemo, useState } from 'react';
import { computeFourierSpectrum } from '../analysis/fourier';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { waveformSeriesLabel } from '../visualization/labels';
import { SvgChart, type ChartSeries } from './SvgChart';

interface FourierPanelProps {
  waveforms: DerivedWaveform[];
}

type FourierYRange = 'journal' | 'full';

function quantityLabel(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'Acceleration';
  if (quantity === 'velocity') return 'Velocity';
  return 'Displacement';
}

function unitForQuantity(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function fourierUnitForQuantity(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s';
  if (quantity === 'velocity') return 'cm';
  return 'cm s';
}

function fourierYDomain(series: readonly ChartSeries[], mode: FourierYRange): [number, number] {
  let minimum = Infinity;
  let maximum = 0;
  series.forEach((entry) => entry.y.forEach((value) => {
    if (!Number.isFinite(value) || value <= 0) return;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }));
  if (!(maximum > 0)) return [1e-4, 1];
  const upper = 10 ** Math.ceil(Math.log10(maximum * 1.02));
  if (mode === 'journal') return [maximum / 1e4, upper];
  const lower = Number.isFinite(minimum) ? 10 ** Math.floor(Math.log10(minimum)) : upper / 1e4;
  return [Math.min(lower, upper / 10), upper];
}

export function FourierPanel({ waveforms }: FourierPanelProps): JSX.Element {
  const [quantity, setQuantity] = useState<Quantity>('acceleration');
  const [yRange, setYRange] = useState<FourierYRange>('journal');

  const series = useMemo<ChartSeries[]>(() => waveforms.map((waveform) => {
    const values = quantity === 'acceleration' ? waveform.acceleration : quantity === 'velocity' ? waveform.velocity : waveform.displacement;
    const spectrum = computeFourierSpectrum(values, waveform.dt, unitForQuantity(quantity));
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < spectrum.frequency.length; i += 1) {
      const f = spectrum.frequency[i];
      if (f >= 0.05 && f <= 50 && spectrum.amplitude[i] > 0) {
        x.push(f);
        y.push(spectrum.amplitude[i]);
      }
    }
    return { id: waveform.sourceRecordId, name: waveformSeriesLabel(waveform), x, y, style: componentSeriesStyle(waveform.component) };
  }), [waveforms, quantity]);
  const yDomain = useMemo(() => fourierYDomain(series, yRange), [series, yRange]);

  if (waveforms.length === 0) return <p className="empty-state">No data is available for Fourier spectra.</p>;

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
          Y Range
          <select value={yRange} onChange={(event) => setYRange(event.target.value as FourierYRange)}>
            <option value="journal">Peak − 4 decades</option>
            <option value="full">All positive values</option>
          </select>
        </label>
        <span className="note">The journal range clips values below the peak-minus-four-decades threshold.</span>
      </div>
      <SvgChart
        title={`Fourier Amplitude Spectrum: ${quantityLabel(quantity)}`}
        xLabel="Frequency [Hz]"
        yLabel={`Amplitude [${fourierUnitForQuantity(quantity)}]`}
        series={series}
        xScale="log"
        yScale="log"
        domainY={yDomain}
        fileNameBase={`fourier_${quantity}`}
        height={430}
        description={`One-sided Fourier amplitude spectra of ${quantityLabel(quantity).toLowerCase()} on logarithmic axes. Display range is 0.05–50 Hz. ${yRange === 'journal' ? 'The lower ordinate limit is four decades below the largest amplitude.' : 'The ordinate includes every positive computed amplitude.'}`}
      />
    </div>
  );
}
