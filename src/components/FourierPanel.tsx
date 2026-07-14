import { useMemo, useState } from 'react';
import {
  computeFourierAnalysis,
  DEFAULT_PARZEN_BANDWIDTH_HZ,
  smoothFourierSpectrumKonnoOhmachi,
  smoothFourierSpectrumParzen,
  type FourierAnalysisResult,
} from '../analysis/fourier';
import type { DerivedWaveform, FourierSpectrum, Quantity } from '../types/waveform';
import { componentSeriesStyle } from '../visualization/chartStyle';
import {
  buildFigureProvenance,
  datasetLabel,
  preprocessingLabel,
} from '../visualization/provenance';
import { buildWaveformRecordSets } from '../visualization/waveformGroups';
import { SvgChart, type ChartSeries } from './SvgChart';

interface FourierPanelProps {
  waveforms: DerivedWaveform[];
}

type FourierYRange = 'journal' | 'full';
type FourierDisplayMode = 'smoothed-raw' | 'smoothed' | 'raw';
type FourierWindow = 'cosine-5' | 'rectangular';
type FourierSmoothingMethod = 'parzen' | 'konno-ohmachi';

interface AnalysedWaveform {
  waveform: DerivedWaveform;
  label: string;
  analysis: FourierAnalysisResult;
}

const RELATIVE_SUPPORT_FLOOR = 1e-12;
const KONNO_OHMACHI_POINT_COUNT = 360;

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
  return 'cm·s';
}

function valuesForQuantity(waveform: DerivedWaveform, quantity: Quantity): number[] {
  if (quantity === 'acceleration') return waveform.acceleration;
  if (quantity === 'velocity') return waveform.velocity;
  return waveform.displacement;
}

function conciseComponentLabels(waveforms: readonly DerivedWaveform[]): string[] {
  const baseLabels = waveforms.map((waveform) => waveform.componentLabel.trim() || waveform.component);
  const totals = new Map<string, number>();
  baseLabels.forEach((label) => totals.set(label, (totals.get(label) ?? 0) + 1));
  const seen = new Map<string, number>();
  return baseLabels.map((label) => {
    const occurrence = (seen.get(label) ?? 0) + 1;
    seen.set(label, occurrence);
    return (totals.get(label) ?? 0) > 1 ? `${label}-${occurrence}` : label;
  });
}

function positiveSupport(
  spectrum: FourierSpectrum,
  independentResolutionHz: number,
): [number, number] | undefined {
  let maximum = 0;
  spectrum.amplitude.forEach((amplitude) => {
    if (Number.isFinite(amplitude) && amplitude > maximum) maximum = amplitude;
  });
  if (!(maximum > 0)) return undefined;

  const floor = maximum * RELATIVE_SUPPORT_FLOOR;
  let minimumFrequency = Infinity;
  let maximumFrequency = 0;
  const count = Math.min(spectrum.frequency.length, spectrum.amplitude.length);
  for (let index = 0; index < count; index += 1) {
    const frequency = spectrum.frequency[index];
    const amplitude = spectrum.amplitude[index];
    if (!Number.isFinite(frequency) || frequency < independentResolutionHz) continue;
    if (!Number.isFinite(amplitude) || amplitude <= floor) continue;
    minimumFrequency = Math.min(minimumFrequency, frequency);
    maximumFrequency = Math.max(maximumFrequency, frequency);
  }
  return Number.isFinite(minimumFrequency) && maximumFrequency > minimumFrequency
    ? [minimumFrequency, maximumFrequency]
    : undefined;
}

function commonDisplayBand(analyses: readonly AnalysedWaveform[]): [number, number] {
  if (analyses.length === 0) return [0.01, 1];
  const lowerFallback = Math.max(0, ...analyses.map((entry) => {
    const { preprocessing } = entry.waveform;
    const highpass = preprocessing?.applyHighpass
      && preprocessing.highpassHz > 0
      && preprocessing.highpassHz < entry.analysis.metadata.nyquistFrequencyHz
      ? preprocessing.highpassHz
      : 0;
    return Math.max(entry.analysis.metadata.independentResolutionHz, highpass);
  }));
  const upperFallback = Math.min(Infinity, ...analyses.map((entry) => {
    const { preprocessing } = entry.waveform;
    const lowpass = preprocessing?.applyLowpass
      && preprocessing.lowpassHz > 0
      && preprocessing.lowpassHz < entry.analysis.metadata.nyquistFrequencyHz
      ? preprocessing.lowpassHz
      : entry.analysis.metadata.nyquistFrequencyHz;
    return Math.min(entry.analysis.metadata.nyquistFrequencyHz, lowpass);
  }));
  const supports = analyses.map((entry) => positiveSupport(
    entry.analysis.spectrum,
    entry.analysis.metadata.independentResolutionHz,
  ));
  const lower = Math.max(lowerFallback, ...supports.map((support) => support?.[0] ?? lowerFallback));
  const upper = Math.min(upperFallback, ...supports.map((support) => support?.[1] ?? upperFallback));
  if (lower > 0 && upper > lower * 1.01) return [lower, upper];

  const firstPositive = Math.max(0, ...analyses.map((entry) => entry.analysis.metadata.firstPositiveFrequencyHz));
  return upperFallback > firstPositive
    ? [Math.max(firstPositive, lowerFallback), upperFallback]
    : [0.01, 1];
}

