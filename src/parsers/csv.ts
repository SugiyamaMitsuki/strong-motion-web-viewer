import type { ComponentCode, CsvParseOptions, ParseResult, Quantity, WaveformRecord } from '../types/waveform';
import { makeId } from '../utils/file';

interface ParsedTable {
  headers: string[];
  rows: number[][];
  hasHeader: boolean;
}

function isNumericToken(token: string): boolean {
  if (token.trim() === '') return false;
  return Number.isFinite(Number(token));
}

function chooseDelimiter(lines: string[]): 'comma' | 'tab' | 'semicolon' | 'space' {
  const sample = lines.slice(0, 10).join('\n');
  const comma = (sample.match(/,/g) ?? []).length;
  const tab = (sample.match(/\t/g) ?? []).length;
  const semicolon = (sample.match(/;/g) ?? []).length;

  if (comma >= tab && comma >= semicolon && comma > 0) return 'comma';
  if (tab >= comma && tab >= semicolon && tab > 0) return 'tab';
  if (semicolon > 0) return 'semicolon';
  return 'space';
}

function splitLine(line: string, delimiter: ReturnType<typeof chooseDelimiter>): string[] {
  if (delimiter === 'comma') return line.split(',').map((v) => v.trim());
  if (delimiter === 'tab') return line.split('\t').map((v) => v.trim());
  if (delimiter === 'semicolon') return line.split(';').map((v) => v.trim());
  return line.trim().split(/\s+/).map((v) => v.trim());
}

function parseTable(text: string): ParsedTable {
  const usefulLines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (usefulLines.length === 0) return { headers: [], rows: [], hasHeader: false };

  const delimiter = chooseDelimiter(usefulLines);
  const first = splitLine(usefulLines[0], delimiter);
  const hasHeader = first.some((token) => !isNumericToken(token));
  const headers = hasHeader ? first : first.map((_, i) => `col${i + 1}`);
  const rows: number[][] = [];

  const start = hasHeader ? 1 : 0;
  for (let i = start; i < usefulLines.length; i += 1) {
    const tokens = splitLine(usefulLines[i], delimiter);
    const row = tokens.map((token) => Number(token));
    if (row.length === 0 || row.every((value) => !Number.isFinite(value))) continue;
    rows.push(row);
  }

  return { headers, rows, hasHeader };
}

function inferQuantity(header: string, fallback: Quantity): Quantity {
  const h = header.toLowerCase();
  if (/acc|accel|acceleration|加速度|gal|cm\s*\/\s*s\^?2|cm\s*\/\s*s2|m\s*\/\s*s\^?2|m\s*\/\s*s2/.test(h)) return 'acceleration';
  if (/vel|velocity|速度|cm\s*\/\s*s|m\s*\/\s*s|mm\s*\/\s*s/.test(h)) return 'velocity';
  if (/disp|displacement|変位|変形|\bcm\b|\bmm\b|\bm\b/.test(h)) return 'displacement';
  return fallback;
}

function inferComponent(header: string, columnIndex: number): ComponentCode {
  const h = header.toUpperCase();
  if (/\bNS\b|N-S|NORTH|北/.test(h)) return 'NS';
  if (/\bEW\b|E-W|EAST|東/.test(h)) return 'EW';
  if (/\bUD\b|U-D|UP|VERT|Z|上下/.test(h)) return 'UD';
  if (columnIndex === 0) return 'NS';
  if (columnIndex === 1) return 'EW';
  if (columnIndex === 2) return 'UD';
  return 'OTHER';
}

function componentLabel(component: ComponentCode, header: string): string {
  if (component !== 'OTHER') return component;
  return header || 'OTHER';
}

function inferUnit(header: string, quantity: Quantity): string {
  const h = header.toLowerCase();
  if (/m\s*\/\s*s\^?2|m\s*\/\s*s2/.test(h)) return 'm/s²';
  if (/gal|cm\s*\/\s*s\^?2|cm\s*\/\s*s2/.test(h)) return 'cm/s²';
  if (/mm\s*\/\s*s/.test(h)) return 'mm/s';
  if (/m\s*\/\s*s/.test(h)) return 'm/s';
  if (/cm\s*\/\s*s/.test(h)) return 'cm/s';
  if (/\bmm\b/.test(h)) return 'mm';
  if (/\bcm\b/.test(h)) return 'cm';
  if (/\bm\b/.test(h)) return 'm';

  if (quantity === 'acceleration') return 'cm/s²';
  if (quantity === 'velocity') return 'cm/s';
  return 'cm';
}

