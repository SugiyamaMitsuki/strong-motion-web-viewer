import { useEffect, useMemo, useState } from 'react';
import { detectCustomTextLayout, parseCustomTextFile, type CustomTextDelimiter, type CustomTextParseConfig } from '../parsers/customText';
import type { ComponentCode, Quantity, WaveformRecord } from '../types/waveform';

export interface PendingManualFormatFile {
  id: string;
  fileName: string;
  text: string;
  reason: string;
}

interface ManualFormatImportPanelProps {
  files: PendingManualFormatFile[];
  onImport: (fileId: string, records: WaveformRecord[], warnings: string[]) => void;
  onRemove: (fileId: string) => void;
  onWarnings: (warnings: string[]) => void;
}

interface ManualFormState {
  headerLines: string;
  delimiter: CustomTextDelimiter;
  dt: string;
  amplitudeScale: string;
  quantity: Quantity;
  timeColumn: string;
  nsColumn: string;
  ewColumn: string;
  udColumn: string;
  otherColumn: string;
  otherLabel: string;
}

function splitForInference(line: string): string[] {
  if (line.includes(',')) return line.split(',').map((value) => value.trim());
  if (line.includes('\t')) return line.split('\t').map((value) => value.trim());
  if (line.includes(';')) return line.split(';').map((value) => value.trim());
  return line.trim().split(/\s+/).map((value) => value.trim());
}

function numericCount(tokens: readonly string[]): number {
  return tokens.filter((token) => Number.isFinite(Number(token))).length;
}

function inferHeaderLines(text: string): number {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (numericCount(splitForInference(line)) >= 1) return i;
  }
  return 0;
}

function inferFileComponent(fileName: string): ComponentCode | undefined {
  const upper = fileName.toUpperCase();
  const match = upper.match(/(?:^|[._\-\s/])(NS|EW|UD)(?:\d*)?(?:$|[._\-\s])/);
  if (!match) return undefined;
  return match[1] as ComponentCode;
}

function firstColumnLooksLikeTime(previewRows: readonly string[][]): boolean {
  const values = previewRows
    .map((row) => Number(row[0]))
    .filter((value) => Number.isFinite(value));
  if (values.length < 3) return false;
  return values[1] > values[0] && values[2] > values[1];
}

function numberText(value: number | undefined, fallback = ''): string {
  return Number.isFinite(value) ? String(value) : fallback;
}

function initialFormFor(file: PendingManualFormatFile): ManualFormState {
  const headerLines = inferHeaderLines(file.text);
  const layout = detectCustomTextLayout(file.text, headerLines, 'auto');
  const hasTime = firstColumnLooksLikeTime(layout.previewRows) && layout.columnCount >= 2;
  const firstValueColumn = hasTime ? 2 : 1;
  const inferredComponent = inferFileComponent(file.fileName);

  let nsColumn = '';
  let ewColumn = '';
  let udColumn = '';
  let otherColumn = '';

  if (inferredComponent === 'NS') nsColumn = numberText(firstValueColumn);
  else if (inferredComponent === 'EW') ewColumn = numberText(firstValueColumn);
  else if (inferredComponent === 'UD') udColumn = numberText(firstValueColumn);
  else if (layout.columnCount >= firstValueColumn + 2) {
    nsColumn = numberText(firstValueColumn);
    ewColumn = numberText(firstValueColumn + 1);
    udColumn = numberText(firstValueColumn + 2);
  } else if (layout.columnCount >= firstValueColumn) {
    otherColumn = numberText(firstValueColumn);
  }

  return {
    headerLines: String(headerLines),
    delimiter: 'auto',
    dt: '0.01',
    amplitudeScale: '1',
    quantity: 'acceleration',
    timeColumn: hasTime ? '1' : '',
    nsColumn,
    ewColumn,
    udColumn,
    otherColumn,
    otherLabel: inferredComponent ?? 'OTHER',
  };
}