function clippedSpectrum(spectrum: FourierSpectrum, domain: [number, number]): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  const count = Math.min(spectrum.frequency.length, spectrum.amplitude.length);
  for (let index = 0; index < count; index += 1) {
    const frequency = spectrum.frequency[index];
    const amplitude = spectrum.amplitude[index];
    if (frequency < domain[0] || frequency > domain[1] || !Number.isFinite(amplitude) || amplitude <= 0) continue;
    x.push(frequency);
    y.push(amplitude);
  }
  return { x, y };
}

function fourierYDomain(series: readonly ChartSeries[], mode: FourierYRange): [number, number] {
  let minimum = Infinity;
  let maximum = 0;
  series.forEach((entry) => entry.y.forEach((value) => {
    if (!Number.isFinite(value) || value <= 0) return;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }));
  if (!(maximum > 0)) return [1e-4, 1];
  const upper = 10 ** Math.ceil(Math.log10(maximum * 1.02));
  if (mode === 'journal') return [maximum / 1e4, upper];
  const lower = Number.isFinite(minimum) ? 10 ** Math.floor(Math.log10(minimum)) : upper / 1e4;
  return [Math.min(lower, upper / 10), upper];
}

function formatFrequency(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 10) return Number(value.toFixed(1)).toString();
  if (value >= 1) return Number(value.toFixed(2)).toString();
  return Number(value.toPrecision(3)).toString();
}

function formatValueRange(values: readonly number[]): string {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 'n/a';
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  return Math.abs(maximum - minimum) <= Math.max(Math.abs(maximum), 1) * 1e-10
    ? formatFrequency(minimum)
    : `${formatFrequency(minimum)}–${formatFrequency(maximum)}`;
}

function formatParzenBandwidth(value: number): string {
  return value.toFixed(2);
}

