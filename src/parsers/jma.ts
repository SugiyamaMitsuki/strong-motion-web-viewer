import type { ComponentCode, ParseResult, WaveformMetadata, WaveformRecord } from '../types/waveform';
import { makeId } from '../utils/file';

interface JmaHeader {
  siteCode?: string;
  stationName?: string;
  stationLabel?: string;
  stationLat?: number;
  stationLon?: number;
  eventLat?: number;
  eventLon?: number;
  depthKm?: number;
  magnitude?: number;
  samplingHz?: number;
  unit?: string;
  initialTime?: string;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSiteLine(line: string): Pick<JmaHeader, 'siteCode' | 'stationName' | 'stationLabel' | 'eventLat' | 'eventLon' | 'depthKm' | 'magnitude'> {
  const tokens = line.split(',').map((token) => token.trim());
  const siteText = tokens[0]?.replace(/^SITE\s+CODE\s*=/i, '').trim() ?? '';
  const siteMatch = siteText.match(/^(\d+)\s*(.*)$/);
  const siteCode = siteMatch?.[1] || siteText || undefined;
  const stationName = siteMatch?.[2]?.trim() || undefined;
  const stationLabel = stationName && siteCode ? `${siteCode} ${stationName}` : stationName || siteCode;

  return {
    siteCode,
    stationName,
    stationLabel,
    eventLat: finiteNumber(tokens[1]),
    eventLon: finiteNumber(tokens[2]),
    depthKm: finiteNumber(tokens[3]),
    magnitude: finiteNumber(tokens[4]),
  };
}

function parseLabeledNumber(line: string): number | undefined {
  const match = line.match(/=\s*([+-]?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

function parseSamplingHz(line: string): number | undefined {
  const match = line.match(/=\s*([+-]?\d+(?:\.\d+)?)\s*Hz/i);
  return match ? Number(match[1]) : undefined;
}

function parseInitialTime(line: string): string | undefined {
  const match = line.match(/=\s*(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+([+-]?\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const two = (value: string): string => value.padStart(2, '0');
  const secValue = Number(second);
  const secText = Number.isFinite(secValue) && !Number.isInteger(secValue)
    ? secValue.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').padStart(2, '0')
    : two(String(Math.trunc(secValue)));
  return `${year}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}:${secText}`;
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map((token) => token.trim());
}

function componentFromLabel(label: string, index: number): ComponentCode {
  const upper = label.toUpperCase();
  if (upper === 'NS' || upper.includes('N-S')) return 'NS';
  if (upper === 'EW' || upper.includes('E-W')) return 'EW';
  if (upper === 'UD' || upper.includes('U-D')) return 'UD';
  if (index === 0) return 'NS';
  if (index === 1) return 'EW';
  if (index === 2) return 'UD';
  return 'OTHER';
}

function baseMetadata(header: JmaHeader): WaveformMetadata {
  return {
    stationCode: header.stationLabel,
    stationLat: header.stationLat,
    stationLon: header.stationLon,
    eventLat: header.eventLat,
    eventLon: header.eventLon,
    depthKm: header.depthKm,
    magnitude: header.magnitude,
    recordTime: header.initialTime,
    originTime: header.initialTime,
    jmaSiteCode: header.siteCode,
    jmaStationName: header.stationName,
    originalUnit: header.unit,
  };
}

export function isJmaStrongMotionText(text: string): boolean {
  return /^SITE\s+CODE\s*=/im.test(text)
    && /^\s*SAMPLING\s+RATE\s*=/im.test(text)
    && /^\s*INITIAL\s+TIME\s*=/im.test(text);
}

export function parseJmaStrongMotionFile(fileName: string, text: string): ParseResult {
  const warnings: string[] = [];
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const siteLine = lines.find((line) => /^SITE\s+CODE\s*=/i.test(line));
  const latLine = lines.find((line) => /^LAT\.\s*=/i.test(line));
  const lonLine = lines.find((line) => /^LON\.\s*=/i.test(line));
  const samplingLine = lines.find((line) => /^SAMPLING\s+RATE\s*=/i.test(line));
  const unitLine = lines.find((line) => /^UNIT\s*=/i.test(line));
  const initialTimeLine = lines.find((line) => /^INITIAL\s+TIME\s*=/i.test(line));
  const componentLineIndex = lines.findIndex((line) => {
    const tokens = splitCsvLine(line).map((token) => token.toUpperCase());
    return tokens.length >= 2 && tokens.some((token) => token === 'NS') && tokens.some((token) => token === 'EW');
  });

  if (!siteLine || !samplingLine || !initialTimeLine || componentLineIndex < 0) {
    warnings.push(`${fileName}: JMA strong-motion header was incomplete.`);
    return { records: [], warnings };
  }

  const header: JmaHeader = {
    ...parseSiteLine(siteLine),
    stationLat: latLine ? parseLabeledNumber(latLine) : undefined,
    stationLon: lonLine ? parseLabeledNumber(lonLine) : undefined,
    samplingHz: parseSamplingHz(samplingLine),
    unit: unitLine?.replace(/^UNIT\s*=/i, '').trim(),
    initialTime: parseInitialTime(initialTimeLine),
  };

  if (!header.samplingHz || header.samplingHz <= 0) {
    warnings.push(`${fileName}: Could not read JMA sampling rate.`);
    return { records: [], warnings };
  }

  const componentLabels = splitCsvLine(lines[componentLineIndex]);
  const columns = componentLabels.map((): number[] => []);

  for (let lineIndex = componentLineIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const tokens = splitCsvLine(lines[lineIndex]);
    componentLabels.forEach((_, columnIndex) => {
      const value = Number(tokens[columnIndex]);
      if (Number.isFinite(value)) columns[columnIndex].push(value);
    });
  }

  const records: WaveformRecord[] = [];
  const samplingHz = header.samplingHz;
  const dt = 1 / samplingHz;

  componentLabels.forEach((label, index) => {
    const values = columns[index];
    if (values.length < 2) return;
    const component = componentFromLabel(label, index);
    records.push({
      id: makeId('wf'),
      fileName: records.length === 0 ? fileName : `${fileName}#${label}`,
      sourceType: 'jma',
      component,
      componentLabel: component === 'OTHER' ? label || `col${index + 1}` : component,
      quantity: 'acceleration',
      unit: 'cm/s²',
      values,
      dt,
      samplingHz,
      metadata: {
        ...baseMetadata(header),
        sourceColumn: label,
        originalQuantity: 'acceleration',
      },
      notes: ['JMA strong-motion acceleration CSV', 'Positive directions: north, east, and up.'],
    });
  });

  if (records.length === 0) warnings.push(`${fileName}: Could not read JMA waveform samples.`);
  return { records, warnings };
}
