import { downloadTextFile, safeFileName } from '../utils/file';

export function downloadFigureMetadata(fileNameBase: string, metadata: unknown): void {
  downloadTextFile(
    `${safeFileName(fileNameBase)}.figure.json`,
    `${JSON.stringify(metadata, null, 2)}\n`,
    'application/json;charset=utf-8',
  );
}
