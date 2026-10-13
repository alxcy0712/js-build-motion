import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { backupCore, engine, root, skill, verifyCore } from './core.mjs';
import { digest, importSourceArguments, json, spawnWithSignalRelay, writeJson } from '../engine/workspace.mjs';
import { startDirectorProject } from '../engine/src/cli/director.ts';
import { compileDirector } from '../engine/src/project/director.ts';

function projectPath(slug) {
  const projects = join(root, 'projects');
  const project = resolve(projects, slug);
  if (dirname(project) !== projects || basename(project) !== slug) throw new Error('PROJECT_SLUG: use one project name');
  return project;
}

export function initializeWorkspace({ slug, idea, title = slug, components = ['easing', 'random'] }) {
  const manifest = verifyCore();
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
    shots: [{ purpose: '等待本片导演计划', beats: 2, title, backdrop: 'studio', motif: 'none', actors: [], cameraMove: 'static', transition: 'cut' }] });
  writeJson(join(project, 'spec/main.json'), neutral.spec);
  cpSync(engine, join(project, '.engine'), { recursive: true, dereference: true, filter: path => path !== join(engine, 'test') });
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
  writeJson(join(project, 'workspace.json'), { version: '0.2', packageId: manifest.packageId, isolationSha256: digest(JSON.stringify(isolation)), components: [...selected].sort() });
  return { project: result.dir, status: 'needs-intake', next: '按 guide/intake.md 用模型解析一句话需求，推荐风格、叙事与记忆点，集中提出关键问题；重要选择有回答或明确委托后制定导演计划与素材方案', packageId: manifest.packageId, components: [...selected].sort(), backup };
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
      const { values, positionals } = parseArgs({ args, options: { idea: { type: 'string' }, 'idea-file': { type: 'string' }, title: { type: 'string' }, components: { type: 'string' } }, allowPositionals: true });
      if (positionals.length !== 1 || (values.idea === undefined) === (values['idea-file'] === undefined)) throw new Error('USAGE: video.mjs start <slug> --idea "idea" | --idea-file prompt.txt');
      const idea = values['idea-file'] !== undefined ? readFileSync(resolve(values['idea-file']), 'utf8') : values.idea;
      process.stdout.write(JSON.stringify(initializeWorkspace({ slug: positionals[0], idea, ...(values.title ? { title: values.title } : {}), ...(values.components ? { components: values.components.split(',') } : {}) }), null, 2) + '\n');
    } else {
      if (!command || !args.length) throw new Error('USAGE: video.mjs <slug> <command> [args] | start | backup');
      process.exitCode = await invokeProject(command, args);
    }
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
