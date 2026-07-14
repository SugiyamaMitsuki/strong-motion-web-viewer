import { useMemo, useState } from 'react';
import type { DerivedWaveform } from '../types/waveform';
import { componentSeriesStyle } from '../visualization/chartStyle';
import { waveformSeriesLabel } from '../visualization/labels';
import { alignWaveformTimes, buildWaveformRecordSets } from '../visualization/waveformGroups';
import { StackedTimeHistoryFigure } from './StackedTimeHistoryFigure';
import { SvgChart, type ChartSeries } from './SvgChart';

interface TimeHistoryPanelProps {
  waveforms: DerivedWaveform[];
}

type TimeHistoryQuantity = 'acceleration' | 'velocity' | 'displacement';
type TimeHistoryLayout = 'journal' | 'overlay';

interface QuantityConfig {
  key: TimeHistoryQuantity;
  label: string;
  shortLabel: string;
  yLabel: string;
  unit: string;
  fileName: string;
}

const QUANTITIES: QuantityConfig[] = [
  { key: 'acceleration', label: 'Acceleration', shortLabel: 'PGA', yLabel: 'Acc. [cm/s²]', unit: 'cm/s²', fileName: 'acceleration' },
  { key: 'velocity', label: 'Velocity', shortLabel: 'PGV', yLabel: 'Vel. [cm/s]', unit: 'cm/s', fileName: 'velocity' },
  { key: 'displacement', label: 'Displacement', shortLabel: 'PGD', yLabel: 'Disp. [cm]', unit: 'cm', fileName: 'displacement' },
];

const COMPONENT_ORDER = ['NS', 'EW', 'UD', 'OTHER'];

function buildSeries(waveforms: DerivedWaveform[], key: TimeHistoryQuantity, alignedTimes?: ReadonlyMap<string, number[]>): ChartSeries[] {
  return waveforms.map((waveform) => ({
    id: waveform.sourceRecordId,
    name: waveformSeriesLabel(waveform),
    x: alignedTimes?.get(waveform.sourceRecordId) ?? waveform.time,
    y: waveform[key],
    style: componentSeriesStyle(waveform.component),
  }));
}

function componentRank(waveform: DerivedWaveform): number {
  const index = COMPONENT_ORDER.indexOf(waveform.component);
  return index >= 0 ? index : COMPONENT_ORDER.length;
}

export function TimeHistoryPanel({ waveforms }: TimeHistoryPanelProps): JSX.Element {
  const [layout, setLayout] = useState<TimeHistoryLayout>('journal');
  const [recordSetId, setRecordSetId] = useState('');
  const recordSets = useMemo(() => buildWaveformRecordSets(waveforms), [waveforms]);
  const selected = recordSets.find((set) => set.id === (recordSetId || recordSets[0]?.id)) ?? recordSets[0];
  const orderedWaveforms = useMemo(
    () => [...(selected?.waveforms ?? [])].sort((a, b) => componentRank(a) - componentRank(b) || a.componentLabel.localeCompare(b.componentLabel)),
    [selected],
  );
  const alignment = useMemo(() => alignWaveformTimes(orderedWaveforms), [orderedWaveforms]);

  if (waveforms.length === 0) return <p className="empty-state">No data is available for time-history plots.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        {recordSets.length > 1 && selected && (
          <label>
            Record set
            <select value={selected.id} onChange={(event) => setRecordSetId(event.target.value)}>
              {recordSets.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
            </select>
          </label>
        )}
        <label>
          Figure layout
          <select value={layout} onChange={(event) => setLayout(event.target.value as TimeHistoryLayout)}>
            <option value="journal">Stacked journal panels</option>
            <option value="overlay">Overlay for screen inspection</option>
          </select>
        </label>
        <span className="note">Journal panels use direct component labels, one shared ordinate, and the time axis only on the bottom panel.</span>
      </div>

      {layout === 'journal' ? QUANTITIES.map((quantity) => (
        <StackedTimeHistoryFigure
          key={quantity.key}
          waveforms={orderedWaveforms}
          quantity={quantity.key}
          label={quantity.label}
          shortLabel={quantity.shortLabel}
          unit={quantity.unit}
          contextLabel={selected?.label}
          fileNameBase={`journal_time_history_${quantity.fileName}_${selected?.id ?? 'record-set'}`}
        />
      )) : QUANTITIES.map((quantity) => (
        <SvgChart
          key={quantity.key}
          title={`Time History: ${quantity.label}${selected ? ` · ${selected.label}` : ''}`}
          xLabel="Time [s]"
          yLabel={quantity.yLabel}
          series={buildSeries(orderedWaveforms, quantity.key, alignment.values)}
          fileNameBase={`time_history_${quantity.fileName}_${selected?.id ?? 'record-set'}`}
          height={Math.max(410, 330 + orderedWaveforms.length * 22)}
          showToolbarTitle
          description={`${quantity.label} time histories overlaid for interactive screen inspection. ${alignment.reference}. Use the stacked journal layout for manuscript figures.`}
        />
      ))}
    </div>
  );
}
