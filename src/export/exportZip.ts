import JSZip from 'jszip';
import { computeHorizontalVerticalRatios } from '../analysis/horizontalVerticalRatio';
import type { DerivedWaveform, JmaIntensityResult, PeakSummary, ResponseSpectrumResult } from '../types/waveform';
import { buildDistanceCsv, buildFourierCsv, buildHorizontalVerticalRatioCsv, buildResponseSpectrumCsv, buildSummaryJson, buildTimeHistoryCsv } from './exportCsv';
import { downloadBlob } from '../utils/file';

export async function downloadAnalysisZip(
  waveforms: DerivedWaveform[],
  responseSpectra: ResponseSpectrumResult[],
  peaks: PeakSummary[],
  intensity: JmaIntensityResult,
): Promise<void> {
  const zip = new JSZip();
  zip.file('time_history.csv', buildTimeHistoryCsv(waveforms));
  zip.file('distance_summary.csv', buildDistanceCsv(waveforms));
  zip.file('fourier_acceleration_raw_rectangular.csv', buildFourierCsv(waveforms, 'acceleration'));
  zip.file('fourier_velocity_raw_rectangular.csv', buildFourierCsv(waveforms, 'velocity'));
  zip.file('fourier_displacement_raw_rectangular.csv', buildFourierCsv(waveforms, 'displacement'));
  zip.file('horizontal_vertical_ratio_acceleration.csv', buildHorizontalVerticalRatioCsv(computeHorizontalVerticalRatios(waveforms, 'acceleration')));
  zip.file('horizontal_vertical_ratio_velocity.csv', buildHorizontalVerticalRatioCsv(computeHorizontalVerticalRatios(waveforms, 'velocity')));
  zip.file('horizontal_vertical_ratio_displacement.csv', buildHorizontalVerticalRatioCsv(computeHorizontalVerticalRatios(waveforms, 'displacement')));
  zip.file('response_spectrum.csv', buildResponseSpectrumCsv(responseSpectra));
  zip.file('summary.json', buildSummaryJson(peaks, intensity));

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob('strong_motion_analysis.zip', blob);
}
