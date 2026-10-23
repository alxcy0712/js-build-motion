import { copyGuides } from './guide-files.mjs';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error(`NODE_VERSION: 需要 Node 24，当前 ${process.version}；请切换后重新初始化`);
const slug = process.env.JBM_FILM_SLUG, theme = process.env.JBM_FILM_THEME;
if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug ?? '')) throw Error('PROJECT_SLUG');
if (!['minimal', 'kinetic'].includes(theme)) throw Error('THEME_REQUIRED');
const idea = readFileSync(process.env.JBM_IDEA_FILE, 'utf8');
if (!idea.trim()) throw Error('PROMPT_REQUIRED');
const project = resolve('projects', slug), engine = resolve('.skill/engine');
if (existsSync(project)) throw Error('PROJECT_EXISTS');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const account = read('.skill/brand.json'), source = read('.skill/manifest.json');
const { packageId: sourceId, ...sourceContent } = source;
if (hash(JSON.stringify(sourceContent)) !== sourceId) throw Error('SOURCE_MANIFEST_CHANGED');
const timestamp = new Date().toISOString();
const at = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
for (const dir of ['spec', 'src/components', 'assets', 'evidence', 'out/.tmp']) mkdirSync(join(project, dir), { recursive: true });
const excluded = ['node_modules', 'test', '.research', 'projects', 'assets/asr/bin', 'assets/asr/models', 'assets/ocr/tessdata'];
cpSync(engine, join(project, '.engine'), { recursive: true, dereference: true,
  filter: path => !excluded.includes(relative(engine, path)) });
const components = ['easing', 'random'], catalog = read('.skill/assets/components.json');
for (const name of components) cpSync(join(engine, catalog[name].source), join(project, 'src/components', `${name}.ts`));
copyGuides(resolve('.skill'), project);
cpSync('.skill/assets/project/evidence', join(project, 'evidence'), { recursive: true });
for (const entry of ['video.mjs', 'exec.mjs']) cpSync(join('.skill/assets/project', entry), join(project, entry));
cpSync('.skill/manifest.json', join(project, '.engine/source-manifest.json'));
const write = (path, value) => writeFileSync(join(project, path), JSON.stringify(value, null, 2) + '\n');
const brand = { ...account, theme, defaultTheme: account.theme, changes: [...account.changes,
  { at, theme, reason: `Linux 手建显式指定主题 ${theme}（账号默认 ${account.theme}）` }] };
write('brand.json', brand);
write('workspace.json', { version: 'manual-0.1', mode: 'manual-linux', sourcePackageId: source.packageId,
  host: { platform: process.platform, arch: process.arch, node: process.version }, engineSha256: null, components,
  sandbox: 'host-managed-unverified', brand: { theme, defaultTheme: account.theme, sha256: hash(readFileSync(join(project, 'brand.json'))) } });
write('project.json', { version: '0.1', slug, title: slug, status: 'draft', entry: 'spec/main.json', brief: 'brief.json', outDir: 'out' });
write('spec/main.json', { version: '0.1', video: { width: 1080, height: 1920, fps: 24, duration: 3, seed: 1 },
  style: { theme }, scenes: [{ id: 's1', start: 0, end: 3, environment: 'theme_stage', headline: ['等待剧本'] }],
  audio: { narration: [], bgm: { volume: 0 } }, captions: { enabled: false } });
write('brief.json', { version: '0.1', archetype: 'code-animation-no-assets', intent: '根据已记录的用户原文制作本片，当前为初始化占位。',
  deliverable: { duration: 3, aspect: '9:16', fps: 24, captions: 'none' }, assets: [], tools: { allowed: ['skia-canvas', 'ffmpeg', 'ffprobe'] },
  claims: { humanRounds: null, pureCode: true, zeroExternalAssets: true, humanRevision: false } });
writeFileSync(join(project, 'prompt-history.jsonl'), JSON.stringify({ timestamp, kind: 'prompt', text: idea }) + '\n');
writeFileSync(join(project, 'NOTES.md'), '# 制作记录\n\nLinux 手建工作区；主题原文与问答待补齐。按本片 guide 完成创作和验收。\n\n每次渲染记录 Asia/Shanghai 生成时间。\n\n学习状态：pending。\n');
writeFileSync(join(project, 'AGENTS.md'), '# Linux 手建入口\n\n本片 mode 为 manual-linux，安装依赖和字体后执行 node .engine/scripts/seal-linux.mjs .；制作命令使用 node video.mjs，通用命令使用 node exec.mjs。系统隔离由团队宿主管理，每次运行前后核验本片引擎、品牌及媒体工具闭包；以下通用规范中的统一入口在本片按本段执行。\n\n' + readFileSync('.skill/assets/project/AGENTS.md', 'utf8'));
write('package.json', { private: true, type: 'module' });
const pkg = read(join(project, '.engine/package.json'));
const versions = new Map(source.dependencies.map(item => [item.slice(0, item.lastIndexOf('@')), item.slice(item.lastIndexOf('@') + 1)]));
pkg.dependencies = Object.fromEntries(Object.keys(pkg.dependencies).map(name => {
  if (!versions.has(name)) throw Error(`DEPENDENCY_VERSION: ${name}`);
  return [name, versions.get(name)];
}));
write('.engine/package.json', pkg);