export function FourierPanel({ waveforms }: FourierPanelProps): JSX.Element {
  const [recordSetId, setRecordSetId] = useState('');
  const [quantity, setQuantity] = useState<Quantity>('acceleration');
  const [yRange, setYRange] = useState<FourierYRange>('journal');
  const [displayMode, setDisplayMode] = useState<FourierDisplayMode>('smoothed-raw');
  const [timeWindow, setTimeWindow] = useState<FourierWindow>('cosine-5');
  const [smoothingMethod, setSmoothingMethod] = useState<FourierSmoothingMethod>('parzen');
  const [parzenBandwidthHz, setParzenBandwidthHz] = useState(DEFAULT_PARZEN_BANDWIDTH_HZ);
  const [konnoOhmachiBandwidth, setKonnoOhmachiBandwidth] = useState(40);
  const recordSets = useMemo(() => buildWaveformRecordSets(waveforms), [waveforms]);
  const selectedRecordSet = recordSets.find((set) => set.id === (recordSetId || recordSets[0]?.id)) ?? recordSets[0];
  const selectedWaveforms = selectedRecordSet?.waveforms ?? [];
  const exportRecordSetSuffix = selectedRecordSet?.label ? `_${selectedRecordSet.label}` : '';

  const analyses = useMemo<AnalysedWaveform[]>(() => {
    const labels = conciseComponentLabels(selectedWaveforms);
    return selectedWaveforms.map((waveform, index) => ({
      waveform,
      label: labels[index],
      analysis: computeFourierAnalysis(
        valuesForQuantity(waveform, quantity),
        waveform.dt,
        unitForQuantity(quantity),
        {
          applyFrequencyTaper: false,
          applyTimeTaper: timeWindow === 'cosine-5',
          timeTaperFraction: 0.05,
        },
      ),
    }));
  }, [quantity, selectedWaveforms, timeWindow]);

  const xDomain = useMemo<[number, number]>(() => commonDisplayBand(analyses), [analyses]);

  const smoothedSpectra = useMemo(() => analyses.map((entry) => (
    smoothingMethod === 'parzen'
      ? smoothFourierSpectrumParzen(entry.analysis.spectrum, {
        bandwidthHz: parzenBandwidthHz,
        dcAmplitude: entry.analysis.metadata.dcAmplitude,
      })
      : smoothFourierSpectrumKonnoOhmachi(entry.analysis.spectrum, {
        bandwidth: konnoOhmachiBandwidth,
        minFrequencyHz: xDomain[0],
        maxFrequencyHz: xDomain[1],
        outputCount: KONNO_OHMACHI_POINT_COUNT,
      })
  )), [analyses, konnoOhmachiBandwidth, parzenBandwidthHz, smoothingMethod, xDomain]);

  const series = useMemo<ChartSeries[]>(() => {
    const rawSeries = analyses.map((entry, index): ChartSeries => {
      const points = clippedSpectrum(entry.analysis.spectrum, xDomain);
      return {
        id: `${entry.waveform.sourceRecordId}-raw`,
        name: entry.label,
        ...points,
        style: componentSeriesStyle(entry.waveform.component, index),
        showInLegend: displayMode === 'raw',
        lineWidthPt: displayMode === 'raw' ? 0.65 : 0.5,
        opacity: displayMode === 'raw' ? 1 : 0.2,
      };
    });
    const smoothSeries = analyses.map((entry, index): ChartSeries => {
      const points = clippedSpectrum(smoothedSpectra[index], xDomain);
      return {
        id: smoothingMethod === 'parzen'
          ? `${entry.waveform.sourceRecordId}-parzen-${parzenBandwidthHz}`
          : `${entry.waveform.sourceRecordId}-ko-${konnoOhmachiBandwidth}`,
        name: entry.label,
        ...points,
        style: componentSeriesStyle(entry.waveform.component, index),
        showInLegend: true,
        lineWidthPt: 0.9,
      };
    });
    if (displayMode === 'raw') return rawSeries;
    if (displayMode === 'smoothed') return smoothSeries;
    return [...rawSeries, ...smoothSeries];
  }, [analyses, displayMode, konnoOhmachiBandwidth, parzenBandwidthHz, smoothedSpectra, smoothingMethod, xDomain]);

  const yDomain = useMemo(() => {
    const domainSeries = displayMode === 'smoothed-raw' && yRange === 'journal'
      ? series.slice(analyses.length)
      : series;
    return fourierYDomain(domainSeries, yRange);
  }, [analyses.length, displayMode, series, yRange]);

  const processingCaption = useMemo(() => {
    const windowLabel = timeWindow === 'cosine-5' ? '5% cosine edge taper' : 'rectangular window';
    const df = formatValueRange(analyses.map((entry) => entry.analysis.metadata.fftBinSpacingHz));
    const resolution = formatValueRange(analyses.map((entry) => entry.analysis.metadata.independentResolutionHz));
    const modeLabel = displayMode === 'raw'
      ? 'raw ordinates'
      : smoothingMethod === 'parzen'
        ? `ViewWave-style Parzen B=${formatParzenBandwidth(parzenBandwidthHz)} Hz on squared amplitude (power), followed by square-root amplitude recovery on the original FFT-bin grid${displayMode === 'smoothed-raw' ? '; raw ordinates faint' : ''}`
        : `Konno–Ohmachi b=${konnoOhmachiBandwidth} (${KONNO_OHMACHI_POINT_COUNT} log-spaced targets)${displayMode === 'smoothed-raw' ? '; raw ordinates faint' : ''}`;
    const priorProcessing = [...new Set(analyses.map((entry) => {
      const settings = entry.waveform.preprocessing;
      if (!settings) return 'upstream preprocessing unavailable';
      return preprocessingLabel(settings);
    }))].join(' / ');
    const dcTreatment = displayMode !== 'raw' && smoothingMethod === 'parzen'
      ? 'DC omitted from the plot but retained for Parzen edge treatment'
      : 'DC omitted';
    const ordinate = yRange === 'journal'
      ? displayMode === 'smoothed-raw'
        ? 'ordinate based on the smoothed peak minus four decades; faint raw diagnostics may clip at the plot boundary'
        : 'ordinate clipped at peak minus four decades'
      : 'all positive ordinates shown';
    return `Data: ${datasetLabel(analyses.map((entry) => entry.waveform))}. Upstream: ${priorProcessing}. Fourier stage: mean removed; ${windowLabel}; positive-frequency |DFT|Δt (${dcTreatment}, ×1, no record-length or window-gain normalization); FFT-bin df ${df} Hz; independent resolution ≈1/T ${resolution} Hz; display band ${formatFrequency(xDomain[0])}–${formatFrequency(xDomain[1])} Hz (common resolved viewer-analysis band); ${modeLabel}; ${ordinate}. Instrument/sensor response limits require external metadata.`;
  }, [analyses, displayMode, konnoOhmachiBandwidth, parzenBandwidthHz, smoothingMethod, timeWindow, xDomain, yRange]);

  const parzenBinsPerBandwidth = analyses.map((entry) => (
    entry.analysis.metadata.fftBinSpacingHz > 0
      ? parzenBandwidthHz / entry.analysis.metadata.fftBinSpacingHz
      : 0
  ));
  const parzenResolutionWarning = smoothingMethod === 'parzen'
    && displayMode !== 'raw'
    && parzenBinsPerBandwidth.some((value) => value > 0 && value < 2);

  const figureMetadata = useMemo(() => ({
    schema: 'strong-motion-fourier-spectrum/1.1',
    recordSet: selectedRecordSet?.label,
    provenance: buildFigureProvenance(analyses.map((entry) => entry.waveform)),
    quantity,
    spectrumDefinition: {
      meanRemoved: true,
      sidedness: 'positive-frequency half-spectrum; DC omitted; Nyquist retained',
      amplitude: '|DFT| * dt',
      oneSidedFactor: 1,
      recordLengthNormalization: false,
      windowGainCorrection: false,
      fourierStageFrequencyTaper: false,
      timeWindow: timeWindow === 'cosine-5' ? '5% cosine edge taper' : 'rectangular',
    },
    display: {
      mode: displayMode,
      yRange,
      ordinateBasis: displayMode === 'smoothed-raw' && yRange === 'journal'
        ? 'smoothed curves; faint raw diagnostics may be clipped'
        : 'all displayed curves',
      commonResolvedBandHz: xDomain,
      fallbackNonZeroSupportRelativeFloor: RELATIVE_SUPPORT_FLOOR,
    },
    smoothing: displayMode === 'raw'
      ? null
      : smoothingMethod === 'parzen'
        ? {
          method: 'Parzen',
          bandwidthHz: parzenBandwidthHz,
          bandwidthParameterUSeconds: 280 / (151 * parzenBandwidthHz),
          firstZeroOffsetHz: (151 * parzenBandwidthHz) / 140,
          domain: 'squared-amplitude power',
          amplitudeRecovery: 'square root after smoothing',
          kernel: '3u/4 * [sin(pi*u*deltaF/2)/(pi*u*deltaF/2)]^4',
          discreteNormalization: 'unit sum on two-sided FFT grid',
          boundaryTreatment: 'circular convolution of Hermitian two-sided spectrum',
          outputGrid: 'original positive FFT bins',
          binsPerBandwidth: parzenBinsPerBandwidth,
        }
        : {
          method: 'Konno-Ohmachi',
          bandwidth: konnoOhmachiBandwidth,
          outputCount: KONNO_OHMACHI_POINT_COUNT,
          kernel: '[sin(b log10(f/fc))/(b log10(f/fc))]^4',
          retainedZeroCrossingsEachSide: 4,
        },
    records: analyses.map((entry) => ({
      id: entry.waveform.sourceRecordId,
      fileName: entry.waveform.fileName,
      component: entry.label,
      upstreamPreprocessing: entry.waveform.preprocessing ?? null,
      ...entry.analysis.metadata,
    })),
  }), [analyses, displayMode, konnoOhmachiBandwidth, parzenBandwidthHz, parzenBinsPerBandwidth, quantity, selectedRecordSet?.label, smoothingMethod, timeWindow, xDomain, yRange]);

  const smoothingFileToken = smoothingMethod === 'parzen'
    ? `parzen${formatParzenBandwidth(parzenBandwidthHz).replace('.', 'p')}hz`
    : `ko${konnoOhmachiBandwidth}`;
  const timeWindowFileToken = timeWindow === 'cosine-5' ? 'taper5' : 'rectangular';

  if (waveforms.length === 0) return <p className="empty-state">No data is available for Fourier spectra.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        {recordSets.length > 1 && selectedRecordSet && (
          <label>
            Record set
            <select value={selectedRecordSet.id} onChange={(event) => setRecordSetId(event.target.value)}>
              {recordSets.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
            </select>
          </label>
        )}
        <label>
          Quantity
          <select value={quantity} onChange={(event) => setQuantity(event.target.value as Quantity)}>
            <option value="acceleration">Acceleration</option>
            <option value="velocity">Velocity</option>
            <option value="displacement">Displacement</option>
          </select>
        </label>
        <label>
          Display
          <select value={displayMode} onChange={(event) => setDisplayMode(event.target.value as FourierDisplayMode)}>
            <option value="smoothed-raw">Smoothed + faint raw</option>
            <option value="smoothed">Smoothed only</option>
            <option value="raw">Raw only</option>
          </select>
        </label>
        <label>
          Smoothing
          <select value={smoothingMethod} disabled={displayMode === 'raw'} onChange={(event) => setSmoothingMethod(event.target.value as FourierSmoothingMethod)}>
            <option value="parzen">Parzen · power-domain</option>
            <option value="konno-ohmachi">Konno–Ohmachi · log-frequency</option>
          </select>
        </label>
        {smoothingMethod === 'parzen' ? (
          <label>
            Parzen width
            <select value={parzenBandwidthHz} disabled={displayMode === 'raw'} onChange={(event) => setParzenBandwidthHz(Number(event.target.value))}>
              <option value={0.05}>0.05 Hz · narrower</option>
              <option value={0.1}>0.10 Hz · default</option>
              <option value={0.2}>0.20 Hz · broader</option>
              <option value={0.4}>0.40 Hz · broadest</option>
            </select>
          </label>
        ) : (
          <label>
            KO bandwidth
            <select value={konnoOhmachiBandwidth} disabled={displayMode === 'raw'} onChange={(event) => setKonnoOhmachiBandwidth(Number(event.target.value))}>
              <option value={20}>20 · broader</option>
              <option value={40}>40 · standard</option>
              <option value={60}>60 · narrower</option>
            </select>
          </label>
        )}
        <label>
          Time window
          <select value={timeWindow} onChange={(event) => setTimeWindow(event.target.value as FourierWindow)}>
            <option value="cosine-5">Cosine · 5% each edge</option>
            <option value="rectangular">Rectangular</option>
          </select>
        </label>
        <label>
          Y Range
          <select value={yRange} onChange={(event) => setYRange(event.target.value as FourierYRange)}>
            <option value="journal">Peak − 4 decades</option>
            <option value="full">All positive values</option>
          </select>
        </label>
        <span className="note">The frequency axis is the common resolved viewer-analysis band from record duration, sampling, and active preprocessing; instrument response limits require external metadata.</span>
        {parzenResolutionWarning && (
          <span className="note warning">The selected Parzen width spans fewer than two FFT bins for at least one record. Use a longer record or a wider bandwidth for effective smoothing.</span>
        )}
      </div>
      <SvgChart
        title={`Fourier Amplitude Spectrum: ${quantityLabel(quantity)}`}
        xLabel="Frequency [Hz]"
        yLabel={`Amplitude [${fourierUnitForQuantity(quantity)}]`}
        series={series}
        xScale="log"
        yScale="log"
        domainX={xDomain}
        domainY={yDomain}
        fileNameBase={`fourier_${quantity}_${displayMode}${displayMode === 'raw' ? '' : `_${smoothingFileToken}`}_${timeWindowFileToken}_${yRange}${exportRecordSetSuffix}`}
        height={460}
        cornerNote={displayMode === 'raw'
          ? `${timeWindow === 'cosine-5' ? '5% cosine taper' : 'rectangular window'}; raw FAS`
          : smoothingMethod === 'parzen'
            ? `Parzen B=${formatParzenBandwidth(parzenBandwidthHz)} Hz; power-domain${displayMode === 'smoothed-raw' ? '; faint = raw' : ''}`
            : `Konno–Ohmachi b=${konnoOhmachiBandwidth}${displayMode === 'smoothed-raw' ? '; faint = raw' : ''}`}
        caption={processingCaption}
        metadata={figureMetadata}
        description={`Positive-frequency Fourier amplitude spectra of ${quantityLabel(quantity).toLowerCase()}. The plotted common resolved band is ${formatFrequency(xDomain[0])} to ${formatFrequency(xDomain[1])} Hz. ${processingCaption}`}
      />
    </div>
  );
}
