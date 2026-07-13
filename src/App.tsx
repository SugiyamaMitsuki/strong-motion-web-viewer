import { useMemo, useState } from 'react';
import { buildDerivedWaveforms } from './analysis/derive';
import { computeJmaIntensity } from './analysis/jmaIntensity';
import { computePeakSummary } from './analysis/peaks';
import { DropZone } from './components/DropZone';
import { ExportPanel } from './components/ExportPanel';
import { FourierPanel } from './components/FourierPanel';
import { HorizontalVerticalRatioPanel } from './components/HorizontalVerticalRatioPanel';
import { ManualFormatImportPanel, type PendingManualFormatFile } from './components/ManualFormatImportPanel';
import { ParticleOrbitPanel } from './components/ParticleOrbitPanel';
import { RecordTable } from './components/RecordTable';
import { ReportFigurePanel } from './components/ReportFigurePanel';
import { ResponseSpectrumPanel } from './components/ResponseSpectrumPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SummaryPanel } from './components/SummaryPanel';
import { TimeHistoryPanel } from './components/TimeHistoryPanel';
import { WaveletPanel } from './components/WaveletPanel';
import { parseWaveformFile } from './parsers';
import type { AppSettings, WaveformRecord } from './types/waveform';
import { isSupportedWaveformFileName, makeId, readFileAsText } from './utils/file';
import './styles.css';

type TabKey = 'summary' | 'time' | 'orbit' | 'fourier' | 'wavelet' | 'hvsr' | 'response' | 'report' | 'export';

const defaultSettings: AppSettings = {
  csv: {
    defaultSamplingHz: 100,
    defaultQuantity: 'acceleration',
  },
  preprocess: {
    removeMean: true,
    detrend: true,
    applyHighpass: true,
    highpassHz: 0.05,
    applyLowpass: true,
    lowpassHz: 20,
    correctIntegrationDrift: true,
  },
  responseSpectrum: {
    dampingRatio: 0.05,
    minPeriod: 0.02,
    maxPeriod: 10,
    periodCount: 500,
  },
};

const jmaInputSettings: AppSettings['preprocess'] = {
  removeMean: false,
  detrend: false,
  applyHighpass: false,
  highpassHz: 0.05,
  applyLowpass: false,
  lowpassHz: 20,
  correctIntegrationDrift: false,
};

function tabLabel(tab: TabKey): string {
  switch (tab) {
    case 'summary': return 'Summary';
    case 'time': return 'Time History';
    case 'orbit': return 'Orbit';
    case 'fourier': return 'Fourier';
    case 'wavelet': return 'Wavelet';
    case 'hvsr': return 'H/V Ratio';
    case 'response': return 'Response Spectrum';
    case 'report': return 'Report Figure';
    case 'export': return 'Export';
  }
}

function isIgnoredImportFile(fileName: string): boolean {
  const baseName = fileName.split('/').pop() ?? fileName;
  if (baseName.startsWith('.')) return true;
  return /\.(png|jpe?g|gif|pdf|zip|gz|tar|xlsx?|docx?|pptx?)$/i.test(baseName);
}

