import type { ComponentCode, Quantity, WaveformRecord } from '../types/waveform';
import { formatNumber } from '../utils/file';

interface RecordTableProps {
  records: WaveformRecord[];
  onRecordsChange: (records: WaveformRecord[]) => void;
}

function nextComponentLabel(component: ComponentCode, fallback: string): string {
  return component === 'OTHER' ? fallback || 'OTHER' : component;
}

export function RecordTable({ records, onRecordsChange }: RecordTableProps): JSX.Element {
  const updateRecord = (id: string, patch: Partial<WaveformRecord>): void => {
    onRecordsChange(records.map((record) => {
      if (record.id !== id) return record;
      const component = (patch.component ?? record.component) as ComponentCode;
      return {
        ...record,
        ...patch,
        component,
        componentLabel: patch.component ? nextComponentLabel(component, record.componentLabel) : (patch.componentLabel ?? record.componentLabel),
      };
    }));
  };

  if (records.length === 0) {
    return (
      <section className="panel">
        <h2>Loaded Data</h2>
        <p className="empty-state">No files have been loaded yet.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Loaded Data</h2>
        <button type="button" className="secondary" onClick={() => onRecordsChange([])}>Clear All</button>
      </div>
      <div className="table-wrapper">
        <table>
          <caption className="sr-only">Loaded waveform records and editable component metadata</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Format</th>
              <th scope="col">Component</th>
              <th scope="col">Quantity</th>
              <th scope="col" className="numeric">fs [Hz]</th>
              <th scope="col" className="numeric">Samples</th>
              <th scope="col">Station</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td className="file-cell">{record.fileName}</td>
                <td>{record.sourceType}</td>
                <td>
                  <select
                    value={record.component}
                    aria-label={`Component for ${record.fileName}`}
                    onChange={(event) => updateRecord(record.id, { component: event.target.value as ComponentCode })}
                  >
                    <option value="NS">NS</option>
                    <option value="EW">EW</option>
                    <option value="UD">UD</option>
                    <option value="OTHER">OTHER</option>
                  </select>
                </td>
                <td>
                  <select
                    value={record.quantity}
                    aria-label={`Quantity for ${record.fileName}`}
                    onChange={(event) => updateRecord(record.id, { quantity: event.target.value as Quantity })}
                  >
                    <option value="acceleration">Acceleration</option>
                    <option value="velocity">Velocity</option>
                    <option value="displacement">Displacement</option>
                  </select>
                </td>
                <td className="numeric">{formatNumber(record.samplingHz, 4)}</td>
                <td className="numeric">{record.values.length.toLocaleString()}</td>
                <td>{record.metadata.stationCode ?? '-'}</td>
                <td><button type="button" className="danger" aria-label={`Remove ${record.fileName}`} onClick={() => onRecordsChange(records.filter((r) => r.id !== record.id))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