function parseOptionalColumn(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function buildConfig(form: ManualFormState): CustomTextParseConfig {
  const columns: CustomTextParseConfig['columns'] = [];
  const addColumn = (component: ComponentCode, value: string, label?: string): void => {
    const column = parseOptionalColumn(value);
    if (!column) return;
    columns.push({ component, column, label });
  };

  addColumn('NS', form.nsColumn, 'NS');
  addColumn('EW', form.ewColumn, 'EW');
  addColumn('UD', form.udColumn, 'UD');
  addColumn('OTHER', form.otherColumn, form.otherLabel.trim() || 'OTHER');

  return {
    headerLines: Math.max(0, Math.floor(Number(form.headerLines) || 0)),
    delimiter: form.delimiter,
    dt: Number(form.dt) || 0.01,
    amplitudeScale: Number(form.amplitudeScale) || 1,
    quantity: form.quantity,
    timeColumn: parseOptionalColumn(form.timeColumn),
    columns,
  };
}

export function ManualFormatImportPanel({
  files,
  onImport,
  onRemove,
  onWarnings,
}: ManualFormatImportPanelProps): JSX.Element | null {
  const [selectedId, setSelectedId] = useState<string>('');
  const selectedFile = files.find((file) => file.id === selectedId) ?? files[0];
  const [form, setForm] = useState<ManualFormState>(() => (selectedFile ? initialFormFor(selectedFile) : initialFormFor({
    id: 'empty',
    fileName: 'empty',
    text: '',
    reason: '',
  })));

  useEffect(() => {
    if (files.length === 0) return;
    if (!selectedId || !files.some((file) => file.id === selectedId)) {
      setSelectedId(files[0].id);
    }
  }, [files, selectedId]);

  useEffect(() => {
    if (selectedFile) setForm(initialFormFor(selectedFile));
  }, [selectedFile?.id]);

  const config = useMemo(() => buildConfig(form), [form]);
  const layout = useMemo(() => {
    if (!selectedFile) return undefined;
    return detectCustomTextLayout(selectedFile.text, config.headerLines, config.delimiter);
  }, [selectedFile, config.headerLines, config.delimiter]);

  if (files.length === 0 || !selectedFile || !layout) return null;

  const update = (patch: Partial<ManualFormState>): void => setForm((current) => ({ ...current, ...patch }));
  const importCurrent = (): void => {
    const result = parseCustomTextFile(selectedFile.fileName, selectedFile.text, config);
    if (result.records.length > 0) {
      onImport(selectedFile.id, result.records, result.warnings);
    } else {
      onWarnings(result.warnings);
    }
  };

  return (
    <section className="panel manual-import-panel">
      <div className="panel-header">
        <div>
          <h2>Manual Format Import</h2>
          <p className="note">These files need format settings before import. Column numbers are 1-based.</p>
        </div>
        <button type="button" className="secondary" onClick={() => onRemove(selectedFile.id)}>Remove File</button>
      </div>

      <div className="manual-import-layout">
        <div className="manual-file-list">
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              className={file.id === selectedFile.id ? 'active' : ''}
              aria-pressed={file.id === selectedFile.id}
              onClick={() => setSelectedId(file.id)}
            >
              <span>{file.fileName}</span>
              <small>{file.reason}</small>
            </button>
          ))}
        </div>

        <div className="manual-format-editor">
          <div className="manual-format-grid">
            <label>
              Header Lines
              <input type="number" min="0" step="1" value={form.headerLines} onChange={(event) => update({ headerLines: event.target.value })} />
            </label>
            <label>
              Delimiter
              <select value={form.delimiter} onChange={(event) => update({ delimiter: event.target.value as CustomTextDelimiter })}>
                <option value="auto">Auto</option>
                <option value="space">Space</option>
                <option value="comma">Comma</option>
                <option value="tab">Tab</option>
                <option value="semicolon">Semicolon</option>
              </select>
            </label>
            <label>
              Time Column
              <input type="number" min="1" step="1" placeholder="blank" value={form.timeColumn} onChange={(event) => update({ timeColumn: event.target.value })} />
            </label>
            <label>
              dt [s]
              <input type="number" min="0.000001" step="0.001" value={form.dt} onChange={(event) => update({ dt: event.target.value })} />
            </label>
            <label>
              Amplitude Scale
              <input type="number" step="any" value={form.amplitudeScale} onChange={(event) => update({ amplitudeScale: event.target.value })} />
            </label>
            <label>
              Quantity
              <select value={form.quantity} onChange={(event) => update({ quantity: event.target.value as Quantity })}>
                <option value="acceleration">Acceleration</option>
                <option value="velocity">Velocity</option>
                <option value="displacement">Displacement</option>
              </select>
            </label>
          </div>

          <div className="manual-format-grid column-grid">
            <label>
              NS Column
              <input type="number" min="1" step="1" placeholder="blank" value={form.nsColumn} onChange={(event) => update({ nsColumn: event.target.value })} />
            </label>
            <label>
              EW Column
              <input type="number" min="1" step="1" placeholder="blank" value={form.ewColumn} onChange={(event) => update({ ewColumn: event.target.value })} />
            </label>
            <label>
              UD Column
              <input type="number" min="1" step="1" placeholder="blank" value={form.udColumn} onChange={(event) => update({ udColumn: event.target.value })} />
            </label>
            <label>
              Other Column
              <input type="number" min="1" step="1" placeholder="blank" value={form.otherColumn} onChange={(event) => update({ otherColumn: event.target.value })} />
            </label>
            <label>
              Other Label
              <input type="text" value={form.otherLabel} onChange={(event) => update({ otherLabel: event.target.value })} />
            </label>
          </div>

          <div className="manual-import-summary">
            <span>Detected delimiter: <strong>{layout.delimiter}</strong></span>
            <span>Detected columns: <strong>{layout.columnCount || '-'}</strong></span>
            <span>Numeric rows: <strong>{layout.dataLineCount.toLocaleString()}</strong></span>
          </div>

          <div className="table-wrapper preview-table-wrapper">
            <table className="preview-table">
              <caption className="sr-only">Preview of the detected columns in {selectedFile.fileName}</caption>
              <thead>
                <tr>
                  {Array.from({ length: Math.max(1, layout.columnCount) }, (_, index) => (
                    <th key={`col-${index + 1}`} scope="col">Col {index + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {layout.previewRows.map((row, rowIndex) => (
                  <tr key={`preview-${rowIndex}`}>
                    {Array.from({ length: Math.max(1, layout.columnCount) }, (_, columnIndex) => (
                      <td key={`preview-${rowIndex}-${columnIndex}`}>{row[columnIndex] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="button-row">
            <button type="button" onClick={importCurrent}>Import Current File</button>
          </div>
        </div>
      </div>
    </section>
  );
}
