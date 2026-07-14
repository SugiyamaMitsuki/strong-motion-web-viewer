import { computeHorizontalVerticalRatios } from '../analysis/horizontalVerticalRatio';
import { computeResponseSpectra } from '../analysis/responseSpectrum';
import { buildDistanceCsv, buildFourierCsv, buildHorizontalVerticalRatioCsv, buildResponseSpectrumCsv, buildSummaryJson, buildTimeHistoryCsv } from '../export/exportCsv';
import { downloadAnalysisZip } from '../export/exportZip';
import type { DerivedWaveform, JmaIntensityResult, PeakSummary, ResponseSpectrumSettings } from '../types/waveform';
import { downloadTextFile } from '../utils/file';

interface ExportPanelProps {
  waveforms: DerivedWaveform[];
  responseSettings: ResponseSpectrumSettings;
  peaks: PeakSummary[];
  intensity: JmaIntensityResult;
}

export function ExportPanel({ waveforms, responseSettings, peaks, intensity }: ExportPanelProps): JSX.Element {
  const responseSpectra = computeResponseSpectra(waveforms, responseSettings);
  const hvsr = computeHorizontalVerticalRatios(waveforms, 'acceleration');
  const hvsrAvailable = hvsr.some((result) => result.frequency.length > 0);
  const disabled = waveforms.length === 0;

  return (
    <section className="panel">
      <h2>Export Processed Data</h2>
      <p className="note">Export time histories, rectangular-window raw Fourier spectra, H/V spectral ratios, response spectra, and summaries as CSV/JSON/ZIP. Figure-specific windowing and smoothing are documented by each chart's Methods JSON. Use the buttons on each chart to export PNG or SVG figures.</p>
      <div className="button-row wrap">
        <button type="button" disabled={disabled} onClick={() => downloadTextFile('time_history.csv', buildTimeHistoryCsv(waveforms), 'text/csv;charset=utf-8')}>Time History CSV</button>
        <button type="button" disabled={disabled} onClick={() => downloadTextFile('distance_summary.csv', buildDistanceCsv(waveforms), 'text/csv;charset=utf-8')}>Distance CSV</button>
        <button type="button" disabled={disabled} onClick={() => downloadTextFile('fourier_acceleration_raw_rectangular.csv', buildFourierCsv(waveforms, 'acceleration'), 'text/csv;charset=utf-8')}>Raw Fourier CSV · rectangular</button>
        <button type="button" disabled={disabled || !hvsrAvailable} onClick={() => downloadTextFile('horizontal_vertical_ratio_acceleration.csv', buildHorizontalVerticalRatioCsv(hvsr), 'text/csv;charset=utf-8')}>H/V Ratio CSV</button>
        <button type="button" disabled={disabled} onClick={() => downloadTextFile('response_spectrum.csv', buildResponseSpectrumCsv(responseSpectra), 'text/csv;charset=utf-8')}>Response Spectrum CSV</button>
        <button type="button" disabled={disabled} onClick={() => downloadTextFile('summary.json', buildSummaryJson(peaks, intensity), 'application/json;charset=utf-8')}>Summary JSON</button>
        <button type="button" disabled={disabled} onClick={() => void downloadAnalysisZip(waveforms, responseSpectra, peaks, intensity)}>All-in-one ZIP</button>
      </div>
    </section>
  );
}
