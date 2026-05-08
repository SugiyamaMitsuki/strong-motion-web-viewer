import { useMemo, useState } from 'react';
import { computeFourierSpectrum } from '../analysis/fourier';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { SvgChart, type ChartSeries } from './SvgChart';

interface FourierPanelProps {
  waveforms: DerivedWaveform[];
}

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

export function FourierPanel({ waveforms }: FourierPanelProps): JSX.Element {
  const [quantity, setQuantity] = useState<Quantity>('acceleration');

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
    return { name: waveform.componentLabel, x, y };
  }), [waveforms, quantity]);

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
      </div>
      <SvgChart
        title={`Fourier Amplitude Spectrum: ${quantityLabel(quantity)}`}
        xLabel="Frequency [Hz]"
        yLabel={`Amplitude [${fourierUnitForQuantity(quantity)}]`}
        series={series}
        xScale="log"
        yScale="log"
        fileNameBase={`fourier_${quantity}`}
        height={430}
      />
    </div>
  );
}
