import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { getTheme } from '../themes/registry.ts';
import { parseBrand } from '../themes/brand.ts';

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.otf': 'font/otf', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

export function inside(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || /[\\\x00?#]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('THREE_PATH_INVALID');
  const target = join(root, path);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || (lstatSync(ancestor).isFile() && lstatSync(ancestor).nlink !== 1)) throw Error('THREE_PATH_LINK');
  return target;
}

export function validateOptions(project, options) {
  const out = { width: 960, height: 540, fps: 30, frames: 150, seed: 1, alpha: false, ...options };
  for (const name of ['width', 'height', 'fps', 'frames']) if (!Number.isSafeInteger(out[name]) || out[name] < 1) throw Error(`THREE_OPTION_INVALID: ${name}`);
  if (!Number.isSafeInteger(out.seed) || out.seed < 0) throw Error('THREE_OPTION_INVALID: seed');
  if (!/^src\/.+\.(mjs|js)$/.test(out.scene ?? '') || !/^assets\/three\/.+/.test(out.out ?? '')) throw Error('THREE_SCENE_OR_OUTPUT_PATH');
  if (!lstatSync(inside(project, out.scene)).isFile()) throw Error('THREE_SCENE_FILE_REQUIRED');
  if (existsSync(inside(project, out.out))) throw Error('THREE_OUTPUT_EXISTS: choose a new output directory');
  return out;
}

