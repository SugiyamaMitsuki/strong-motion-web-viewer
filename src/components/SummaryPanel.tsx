import type { JmaIntensityResult, PeakSummary, WaveformRecord } from '../types/waveform';
import { formatNumber } from '../utils/file';
import { LocationDistancePanel } from './LocationDistancePanel';
import { StationMap } from './StationMap';

interface SummaryPanelProps {
  records: WaveformRecord[];
  onRecordsChange: (records: WaveformRecord[]) => void;
  peaks: PeakSummary[];
  intensity: JmaIntensityResult;
}

export function SummaryPanel({ records, onRecordsChange, peaks, intensity }: SummaryPanelProps): JSX.Element {
  if (records.length === 0) return <p className="empty-state">No data is available for the summary.</p>;

  const first = records[0];

  return (
    <div className="summary-grid">
      <section className="panel summary-card">
        <h2>Metadata</h2>
        <dl>
          <dt>Station</dt><dd>{first.metadata.stationCode ?? '-'}</dd>
          <dt>Record Time</dt><dd>{first.metadata.recordTime ?? '-'}</dd>
          <dt>Origin Time</dt><dd>{first.metadata.originTime ?? '-'}</dd>
          <dt>Sampling Frequency</dt><dd>{formatNumber(first.samplingHz, 4)} Hz</dd>
          <dt>Loaded Components</dt><dd>{records.length}</dd>
        </dl>
      </section>

      <section className="panel summary-card">
        <h2>JMA Intensity</h2>
        {intensity.available ? (
          <dl>
            <dt>Instrumental Intensity</dt><dd className="large-number">{formatNumber(intensity.intensity, 1)}</dd>
            <dt>Shindo Class</dt><dd className="large-number">{intensity.classLabel}</dd>
            <dt>Threshold Acceleration</dt><dd>{formatNumber(intensity.thresholdAcceleration, 4)} cm/s²</dd>
            <dt>Cumulative Duration</dt><dd>{formatNumber(intensity.durationAboveThreshold, 3)} s</dd>
          </dl>
        ) : (
          <p className="note">{intensity.message}</p>
        )}
      </section>

      <LocationDistancePanel records={records} onRecordsChange={onRecordsChange} />

      <StationMap records={records} />

      <section className="panel full-width">
        <h2>Peak Values</h2>
        <div className="table-wrapper">
          <table>
            <caption className="sr-only">Peak ground-motion values for each loaded component</caption>
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">File</th>
                <th scope="col" className="numeric">PGA [cm/s²]</th>
                <th scope="col" className="numeric">PGV [cm/s]</th>
                <th scope="col" className="numeric">PGD [cm]</th>
              </tr>
            </thead>
            <tbody>
              {peaks.map((peak) => (
                <tr key={peak.sourceRecordId}>
                  <th scope="row">{peak.componentLabel}</th>
                  <td className="file-cell">{peak.fileName}</td>
                  <td className="numeric">{formatNumber(peak.pga, 6)}</td>
                  <td className="numeric">{formatNumber(peak.pgv, 6)}</td>
                  <td className="numeric">{formatNumber(peak.pgd, 6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
