# js-build-motion：按执行环境分工

进入仓库后，先根据运行位置、工作区和用户指派确定角色，读取对应部分及[两端共用](#三两端共用)规则。共享规范中的角色专用条款按本文件对应角色执行。新增偏好与授权写入对应角色，共用规则集中在第三部分及文末的[多团队协作与分支合并](#多团队协作与分支合并)。运行位置还未确认时，先确认环境，再处理相关素材或凭据。

日常维护按角色分工：第一部分由 Grok Bot 团队维护，第二部分由本地 Agent 维护。修改对方规则、公共入口或两端共用规则，按用户明确指派的范围执行，已有授权在其范围内持续有效。维护本文件时只修改相关段落；仅更新自己的部分时，检查对方部分、公共入口和共用规则保持原样。发现职责范围外的问题时，说明具体位置和影响，保留原文。

| 执行角色 | 工作输入与产出 | 适用入口 |
|---|---|---|
| Grok Bot 团队 | 用户提供的选题、稿件与文字素材 → 团队制作的视频、图文或文章素材包 | [第一部分](#一grok-bot-团队)、[两端共用](#三两端共用) |
| 本地 Agent（Codex 等） | 用户在本地委托的文字需求、原片、录音与素材库 → 本地制作、剪辑与素材补充 | [第二部分](#二本地-agentcodex-等)、[两端共用](#三两端共用) |

两端各自使用所在环境的工作区、工具、凭据和项目记录。同名仓库或 `projects/<slug>/` 各自指向所在环境的副本；跨环境交接以用户明确提供或授权共享的内容为准。另一端的对话、截图与记忆作为协作背景，任务和授权以用户指派及其明确覆盖的环境为准。`AGENTS.md` 约定执行边界，实际文件访问权限由各自宿主的沙箱和账号控制。

## 一、Grok Bot 团队

### 群内分工

接收用户的选题、稿件或文字素材，在 Grok Bot 自己的环境中制作视频、图文或 X 文章素材包。工作素材来自用户明确交给该团队的内容、共享仓库资产和团队自行生成的素材。用户电脑上的私人素材库、拍摄原片、原片剪辑、补录与素材补齐由本地 Agent 承接。

| 角色 | 职责与交付边界 |
|---|---|
| Onei | 讨论选题、编写每日 AI 早报、协调团队分工；按用户授权维护共享仓库代码，本片有通用改进时按下述流程推送到 `style-system`。 |
| 文案 | X 文章由用户写作，团队负责校对与建议；口播稿仅在用户要求时编写。每次都检查抖音、小红书合规，分别列出问题。 |
| 脚本 | 将校对后的文章转换为小红书图文；视频分镜按 TTS 时间戳拆分，逐镜标注生成镜头或代码镜头。 |
| 视频制作 | 使用 js-build-motion 与生成视频完成团队影片，按审片清单修正。 |
| 审片 | 检查成片质量，集中提出一轮「必须改」，复审验收该轮条目。 |
| 配图 | 制作 X 文章的封面与配图，以及抖音竖版、横版封面。 |

### 实施步骤

团队视频按以下顺序推进：

1. 用户提供选题或文案。
2. 口播稿仅在用户要求时由文案编写。抖音、小红书合规检查每次都做，分别列出问题；口播稿经用户确认后锁定。
3. TTS 生成配音与时间戳；脚本按时间戳拆分镜，逐镜标注生成镜头或代码镜头，交付视频制作后锁定。
4. 视频制作按锁定稿和分镜出片。
5. 审片只开一轮「必须改」；视频制作按清单修正，复审只验收这几条。建议项记入本片 `NOTES.md` 的下一条视频待办，不挡发布。
6. 配图制作两张抖音封面：竖版、横版各一张，经用户确认后锁定。
7. 如本片沉淀出通用改进，Onei 按[推送流程](#onei-的推送流程)将代码推送到 `style-system`。
8. 用户自行发布。

每条新片开工时询问用户是否需要片尾头像与个人 IP 落款，答复记入本片并沿用。用户确认采用时，成片以「我是澄记，用计算机思维想现实。」结尾，前一句要自然承接本片内容，片尾卡按[片尾规格](.skill/references/visual-identity.md#片尾头像与个人-ip-落款)制作并与该句口播同步；用户不采用时，片尾卡与收尾口播都不加，成片在正片内容的结论处结束。口播写法详见[口播与发布规范](.skill/references/douyin-publishing.md)。

其他内容按以下流程交付：

- X 文章：用户写作 → 文案校对 → 配图制作封面和配图 → 用户发布。
- 小红书图文：用户写作 → 文案校对与合规检查 → 脚本转为图文 → 用户发布。

### 项目文件夹

- 每条团队视频开工先建 `projects/<slug>/`，一片一个文件夹。
- 本片的输入、网上下载的素材（附来源链接）、生成素材、配音、封面和成片都存放在该文件夹内，不散落在其他目录。
- 本片 `NOTES.md` 记录每次视频渲染的生成时间（Asia/Shanghai），便于追溯版本。
- 磁盘空间不足时可直接删除旧项目，无需另行保留。

### Linux 团队手建流程

当前封存入口适用于 macOS ARM64。Linux 团队使用本节的独立手建流程，适用范围为文字稿、代码画面和本片已保存素材的制作；Node 24、FFmpeg/ffprobe、Linux 版 Skia Canvas 与实际使用的字体须可用。当前代码的沙箱适配为 `sandbox-exec`，宿主已有的 `bwrap` 由团队宿主自行配置和验证。本流程的系统隔离状态记为 `host-managed-unverified`，本片文件校验按下述步骤执行。

1. 执行初始化前，先在当前终端通过宿主版本管理器或 PATH 切换到 Node 24，用 `node --version` 确认输出为 `v24.x.x`；后续 `node` 和 `npm` 沿用该终端环境。初始化代码在写入项目之前检查版本，版本不符时报 `NODE_VERSION`。按创作问答取得本片主题，准备保存用户原文的 UTF-8 文件。在仓库根运行下面的初始化示例：`JBM_FILM_SLUG` 使用新目录名，`JBM_FILM_THEME` 填已选的 `minimal` 或 `kinetic`，`JBM_IDEA_FILE` 指向实际原文。示例只写占位画面；剧本与镜头仍按已确认要求制作。

```bash
export JBM_FILM_SLUG=example-film
export JBM_FILM_THEME=kinetic
export JBM_IDEA_FILE=/path/to/original-prompt.txt
node --input-type=module <<'JS' &&
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
const timestamp = new Date().toISOString();
const at = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
for (const dir of ['spec', 'src/components', 'assets', 'evidence', 'out/.tmp']) mkdirSync(join(project, dir), { recursive: true });
const excluded = ['node_modules', 'test', '.research', 'projects', 'assets/asr/bin', 'assets/asr/models', 'assets/ocr/tessdata'];
cpSync(engine, join(project, '.engine'), { recursive: true, dereference: true,
  filter: path => !excluded.includes(relative(engine, path)) });
const components = ['easing', 'random'], catalog = read('.skill/assets/components.json');
for (const name of components) cpSync(join(engine, catalog[name].source), join(project, 'src/components', `${name}.ts`));
cpSync('.skill/references', join(project, 'guide'), { recursive: true });
cpSync('.skill/assets/project/evidence', join(project, 'evidence'), { recursive: true });
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
writeFileSync(join(project, 'AGENTS.md'), '# Linux 手建入口\n\n本片 mode 为 manual-linux，命令使用 node .engine/src/cli/index.ts，项目参数传入本片绝对路径，系统隔离由团队宿主管理。每次运行前按根 AGENTS.md 核对 engineSha256 和 brand.sha256；以下通用规范中的统一入口在本片按本段执行。\n\n' + readFileSync('.skill/assets/project/AGENTS.md', 'utf8'));
write('package.json', { private: true, type: 'module' });
const pkg = read(join(project, '.engine/package.json'));
const versions = new Map(source.dependencies.map(item => [item.slice(0, item.lastIndexOf('@')), item.slice(item.lastIndexOf('@') + 1)]));
pkg.dependencies = Object.fromEntries(Object.keys(pkg.dependencies).map(name => {
  if (!versions.has(name)) throw Error(`DEPENDENCY_VERSION: ${name}`);
  return [name, versions.get(name)];
}));
write('.engine/package.json', pkg);
JS
npm install --prefix "projects/$JBM_FILM_SLUG/.engine" --omit=dev --bin-links=false &&
cd "projects/$JBM_FILM_SLUG" &&
export TMPDIR="$PWD/out/.tmp/"
```

2. 初始化已将 `easing.ts` 和 `random.ts` 独立复制到本片 `src/components/`，本片源码可按 guide 中的例子导入。在本片 `.engine/assets/fonts/` 恢复所需字体及许可，尤其是 `LXGWWenKai-Regular.ttf`；下载来源见根 README 的字体归因。依赖使用 Linux 原生包，`package-lock.json` 随本片保留。完成依赖准备后登记运行时摘要：

```bash
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { digest, fileHashes } from './.engine/workspace.mjs';
const workspace = JSON.parse(readFileSync('workspace.json', 'utf8'));
const files = fileHashes('.engine');
workspace.engineSha256 = digest(JSON.stringify(files));
writeFileSync('evidence/runtime-files.json', JSON.stringify(files, null, 2) + '\n');
writeFileSync('workspace.json', JSON.stringify(workspace, null, 2) + '\n');
JS
```

`brand.json` 的 `theme` 是本片已选主题，`defaultTheme` 是当时账号推荐值，最后一条 `changes` 记录初始化事实；用户选择依据另存原文。`workspace.json` 使用 `manual-0.1` 标明执行方式，`sourcePackageId` 只记录来源版本，`engineSha256` 是本片安装完成后的实际字节摘要，`brand.sha256` 是完整快照文件的 SHA-256。每次恢复、执行和交付前运行以下检查，运行时变化须先明确迁移范围并保留旧版本证据：

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertIndependentTree, digest, fileHashes } from './.engine/workspace.mjs';
const workspace = JSON.parse(readFileSync('workspace.json', 'utf8'));
assert.equal(workspace.mode, 'manual-linux');
assertIndependentTree('.');
assert.equal(digest(JSON.stringify(fileHashes('.engine'))), workspace.engineSha256);
assert.equal(digest(readFileSync('brand.json')), workspace.brand.sha256);
JS
```

修改本片前，等待本片正在执行的命令结束，在本片根目录运行以下备份命令。它归档整个项目，包含运行时、素材、记录和已有输出，保存到 `projects/.backups/<slug>/` 下的独立目录；归档内容检查通过后打印备份路径。恢复时解压到新的空目录，再运行上面的独立文件与摘要检查。

```bash
(
set -eu
test -f workspace.json
test -f project.json
JBM_PROJECT_DIR="$(pwd -P)"
JBM_PROJECT_NAME="$(basename "$JBM_PROJECT_DIR")"
JBM_BACKUP_ROOT="$(dirname "$JBM_PROJECT_DIR")/.backups/$JBM_PROJECT_NAME"
mkdir -p "$JBM_BACKUP_ROOT"
JBM_SNAPSHOT_DIR="$(mktemp -d "$JBM_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
tar -czf "$JBM_SNAPSHOT_DIR/project.tar.gz" -C "$(dirname "$JBM_PROJECT_DIR")" "$JBM_PROJECT_NAME"
tar -tzf "$JBM_SNAPSHOT_DIR/project.tar.gz" > /dev/null
printf '%s\n' "$JBM_SNAPSHOT_DIR/project.tar.gz"
)
```

3. `prompt-history.jsonl` 每行是 `{ "timestamp": "ISO 8601 时间", "kind": "prompt|question|answer", "text": "原文" }`，首条保存用户原始 prompt；后续修改要求用 `prompt`，模型问题用 `question`，用户答复用 `answer`，按沟通顺序追加。`timestamp` 记录入库时间，补录时保留实际原文。可使用本片 CLI 追加，所有参数文件、素材和输出继续放在本片：

```bash
node .engine/src/cli/index.ts prompt "$PWD" --kind question --text "实际提出的问题原文"
node .engine/src/cli/index.ts prompt "$PWD" --kind answer --text "实际收到的用户答案原文"
node .engine/src/cli/index.ts capabilities --schema
node .engine/src/cli/index.ts env --out-dir out --json
node .engine/src/cli/index.ts validate "$PWD"
node .engine/src/cli/index.ts brief validate "$PWD"
node .engine/src/cli/index.ts project audit "$PWD"
node .engine/src/cli/index.ts frame "$PWD" --at 1
node .engine/src/cli/index.ts render "$PWD" --no-audio --no-network
```

初始化的 3 秒占位 spec 采用空旁白、BGM 音量 0，首次试片使用上面的 `--no-audio --no-network`。普通 `render` 会构建音频，需先在本片规格中配置旁白、BGM 或音效；有意无声的视频继续显式传入 `--no-audio`。

4. 更新占位 spec、brief 和本片源码后执行 `qa "$PWD"`、`render "$PWD"`、`artifact "$PWD" --out evidence/artifact.json`、`disclosure "$PWD"`，命令前缀均为 `node .engine/src/cli/index.ts`。辅助脚本使用 `node .engine/scripts/<脚本>`，默认输出为本片 `out/`；通用命令由宿主在本片工作目录执行，`TMPDIR` 设为本片 `out/.tmp/`。原片、图片、配音按授权复制为本片独立文件，并记录来源、许可和哈希。引擎 `.engine` 自动读取同级 `brand.json`；从共享核心调用 `validateSpec` 的自定义脚本显式传入 `{ brand: loadBrand(本片brand路径) }`。

本流程跳过的项目为：macOS 封存清单的宿主匹配、根 `video.mjs` 自动备份、`verifyRuntime` 的发行包校验、`sandbox-exec` 进程门禁及 macOS `--native`／`--standalone` 宿主检查。替代记录为手建工作区摘要、修改前的本片备份和宿主隔离事实。文案确认、主题确认、原文记录、普通独立文件检查、规格／声明／路径校验、实际音视频验收、来源权利与用户发布审批继续执行。OCR／ASR、受限素材入库与视频准备、Production 及结构化交付命令依赖各自固定原生闭包和系统隔离，留待 Linux 适配后启用；本流程交付使用当前编码、真实 run.json 和人工审片证据。

### 锁定规则

- 审片修改中的时间戳、引号、叠化等问题，只改代码并重新渲染，沿用已生成的镜头。只有人物长相或动作整段不对时，才重新生成对应镜头。
- 封面经用户确认后锁定，成片小改动沿用已确认封面；只有用户明确要求换标题或换主体时，才重做封面。

### Onei 的推送流程

1. 先执行 `git pull --rebase origin style-system`。
2. 推送前检查本次差异，确认只包含通用改进，排除视频产物、单片产物和密钥。
3. 检查通过后推送到 `style-system`，禁止使用 `--force`。

遇到冲突立即停止，向用户报告，等用户明确处理方式后再继续。

### 执行范围

Grok Bot 的配音使用本团队已获授权的音色、凭据与实际可用接口。涉及用户私人原片或素材库的需求交由本地 Agent 处理，交接时写明文字需求与目标产物。

## 二、本地 Agent（Codex 等）

### 本地素材与剪辑

本地 Agent（包括 Codex）以用户本地项目的剪辑为主要职责，同时可按用户的文字需求生成新视频，或生成镜头与素材用于本地项目。具体制作范围、素材访问与工具调用沿用用户当次指派及已有授权。

在用户电脑上接收文字需求，处理其明确指定的原片、录音和素材文件夹，完成本地制作、素材整理、剪辑、强相关内容补充、配音和成片验证。执行依据为用户当次任务、已确认文案及本地素材证据。本地审片按用户要求与[成片质量](.skill/references/quality.md)完成问题修正和复核。

### 素材补充与个人配音

补充以用户提供的素材库、已确认文案和当前讲解对象为依据，只选择强相关、能从上下文自然推导的内容。每项补充写清对应的原素材、补足的信息与使用镜头，用于帮助理解和丰富既有表达；涉及新的主题、事实主张或叙事方向时先确认。用户仅说明后续制作偏好时，保存约定供后续制作沿用；已有影片的修改按用户当次指定范围执行。

大众熟悉的品牌、产品和物体优先采用可核验的原始素材，包括官方原版图标、产品截图、实物照片和演示片段。先查官方品牌资源、产品页面或媒体资料，保留识别特征、比例、配色与真实外观；官方原件可用且许可满足用途时直接采用。与讲解对象直接相关的品牌标识和产品界面可按该用途入片，执行本节的来源与权利核验。每项采用保存来源页面、提供方、版本、许可依据和文件哈希，并在成片或配套说明中按许可及发布要求声明来源。

网络补充素材优先采用经核验的公有领域或 CC0 内容；官方品牌素材逐项核实适用许可、品牌规范与本片用途。署名与使用授权分别记录，免费获取与官方发布各自作为来源信息，采用依据须覆盖实际使用范围；权利依据待核实时保留待处理状态。含水印时优先寻找合法的无水印原件；去水印仅用于用户自有或权利人明确允许该处理的素材，保留许可要求的署名和权利信息，登记处理依据与派生版本。具体素材与证据仍按[素材选择](.skill/references/assets.md)保存在本片。

补充内容需要本人旁白且用户尚未录音时，用户已授权使用豆包语音中预先录制的“我002”音色，并沿用其此前提供的 API Key；该授权在此范围内持续有效。调用前核对真实音色 ID、模型资源、账户权限与本片运行时支持情况，凭据通过 `DOUBAO_API_KEY` 环境变量传入，项目与日志只记录凭据可用状态。音色身份或凭据待核实时，将补录项保留为待处理；实际合成后保存文本、音色身份、音频来源和试听结果。具体配音执行遵循[音视频与验收](.skill/references/execution.md)，本节的个人音色授权优先于通用默认音色选择。

## 三、两端共用

本部分和下文的[多团队协作与分支合并](#多团队协作与分支合并)适用于 Grok Bot 团队与本地 Agent。两端每次制作、修改或维护都要遵守。

### 内容与资产边界

仓库共享内容限于通用规则、方法、代码和可复用资产。本文件保存通用协作与执行规则，`.research/` 保存可分享的理念、假设和研究方法，`.skill/` 保存通用流程、契约、组件与虚构测试夹具。具体项目的名称、用户原文、素材、源码、哈希、审片结论与待办归入 `projects/<slug>/`；跨项目维护过程归入各自环境的 `projects/.maintenance/`。提炼知识时保留原理、适用条件与验证方法，公开来源与归因集中在根 README.md。内容边界与整理步骤以[核心维护](.skill/references/maintenance.md)为准。

第三方 skill 与参考项目的名称、链接、致谢和归因统一保存在根 README.md。其他协作说明、研究文档、核心规范与源码说明保存通用方法、独立设计依据和验证条件。

外部参考按[独立创作与项目表达](.research/art-and-explainer-animation.md#独立创作与项目表达)提炼机制。本片从内容出发独立设计主体、视觉母题、构图、色板、镜头结构与声音，记录来源贡献和自己的设计依据；在动态粗剪中对照参考的识别特征，形成连贯的项目表达。

`assets/douyin-cover/` 仅用于独立封面。其模板、导出图片和封面版式禁止进入视频正片，包括片头、片尾、转场、信息卡和字幕背景；正片按本片内容独立设计。制作与审片均核对这一边界，细则见[封面使用范围](assets/douyin-cover/README.md#使用范围)。

用户已指定个人形象 IP 时，视频中需要创作者本人出镜或以个人角色参与讲解的镜头沿用该 IP。制作前根据用户提供的形象参考核对外观，所需素材在本片内独立保存，并登记来源与哈希。出镜时机、动作与占画面比例服务于当前内容。

用户明确要求纳入 Git 的跨片个人 IP 源素材保存在 `assets/personal-ip/`，形象与使用约定见[个人 IP 素材](assets/personal-ip/README.md)。影片将所需源素材复制到本片后使用；项目内候选、原文与检查证据继续保存在生成区。

`projects/` 是可随时删除的生成区。区外代码、配置、资源与文档禁止依赖其中的具体文件，符号链接与硬链接同样禁止；通用内容在权威位置独立保存。核心校验、测试和新片初始化须独立于已有生成结果运行。制作与复盘按显式指定的项目读取本次输入，边界见[工作区规范](.skill/references/workspace.md#生成区的外部依赖约束)。

### 制作与维护

每次制作、修改或维护读取 [.skill/SKILL.md](.skill/SKILL.md) 与[创作主线](.skill/references/motion-language.md#创作主线)，随后只读取当前步骤需要的规范。新片按[创作问答](.skill/references/intake.md)解析需求、提出推荐并取得本片主题选择，再通过 `node .skill/scripts/video.mjs start <slug> --idea "用户原文" --theme <minimal|kinetic>` 保存首次原文并创建项目，立即补齐此前问答；剩余重要选择有回答或明确委托后进入剧本、素材制作和画面开发。已有影片先调用 backup，再按本片 AGENTS.md、guide/、固定主题、沟通记录与待验收项恢复指定项目。

每片的 prompt-history.jsonl 保存创建时的原始 prompt、后续用户修改要求、模型问题与用户答案。新片原文由 start 自动保存；改片和问答按 [.skill/references/workspace.md](.skill/references/workspace.md) 通过 prompt 命令逐条追加，保持原文与时间。维护评估在用户指定的项目范围内结合记录、源码、证据与成片寻找改进依据。

macOS 制作与通用命令通过 `node .skill/scripts/video.mjs <slug> <command>`，通用命令使用 exec 子命令。统一入口自动校验和备份核心，.skill-backups/ 保留最近两份成功快照。Linux 团队使用[手建流程](#linux-团队手建流程)中的创建、备份与执行入口。运行条件与使用入口见 README.md。

影片制作的输入、计划、代码、证据与生成文件保存在对应的 projects/<slug>/，包含生图候选与修订、参考下载、三维模型与纹理、依赖副本、预览、截图、日志及临时产物。工具固定位置的输出立即迁入对应影片项目；影片制作工具的临时目录使用本片 out/.tmp/。制作时按本片边界访问，新增画法编辑本片 src/ 和组件副本。按[素材选择](.skill/references/assets.md)组合生图与精确代码图形，按[电影化运镜](.skill/references/cinematography.md)设计镜头并验证代表性短样片。核心位于 .skill/，不同模型、题材和参考输入使用相同契约；本片的参考用途与特有约束记录在本片。

修改核心通用能力或标准时，按用户明确要求的维护范围执行，读取 [.skill/references/maintenance.md](.skill/references/maintenance.md)。修改前先备份，在对应源文件中编辑，运行适用回归与隔离检查；涉及 `.skill/` 改动时，重新 seal 后交付。检查的临时产物放 .research/out/，完成后清理。

先检查现状，采用最小必要改动，检查最终差异均属于本次授权范围，完成适用验证后交付。用户已有授权在其范围内持续有效，用户明确要求的视觉选择、发布、费用、访问变更及破坏性操作审批保留。宿主编辑器和模型文件工具采用宿主权限；制作命令的系统沙箱覆盖其进程及后代。

## 多团队协作与分支合并

本节适用于两端对共享仓库的修改与合并；各自的素材、凭据和任务授权仍按所属角色执行。

多个团队并行维护时，开始修改与合并前核对当前分支、工作区已有改动及目标分支差异。合并前同步远端引用，结合合并基点检查双方提交；并行代码任务优先采用独立分支或工作区，提交保持单一目的，保留其他团队已有工作。

冲突逐文件、逐段核对双方意图并保留有效修改，禁止整批使用 ours/theirs 覆盖另一侧。文本可自动合并的文件也检查接口、行为与规范的一致性。证据不足且双方设计互斥时，说明具体差异与影响，再确定取舍。

合并后检查最终差异、残留冲突标记并运行适用验证。涉及 `.skill/` 时，在源码与规范合并完成、适用检查通过后统一重新 seal，复核版本清单与最终内容一致。
