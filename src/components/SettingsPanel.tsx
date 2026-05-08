import type { AppSettings, Quantity } from '../types/waveform';

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps): JSX.Element {
  const update = (patch: Partial<AppSettings>): void => onChange({ ...settings, ...patch });

  return (
    <section className="panel settings-panel">
      <h2>Analysis Settings</h2>
      <div className="settings-grid">
        <label>
          Default CSV Sampling Frequency [Hz]
          <input
            type="number"
            min="0.001"
            step="1"
            value={settings.csv.defaultSamplingHz}
            onChange={(event) => update({ csv: { ...settings.csv, defaultSamplingHz: Number(event.target.value) || 100 } })}
          />
        </label>
        <label>
          Default CSV Quantity
          <select
            value={settings.csv.defaultQuantity}
            onChange={(event) => update({ csv: { ...settings.csv, defaultQuantity: event.target.value as Quantity } })}
          >
            <option value="acceleration">Acceleration</option>
            <option value="velocity">Velocity</option>
            <option value="displacement">Displacement</option>
          </select>
        </label>
        <label>
          Response Spectrum Damping Ratio
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={settings.responseSpectrum.dampingRatio}
            onChange={(event) => update({ responseSpectrum: { ...settings.responseSpectrum, dampingRatio: Number(event.target.value) || 0 } })}
          />
        </label>
        <label>
          Minimum Period [s]
          <input
            type="number"
            min="0.001"
            step="0.01"
            value={settings.responseSpectrum.minPeriod}
            onChange={(event) => update({ responseSpectrum: { ...settings.responseSpectrum, minPeriod: Number(event.target.value) || 0.02 } })}
          />
        </label>
        <label>
          Maximum Period [s]
          <input
            type="number"
            min="0.01"
            step="0.1"
            value={settings.responseSpectrum.maxPeriod}
            onChange={(event) => update({ responseSpectrum: { ...settings.responseSpectrum, maxPeriod: Number(event.target.value) || 10 } })}
          />
        </label>
        <label>
          Period Count
          <input
            type="number"
            min="10"
            max="1000"
            step="10"
            value={settings.responseSpectrum.periodCount}
            onChange={(event) => update({ responseSpectrum: { ...settings.responseSpectrum, periodCount: Number(event.target.value) || 500 } })}
          />
        </label>
      </div>
      <div className="checkbox-grid">
        <label><input type="checkbox" checked={settings.preprocess.removeMean} onChange={(event) => update({ preprocess: { ...settings.preprocess, removeMean: event.target.checked } })} /> Remove Mean</label>
        <label><input type="checkbox" checked={settings.preprocess.detrend} onChange={(event) => update({ preprocess: { ...settings.preprocess, detrend: event.target.checked } })} /> Remove Linear Trend</label>
        <label><input type="checkbox" checked={settings.preprocess.correctIntegrationDrift} onChange={(event) => update({ preprocess: { ...settings.preprocess, correctIntegrationDrift: event.target.checked } })} /> Correct Integration Drift</label>
        <label><input type="checkbox" checked={settings.preprocess.applyHighpass} onChange={(event) => update({ preprocess: { ...settings.preprocess, applyHighpass: event.target.checked } })} /> FFT Cosine-taper High-pass</label>
        <label>
          High-pass Cutoff [Hz]
          <input
            type="number"
            min="0"
            step="0.01"
            value={settings.preprocess.highpassHz}
            onChange={(event) => update({ preprocess: { ...settings.preprocess, highpassHz: Number(event.target.value) || 0 } })}
          />
        </label>
        <label><input type="checkbox" checked={settings.preprocess.applyLowpass} onChange={(event) => update({ preprocess: { ...settings.preprocess, applyLowpass: event.target.checked } })} /> FFT Cosine-taper Low-pass</label>
        <label>
          Low-pass Cutoff [Hz]
          <input
            type="number"
            min="0"
            step="0.1"
            value={settings.preprocess.lowpassHz}
            onChange={(event) => update({ preprocess: { ...settings.preprocess, lowpassHz: Number(event.target.value) || 0 } })}
          />
        </label>
      </div>
    </section>
  );
}
