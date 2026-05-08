import type { CsvParseOptions, ParseResult } from '../types/waveform';
import { isKnetLikeText, parseKnetFile } from './knet';
import { parseCsvFile } from './csv';

export function parseWaveformFile(fileName: string, text: string, csvOptions: CsvParseOptions): ParseResult {
  if (isKnetLikeText(text)) return parseKnetFile(fileName, text);
  return parseCsvFile(fileName, text, csvOptions);
}
