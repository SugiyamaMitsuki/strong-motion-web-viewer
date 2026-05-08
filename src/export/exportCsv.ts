import type { DerivedWaveform, HorizontalVerticalRatioResult, JmaIntensityResult, PeakSummary, Quantity, ResponseSpectrumResult, WaveformRecord } from '../types/waveform';
import { computeStationDistanceRows } from '../analysis/distance';
import { computeFourierSpectrum } from '../analysis/fourier';
import { formatNumber } from '../utils/file';

function csvEscape(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildTimeHistoryCsv(waveforms: DerivedWaveform[]): string {
  const headers = ['time_s'];
  for (const w of waveforms) {
    const suffix = w.componentLabel || w.component;
    headers.push(`acc_${suffix}_cm_s2`, `vel_${suffix}_cm_s`, `disp_${suffix}_cm`);
  }

  const maxLength = Math.max(0, ...waveforms.map((w) => w.time.length));
  const lines = [headers.map(csvEscape).join(',')];

  for (let i = 0; i < maxLength; i += 1) {
    const time = waveforms.find((w) => i < w.time.length)?.time[i] ?? i * (waveforms[0]?.dt ?? 0);
    const row: (string | number | undefined)[] = [formatNumber(time, 6)];

    for (const w of waveforms) {
      row.push(
        i < w.acceleration.length ? formatNumber(w.acceleration[i], 8) : '',
        i < w.velocity.length ? formatNumber(w.velocity[i], 8) : '',
        i < w.displacement.length ? formatNumber(w.displacement[i], 8) : '',
      );
    }

    lines.push(row.map(csvEscape).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export function buildFourierCsv(waveforms: DerivedWaveform[], quantity: Quantity): string {
  const headers = ['frequency_Hz', ...waveforms.map((w) => `${quantity}_${w.componentLabel}`)];
  const spectra = waveforms.map((w) => {
    const values = quantity === 'acceleration' ? w.acceleration : quantity === 'velocity' ? w.velocity : w.displacement;
    const unit = quantity === 'acceleration' ? 'cm/s²' : quantity === 'velocity' ? 'cm/s' : 'cm';
    return computeFourierSpectrum(values, w.dt, unit);
  });

  const maxLength = Math.max(0, ...spectra.map((s) => s.frequency.length));
  const lines = [headers.map(csvEscape).join(',')];

  for (let i = 0; i < maxLength; i += 1) {
    const frequency = spectra.find((s) => i < s.frequency.length)?.frequency[i];
    const row: (string | number | undefined)[] = [frequency !== undefined ? formatNumber(frequency, 8) : ''];
    for (const s of spectra) row.push(i < s.amplitude.length ? formatNumber(s.amplitude[i], 8) : '');
    lines.push(row.map(csvEscape).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export function buildResponseSpectrumCsv(results: ResponseSpectrumResult[]): string {
  const headers = ['period_s'];
  for (const r of results) {
    headers.push(`Sd_${r.componentLabel}_cm`, `pSv_${r.componentLabel}_cm_s`, `Sa_${r.componentLabel}_cm_s2`);
  }

  const maxLength = Math.max(0, ...results.map((r) => r.points.length));
  const lines = [headers.map(csvEscape).join(',')];

  for (let i = 0; i < maxLength; i += 1) {
    const period = results.find((r) => i < r.points.length)?.points[i].period;
    const row: (string | number | undefined)[] = [period !== undefined ? formatNumber(period, 8) : ''];
    for (const r of results) {
      const p = r.points[i];
      row.push(
        p ? formatNumber(p.sd, 8) : '',
        p ? formatNumber(p.psv, 8) : '',
        p ? formatNumber(p.psa, 8) : '',
      );
    }
    lines.push(row.map(csvEscape).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export function buildHorizontalVerticalRatioCsv(results: HorizontalVerticalRatioResult[]): string {
  const headers = ['frequency_Hz', ...results.map((result) => `H_V_${result.label}`)];
  const maxLength = Math.max(0, ...results.map((result) => result.frequency.length));
  const lines = [headers.map(csvEscape).join(',')];

  for (let i = 0; i < maxLength; i += 1) {
    const frequency = results.find((result) => i < result.frequency.length)?.frequency[i];
    const row: (string | number | undefined)[] = [frequency !== undefined ? formatNumber(frequency, 8) : ''];

    for (const result of results) {
      row.push(i < result.ratio.length ? formatNumber(result.ratio[i], 8) : '');
    }

    lines.push(row.map(csvEscape).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export function buildDistanceCsv(records: DerivedWaveform[]): string {
  const rows = computeStationDistanceRows(records.map((record): WaveformRecord => ({
    id: record.sourceRecordId,
    fileName: record.fileName,
    sourceType: 'unknown',
    component: record.component,
    componentLabel: record.componentLabel,
    quantity: 'acceleration',
    unit: 'cm/s²',
    values: [],
    dt: record.dt,
    samplingHz: record.samplingHz,
    metadata: record.metadata,
  })));
  const headers = [
    'station',
    'components',
    'source_lat',
    'source_lon',
    'source_depth_km',
    'station_lat',
    'station_lon',
    'epicentral_distance_km',
    'hypocentral_distance_km',
  ];
  const lines = [headers.map(csvEscape).join(',')];

  for (const row of rows) {
    lines.push([
      row.label,
      row.components.join(' / '),
      row.eventLat !== undefined ? formatNumber(row.eventLat, 8) : '',
      row.eventLon !== undefined ? formatNumber(row.eventLon, 8) : '',
      row.depthKm !== undefined ? formatNumber(row.depthKm, 8) : '',
      row.stationLat !== undefined ? formatNumber(row.stationLat, 8) : '',
      row.stationLon !== undefined ? formatNumber(row.stationLon, 8) : '',
      row.epicentralDistanceKm !== undefined ? formatNumber(row.epicentralDistanceKm, 8) : '',
      row.hypocentralDistanceKm !== undefined ? formatNumber(row.hypocentralDistanceKm, 8) : '',
    ].map(csvEscape).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export function buildSummaryJson(peaks: PeakSummary[], intensity: JmaIntensityResult): string {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    peaks,
    jmaIntensity: intensity,
  }, null, 2);
}