function convertToBaseUnit(value: number, quantity: Quantity, unit: string): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const u = unit.toLowerCase().replace(/\s+/g, '');

  if (quantity === 'acceleration') {
    if (u === 'm/s²' || u === 'm/s^2' || u === 'm/s2') return value * 100;
    if (u === 'g') return value * 980.665;
    return value;
  }

  if (quantity === 'velocity') {
    if (u === 'm/s') return value * 100;
    if (u === 'mm/s') return value * 0.1;
    return value;
  }

  if (u === 'm') return value * 100;
  if (u === 'mm') return value * 0.1;
  return value;
}

function looksLikeTimeColumn(values: readonly number[]): boolean {
  if (values.length < 3) return false;
  let increasingCount = 0;
  const diffs: number[] = [];

  for (let i = 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) increasingCount += 1;
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }

  if (increasingCount < values.length * 0.9 || diffs.length < 2) return false;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  if (median <= 0) return false;
  const tolerance = median * 0.05;
  const stableCount = diffs.filter((d) => Math.abs(d - median) <= tolerance).length;
  return stableCount >= diffs.length * 0.8;
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

function finiteColumn(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => Number.isFinite(value));
}

export function parseCsvFile(fileName: string, text: string, options: CsvParseOptions): ParseResult {
  const warnings: string[] = [];
  const table = parseTable(text);

  if (table.rows.length === 0 || table.headers.length === 0) {
    warnings.push(`${fileName}: Could not read numeric CSV data.`);
    return { records: [], warnings };
  }

  const columnCount = Math.max(...table.rows.map((row) => row.length));
  const columns = Array.from({ length: columnCount }, (_, col) => finiteColumn(table.rows.map((row) => row[col])));
  const headers = Array.from({ length: columnCount }, (_, i) => table.headers[i] ?? `col${i + 1}`);

  const firstHeader = headers[0]?.toLowerCase() ?? '';
  const firstColumnIsTime = /time|sec|秒|時刻|t\b/.test(firstHeader) || (columnCount >= 2 && looksLikeTimeColumn(columns[0]));

  let dt = 1 / options.defaultSamplingHz;
  let valueColumnStart = 0;

  if (firstColumnIsTime) {
    valueColumnStart = 1;
    const detectedDt = medianDiff(columns[0]);
    if (detectedDt && detectedDt > 0) {
      dt = detectedDt;
    } else {
      warnings.push(`${fileName}: Could not infer the sampling interval from the time column. Using ${options.defaultSamplingHz} Hz.`);
    }
  }

  if (valueColumnStart >= columnCount) {
    warnings.push(`${fileName}: No data columns were found after the time column.`);
    return { records: [], warnings };
  }

  const records: WaveformRecord[] = [];
  const samplingHz = 1 / dt;

  for (let col = valueColumnStart; col < columnCount; col += 1) {
    const header = headers[col] ?? `col${col + 1}`;
    const values = finiteColumn(table.rows.map((row) => row[col]));

    if (values.length < 2) continue;

    const quantity = inferQuantity(header, options.defaultQuantity);
    const unit = inferUnit(header, quantity);
    const componentIndex = col - valueColumnStart;
    const component = inferComponent(header, componentIndex);
    const convertedValues = values.map((value) => convertToBaseUnit(value, quantity, unit));

    records.push({
      id: makeId('wf'),
      fileName: records.length === 0 ? fileName : `${fileName}#${header}`,
      sourceType: 'csv',
      component,
      componentLabel: componentLabel(component, header),
      quantity,
      unit: quantity === 'acceleration' ? 'cm/s²' : quantity === 'velocity' ? 'cm/s' : 'cm',
      values: convertedValues,
      dt,
      samplingHz,
      metadata: {
        sourceColumn: header,
        originalUnit: unit,
        originalQuantity: quantity,
      },
      notes: [firstColumnIsTime ? 'time column detected' : `dt from default sampling frequency: ${options.defaultSamplingHz}Hz`],
    });
  }

  if (records.length === 0) warnings.push(`${fileName}: Could not read any valid data columns.`);

  return { records, warnings };
}
