import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { root, skill, verifyCore } from './core.mjs';
import { digest, json, writeJson } from '../engine/workspace.mjs';

/** Opt-in browser regression, isolated from real films and the source runtime. */
export async function checkThreeNative() {
  const release = verifyCore(), output = join(root, '.research/out');
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(output, 'three-check-')), isolated = join(scratch, 'workspace');
  const records = join(root, 'projects/.maintenance', 'three-' + new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(isolated); mkdirSync(records, { recursive: true });
  cpSync(skill, join(isolated, '.skill'), { recursive: true });
  let ordinal = 0;
  const run = (cwd, args, expected = 0) => {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(records, `command-${++ordinal}.log`), JSON.stringify({ args, status: result.status, signal: result.signal }) + '\n' + result.stdout + result.stderr);
    if (result.error) throw result.error;
    assert.equal(result.status, expected, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  };
  try {
    const start = JSON.parse(run(isolated, ['.skill/scripts/video.mjs', 'start', 'three-fixture', '--theme', 'kinetic', '--idea', '通用三维回归夹具：颜色、透明、模型与固定时间']));
    let project = start.project;
    const isolation = { protectedRoots: [root, isolated] };
    writeJson(join(project, '.engine/isolation.json'), isolation);
    writeJson(join(project, 'workspace.json'), { ...json(join(project, 'workspace.json')), isolationSha256: digest(JSON.stringify(isolation)) });
    for (const operation of [`require('node:fs').readFileSync(${JSON.stringify(join(root, 'README.md'))})`, `require('node:fs').writeFileSync(${JSON.stringify(join(scratch, 'outside.txt'))},'outside')`]) {
      assert.match(run(project, ['exec.mjs', process.execPath, '-e', `try{${operation};process.exit(7)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('DENIED')}`]), /DENIED/);
    }
    const require = createRequire(join(project, '.engine/package.json')), { Canvas, loadImage } = require('skia-canvas');
    const image = new Canvas(32, 32), ctx = image.getContext('2d');
    ctx.fillStyle = '#FFC712'; ctx.fillRect(0, 0, 32, 32);
    writeFileSync(join(project, 'assets/colour.png'), await image.toBuffer('png'));
    const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }] };
    const raw = Buffer.from(JSON.stringify(gltf)), padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(padded);
    const bin = Buffer.from(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]).buffer), glb = Buffer.alloc(28 + padded.length + bin.length);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
    glb.writeUInt32LE(bin.length, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(glb, 28 + padded.length);
    writeFileSync(join(project, 'assets/triangle.glb'), glb);
    writeFileSync(join(project, 'src/probe.mjs'), `import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
export async function createScene({THREE,scene,camera,flatMaterial,assetUrl}) {
  camera.position.set(0,0,6); camera.lookAt(0,0,0);
  const texture=await new THREE.TextureLoader().loadAsync(assetUrl('assets/colour.png'));texture.colorSpace=THREE.SRGBColorSpace;
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(2,2),flatMaterial({map:texture}));scene.add(plane);
  const model=await new GLTFLoader().loadAsync(assetUrl('assets/triangle.glb'));model.scene.position.set(2,0,0);model.scene.scale.setScalar(.4);scene.add(model.scene);
  return {update({time}){plane.position.x=.6*Math.sin(time);}};
}`);
    const render = name => run(project, ['exec.mjs', process.execPath, '.engine/src/three/render.mjs', '--scene', 'src/probe.mjs', '--out', `assets/three/${name}`, '--width', '320', '--height', '180', '--fps', '1', '--frames', '3', '--alpha']);
    render('first');
    const receipt = json(join(project, 'assets/three/first/receipt.json'));
    assert.equal(receipt.theme.id, 'kinetic'); assert.equal(receipt.runtime, release.packageId);
    assert.equal(receipt.browser.isolation, 'project-sandbox-exec');
    assert.equal(receipt.seekVerified, true); assert.equal(receipt.frames, 3);
    for (const path of ['assets/triangle.glb', 'assets/colour.png', 'src/probe.mjs']) assert.ok(receipt.inputs.some(file => file.path === path));
    assert.notEqual(receipt.outputs[0].sha256, receipt.outputs[2].sha256);
    const pixels = new Canvas(320, 180), pc = pixels.getContext('2d'); pc.drawImage(await loadImage(join(project, 'assets/three/first/frame-000000.png')), 0, 0);
    assert.deepEqual([...pc.getImageData(160, 90, 1, 1).data], [255, 199, 18, 255]);
    assert.equal(pc.getImageData(0, 0, 1, 1).data[3], 0);
    writeFileSync(join(project, 'src/composite.mjs'), `import {loadImage} from '../.engine/node_modules/skia-canvas/lib/index.js';
const image=await loadImage(new URL('../assets/three/first/frame-000000.png',import.meta.url));
export function drawScene({ctx,width,height}){ctx.fillStyle='#101116';ctx.fillRect(0,0,width,height);ctx.drawImage(image,0,0,width,height);}`);
    writeJson(join(project, 'project.json'), { ...json(join(project, 'project.json')), drawing: 'src/composite.mjs' });
    writeJson(join(project, 'director.json'), { version: '0.1', idea: '三维帧与二维层合成验证', title: '三维合成', aspect: '16:9', look: 'graphic', fps: 30, bpm: 120,
      shots: [{ purpose: '观察三维颜色与透明层的合成', visualIntent: '保留黄色图形和透明边缘', beats: 10, title: '三维合成', backdrop: 'studio', motif: 'none', cameraMove: 'static', transition: 'cut' }] });
    run(project, ['video.mjs', 'direct', 'compile']);
    run(project, ['video.mjs', 'frame', '--frame', '0', '--width', '320', '--height', '180', '--out', 'out/composite.png']);
    pc.clearRect(0, 0, 320, 180); pc.drawImage(await loadImage(join(project, 'out/composite.png')), 0, 0);
    assert.ok(pc.getImageData(160, 90, 1, 1).data[0] > 200);
    const moved = join(scratch, 'moved-film'); renameSync(project, moved); project = moved;
    render('moved');
    assert.deepEqual(json(join(project, 'assets/three/moved/receipt.json')).outputs, receipt.outputs);
    writeFileSync(join(project, 'src/bad.mjs'), 'export function createScene({THREE,scene,camera,material}) {scene.add(new THREE.Mesh(new THREE.BoxGeometry(2,2,2),material()));return {update(){camera.position.x+=1;}}}');
    assert.match(run(project, ['exec.mjs', process.execPath, '.engine/src/three/render.mjs', '--scene', 'src/bad.mjs', '--out', 'assets/three/bad', '--frames', '3'], 1), /THREE_SEEK_MISMATCH/);
    assert.equal(existsSync(join(project, 'assets/three/bad/receipt.json')), false);
    assert.equal(json(join(project, 'assets/three/bad/failed.json')).framesWritten, 0);
    copyFileSync(join(project, '.engine/src/three/example.mjs'), join(project, 'src/example.mjs'));
    run(project, ['exec.mjs', process.execPath, '.engine/src/three/render.mjs', '--scene', 'src/example.mjs', '--out', 'assets/three/example', '--width', '960', '--height', '540', '--fps', '30', '--frames', '150']);
    run(project, ['exec.mjs', 'ffmpeg', '-v', 'error', '-framerate', '30', '-i', 'assets/three/example/frame-%06d.png', '-frames:v', '150', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'out/three-example.mp4']);
    run(project, ['exec.mjs', 'ffmpeg', '-v', 'error', '-i', 'out/three-example.mp4', '-f', 'null', '-']);
    const probe = JSON.parse(run(project, ['exec.mjs', 'ffprobe', '-v', 'error', '-show_streams', '-of', 'json', 'out/three-example.mp4'])).streams[0];
    assert.equal(probe.nb_frames, '150'); assert.equal(Number(probe.duration), 5); assert.equal(probe.width, 960); assert.equal(probe.height, 540);
    copyFileSync(join(project, 'out/three-example.mp4'), join(records, 'three-example.mp4'));
    copyFileSync(join(project, 'assets/three/example/frame-000060.png'), join(records, 'example-frame.png'));
    copyFileSync(join(project, 'assets/three/example/receipt.json'), join(records, 'example-receipt.json'));
    const result = { ok: true, packageId: release.packageId, checks: ['fixed theme', 'texture sRGB pixels', 'alpha', 'GLB loading', 'seek', 'Canvas 2D composition', 'project sandbox', 'relocation', 'stateful update rejection', '5s H.264 encode and full decode'], gpu: receipt.gpu, browser: receipt.browser.version, records };
    writeJson(join(records, 'result.json'), result); process.stdout.write(JSON.stringify(result) + '\n');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
