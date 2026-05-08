import type { DerivedWaveform, PeakSummary } from '../types/waveform';
import { maxAbs } from './statistics';

export function computePeakSummary(waveforms: DerivedWaveform[]): PeakSummary[] {
  return waveforms.map((w) => ({
    sourceRecordId: w.sourceRecordId,
    fileName: w.fileName,
    component: w.component,
    componentLabel: w.componentLabel,
    pga: maxAbs(w.acceleration),
    pgv: maxAbs(w.velocity),
    pgd: maxAbs(w.displacement),
  }));
}
