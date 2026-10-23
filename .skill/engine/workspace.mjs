import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateAsrLock } from './src/project/asr.ts';
import { linuxMediaRuntimeIdentity } from './native-media.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

/** Frozen OCR programs, logical aliases and physical bytes. No discovery runs inside the child sandbox. */
export function ocrRuntimeIdentity() {
  const engine = dirname(fileURLToPath(import.meta.url)), lockPath = join(engine, 'ocr-dependencies.lock.json');
  const fixed = path => {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('OCR_RUNTIME_FILE_INVALID');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), hash = createHash('sha256'); let bytes = 0;
    const same = stat => ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key]);
    try {
      if (!same(fstatSync(fd, { bigint: true }))) throw new Error('OCR_RUNTIME_FILE_CHANGED');
      const chunk = Buffer.alloc(65536);
      while (true) { const count = readSync(fd, chunk, 0, chunk.length, bytes); if (!count) break; bytes += count; if (BigInt(bytes) > before.size) throw new Error('OCR_RUNTIME_FILE_CHANGED'); hash.update(chunk.subarray(0, count)); }
      if (BigInt(bytes) !== before.size || !same(fstatSync(fd, { bigint: true })) || !same(lstatSync(path, { bigint: true }))) throw new Error('OCR_RUNTIME_FILE_CHANGED');
      return { bytes, sha256: hash.digest('hex') };
    } finally { closeSync(fd); }
  };
  const lockIdentity = fixed(lockPath), lock = json(lockPath);
  if (digest(readFileSync(lockPath)) !== lockIdentity.sha256 || lock.version !== '0.1' || lock.kind !== 'ocr-dependencies' || lock.platform !== process.platform || lock.arch !== process.arch ||
      lock.languageSpec !== 'chi_sim+eng+~chi_sim_vert' || lock.oem !== 1 || lock.psm !== 3 || lock.dpi !== 300 ||
      JSON.stringify(Object.keys(lock.tools).sort()) !== JSON.stringify(['ffmpeg', 'ffprobe', 'tesseract']) || lock.models.length !== 2) throw new Error('OCR_RUNTIME_LOCK_INVALID');
  const nativePath = path => typeof path === 'string' && /^\/(?:opt\/homebrew|usr\/local)\//.test(path) && !path.split('/').some(p => p === '..' || p === '.') && !/[\x00-\x1f\x7f]/.test(path);
  const checked = new Map();
  for (const [name, tool] of Object.entries(lock.tools)) {
    if (!nativePath(tool.executable) || !tool.executable.endsWith(`/bin/${name}`) || !Array.isArray(tool.files) || !tool.files.length || tool.files.length > 256 || !Array.isArray(tool.aliases) || !tool.aliases.length || tool.aliases.length > 512) throw new Error('OCR_RUNTIME_TOOL_INVALID');
    const files = new Set(tool.files.map(f => f.path)), aliases = new Set(tool.aliases.map(a => a.path));
    if (files.size !== tool.files.length || aliases.size !== tool.aliases.length || !files.has(tool.executable)) throw new Error('OCR_RUNTIME_TOOL_INVALID');
    for (const file of tool.files) {
      if (!nativePath(file.path) || realpathSync(file.path) !== file.path) throw new Error('OCR_RUNTIME_FILE_INVALID');
      const actual = checked.get(file.path) ?? fixed(file.path); checked.set(file.path, actual);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`OCR_RUNTIME_CHANGED: ${name}`);
    }
    for (const alias of tool.aliases) if (!nativePath(alias.path) || !files.has(alias.realpath) || realpathSync(alias.path) !== alias.realpath) throw new Error(`OCR_RUNTIME_ALIAS_CHANGED: ${name}`);
  }
  for (const [index, model] of lock.models.entries()) {
    const code = ['eng', 'chi_sim'][index];
    if (model.code !== code || model.path !== `assets/ocr/tessdata/${code}.traineddata` || model.sourceCommit !== '65727574dfcd264acbb0c3e07860e4e9e9b22185' || !Array.isArray(model.secondary) || model.secondary.length) throw new Error('OCR_RUNTIME_MODEL_INVALID');
    const actual = fixed(join(engine, model.path)); if (actual.bytes !== model.bytes || actual.sha256 !== model.sha256) throw new Error('OCR_RUNTIME_MODEL_CHANGED');
  }
  return { id: 'tesseract', version: '5.5.0', lockSha256: lockIdentity.sha256, platform: lock.platform, arch: lock.arch,
    tools: lock.tools, models: lock.models, languageSpec: lock.languageSpec, oem: lock.oem, psm: lock.psm, dpi: lock.dpi };
}