function looksLikeBinaryText(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (sample.includes('\0')) return true;
  if (sample.length === 0) return false;
  const controlCount = Array.from(sample).filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  }).length;
  return controlCount / sample.length > 0.08;
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [records, setRecords] = useState<WaveformRecord[]>([]);
  const [manualFiles, setManualFiles] = useState<PendingManualFormatFile[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('summary');
  const [loading, setLoading] = useState(false);

  const derivedWaveforms = useMemo(() => buildDerivedWaveforms(records, settings.preprocess), [records, settings.preprocess]);
  const jmaWaveforms = useMemo(() => buildDerivedWaveforms(records, jmaInputSettings), [records]);
  const peaks = useMemo(() => computePeakSummary(derivedWaveforms), [derivedWaveforms]);
  const intensity = useMemo(() => computeJmaIntensity(jmaWaveforms), [jmaWaveforms]);

  const parseFiles = async (files: File[]): Promise<void> => {
    setLoading(true);
    try {
      const nextRecords: WaveformRecord[] = [];
      const nextWarnings: string[] = [];
      const nextManualFiles: PendingManualFormatFile[] = [];

      for (const file of files) {
        if (isIgnoredImportFile(file.name)) {
          nextWarnings.push(`${file.name}: skipped non-waveform file.`);
          continue;
        }

        try {
          const text = await readFileAsText(file);
          if (looksLikeBinaryText(text)) {
            nextWarnings.push(`${file.name}: skipped binary-looking file.`);
            continue;
          }

          if (!isSupportedWaveformFileName(file.name)) {
            nextManualFiles.push({
              id: makeId('manual'),
              fileName: file.name,
              text,
              reason: 'Unknown extension',
            });
            continue;
          }

          const result = parseWaveformFile(file.name, text, settings.csv);
          if (result.records.length > 0) {
            nextRecords.push(...result.records);
            nextWarnings.push(...result.warnings);
          } else {
            nextManualFiles.push({
              id: makeId('manual'),
              fileName: file.name,
              text,
              reason: result.warnings[0] ?? 'Auto parsing failed',
            });
            nextWarnings.push(...result.warnings);
          }
        } catch (error) {
          try {
            const text = await readFileAsText(file);
            nextManualFiles.push({
              id: makeId('manual'),
              fileName: file.name,
              text,
              reason: (error as Error).message,
            });
          } catch {
            nextWarnings.push(`${file.name}: ${(error as Error).message}`);
          }
        }
      }

      setRecords((current) => [...current, ...nextRecords]);
      setManualFiles((current) => [...current, ...nextManualFiles]);
      setWarnings((current) => [...nextWarnings, ...current].slice(0, 50));
      if (nextRecords.length > 0) setActiveTab('summary');
    } finally {
      setLoading(false);
    }
  };

  const loadSample = async (): Promise<void> => {
    setLoading(true);
    try {
      const sampleNames = [
        'KNG0012408091957.NS',
        'KNG0012408091957.EW',
        'KNG0012408091957.UD',
      ];
      const nextRecords: WaveformRecord[] = [];
      const nextWarnings: string[] = [];

      for (const sampleName of sampleNames) {
        const url = `${import.meta.env.BASE_URL}samples/knet/${sampleName}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${sampleName}: sample fetch failed: ${response.status}`);
        const text = await response.text();
        const result = parseWaveformFile(sampleName, text, settings.csv);
        nextRecords.push(...result.records);
        nextWarnings.push(...result.warnings);
      }

      setRecords((current) => [...current, ...nextRecords]);
      setWarnings((current) => [...nextWarnings, ...current].slice(0, 50));
      setActiveTab('summary');
    } catch (error) {
      setWarnings((current) => [`Sample loading failed: ${(error as Error).message}`, ...current].slice(0, 50));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <h1>Strong Motion Web Viewer</h1>
          <p>Analyze K-NET, KiK-net, and CSV waveform data entirely in the browser. Files are not uploaded to a server.</p>
        </div>
        <div className="hero-actions">
          <button type="button" onClick={() => void loadSample()} disabled={loading}>Load Real Sample</button>
        </div>
      </header>

      <DropZone onFiles={(files) => void parseFiles(files)} loading={loading} />
      <ManualFormatImportPanel
        files={manualFiles}
        onImport={(fileId, importedRecords, importWarnings) => {
          setRecords((current) => [...current, ...importedRecords]);
          setManualFiles((current) => current.filter((file) => file.id !== fileId));
          setWarnings((current) => [...importWarnings, ...current].slice(0, 50));
          setActiveTab('summary');
        }}
        onRemove={(fileId) => setManualFiles((current) => current.filter((file) => file.id !== fileId))}
        onWarnings={(manualWarnings) => setWarnings((current) => [...manualWarnings, ...current].slice(0, 50))}
      />
      <SettingsPanel settings={settings} onChange={setSettings} />

      {warnings.length > 0 && (
        <section className="panel warnings">
          <div className="panel-header">
            <h2>Warnings / Log</h2>
            <button type="button" className="secondary" onClick={() => setWarnings([])}>Clear</button>
          </div>
          <ul>
            {warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
          </ul>
        </section>
      )}

      <RecordTable records={records} onRecordsChange={setRecords} />

      <section className="panel analysis-panel">
        <nav className="tabs" aria-label="Analysis views">
          {(['summary', 'time', 'orbit', 'fourier', 'wavelet', 'hvsr', 'response', 'report', 'export'] as TabKey[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={activeTab === tab ? 'active' : ''}
              onClick={() => setActiveTab(tab)}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </nav>

        <div className="tab-content">
          {activeTab === 'summary' && <SummaryPanel records={records} onRecordsChange={setRecords} peaks={peaks} intensity={intensity} />}
          {activeTab === 'time' && <TimeHistoryPanel waveforms={derivedWaveforms} />}
          {activeTab === 'orbit' && <ParticleOrbitPanel waveforms={derivedWaveforms} />}
          {activeTab === 'fourier' && <FourierPanel waveforms={derivedWaveforms} />}
          {activeTab === 'wavelet' && <WaveletPanel waveforms={derivedWaveforms} />}
          {activeTab === 'hvsr' && <HorizontalVerticalRatioPanel waveforms={derivedWaveforms} />}
          {activeTab === 'response' && <ResponseSpectrumPanel waveforms={derivedWaveforms} settings={settings.responseSpectrum} />}
          {activeTab === 'report' && (
            <ReportFigurePanel
              waveforms={derivedWaveforms}
              jmaWaveforms={jmaWaveforms}
              peaks={peaks}
              responseSettings={settings.responseSpectrum}
            />
          )}
          {activeTab === 'export' && (
            <ExportPanel
              waveforms={derivedWaveforms}
              responseSettings={settings.responseSpectrum}
              peaks={peaks}
              intensity={intensity}
            />
          )}
        </div>
      </section>
    </div>
  );
}
