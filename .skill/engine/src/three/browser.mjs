import * as THREE from 'three';
import { createBrandStage } from './stage.mjs';

/** One render job per fresh browser profile; every frame is evaluated at absolute time. */
export async function render(config) {
  const { width, height, fps, frames, seed, theme, alpha, base } = config;
  for (const face of theme.fonts.faces) {
    const font = new FontFace(face.family, `url(${base}runtime/assets/fonts/${face.files[0]})`, { weight: '100 900' });
    document.fonts.add(await font.load());
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.debug.onShaderError = () => { throw Error('THREE_SHADER_FAILED'); };
  document.body.appendChild(renderer.domElement);
  const stage = createBrandStage(config);
  const { createScene } = await import(base + config.scene);
  if (typeof createScene !== 'function') throw Error('THREE_CREATE_SCENE_REQUIRED');
  const assetUrl = path => {
    if (!/^assets\//.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || /[\\?#]/.test(path)) throw Error('THREE_ASSET_PATH');
    return base + path.split('/').map(encodeURIComponent).join('/');
  };
  const drawing = await createScene({ THREE, ...stage, renderer, theme, width, height, fps, frames, seed, assetUrl });
  if (typeof drawing?.update !== 'function') throw Error('THREE_UPDATE_REQUIRED');
  await renderer.compileAsync(stage.scene, stage.camera);
  const capture = async frameIndex => {
    const result = drawing.update({ frameIndex, time: frameIndex / fps, fps, frames, seed });
    if (result?.then) throw Error('THREE_UPDATE_MUST_BE_SYNCHRONOUS');
    renderer.render(stage.scene, stage.camera);
    if (renderer.getContext().isContextLost()) throw Error('THREE_CONTEXT_LOST');
    return await new Promise((resolve, reject) => renderer.domElement.toBlob(blob => blob ? resolve(blob) : reject(Error('THREE_CAPTURE_FAILED')), 'image/png'));
  };
  const hash = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
  const first = await hash(await capture(0));
  await capture(frames - 1);
  if (first !== await hash(await capture(0))) throw Error('THREE_SEEK_MISMATCH: update must derive state from frameIndex/fps');
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    const response = await fetch(base + `frames/${frameIndex}`, { method: 'POST', body: await capture(frameIndex) });
    if (!response.ok) throw Error('THREE_FRAME_WRITE_FAILED');
  }
  const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
  const facts = { revision: THREE.REVISION, width, height, fps, frames, seed, alpha, pixelRatio: renderer.getPixelRatio(),
    outputColorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping, seekVerified: true,
    gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  drawing.dispose?.();
  renderer.dispose();
  const response = await fetch(base + 'done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(facts) });
  if (!response.ok) throw Error('THREE_RECEIPT_WRITE_FAILED');
}