/** Bundled ASR identity resolves from this engine, including after runtime relocation. */
export function asrRuntimePaths() { const engine = dirname(fileURLToPath(import.meta.url)); return { program: join(engine, 'assets/asr/bin/whisper-cli'), model: join(engine, 'assets/asr/models/ggml-base.bin') }; }
export function asrRuntimeIdentity({ toolsOnly = false } = {}) {
  const engine = dirname(fileURLToPath(import.meta.url)), lockPath = join(engine, 'asr-dependencies.lock.json');
  const fixed = path => {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('ASR_RUNTIME_FILE_INVALID');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), hash = createHash('sha256'); let bytes = 0;
    const same = stat => ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key]);
    try {
      if (!same(fstatSync(fd, { bigint: true }))) throw new Error('ASR_RUNTIME_FILE_CHANGED');
      const chunk = Buffer.alloc(65536);
      for (;;) { const count = readSync(fd, chunk, 0, chunk.length, bytes); if (!count) break; bytes += count; if (BigInt(bytes) > before.size) throw new Error('ASR_RUNTIME_FILE_CHANGED'); hash.update(chunk.subarray(0, count)); }
      if (BigInt(bytes) !== before.size || !same(fstatSync(fd, { bigint: true })) || !same(lstatSync(path, { bigint: true }))) throw new Error('ASR_RUNTIME_FILE_CHANGED');
      return { bytes, sha256: hash.digest('hex') };
    } finally { closeSync(fd); }
  };
  const identity = fixed(lockPath), lock = validateAsrLock(json(lockPath));
  if (digest(readFileSync(lockPath)) !== identity.sha256 || lock.platform !== process.platform || lock.arch !== process.arch) throw new Error('ASR_RUNTIME_LOCK_INVALID');
  if (!toolsOnly) {
    for (const [directory, expected] of [['assets/asr/bin', 'whisper-cli'], ['assets/asr/models', 'ggml-base.bin']]) {
      const path = join(engine, directory); if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([expected])) throw new Error('ASR_RUNTIME_DIRECTORY_INVALID');
    }
    for (const file of [lock.program, lock.model]) { const actual = fixed(join(engine, file.path)); if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('ASR_RUNTIME_CHANGED'); }
  }
  const nativePath = path => typeof path === 'string' && /^\/(?:opt\/homebrew|usr\/local)\//.test(path) && !path.split('/').some(p => p === '..' || p === '.') && !/[\x00-\x1f\x7f]/.test(path);
  const checked = new Map();
  for (const [name, tool] of Object.entries(lock.tools)) {
    if (!nativePath(tool.executable) || !tool.executable.endsWith('/bin/' + name) || !tool.files.length || tool.files.length > 256 || !tool.aliases.length || tool.aliases.length > 512) throw new Error('ASR_RUNTIME_TOOL_INVALID');
    const files = new Set(tool.files.map(f => f.path)), aliases = new Set(tool.aliases.map(a => a.path));
    if (files.size !== tool.files.length || aliases.size !== tool.aliases.length || !files.has(tool.executable)) throw new Error('ASR_RUNTIME_TOOL_INVALID');
    for (const file of tool.files) { if (!nativePath(file.path) || realpathSync(file.path) !== file.path) throw new Error('ASR_RUNTIME_FILE_INVALID'); const actual = checked.get(file.path) ?? fixed(file.path); checked.set(file.path, actual); if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('ASR_RUNTIME_NATIVE_CHANGED'); }
    for (const alias of tool.aliases) if (!nativePath(alias.path) || !files.has(alias.realpath) || realpathSync(alias.path) !== alias.realpath) throw new Error('ASR_RUNTIME_ALIAS_CHANGED');
  }
  return toolsOnly ? { id: 'bounded-audio-input', version: '0.1', lockSha256: identity.sha256, platform: lock.platform, arch: lock.arch, tools: lock.tools } :
    { ...lock, id: 'whisper-cpp-input-asr', lockSha256: identity.sha256 };
}
export function audioInputRuntimeIdentity() {
  return process.platform === 'linux' ? linuxMediaRuntimeIdentity(dirname(fileURLToPath(import.meta.url))) : asrRuntimeIdentity({ toolsOnly: true });
}

