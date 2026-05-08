import type { ComponentCode, ParseResult, SourceType, WaveformMetadata, WaveformRecord } from '../types/waveform';
import { mean } from '../analysis/statistics';
import { makeId } from '../utils/file';

function parseNumber(text: string): number | undefined {
  const match = text.match(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function parseHeaderValue(line: string, key: string): string | undefined {
  if (!line.toLowerCase().startsWith(key.toLowerCase())) return undefined;
  return line.slice(key.length).trim();
}

function componentLabel(component: ComponentCode): string {
  if (component === 'NS') return 'NS';
  if (component === 'EW') return 'EW';
  if (component === 'UD') return 'UD';
  return 'OTHER';
}

function channelLabelToComponent(label: string): ComponentCode {
  if (label.startsWith('NS')) return 'NS';
  if (label.startsWith('EW')) return 'EW';
  if (label.startsWith('UD')) return 'UD';
  return 'OTHER';
}

export function inferChannelLabelFromName(fileName: string, direction?: string): string {
  const upper = fileName.toUpperCase();
  const extMatch = upper.match(/\.(NS|EW|UD)(\d*)$/);
  if (extMatch) return `${extMatch[1]}${extMatch[2]}`;

  const dir = (direction ?? '').trim().toUpperCase();
  if (dir.includes('E-W') || dir === 'EW') return 'EW';
  if (dir.includes('N-S') || dir === 'NS' || dir === "'NS") return 'NS';
  if (dir.includes('U-D') || dir === 'UD') return 'UD';
  if (dir === '1') return 'EW1';
  if (dir === '2') return 'NS1';
  if (dir === '3') return 'UD1';
  if (dir === '4') return 'EW2';
  if (dir === '5') return 'NS2';
  if (dir === '6') return 'UD2';
  return 'OTHER';
}

export function inferComponentFromName(fileName: string, direction?: string): ComponentCode {
  return channelLabelToComponent(inferChannelLabelFromName(fileName, direction));
}

function inferSourceType(fileName: string, stationCode?: string): SourceType {
  const upper = fileName.toUpperCase();
  if (/\.(NS|EW|UD)\d+$/.test(upper)) return 'kiknet';
  if (stationCode && stationCode.length >= 6 && /[A-Z]{3}H\d{2}/i.test(stationCode)) return 'kiknet';
  return 'knet';
}

export function isKnetLikeText(text: string): boolean {
  return /Scale Factor\s+/i.test(text)
    && /Sampling Freq\(Hz\)/i.test(text)
    && /Max\. Acc\. \(gal\)/i.test(text);
}

export function parseKnetFile(fileName: string, text: string): ParseResult {
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const metadata: WaveformMetadata = {};

  let samplingHz = 0;
  let scaleFactor = 1;
  let scaleFactorText = '';
  let direction = '';
  let memoIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*Memo\./i.test(line)) {
      memoIndex = i;
      metadata.memo = line.replace(/^\s*Memo\.\s*/i, '').trim();
      break;
    }

    const originTime = parseHeaderValue(line, 'Origin Time');
    if (originTime !== undefined) metadata.originTime = originTime;

    const eventLat = parseHeaderValue(line, 'Lat.');
    if (eventLat !== undefined) metadata.eventLat = parseNumber(eventLat);

    const eventLon = parseHeaderValue(line, 'Long.');
    if (eventLon !== undefined) metadata.eventLon = parseNumber(eventLon);

    const depth = parseHeaderValue(line, 'Depth. (km)');
    if (depth !== undefined) metadata.depthKm = parseNumber(depth);

    const mag = parseHeaderValue(line, 'Mag.');
    if (mag !== undefined) metadata.magnitude = parseNumber(mag);

    const stationCode = parseHeaderValue(line, 'Station Code');
    if (stationCode !== undefined) metadata.stationCode = stationCode;

    const stationLat = parseHeaderValue(line, 'Station Lat.');
    if (stationLat !== undefined) metadata.stationLat = parseNumber(stationLat);

    const stationLon = parseHeaderValue(line, 'Station Long.');
    if (stationLon !== undefined) metadata.stationLon = parseNumber(stationLon);

    const stationHeight = parseHeaderValue(line, 'Station Height(m)');
    if (stationHeight !== undefined) metadata.stationHeightM = parseNumber(stationHeight);

    const recordTime = parseHeaderValue(line, 'Record Time');
    if (recordTime !== undefined) metadata.recordTime = recordTime;

    const sampling = parseHeaderValue(line, 'Sampling Freq(Hz)');
    if (sampling !== undefined) samplingHz = parseNumber(sampling) ?? 0;

    const duration = parseHeaderValue(line, 'Duration Time(s)');
    if (duration !== undefined) metadata.durationSec = parseNumber(duration);

    const dir = parseHeaderValue(line, 'Dir.');
    if (dir !== undefined) {
      direction = dir;
      metadata.direction = dir;
    }

    const sf = parseHeaderValue(line, 'Scale Factor');
    if (sf !== undefined) {
      scaleFactorText = sf;
      metadata.scaleFactorText = sf;
      const match = sf.match(/([+-]?\d+(?:\.\d+)?)\s*\(\s*gal\s*\)\s*\/\s*([+-]?\d+(?:\.\d+)?)/i);
      if (match) scaleFactor = Number(match[1]) / Number(match[2]);
      else warnings.push(`${fileName}: Could not parse Scale Factor. Using 1.0.`);
    }

    const maxAcc = parseHeaderValue(line, 'Max. Acc. (gal)');
    if (maxAcc !== undefined) metadata.maxAccelerationGalHeader = parseNumber(maxAcc);

    const correction = parseHeaderValue(line, 'Last Correction');
    if (correction !== undefined) metadata.lastCorrection = correction;
  }

  if (memoIndex < 0) {
    warnings.push(`${fileName}: Memo. line was not found. Searching for integer data after the header.`);
    memoIndex = lines.findIndex((line) => /^\s*[+-]?\d+(?:\s+[+-]?\d+)+\s*$/.test(line));
    memoIndex = memoIndex >= 0 ? memoIndex - 1 : lines.length;
  }

  if (samplingHz <= 0) {
    samplingHz = 100;
    warnings.push(`${fileName}: Could not read Sampling Freq(Hz). Using 100 Hz.`);
  }

  const rawValues: number[] = [];
  for (let i = memoIndex + 1; i < lines.length; i += 1) {
    const matches = lines[i].match(/[+-]?\d+/g);
    if (!matches) continue;
    for (const m of matches) rawValues.push(Number(m));
  }

  if (rawValues.length === 0) {
    warnings.push(`${fileName}: Could not read waveform data.`);
    return { records: [], warnings };
  }

  const rawMean = mean(rawValues);
  const values = rawValues.map((value) => (value - rawMean) * scaleFactor);
  const inferredChannelLabel = inferChannelLabelFromName(fileName, direction);
  const component = channelLabelToComponent(inferredChannelLabel);
  const sourceType = inferSourceType(fileName, metadata.stationCode);

  const record: WaveformRecord = {
    id: makeId('wf'),
    fileName,
    sourceType,
    component,
    componentLabel: inferredChannelLabel === 'OTHER' ? componentLabel(component) : inferredChannelLabel,
    quantity: 'acceleration',
    unit: 'cm/s²',
    values,
    dt: 1 / samplingHz,
    samplingHz,
    metadata,
    notes: [
      `Scale Factor: ${scaleFactorText || scaleFactor}`,
      `raw mean removed: ${rawMean.toFixed(6)}`,
    ],
  };

  return { records: [record], warnings };
}
