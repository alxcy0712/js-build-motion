import { join } from 'node:path';
import { NodeImportFiles } from '../adapters/import-files.ts';
import { readFixed } from '../adapters/inspection.ts';
import { UUID_PATTERN } from '../project/unpack.ts';
import { validateVideoPublication, type VideoPublication } from '../project/video-preparation.ts';

export async function readVideoPublication(projectDir: string, mapPath: string, mapData: Buffer) {
  if (!new RegExp(`^assets/derived/video/${UUID_PATTERN}/map\\.json$`).test(mapPath)) throw Error('VIDEO_MAP_PATH_INVALID');
  const path = mapPath.replace(/map\.json$/, 'publication.json'), files = new NodeImportFiles(projectDir);
  const raw = await readFixed(files.projectPath(join(projectDir, path)), 8388608);
  const value = JSON.parse(raw.data.toString('utf8')) as VideoPublication;
  if (!new RegExp(`^runs/video-attempt-${UUID_PATTERN}/receipt\\.json$`).test(value?.receipt?.path ?? '')) throw Error('VIDEO_PUBLICATION_INVALID');
  const receipt = await readFixed(files.projectPath(join(projectDir, value.receipt.path)), 8388608);
  validateVideoPublication(value, receipt.data, mapPath, mapData);
  return { path, value, raw, receipt };
}
