import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Canvas, loadImage } from '../../.skill/engine/node_modules/skia-canvas/lib/index.mjs';
import { drawWardrobePortrait } from './puppet.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const json = path => JSON.parse(readFileSync(root + path, 'utf8'));
const rig = json('rig.json'), wardrobe = json('wardrobe.json'), expressions = json('expressions.json');
const hash = path => createHash('sha256').update(readFileSync(root + path)).digest('hex');
assert.equal(wardrobe.outfits.length, 10);
assert.equal(new Set(wardrobe.outfits.map(item => item.id)).size, 10);
for (const ref of wardrobe.generation.references) assert.equal(hash(ref.path), ref.sha256);
const images = Object.fromEntries(await Promise.all(['base','body','mouths','blink','eyes','brows','cheeks','restMouths'].map(async key => [key, await loadImage(root + rig[key])])));
for (const view of ['left45','right45']) images[view] = await loadImage(root + rig.angledExpressions[view].path);
const referenceHeads = new Map();
const referencePortraits = new Map();
for (const item of expressions) for (const view of wardrobe.views) {
  const canvas = new Canvas(256,256); canvas.gpu = false;
  const ctx = canvas.getContext('2d'); ctx.drawImage(await loadImage(root + item.views[view]),0,0,256,256);
  referenceHeads.set(view + ':' + item.id, Buffer.from(ctx.getImageData(0,0,256,160).data));
  referencePortraits.set(view + ':' + item.id, Buffer.from(ctx.getImageData(0,0,256,256).data));
}
const canvas = new Canvas(256,256); canvas.gpu = false; const ctx = canvas.getContext('2d');
let combinations = 0, wardrobeBytes = 0, visibleNecks = 0, connectedNecks = 0;
const neckRegions = { front: [116,190,24,22], left45: [119,187,19,25], right45: [128,188,23,26] };
const jawEdges = { front: [[100,178],[154,180]], left45: [[104,185],[112,185]], right45: [[152,184],[144,183]] };
// Sample across the visible joins, including the reported gap beneath the right jaw.
const neckJoins = { front: [[112,185],[128,188],[144,183]], left45: [[112,184],[124,182],[137,180]], right45: [[118,173],[128,178],[137,181]] };
const assertNeckJoin = (view, label) => {
  for (const [x,y] of neckJoins[view]) for (let row = 0; row < 3; row++) {
    assert.ok(ctx.getImageData(x,y + row,1,1).data[3] >= 245,'Opaque head/neck join: ' + label + ' at ' + x + ',' + (y + row));
  }
  connectedNecks++;
};
for (const outfit of wardrobe.outfits) {
  const full = await loadImage(root + outfit.path);
  assert.equal(full.width,outfit.width); assert.equal(full.height,outfit.height);
  images.outfit = await loadImage(root + outfit.upperBody.path);
  assert.equal(images.outfit.width,outfit.upperBody.cellSize * 3);
  assert.equal(images.outfit.height,outfit.upperBody.cellSize);
  const layer = new Canvas(images.outfit.width,images.outfit.height); layer.gpu = false;
  const lc = layer.getContext('2d'); lc.drawImage(images.outfit,0,0);
  assert.ok(lc.getImageData(0,0,images.outfit.width,330).data.every(value => value === 0),'Head clearance: ' + outfit.id);
  for (const view of wardrobe.views) for (const expression of rig.expressionIds) {
    ctx.clearRect(0,0,256,256);
    drawWardrobePortrait(ctx,images,rig,outfit,{view,expression,blink:false,motion:false});
    assert.deepEqual(Buffer.from(ctx.getImageData(0,0,256,160).data),referenceHeads.get(view + ':' + expression),'Identity pixels: ' + outfit.id + '/' + view + '/' + expression);
    assert.ok(ctx.getImageData(20,218,216,38).data.some((value,index) => index % 4 === 3 && value > 128),'Clothing visible: ' + outfit.id + '/' + view);
    assertNeckJoin(view,outfit.id + '/' + view + '/' + expression);
    if (expression === 'neutral') {
      const [x,y,width,height] = neckRegions[view], pixels = ctx.getImageData(x,y,width,height).data;
      let run = 0, longest = 0;
      for (let row = 0; row < height; row++) {
        let skin = 0;
        for (let col = 0; col < width; col++) {
          const index = (row * width + col) * 4, [r,g,b,a] = pixels.slice(index,index + 4);
          if (a > 240 && r > 160 && g > 90 && r - g > 10 && g - b > 5 && r - b > 30) skin++;
        }
        run = skin >= 4 ? run + 1 : 0; longest = Math.max(longest,run);
      }
      assert.ok(longest >= 20,'Continuous exposed neck below the chin: ' + outfit.id + '/' + view);
      visibleNecks++;
    }
    combinations++;
    if (view === 'front') for (const headTilt of [-5,5]) for (const time of [0,3]) {
      ctx.clearRect(0,0,256,256);
      drawWardrobePortrait(ctx,images,rig,outfit,{view,expression,headTilt,time,speaking:true,mouthOpen:0.8,blink:false});
      assertNeckJoin(view,outfit.id + '/' + expression + '/tilt=' + headTilt + '/time=' + time);
    }
  }
  wardrobeBytes += statSync(root + outfit.path).size + statSync(root + outfit.upperBody.path).size;
}
for (const view of wardrobe.views) for (const expression of rig.expressionIds) {
  ctx.clearRect(0,0,256,256);
  drawWardrobePortrait(ctx,images,rig,undefined,{view,expression,blink:false,motion:false});
  assert.deepEqual(Buffer.from(ctx.getImageData(0,0,256,256).data),referencePortraits.get(view + ':' + expression),'Original hoodie portrait: ' + view + '/' + expression);
}
const clothing = images.outfit;
images.outfit = new Canvas(wardrobe.outfits[0].upperBody.cellSize * 3,wardrobe.outfits[0].upperBody.cellSize);
images.outfit.gpu = false;
for (const view of wardrobe.views) for (const expression of rig.expressionIds) {
  ctx.clearRect(0,0,256,256);
  drawWardrobePortrait(ctx,images,rig,wardrobe.outfits[0],{view,expression,blink:false,motion:false});
  for (const [x,y] of jawEdges[view]) {
    const [r,g,b,a] = ctx.getImageData(x,y,1,1).data;
    assert.ok(a <= 100 || Math.max(r,g,b) >= 110,'Head layer has a clean jaw edge: ' + view + '/' + expression);
  }
}
images.outfit = clothing;
const outfit = wardrobe.outfits.at(-1);
const render = options => {
  ctx.clearRect(0,0,256,256); drawWardrobePortrait(ctx,images,rig,outfit,{blink:false,motion:false,...options});
};
render({speaking:true,mouthOpen:0}); const rest = Buffer.from(ctx.getImageData(100,148,56,28).data);
render({speaking:true,mouthOpen:0.8}); assert.notDeepEqual(Buffer.from(ctx.getImageData(100,148,56,28).data),rest,'Speech mouth moves');
render({headTilt:0}); const body = Buffer.from(ctx.getImageData(0,220,256,36).data);
render({headTilt:5}); assert.deepEqual(Buffer.from(ctx.getImageData(0,220,256,36).data),body,'Body stays aligned during head tilt');
const winter = wardrobe.outfits.find(item => item.id === 'winter'); images.outfit = await loadImage(root + winter.upperBody.path);
ctx.clearRect(0,0,256,256); drawWardrobePortrait(ctx,images,rig,winter,{view:'left45'});
assert.equal(ctx.getImageData(7,250,1,1).data[3],0,'Adjacent atlas cell stays outside the portrait');
const business = wardrobe.outfits.find(item => item.id === 'business'); images.outfit = await loadImage(root + business.upperBody.path);
ctx.clearRect(0,0,256,256); drawWardrobePortrait(ctx,images,rig,business,{view:'left45'});
assert.equal(ctx.getImageData(12,252,1,1).data[3],0,'Business atlas edge fragments stay outside the portrait');
console.log(JSON.stringify({ok:true,outfits:wardrobe.outfits.length,combinations,identityRegionsPreserved:combinations,cleanJawHeads:referenceHeads.size,originalHoodiePortraits:referencePortraits.size,visibleNecks,connectedNecks,wardrobeImageBytes:wardrobeBytes}));