/** Offline PNG pre-rendering, using installed Chrome and Node's HTTP server; no bundled browser. */
export async function renderThree(project, options) {
  project = realpathSync(project);
  const settings = validateOptions(project, options);
  const brandPath = join(project, 'brand.json'), brandBytes = readFileSync(brandPath), theme = getTheme(parseBrand(JSON.parse(brandBytes)).theme);
  const browser = settings.browser ?? process.env.JBM_CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  if (!browser || !isAbsolute(browser) || !existsSync(browser)) throw Error('THREE_BROWSER_REQUIRED: supply --browser /absolute/path/to/chrome');
  // macOS Seatbelt cannot be nested. The fixed film entry already sandboxes this process and every child.
  const inheritedSandbox = process.platform === 'darwin' && Boolean(process.env.JBM_RUNTIME_ID) && engine === join(project, '.engine');
  const version = spawnSync(browser, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0) throw Error('THREE_BROWSER_VERSION_FAILED');
  const output = inside(project, settings.out), tmpParent = inside(project, 'out/.tmp');
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(tmpParent, { recursive: true });
  const temporary = mkdtempSync(join(tmpParent, 'three-'));
  mkdirSync(output);
  const inputs = new Map(), outputs = [], token = '/' + randomUUID() + '/';
  let chrome, timer, settled = false, complete, fail;
  const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  completed.catch(() => {}); // Launch errors can arrive before the render promise is awaited.
  const reject = error => { if (!settled) { settled = true; fail(error); } };
  const heartbeat = () => { clearTimeout(timer); timer = setTimeout(() => reject(Error('THREE_RENDER_TIMEOUT: no frame or completion for 60s')), 60000); };
  let config;
  const serveFile = (root, path, identity) => {
    if (!inputs.has(identity)) {
      const bytes = readFileSync(inside(root, path));
      inputs.set(identity, { path: identity, sha256: sha(bytes), bytes: bytes.length, data: bytes });
    }
    return inputs.get(identity).data;
  };
  const body = async request => {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > settings.width * settings.height * 4 + 1048576) throw Error('THREE_REQUEST_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith(token)) { response.writeHead(404).end(); return; }
      const path = decodeURIComponent(request.url.slice(token.length));
      if (request.method === 'POST') {
        const bytes = await body(request);
        if (path === `frames/${outputs.length}` && outputs.length < settings.frames) {
          if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== settings.width || bytes.readUInt32BE(20) !== settings.height) throw Error('THREE_PNG_INVALID');
          const name = `frame-${String(outputs.length).padStart(6, '0')}.png`;
          writeFileSync(join(output, name), bytes, { flag: 'wx' });
          outputs.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
          heartbeat(); response.writeHead(204).end(); return;
        }
        if (path === 'error') throw Error('THREE_BROWSER_FAILED: ' + bytes.toString('utf8').slice(0, 2000));
        if (path !== 'done' || outputs.length !== settings.frames) throw Error('THREE_FRAME_SEQUENCE_INVALID');
        const facts = JSON.parse(bytes);
        if (['width', 'height', 'fps', 'frames', 'seed', 'alpha'].some(key => facts[key] !== settings[key]) || facts.seekVerified !== true || facts.pixelRatio !== 1) throw Error('THREE_RECEIPT_INVALID');
        const receipt = { version: '0.1', tool: 'threejs', status: 'complete', runtime: process.env.JBM_RUNTIME_ID ?? null,
          three: json(join(engine, 'node_modules/three/package.json')).version, browser: { version: version.stdout.trim(), executableSha256: sha(readFileSync(browser)), isolation: inheritedSandbox ? 'project-sandbox-exec' : 'browser-sandbox' },
          theme: { id: theme.id, brandSha256: sha(brandBytes) }, scene: settings.scene, duration: settings.frames / settings.fps,
          width: facts.width, height: facts.height, fps: facts.fps, frames: facts.frames, seed: facts.seed, alpha: facts.alpha,
          revision: facts.revision, gpu: facts.gpu, pixelRatio: facts.pixelRatio, outputColorSpace: facts.outputColorSpace, toneMapping: facts.toneMapping, seekVerified: facts.seekVerified,
          inputs: [...inputs.values()].map(({ data, ...record }) => record).sort((a, b) => a.path.localeCompare(b.path)), outputs, byteReproducibleAcrossHosts: false };
        writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
        settled = true; clearTimeout(timer); response.writeHead(204).end(); complete(receipt); return;
      }
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (!path) {
        const encode = value => JSON.stringify(value).replaceAll('<', '\\u003c');
        const imports = { imports: { three: config.base + 'runtime/node_modules/three/build/three.module.js', 'three/addons/': config.base + 'runtime/node_modules/three/examples/jsm/' } };
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:");
        response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0}canvas{display:block}</style><script type="importmap">${encode(imports)}</script><script type="module">import(${encode(config.base + 'runtime/src/three/browser.mjs')}).then(m=>m.render(${encode(config)})).catch(e=>fetch(${encode(config.base + 'error')},{method:'POST',body:String(e.stack||e)}));</script>`);
        return;
      }
      const runtimePath = path.startsWith('runtime/') ? path.slice(8) : null;
      const allowedRuntime = runtimePath && /^(node_modules\/three\/|assets\/fonts\/|src\/three\/(browser|stage)\.mjs$)/.test(runtimePath);
      if (!(allowedRuntime || /^(src|assets)\//.test(path))) throw Error('THREE_RESOURCE_PATH');
      const bytes = serveFile(allowedRuntime ? engine : project, allowedRuntime ? runtimePath : path, path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }).end(bytes);
    } catch (error) { response.writeHead(500).end(String(error.message)); reject(error); }
  });
  server.on('error', reject);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    config = { ...settings, theme, base: `http://127.0.0.1:${server.address().port}${token}` };
    const args = ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-breakpad',
      `--user-data-dir=${join(temporary, 'profile')}`, `--disk-cache-dir=${join(temporary, 'cache')}`, config.base];
    if (inheritedSandbox) args.unshift('--no-sandbox');
    // Chromium on macOS uses MAC_CHROMIUM_TMPDIR for its singleton socket directory.
    chrome = spawn(browser, args, { cwd: project, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: temporary, MAC_CHROMIUM_TMPDIR: temporary, CHROME_LOG_FILE: join(temporary, 'chrome.log') } });
    let stderr = '';
    chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    chrome.once('error', reject);
    chrome.once('exit', (code, signal) => reject(Error(`THREE_BROWSER_EXIT: ${code ?? signal}\n${stderr}`)));
    heartbeat();
    return await completed;
  } catch (error) {
    writeFileSync(join(output, 'failed.json'), JSON.stringify({ status: 'failed', error: String(error), framesWritten: outputs.length }, null, 2) + '\n');
    throw error;
  } finally {
    settled = true; clearTimeout(timer);
    if (chrome?.pid) {
      try { process.kill(-chrome.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (chrome.exitCode === null && chrome.signalCode === null) await new Promise(resolve => chrome.once('exit', resolve));
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['scene', 'out', 'width', 'height', 'fps', 'frames', 'seed', 'browser'].map(name => [name, { type: 'string' }]).concat([['alpha', { type: 'boolean' }]])) });
    for (const name of ['width', 'height', 'fps', 'frames', 'seed']) if (values[name] !== undefined) values[name] = Number(values[name]);
    const receipt = await renderThree(process.cwd(), values);
    process.stdout.write(JSON.stringify({ ok: true, tool: receipt.tool, frames: receipt.frames, theme: receipt.theme.id, out: values.out }) + '\n');
  } catch (error) { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; }
}