/** Hash only independent files, in path order. Used by packaging and execution. */
export function fileHashes(root, excluded = []) {
  const files = [];
  const walk = path => {
    const name = relative(root, path).split(sep).join('/');
    if (excluded.includes(name) || name.split('/').at(-1) === '.DS_Store') return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`WORKSPACE_LINK: ${name}`);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child));
    else if (stat.isFile()) files.push({ path: name, sha256: digest(readFileSync(path)) });
    else throw new Error(`WORKSPACE_FILE_TYPE: ${name}`);
  };
  walk(root);
  return files;
}

export function verifyRuntime(project) {
  const engine = join(project, '.engine');
  const { packageId, ...content } = json(join(engine, 'engine-manifest.json'));
  const lock = json(join(project, 'workspace.json'));
  const manualLinux = lock.mode === 'manual-linux';
  if (lock.packageId !== packageId || (manualLinux
    ? content.version !== 'manual-0.2' || content.platform !== 'linux' || content.sourcePackageId !== lock.sourcePackageId || content.sandbox !== 'host-managed-unverified' || lock.sandbox !== content.sandbox
    : lock.isolationSha256 !== digest(JSON.stringify(json(join(engine, 'isolation.json')))))) throw new Error('RUNTIME_LOCK_CHANGED: keep the initialized release and isolation policy');
  if (digest(JSON.stringify(content)) !== packageId) throw new Error('RUNTIME_MANIFEST_CHANGED');
  const actual = fileHashes(engine, ['engine-manifest.json', 'isolation.json']);
  if (JSON.stringify(actual) !== JSON.stringify(content.files)) throw new Error('RUNTIME_CHANGED: use the pinned release');
  if (manualLinux && lock.engineSha256 !== digest(JSON.stringify(actual))) throw new Error('RUNTIME_ENGINE_CHANGED');
  // 本片风格选择：start 记录显式参数，workspace.json 固定快照哈希与生效风格。
  const brandPath = join(project, 'brand.json');
  const brandRecord = lock.brand;
  if (!existsSync(brandPath)) throw new Error('RUNTIME_BRAND_CHANGED: use the initialized brand snapshot');
  if (!brandRecord || typeof brandRecord.theme !== 'string' || typeof brandRecord.sha256 !== 'string') throw new Error('RUNTIME_BRAND_RECORD: workspace.json 缺少本片风格记录，请重新初始化项目');
  if (digest(readFileSync(brandPath)) !== brandRecord.sha256) throw new Error('RUNTIME_BRAND_CHANGED: use the initialized brand snapshot');
  let brandSnapshot;
  try { brandSnapshot = JSON.parse(readFileSync(brandPath, 'utf8')); } catch { throw new Error('RUNTIME_BRAND_CHANGED: brand.json 不是合法 JSON'); }
  if ((brandSnapshot.theme ?? brandSnapshot.lockedTheme) !== brandRecord.theme) throw new Error('RUNTIME_BRAND_CHANGED: 本片 brand.json 与 workspace.json 记录不一致');
  if (content.platform !== process.platform || content.arch !== process.arch || content.nodeMajor !== Number(process.versions.node.split('.')[0])) {
    throw new Error(`RUNTIME_PLATFORM: requires ${content.platform}/${content.arch}, Node ${content.nodeMajor}`);
  }
  return { packageId, ...content };
}

export function assertIndependentTree(root) {
  const walk = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`WORKSPACE_LINK: ${path}`);
    if (stat.isDirectory()) for (const child of readdirSync(path)) walk(join(path, child));
  };
  walk(root);
}

