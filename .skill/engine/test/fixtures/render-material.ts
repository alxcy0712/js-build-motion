import { createHash } from 'node:crypto';
import { Canvas } from 'skia-canvas';
import { drawMaterialScene, MATERIAL_WIDTH, MATERIAL_HEIGHT } from './material-scene.ts';
const canvas = new Canvas(MATERIAL_WIDTH, MATERIAL_HEIGHT);
drawMaterialScene(canvas.getContext('2d'), Number(process.argv[2] ?? 24), Number(process.argv[3] ?? 41));
process.stdout.write(createHash('sha256').update(canvas.toBufferSync('raw')).digest('hex') + '\n');
