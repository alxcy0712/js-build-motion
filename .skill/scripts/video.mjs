import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { backupCore, engine, root, skill, verifyCore } from './core.mjs';
import { digest, importSourceArguments, json, spawnWithSignalRelay, writeJson } from '../engine/workspace.mjs';
import { startDirectorProject } from '../engine/src/cli/director.ts';
import { compileDirector } from '../engine/src/project/director.ts';
import { parseBrand } from '../engine/src/themes/brand.ts';
import { THEME_IDS } from '../engine/src/themes/ids.ts';

function projectPath(slug) {
  const projects = join(root, 'projects');
  const project = resolve(projects, slug);
  if (dirname(project) !== projects || basename(project) !== slug) throw new Error('PROJECT_SLUG: use one project name');
  return project;
}

export function initializeWorkspace({ slug, idea, title = slug, theme, components = ['easing', 'random'] }) {
  if (!theme) throw new Error('THEME_REQUIRED: 先确认本片主题，再传入 --theme minimal|kinetic；账号默认仅作推荐');
  const manifest = verifyCore();
  // 账号默认（.skill/brand.json）＋ 用户对本片风格的答复 → 本片快照
  const account = parseBrand(json(join(skill, 'brand.json')));
  const filmTheme = theme;
  if (!THEME_IDS.includes(filmTheme)) throw new Error(`THEME_UNKNOWN: ${filmTheme} 未登记（可用：${THEME_IDS.join(' / ')}）`);
  const selectedAt = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const brandSnapshot = {
    version: 2,
    ...(account.owner !== undefined ? { owner: account.owner } : {}),
    theme: filmTheme,
    defaultTheme: account.theme,
    enforcement: account.enforcement,
    ...(account.note !== undefined ? { note: account.note } : {}),
    changes: [...account.changes, { at: selectedAt, theme: filmTheme,
      reason: `初始化显式指定主题 ${filmTheme}（账号默认 ${account.theme}）` }],
  };
  const catalog = json(join(skill, 'assets/components.json'));
  const selected = new Set();
  const include = name => {
    if (!Object.hasOwn(catalog, name)) throw new Error(`COMPONENT_UNKNOWN: ${name}`);
    if (selected.has(name)) return;
    selected.add(name);
    catalog[name].dependencies.forEach(include);
  };
  components.forEach(include);
  const project = projectPath(slug);
  if (existsSync(project)) throw new Error('PROJECT_EXISTS: continue the existing project');
  const backup = backupCore();
  const result = startDirectorProject({ slug, idea, title, projectsRoot: dirname(project) });
  const neutral = compileDirector({ version: '0.1', idea, title, aspect: '16:9', look: 'graphic', bpm: 96,
    shots: [{ purpose: '等待本片导演计划', beats: 2, title, backdrop: 'studio', motif: 'none', cameraMove: 'static', transition: 'cut' }] });
  // 占位 spec 跟着本片选择，避免后续每次校验都触发 BRAND_THEME_LOCKED
  neutral.spec.style.theme = filmTheme;
  writeJson(join(project, 'spec/main.json'), neutral.spec);
  cpSync(engine, join(project, '.engine'), { recursive: true, dereference: true, filter: path => path !== join(engine, 'test') });
  writeJson(join(project, 'brand.json'), brandSnapshot);
  writeJson(join(project, '.engine/engine-manifest.json'), manifest);
  cpSync(join(skill, 'references'), join(project, 'guide'), { recursive: true });
  cpSync(join(skill, 'assets/project'), project, { recursive: true });
  mkdirSync(join(project, 'src/components'), { recursive: true });
  const sources = new Map([...selected].map(name => [resolve(engine, catalog[name].source), name]));
  for (const name of selected) {
    const source = resolve(engine, catalog[name].source);
    const target = join(project, 'src/components', `${name}.ts`);
    const text = readFileSync(source, 'utf8').replace(/(\bfrom\s+)(['"])(skia-canvas|\.\.?\/[^'"]+)\2/g, (match, prefix, quote, path) => {
      const imported = path === 'skia-canvas' ? join(engine, 'node_modules/skia-canvas/lib/index.js') : resolve(dirname(source), path);
      const local = sources.has(imported) ? `./${sources.get(imported)}.ts` : relative(dirname(target), join(project, '.engine', relative(engine, imported))).split('\\').join('/');
      return `${prefix}${quote}${local}${quote}`;
    });
    writeFileSync(target, text);
  }
  const isolation = { protectedRoots: [root] };
  writeJson(join(project, '.engine/isolation.json'), isolation);
  writeJson(join(project, 'workspace.json'), { version: '0.2', packageId: manifest.packageId, isolationSha256: digest(JSON.stringify(isolation)), components: [...selected].sort(),
    brand: { theme: filmTheme, defaultTheme: account.theme, sha256: digest(readFileSync(join(project, 'brand.json'))) } });
  return { project: result.dir, status: 'needs-intake', next: '主题已写入 brand.json；按 guide/intake.md 补齐沟通原文与尚待决定的创作选择，按 guide/motion-language.md 落实创作主线；已有选择与委托持续沿用，完成问答后制定导演计划与素材方案', packageId: manifest.packageId, components: [...selected].sort(), backup };
}

export function invokeProject(slug, args) {
  const project = projectPath(slug);
  if (!existsSync(join(project, 'workspace.json'))) throw new Error('PROJECT_NOT_INITIALIZED');
  backupCore();
  const [command, ...rest] = args;
  const entry = command === 'exec' ? 'exec.mjs' : 'video.mjs';
  const forwarded = [join(project, entry), ...(command === 'exec' ? rest : importSourceArguments(args))];
  const complete = result => {
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`PROJECT_PROCESS: ${result.signal}`);
    return result.status;
  };
  if (['import', 'unpack', 'catalog', 'align', 'production', 'review', 'credits', 'deliver'].includes(command)) return spawnWithSignalRelay(process.execPath, forwarded, { cwd: project, stdio: 'inherit' }).then(complete);
  return complete(spawnSync(process.execPath, forwarded, { cwd: project, stdio: 'inherit' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'backup') process.stdout.write(JSON.stringify({ backup: backupCore() }) + '\n');
    else if (command === 'start') {
      const { values, positionals } = parseArgs({ args, options: { idea: { type: 'string' }, 'idea-file': { type: 'string' }, title: { type: 'string' }, theme: { type: 'string' }, components: { type: 'string' } }, allowPositionals: true });
      if (positionals.length !== 1 || (values.idea === undefined) === (values['idea-file'] === undefined)) throw new Error('USAGE: video.mjs start <slug> (--idea "idea" | --idea-file prompt.txt) --theme minimal|kinetic');
      const idea = values['idea-file'] !== undefined ? readFileSync(resolve(values['idea-file']), 'utf8') : values.idea;
      process.stdout.write(JSON.stringify(initializeWorkspace({ slug: positionals[0], idea, ...(values.title ? { title: values.title } : {}), ...(values.theme ? { theme: values.theme } : {}), ...(values.components ? { components: values.components.split(',') } : {}) }), null, 2) + '\n');
    } else {
      if (!command || !args.length) throw new Error('USAGE: video.mjs <slug> <command> [args] | start | backup');
      process.exitCode = await invokeProject(command, args);
    }
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