export function sandboxProfile(project, protectedRoots, options = {}) {
  const quote = path => JSON.stringify(path);
  const ancestors = [];
  for (let path = dirname(project); path !== dirname(path); path = dirname(path)) ancestors.push(path);
  // Keep standard output devices usable. All ordinary filesystem writes stay in the film.
  const lines = ['(version 1)', '(allow default)',
    `(deny file-write* (require-all (require-not (subpath ${quote(project)})) (require-not (literal "/dev/null")) (require-not (literal "/dev/tty")) (require-not (subpath "/dev/fd"))))`,
    `(deny file-write* (subpath ${quote(join(project, '.engine'))}))`,
    `(deny file-write* (literal ${quote(join(project, 'brand.json'))}))`,
  ];
  for (const root of new Set([dirname(project), ...protectedRoots])) {
    // Node resolves the absolute entry by lstat'ing its ancestor directories.
    const traversal = ancestors.filter(path => path === root || path.startsWith(root + sep));
    lines.push(`(deny file-read* (require-all (subpath ${quote(root)}) (require-not (subpath ${quote(project)})) ${traversal.map(path => `(require-not (literal ${quote(path)}))`).join(' ')}))`);
    lines.push(`(deny file-read-data (require-all (subpath ${quote(root)}) (require-not (subpath ${quote(project)}))))`);
  }
  if (options.unpackOnly) {
    for (const path of ['inputs/original', 'inputs/imports']) lines.push(`(deny file-write* (subpath ${quote(join(project, path))}))`);
    for (const path of ['inputs/import.json', 'inputs/import-policy.json']) lines.push(`(deny file-write* (literal ${quote(join(project, path))}))`);
    lines.push(`(deny file-write-unlink (literal ${quote(join(project, 'inputs'))}))`);
  }
  if (options.catalogOnly) {
    for (const path of ['inputs/original', 'inputs/imports', 'inputs/unpacked', 'inputs/unpacks']) lines.push(`(deny file-write* (subpath ${quote(join(project, path))}))`);
    for (const path of ['inputs/import.json', 'inputs/import-policy.json', 'inputs/unpack.json', 'inputs/unpack-policy.json', 'prompt-history.jsonl']) lines.push(`(deny file-write* (literal ${quote(join(project, path))}))`);
    for (const parent of ['assets', 'assets/derived', 'runs']) lines.push(`(deny file-write-unlink (literal ${quote(join(project, parent))}))`);
    for (const parent of ['assets/catalogs', 'assets/derived/inspection']) {
      if (existsSync(join(project, parent))) for (const name of readdirSync(join(project, parent))) lines.push(`(deny file-write* (subpath ${quote(join(project, parent, name))}))`);
      lines.push(`(deny file-write-unlink (literal ${quote(join(project, parent))}))`);
    }
    if (existsSync(join(project, 'runs'))) for (const name of readdirSync(join(project, 'runs')).filter(name => /^catalog-attempt-[a-f0-9-]{36}$/.test(name))) {
      for (const file of readdirSync(join(project, 'runs', name)).filter(file => file !== 'receipt.json')) lines.push(`(deny file-write* (literal ${quote(join(project, 'runs', name, file))}))`);
    }
    lines.push(`(deny file-write-unlink (literal ${quote(join(project, 'inputs'))}))`);
  }
  if (options.productionOnly) {
    lines.push(`(deny file-write* (subpath ${quote(join(project, 'inputs'))}))`);
    for (const [path, projection] of [['assets', 'assets/asset-plan.json'], ['spec', 'spec/main.json']]) {
      const exceptions = options.productionCompile ? ` (require-not (literal ${quote(join(project, path))})) (require-not (literal ${quote(join(project, projection))}))` : '';
      lines.push(`(deny file-write* (require-all (subpath ${quote(join(project, path))})${exceptions}))`);
      lines.push(`(deny file-write-unlink (literal ${quote(join(project, path))}))`);
    }
    for (const path of ['project.json', 'brief.json', 'director.json', 'prompt-history.jsonl']) lines.push(`(deny file-write* (literal ${quote(join(project, path))}))`);
    for (const path of ['production', 'production/revisions']) lines.push(`(deny file-write-unlink (literal ${quote(join(project, path))}))`);
    if (existsSync(join(project, 'production/revisions'))) for (const name of readdirSync(join(project, 'production/revisions'))) {
      lines.push(`(deny file-write* (subpath ${quote(join(project, 'production/revisions', name))}))`);
    }
    if (existsSync(join(project, 'production/manifest.json'))) lines.push(`(deny file-write* (literal ${quote(join(project, 'production/manifest.json'))}))`);
  }
  if (options.deliveryOnly) {
    for (const path of ['production', 'out/renders']) lines.push(`(deny file-write* (subpath ${quote(join(project, path))}))`);
    lines.push(`(deny file-write* (literal ${quote(join(project, 'run.json'))}))`);
    if (existsSync(join(project, 'runs'))) for (const name of readdirSync(join(project, 'runs')).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
      lines.push(`(deny file-write* (subpath ${quote(join(project, 'runs', name))}))`);
    }
    if (existsSync(join(project, 'out/deliveries'))) for (const name of readdirSync(join(project, 'out/deliveries')).filter(name => /^delivery-[a-f0-9-]{36}$/.test(name))) {
      lines.push(`(deny file-write* (subpath ${quote(join(project, 'out/deliveries', name))}))`);
    }
    if (existsSync(join(project, 'runs'))) for (const name of readdirSync(join(project, 'runs')).filter(name => /^delivery-attempt-[a-f0-9-]{36}$/.test(name))) {
      lines.push(`(deny file-write* (subpath ${quote(join(project, 'runs', name))}))`);
    }
  }
  if (options.alignmentOnly) {
    for (const path of ['inputs', 'production']) lines.push(`(deny file-write* (subpath ${quote(join(project, path))}))`);
    for (const [parent, allowed] of [['assets', ['derived', 'alignment.json']], ['assets/derived', ['alignment']], ['assets/derived/alignment', []]]) {
      if (existsSync(join(project, parent))) for (const name of readdirSync(join(project, parent)).filter(name => !allowed.includes(name))) lines.push(`(deny file-write* (subpath ${quote(join(project, parent, name))}))`);
      lines.push(`(deny file-write-unlink (literal ${quote(join(project, parent))}))`);
    }
    if (existsSync(join(project, 'runs'))) for (const name of readdirSync(join(project, 'runs')).filter(name => /^alignment-attempt-[a-f0-9-]{36}$/.test(name))) {
      for (const file of readdirSync(join(project, 'runs', name)).filter(file => file !== 'receipt.json')) lines.push(`(deny file-write* (literal ${quote(join(project, 'runs', name, file))}))`);
    }
  }
  if (options.videoOnly) {
    const mutable = [];
    if (options.videoRecover && existsSync(join(project, 'assets/derived/video'))) for (const name of readdirSync(join(project, 'assets/derived/video'))) {
      try {
        if (!/^[a-f0-9-]{36}$/.test(name)) continue;
        const marker = json(join(project, 'assets/derived/video', name, 'publication.json'));
        if (!/^runs\/video-attempt-[a-f0-9-]{36}\/receipt\.json$/.test(marker.receipt?.path ?? '')) continue;
        const record = json(join(project, marker.receipt.path));
        if (record.kind !== 'video-preparation-receipt' || record.videoId !== `video-${name}` ||
            marker.receipt.path !== `runs/${record.attemptId}/receipt.json` || !['running', 'prepared'].includes(record.status) ||
            !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1) continue;
        try { process.kill(record.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') mutable.push(name); }
      } catch { /* Unknown ownership retains immutable directory protection. */ }
    }
    for (const path of ['inputs', 'production']) lines.push(`(deny file-write* (subpath ${quote(join(project, path))}))`);
    for (const [parent, allowed] of [['assets', ['derived']], ['assets/derived', ['video']], ['assets/derived/video', mutable]]) {
      if (existsSync(join(project, parent))) for (const name of readdirSync(join(project, parent)).filter(name => !allowed.includes(name))) lines.push(`(deny file-write* (subpath ${quote(join(project, parent, name))}))`);
      lines.push(`(deny file-write-unlink (literal ${quote(join(project, parent))}))`);
    }
    if (existsSync(join(project, 'runs'))) for (const name of readdirSync(join(project, 'runs')).filter(name => /^video-attempt-[a-f0-9-]{36}$/.test(name))) {
      for (const file of readdirSync(join(project, 'runs', name)).filter(file => file !== 'receipt.json')) lines.push(`(deny file-write* (literal ${quote(join(project, 'runs', name, file))}))`);
    }
  }
  if (options.importOnly) {
    const readable = new Set([project, '/System/Library', '/usr/lib', '/dev/fd']);
    if (options.readSource) readable.add(resolve(options.readSource));
    // The loader opens a root-directory descriptor and resolves aliases of loaded runtime files.
    const runtimeFiles = new Set([process.execPath, '/', '/dev/null', '/dev/tty', '/dev/random', '/dev/urandom',
      ...(process.report.getReport().sharedObjects ?? []).filter(path => path.startsWith('/') && !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'))]);
    if (options.catalogOnly) for (const path of inspectionRuntimeFiles()) runtimeFiles.add(path);
    if (options.catalogOnly && existsSync(join(project, '.engine/ocr-dependencies.lock.json'))) {
      try { const identity = ocrRuntimeIdentity(); for (const tool of Object.values(identity.tools)) {
        for (const file of tool.files) runtimeFiles.add(file.path);
        for (const alias of tool.aliases) runtimeFiles.add(alias.path);
      } } catch { /* The adapter records an unavailable/mismatched OCR runtime as partial image inspection. */ }
    }
    for (const path of [...runtimeFiles]) {
      const cellar = path.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/);
      if (!cellar) continue;
      for (const dir of [dirname(path), join(cellar[1], 'opt', cellar[2], dirname(cellar[3]))]) {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          const alias = join(dir, name);
          try { if (realpathSync(alias) === path) runtimeFiles.add(alias); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
    const metadata = new Set(['/']);
    for (const path of [...readable, ...runtimeFiles]) {
      for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) metadata.add(parent);
    }
    const reads = [...readable].map(path => `(subpath ${quote(path)})`).concat([...runtimeFiles].map(path => `(literal ${quote(path)})`));
    const exclusions = filters => filters.map(filter => `(require-not ${filter})`).join(' ');
    lines.push(`(deny file-read* (require-all ${exclusions([...reads, ...[...metadata].map(path => `(literal ${quote(path)})`)])}))`);
    lines.push(`(deny file-read-data (require-all ${exclusions(reads)}))`);
    lines.push('(deny network*)');
  }
  return lines.join('\n') + '\n';
}

/** Resolve only the two fixed media executables and their exact shared-library closure. */
function inspectionRuntimeFiles() {
  const files = new Set(), visited = new Set();
  const visit = (path, inherited = [], executableDir = dirname(path)) => {
    if (!existsSync(path)) throw new Error(`CATALOG_RUNTIME_MISSING: ${path}`);
    const physical = realpathSync(path); files.add(path); files.add(physical); if (visited.has(physical)) return; visited.add(physical);
    const inspect = args => { const result = spawnSync('/usr/bin/otool', [...args, physical], { encoding: 'utf8', maxBuffer: 1048576 }); if (result.status !== 0) throw new Error('CATALOG_RUNTIME_DEPENDENCIES'); return result.stdout; };
    const expand = value => value.startsWith('@loader_path/') ? join(dirname(physical), value.slice(13)) : value.startsWith('@executable_path/') ? join(executableDir, value.slice(17)) : value;
    const own = [...inspect(['-l']).matchAll(/cmd LC_RPATH\n[\s\S]*?\n\s*path (.*?) \(offset/g)].map(match => expand(match[1]));
    const rpaths = [...own, ...inherited];
    for (const line of inspect(['-L']).split('\n').slice(1)) {
      const dependency = line.trim().split(' (')[0]; if (!dependency || dependency === physical || dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) continue;
      const candidate = dependency.startsWith('@rpath/') ? rpaths.map(dir => join(dir, dependency.slice(7))).find(existsSync) : expand(dependency);
      if (!candidate?.startsWith('/')) throw new Error(`CATALOG_RUNTIME_DEPENDENCY_UNRESOLVED: ${dependency} in ${physical}`);
      visit(candidate, rpaths, executableDir);
    }
  };
  for (const name of ['ffmpeg', 'ffprobe']) {
    const path = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(dir => join(dir, name)).find(existsSync);
    if (!path) throw new Error(`CATALOG_TOOL_UNAVAILABLE: ${name}`); visit(path, [], dirname(realpathSync(path)));
  }
  return files;
}

/** Input wrappers relay cancellation while waiting for the child to finish its receipt. */
export function spawnWithSignalRelay(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const signals = ['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]);
    const cleanup = () => signals.forEach(([signal, handler]) => process.removeListener(signal, handler));
    signals.forEach(([signal, handler]) => process.on(signal, handler));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (status, signal) => { cleanup(); resolve({ status, signal }); });
  });
}

/** The sandbox covers this child process and its descendants. Unsupported hosts fail closed. */
export function runBoundCommand(projectArg, command, options = {}) {
  const project = resolve(projectArg);
  if (realpathSync(project) !== project) throw new Error('WORKSPACE_LINK: project root');
  assertIndependentTree(project);
  const runtime = verifyRuntime(project);
  if (runtime.platform === 'linux' && runtime.version === 'manual-0.2') {
    if (!command.length) throw new Error('COMMAND_REQUIRED');
    const native = linuxMediaRuntimeIdentity(join(project, '.engine'));
    const environment = { ...process.env, PATH: `${dirname(process.execPath)}:${dirname(native.tools.ffmpeg.executable)}:${dirname(native.tools.ffprobe.executable)}:/usr/local/bin:/usr/bin:/bin`,
      JBM_RUNTIME_ID: runtime.packageId, JBM_ISOLATION: 'host-managed-unverified', TMPDIR: join(project, 'out/.tmp'), PYTHONDONTWRITEBYTECODE: '1' };
    delete environment.LD_PRELOAD; delete environment.LD_LIBRARY_PATH;
    mkdirSync(environment.TMPDIR, { recursive: true });
    return spawnWithSignalRelay(command[0], command.slice(1), { cwd: project, stdio: 'inherit', env: environment }).then(result => {
      verifyRuntime(project); linuxMediaRuntimeIdentity(join(project, '.engine'));
      if (result.status === null) throw new Error('LINUX_EXECUTION_FAILED: ' + result.signal);
      return result.status;
    });
  }
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('SANDBOX_UNAVAILABLE: macOS sandbox-exec is required');
  if (!command.length) throw new Error('COMMAND_REQUIRED');
  const policy = json(join(project, '.engine/isolation.json'));
  const tmp = join(project, 'out/.tmp');
  mkdirSync(tmp, { recursive: true });
  const environment = options.importOnly ? { PATH: `${dirname(process.execPath)}:${options.catalogOnly ? '/opt/homebrew/bin:/usr/local/bin:' : ''}/usr/bin:/bin`, LANG: process.env.LANG ?? 'en_US.UTF-8', OPENSSL_CONF: '/dev/null' } : process.env;
  const profile = sandboxProfile(project, policy.protectedRoots, options);
  const profilePath = options.catalogOnly ? join(tmp, `catalog-sandbox-${randomUUID()}.sb`) : null;
  if (profilePath) writeFileSync(profilePath, profile, { flag: 'wx', mode: 0o600 });
  const args = profilePath ? ['-f', profilePath, ...command] : ['-p', profile, ...command];
  const cleanup = () => { if (profilePath) rmSync(profilePath, { force: true }); };
  const spawnOptions = {
    cwd: project, stdio: 'inherit',
    env: { ...environment, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: '1', JBM_RUNTIME_ID: runtime.packageId },
  };
  const complete = result => {
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`SANDBOX_EXECUTION_FAILED: ${result.signal}`);
    verifyRuntime(project);
    return result.status;
  };
  if (options.importOnly) return spawnWithSignalRelay('/usr/bin/sandbox-exec', args, spawnOptions).then(complete).finally(cleanup);
  try { return complete(spawnSync('/usr/bin/sandbox-exec', args, spawnOptions)); } finally { cleanup(); }
}

/** Root entry resolves a selected source before switching to the film's working directory. */
export function importSourceArguments(args, cwd = process.cwd()) {
  if (args[0] !== 'import') return args;
  const { tokens } = parseArgs({ args: args.slice(1), options: IMPORT_OPTIONS, tokens: true });
  const normalized = [...args];
  for (const token of tokens) {
    if (token.kind !== 'option' || token.name !== 'source' || !token.value) continue;
    if (token.inlineValue) normalized[token.index + 1] = `--source=${resolve(cwd, token.value)}`;
    else normalized[token.index + 2] = resolve(cwd, token.value);
  }
  return normalized;
}

const UNPACK_OPTIONS = { import: { type: 'string' }, path: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' } };
const CATALOG_OPTIONS = { import: { type: 'string' }, unpack: { type: 'string' }, path: { type: 'string' }, asset: { type: 'string' }, observation: { type: 'string' }, rights: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' } };
const IMPORT_OPTIONS = { source: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' } };
const ALIGNMENT_OPTIONS = { catalog: { type: 'string' }, asset: { type: 'string' }, version: { type: 'string' }, script: { type: 'string' }, verify: { type: 'string' }, recover: { type: 'boolean' }, schema: { type: 'string' } };
const VIDEO_OPTIONS = { request: { type: 'string' }, verify: { type: 'string' }, recover: { type: 'boolean' }, schema: { type: 'string' }, limits: { type: 'string' } };
const PRODUCTION_OPTIONS = { profile: { type: 'string' }, request: { type: 'string' }, proposal: { type: 'string' }, schema: { type: 'string' }, 'expected-revision': { type: 'string' }, 'source-hash': { type: 'string' }, key: { type: 'string', multiple: true }, reason: { type: 'string' } };
const ASSET_OPTIONS = { plan: { type: 'string' }, schema: { type: 'string' } };
const DELIVERY_OPTIONS = { schema: { type: 'string' }, subject: { type: 'boolean' }, request: { type: 'string' }, verify: { type: 'string' } };

export function importCommandOptions(args) {
  if (['review', 'credits', 'deliver'].includes(args[0])) { parseArgs({ args: args.slice(1), options: DELIVERY_OPTIONS }); return { importOnly: true, catalogOnly: true, productionOnly: true, deliveryOnly: true }; }
  if (args[0] === 'production') { const { positionals } = parseArgs({ args: args.slice(1), options: PRODUCTION_OPTIONS, allowPositionals: true }); return { importOnly: true, catalogOnly: true, productionOnly: true, ...(positionals[0] === 'compile' ? { productionCompile: true } : {}) }; }
  if (args[0] === 'video') { const { values } = parseArgs({ args: args.slice(1), options: VIDEO_OPTIONS }); return { importOnly: true, catalogOnly: true, videoOnly: true, ...(values.recover ? { videoRecover: true } : {}) }; }
  if (args[0] === 'assets') { parseArgs({ args: args.slice(1), options: ASSET_OPTIONS }); return { importOnly: true, catalogOnly: true, videoOnly: true }; }
  if (args[0] === 'align') { parseArgs({ args: args.slice(1), options: ALIGNMENT_OPTIONS }); return { importOnly: true, catalogOnly: true, alignmentOnly: true }; }
  if (args[0] === 'catalog') { parseArgs({ args: args.slice(1), options: CATALOG_OPTIONS }); return { importOnly: true, catalogOnly: true }; }
  if (args[0] === 'unpack') {
    parseArgs({ args: args.slice(1), options: UNPACK_OPTIONS });
    return { importOnly: true, unpackOnly: true };
  }
  if (args[0] !== 'import') return {};
  const { values } = parseArgs({ args: args.slice(1), options: IMPORT_OPTIONS });
  return { importOnly: true, ...(values.source ? { readSource: values.source } : {}) };
}

export function engineArguments(project, args) {
  const [command, ...rest] = args;
  if (command === 'audio' && rest[0] === 'lock') return ['audio', 'lock', project, ...rest.slice(1)];
  if (['validate', 'frame', 'storyboard', 'render', 'qa', 'diagnose', 'audio', 'subtitles', 'disclosure', 'postprocess', 'artifact', 'prompt', 'import', 'unpack', 'catalog', 'align', 'assets', 'video', 'production', 'review', 'credits', 'deliver'].includes(command)) return [command, project, ...rest];
  if (command === 'direct' && rest[0] === 'compile') return ['direct', 'compile', project, ...rest.slice(1)];
  if (command === 'brief' && rest[0] === 'validate') return ['brief', 'validate', project, ...rest.slice(1)];
  if (command === 'project' && rest[0] === 'audit') return ['project', 'audit', project, ...rest.slice(1)];
  if (['capabilities', 'voices'].includes(command)) return args;
  if (command === 'env') return ['env', '--out-dir', join(project, 'out'), ...rest];
  throw new Error('WORKSPACE_COMMAND: use capabilities/voices/env/direct compile/prompt/import/unpack/catalog/align/assets/video/production/review/credits/deliver/validate/qa/audio/frame/storyboard/render/subtitles/brief validate/project audit/disclosure/postprocess/artifact');
}
