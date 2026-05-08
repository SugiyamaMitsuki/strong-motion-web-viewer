import type { CsvParseOptions, ParseResult } from '../types/waveform';
import { isJmaStrongMotionText, parseJmaStrongMotionFile } from './jma';
import { isKnetLikeText, parseKnetFile } from './knet';
import { parseCsvFile } from './csv';

export function parseWaveformFile(fileName: string, text: string, csvOptions: CsvParseOptions): ParseResult {
  if (isKnetLikeText(text)) return parseKnetFile(fileName, text);
  if (isJmaStrongMotionText(text)) return parseJmaStrongMotionFile(fileName, text);
  return parseCsvFile(fileName, text, csvOptions);
}
