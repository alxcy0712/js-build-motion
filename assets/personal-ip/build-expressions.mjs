import { Canvas, loadImage } from '../../.skill/engine/node_modules/skia-canvas/lib/index.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawPersonalIP, drawExpressionAccent } from './puppet.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const rig = JSON.parse(readFileSync(root + 'rig.json', 'utf8'));
const expressions = JSON.parse(readFileSync(root + 'expressions.json', 'utf8'));
const images = Object.fromEntries(await Promise.all(['base','body','mouths','blink','eyes','brows','cheeks','restMouths'].map(async key => [key, await loadImage(root + rig[key])])));
for (const view of ['front','left45','right45']) {
  const layout = rig.angledExpressions[view];
  const atlas = layout ? await loadImage(root + layout.path) : null;
  if (view !== 'front') mkdirSync(root + `expressions/${view}`, { recursive: true });
  for (const item of expressions) {
    const canvas = new Canvas(256, 256); canvas.gpu = false;
    const context = canvas.getContext('2d');
    if (view === 'front') drawPersonalIP(context, images, rig, { expression:item.id, blink:false, motion:false });
    else {
      const index = rig.expressionIds.indexOf(item.id);
      const { cellSize, columns } = layout;
      context.drawImage(atlas, index % columns * cellSize, Math.floor(index / columns) * cellSize, cellSize, cellSize, 0, 0, 256, 256);
      // The complete angled portrait includes its native facial expression and tears.
      if (item.id !== 'crying') drawExpressionAccent(context, item.id);
    }
    await canvas.toFile(root + item.views[view]);
  }
}
process.stdout.write(JSON.stringify({expressions:expressions.length,views:3,files:expressions.length * 3}) + '\n');
