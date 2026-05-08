import { useMemo, useState } from 'react';
import type { DerivedWaveform } from '../types/waveform';
import { formatNumber } from '../utils/file';
import { SvgChart, type ChartSeries } from './SvgChart';

interface TimeHistoryPanelProps {
  waveforms: DerivedWaveform[];
}

type TimeHistoryQuantity = 'acceleration' | 'velocity' | 'displacement';
type TimeHistoryLayout = 'overlay' | 'separate';

interface QuantityConfig {
  key: TimeHistoryQuantity;
  label: string;
  shortLabel: string;
  yLabel: string;
  unit: string;
  fileName: string;
}

const QUANTITIES: QuantityConfig[] = [
  { key: 'acceleration', label: 'Acceleration', shortLabel: 'Acc.', yLabel: 'Acc. [cm/s²]', unit: 'cm/s²', fileName: 'acceleration' },
  { key: 'velocity', label: 'Velocity', shortLabel: 'Vel.', yLabel: 'Vel. [cm/s]', unit: 'cm/s', fileName: 'velocity' },
  { key: 'displacement', label: 'Displacement', shortLabel: 'Disp.', yLabel: 'Disp. [cm]', unit: 'cm', fileName: 'displacement' },
];

const COMPONENT_ORDER = ['NS', 'EW', 'UD', 'OTHER'];

function buildSeries(waveforms: DerivedWaveform[], key: TimeHistoryQuantity): ChartSeries[] {
  return waveforms.map((waveform) => ({
    name: waveform.componentLabel,
    x: waveform.time,
    y: waveform[key],
  }));
}

function componentRank(waveform: DerivedWaveform): number {
  const index = COMPONENT_ORDER.indexOf(waveform.component);
  return index >= 0 ? index : COMPONENT_ORDER.length;
}

function peakAnnotation(waveform: DerivedWaveform, quantity: QuantityConfig): string {
  const values = waveform[quantity.key];
  const count = Math.min(values.length, waveform.time.length);
  let peakAbs = 0;
  let peakTime = 0;

  for (let i = 0; i < count; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    const abs = Math.abs(value);
    if (abs > peakAbs) {
      peakAbs = abs;
      peakTime = waveform.time[i];
    }
  }

  return `${waveform.componentLabel} Max |${quantity.shortLabel}| = ${formatNumber(peakAbs, 5)} ${quantity.unit} at ${formatNumber(peakTime, 4)} s`;
}

function peakAnnotations(waveforms: DerivedWaveform[], quantity: QuantityConfig): string[] {
  return waveforms.map((waveform) => peakAnnotation(waveform, quantity));
}

export function TimeHistoryPanel({ waveforms }: TimeHistoryPanelProps): JSX.Element {
  const [layout, setLayout] = useState<TimeHistoryLayout>('overlay');
  const orderedWaveforms = useMemo(
    () => [...waveforms].sort((a, b) => componentRank(a) - componentRank(b) || a.componentLabel.localeCompare(b.componentLabel)),
    [waveforms],
  );

  if (waveforms.length === 0) return <p className="empty-state">No data is available for time-history plots.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        <label>
          Components
          <select value={layout} onChange={(event) => setLayout(event.target.value as TimeHistoryLayout)}>
            <option value="overlay">Overlay components</option>
            <option value="separate">Separate components</option>
          </select>
        </label>
      </div>

      {layout === 'overlay' ? QUANTITIES.map((quantity) => (
        <SvgChart
          key={quantity.key}
          title={`Time History: ${quantity.label}`}
          xLabel="Time [s]"
          yLabel={quantity.yLabel}
          series={buildSeries(orderedWaveforms, quantity.key)}
          fileNameBase={`time_history_${quantity.fileName}`}
          height={300}
          showToolbarTitle={false}
          annotations={peakAnnotations(orderedWaveforms, quantity)}
        />
      )) : QUANTITIES.flatMap((quantity) => orderedWaveforms.map((waveform) => (
        <SvgChart
          key={`${quantity.key}-${waveform.sourceRecordId}`}
          title={`Time History: ${quantity.label} ${waveform.componentLabel}`}
          xLabel="Time [s]"
          yLabel={quantity.yLabel}
          series={buildSeries([waveform], quantity.key)}
          fileNameBase={`time_history_${quantity.fileName}_${waveform.componentLabel}`}
          height={260}
          showToolbarTitle={false}
          annotations={peakAnnotations([waveform], quantity)}
        />
      )))}
    </div>
  );
}
