import { useMemo } from 'react';
import { computeStationDistanceRows, sourceLocationFromRecords } from '../analysis/distance';
import type { WaveformMetadata, WaveformRecord } from '../types/waveform';
import { formatNumber } from '../utils/file';

interface LocationDistancePanelProps {
  records: WaveformRecord[];
  onRecordsChange: (records: WaveformRecord[]) => void;
}

type NumericMetadataKey = 'eventLat' | 'eventLon' | 'depthKm' | 'stationLat' | 'stationLon';

function inputValue(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : '';
}

function parseInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDistance(value: number | undefined): string {
  return value === undefined ? '-' : formatNumber(value, 4);
}

function withNumericMetadata(metadata: WaveformMetadata, key: NumericMetadataKey, value: number | undefined): WaveformMetadata {
  const next = { ...metadata };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function LocationDistancePanel({ records, onRecordsChange }: LocationDistancePanelProps): JSX.Element | null {
  const source = useMemo(() => sourceLocationFromRecords(records), [records]);
  const distanceRows = useMemo(() => computeStationDistanceRows(records), [records]);
  const distanceAvailable = distanceRows.some((row) => row.epicentralDistanceKm !== undefined || row.hypocentralDistanceKm !== undefined);

  if (records.length === 0) return null;

  const updateSource = (key: 'eventLat' | 'eventLon' | 'depthKm', value: number | undefined): void => {
    onRecordsChange(records.map((record) => ({
      ...record,
      metadata: withNumericMetadata(record.metadata, key, value),
    })));
  };

  const updateStation = (recordIds: readonly string[], key: 'stationLat' | 'stationLon', value: number | undefined): void => {
    const targetIds = new Set(recordIds);
    onRecordsChange(records.map((record) => {
      if (!targetIds.has(record.id)) return record;
      return {
        ...record,
        metadata: withNumericMetadata(record.metadata, key, value),
      };
    }));
  };

  return (
    <section className="panel distance-panel full-width">
      <h2>Location / Distance</h2>

      <div className="location-editor-grid">
        <div className="location-editor-block">
          <h3>Source Location</h3>
          <div className="compact-input-grid">
            <label>
              Latitude
              <input
                type="number"
                min="-90"
                max="90"
                step="0.0001"
                value={inputValue(source.eventLat)}
                onChange={(event) => updateSource('eventLat', parseInput(event.target.value))}
              />
            </label>
            <label>
              Longitude
              <input
                type="number"
                min="-180"
                max="180"
                step="0.0001"
                value={inputValue(source.eventLon)}
                onChange={(event) => updateSource('eventLon', parseInput(event.target.value))}
              />
            </label>
            <label>
              Depth [km]
              <input
                type="number"
                min="0"
                step="0.1"
                value={inputValue(source.depthKm)}
                onChange={(event) => updateSource('depthKm', parseInput(event.target.value))}
              />
            </label>
          </div>
        </div>

        <div className="distance-results-block">
          <h3>Distance Results</h3>
          {distanceAvailable ? (
            <div className="distance-result-list">
              {distanceRows.map((row) => (
                <dl key={`result-${row.id}`} className="distance-result-item">
                  <dt>{row.label}</dt>
                  <dd>
                    <span>Epicentral</span>
                    <strong>{formatDistance(row.epicentralDistanceKm)} km</strong>
                  </dd>
                  <dd>
                    <span>Hypocentral</span>
                    <strong>{formatDistance(row.hypocentralDistanceKm)} km</strong>
                  </dd>
                </dl>
              ))}
            </div>
          ) : (
            <p className="empty-state compact">Enter source and station coordinates to calculate distances.</p>
          )}
        </div>
      </div>

      <div className="table-wrapper">
        <table className="distance-table">
          <thead>
            <tr>
              <th>Station</th>
              <th>Components</th>
              <th>Station Latitude</th>
              <th>Station Longitude</th>
              <th>Epicentral Distance [km]</th>
              <th>Hypocentral Distance [km]</th>
            </tr>
          </thead>
          <tbody>
            {distanceRows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td>{row.components.join(' / ')}</td>
                <td>
                  <input
                    type="number"
                    min="-90"
                    max="90"
                    step="0.0001"
                    value={inputValue(row.stationLat)}
                    onChange={(event) => updateStation(row.recordIds, 'stationLat', parseInput(event.target.value))}
                    aria-label={`${row.label} station latitude`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="-180"
                    max="180"
                    step="0.0001"
                    value={inputValue(row.stationLon)}
                    onChange={(event) => updateStation(row.recordIds, 'stationLon', parseInput(event.target.value))}
                    aria-label={`${row.label} station longitude`}
                  />
                </td>
                <td>{formatDistance(row.epicentralDistanceKm)}</td>
                <td>{formatDistance(row.hypocentralDistanceKm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
