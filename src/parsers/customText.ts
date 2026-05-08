import type { ComponentCode, ParseResult, Quantity, WaveformRecord } from '../types/waveform';
import { makeId } from '../utils/file';

export type CustomTextDelimiter = 'auto' | 'comma' | 'tab' | 'semicolon' | 'space';

export interface CustomTextColumnConfig {
  component: ComponentCode;
  column: number;
  label?: string;
}

export interface CustomTextParseConfig {
  headerLines: number;
  delimiter: CustomTextDelimiter;
  dt: number;
  amplitudeScale: number;
  quantity: Quantity;
  timeColumn?: number;
  columns: CustomTextColumnConfig[];
}

export interface CustomTextLayout {
  delimiter: Exclude<CustomTextDelimiter, 'auto'>;
  columnCount: number;
  dataLineCount: number;
  previewRows: string[][];
}

function isNumericToken(token: string): boolean {
  if (token.trim() === '') return false;
  return Number.isFinite(Number(token));
}

function concreteDelimiter(delimiter: CustomTextDelimiter, lines: readonly string[]): Exclude<CustomTextDelimiter, 'auto'> {
  if (delimiter !== 'auto') return delimiter;

  const sample = lines.slice(0, 20).join('\n');
  const comma = (sample.match(/,/g) ?? []).length;
  const tab = (sample.match(/\t/g) ?? []).length;
  const semicolon = (sample.match(/;/g) ?? []).length;

  if (comma >= tab && comma >= semicolon && comma > 0) return 'comma';
  if (tab >= comma && tab >= semicolon && tab > 0) return 'tab';
  if (semicolon > 0) return 'semicolon';
  return 'space';
}

function splitLine(line: string, delimiter: Exclude<CustomTextDelimiter, 'auto'>): string[] {
  if (delimiter === 'comma') return line.split(',').map((value) => value.trim());
  if (delimiter === 'tab') return line.split('\t').map((value) => value.trim());
  if (delimiter === 'semicolon') return line.split(';').map((value) => value.trim());
  return line.trim().split(/\s+/).map((value) => value.trim());
}

function medianDiff(values: readonly number[]): number | undefined {
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }
  if (diffs.length === 0) return undefined;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function unitForQuantity(quantity: Quantity): string {
  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function componentLabel(component: ComponentCode, fallback: string): string {
  return component === 'OTHER' ? fallback || 'OTHER' : component;
}

function usefulLines(text: string, headerLines: number): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(Math.max(0, Math.floor(headerLines)))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function detectCustomTextLayout(
  text: string,
  headerLines: number,
  delimiter: CustomTextDelimiter,
): CustomTextLayout {
  const lines = usefulLines(text, headerLines);
  const resolvedDelimiter = concreteDelimiter(delimiter, lines);
  const previewRows: string[][] = [];
  let columnCount = 0;
  let dataLineCount = 0;

  for (const line of lines) {
    const tokens = splitLine(line, resolvedDelimiter);
    if (tokens.length === 0 || tokens.every((token) => !isNumericToken(token))) continue;
    dataLineCount += 1;
    columnCount = Math.max(columnCount, tokens.length);
    if (previewRows.length < 5) previewRows.push(tokens);
  }

  return {
    delimiter: resolvedDelimiter,
    columnCount,
    dataLineCount,
    previewRows,
  };
}

export function parseCustomTextFile(fileName: string, text: string, config: CustomTextParseConfig): ParseResult {
  const warnings: string[] = [];
  const layout = detectCustomTextLayout(text, config.headerLines, config.delimiter);
  const lines = usefulLines(text, config.headerLines);
  const rows: number[][] = [];

  for (const line of lines) {
    const tokens = splitLine(line, layout.delimiter);
    const row = tokens.map((token) => Number(token));
    if (row.length === 0 || row.every((value) => !Number.isFinite(value))) continue;
    rows.push(row);
  }

  if (rows.length === 0) {
    return { records: [], warnings: [`${fileName}: No numeric data rows were found with the manual format settings.`] };
  }

  let dt = config.dt;
  const timeColumnIndex = config.timeColumn && config.timeColumn > 0 ? Math.floor(config.timeColumn) - 1 : undefined;

  if (timeColumnIndex !== undefined) {
    const timeValues = rows.map((row) => row[timeColumnIndex]).filter((value) => Number.isFinite(value));
    const inferredDt = medianDiff(timeValues);
    if (inferredDt && inferredDt > 0) {
      dt = inferredDt;
    } else {
      warnings.push(`${fileName}: Could not infer dt from the selected time column. Using manual dt.`);
    }
  }

  if (!Number.isFinite(dt) || dt <= 0) {
    dt = 0.01;
    warnings.push(`${fileName}: Invalid dt. Using 0.01 s.`);
  }

  const samplingHz = 1 / dt;
  const scale = Number.isFinite(config.amplitudeScale) ? config.amplitudeScale : 1;
  const records: WaveformRecord[] = [];
  const seenColumns = new Set<number>();

  for (const columnConfig of config.columns) {
    const column = Math.floor(columnConfig.column);
    if (!Number.isFinite(column) || column <= 0 || seenColumns.has(column)) continue;
    seenColumns.add(column);
    const columnIndex = column - 1;
    const values = rows
      .map((row) => row[columnIndex])
      .filter((value) => Number.isFinite(value))
      .map((value) => value * scale);

    if (values.length < 2) {
      warnings.push(`${fileName}: Column ${column} did not contain enough numeric samples.`);
      continue;
    }

    const label = columnConfig.label || componentLabel(columnConfig.component, `col${column}`);
    records.push({
      id: makeId('wf'),
      fileName: records.length === 0 ? fileName : `${fileName}#${label}`,
      sourceType: 'custom',
      component: columnConfig.component,
      componentLabel: label,
      quantity: config.quantity,
      unit: unitForQuantity(config.quantity),
      values,
      dt,
      samplingHz,
      metadata: {
        customFormat: 'manual-text',
        customDelimiter: layout.delimiter,
        customHeaderLines: config.headerLines,
        customTimeColumn: config.timeColumn,
        customValueColumn: column,
        customAmplitudeScale: scale,
      },
      notes: [
        `manual text import`,
        `delimiter: ${layout.delimiter}`,
        `header lines: ${config.headerLines}`,
        `amplitude scale: ${scale}`,
        timeColumnIndex !== undefined ? `dt inferred/manual from column ${config.timeColumn}: ${dt}s` : `manual dt: ${dt}s`,
      ],
    });
  }

  if (records.length === 0) warnings.push(`${fileName}: No waveform columns were imported. Check column numbers and delimiter.`);

  return { records, warnings };
}
