#!/usr/bin/env node
import { cmdLayoutQA } from './layout.ts';
import { capabilities, cmdDirect, cmdPrompt, cmdQuality } from './director.ts';
import { cmdProduction } from './production.ts';
import { cmdDelivery } from './delivery.ts';
import { cmdPostprocess } from './postprocess.ts';
import { cmdDiagnose } from './diagnostics.ts';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { DOUBAO_VOICES } from '../audio/tts/doubao-voices.ts';
import { cmdEnv, cmdValidate } from './environment.ts';
import { cmdFrame, cmdStoryboard, cmdAudio, cmdRender, cmdSubtitles } from './render.ts';
import { cmdProject, cmdBrief, cmdArtifact, cmdDisclosure } from './project.ts';
import { cmdImport, cmdUnpack, cmdCatalog, cmdAlign, cmdAssets, cmdVideo } from './media.ts';
import { requireTarget } from './shared.ts';

const COMMANDS = [
  'env',
  'capabilities',
  'voices',
  'direct',
  'prompt',
  'import',
  'unpack',
  'catalog',
  'align',
  'assets',
  'video',
  'production',
  'review',
  'credits',
  'deliver',
  'qa',
  'diagnose',
  'validate',
  'frame',
  'storyboard',
  'render',
  'audio',
  'subtitles',
  'project',
  'brief',
  'disclosure',
  'postprocess',
  'artifact',
] as const;
type CommandName = (typeof COMMANDS)[number];
const USAGE = `js-build-motion —— 模型无关的程序化视频引擎

用法:
  video <command> [options]

引擎命令:
  capabilities [--schema]        已实现能力 / 导演计划 schema
  voices                        公版配音音色目录（名称、ID、语种、模型及接口）
  direct start <slug> --idea "…" 保存想法，agent 填写导演计划
  direct compile <slug>          导演计划 → VideoSpec + brief
  production <slug> init|next|apply|compile|resume|invalidate|view [options] 权威计划与恢复
  review <slug> --subject | --request <本片 JSON> 核对完整观测、当前编码与审片结论
  credits <slug> --subject | --request <本片 JSON> 核对本地交付权利与逐源署名
  deliver <slug> --request <本片 JSON> | --verify <deliveryId|current> 保存并复查本地交付包
    --schema file|subject|review|credits|request|manifest 输出审片与交付契约
  prompt <slug> [--kind … --text …|--file …] 查看或追加原始 prompt、问题与答案
  unpack <slug> --import <importId> --path <归档相对路径>  显式展开本片已入库 ZIP
    --verify <unpackId>           复查已提交展开版本
    --schema manifest|receipt|policy|index  输出展开契约
  import <slug> --source <路径>    将选定文件或目录复制为本片独立原件并输出回执
    --verify <importId>           校验已提交批次的清单与原件
    --schema manifest|receipt|policy 输出导入契约
  assets <slug> [--plan assets/asset-plan.json] 核对素材需求、版本绑定与待审缺口
    --schema plan|usage           输出素材计划或消费回执契约
  video <slug> --request <本片 JSON> 准备选定整数 PTS 区间的固定帧与静音代理
    --verify <map 路径> | --recover  复查成功发布或恢复已退出的准备
    --schema request|map|limits|receipt|publication 输出视频准备契约
  audio <slug>                   先制作配音与混音，检查逐句时长和信号完整性
  audio lock <slug>              制作并保存可复用的定稿声音包
  qa <slug>                     结构质量与导演计划新鲜度检查
  qa <slug> --layout [--plan evidence/layout.json] [--all-frames] 实际源帧布局、保护区及候选建议
  qa <slug> --cuts evidence/cuts.json  词内剪点与帧/样本建议（保持原时间线）
  diagnose <slug> --from 0 --to 2 连续编码帧、运动热图与源文字边界复核线索
  env                            检查运行环境（Node / FFmpeg / 字体 / 输出目录）
  validate <spec.json|项目>      校验 VideoSpec 并报告自动修复内容
  frame <spec.json|项目>         渲染单帧为 PNG（调试用，不是正式管线）
  storyboard <spec.json|项目>   按场景抽取关键帧生成 contact sheet
  render <spec.json|项目>        渲染完整视频（并写出 run.json 实测遥测）
    --asset-plan <本片计划>       冻结素材绑定；默认读取 assets/asset-plan.json
    --audio-lock <本片锁路径>     复用声音，校验内容、排布与实际文件
    --tts-provider file --no-network  使用本片预制配音进行离线制作
  subtitles <spec.json|项目>     导出外挂字幕 .srt / .vtt

项目层命令:
  project list                   列出全部项目与状态
  project init <slug>            新建项目骨架（不覆盖已有目录）
  project archetypes             列出提示词原型库
  project audit <slug|--all>     审计项目隔离（输入是否越界引用别的项目/产物）
  brief validate <项目|json>     校验提示词契约（brief.json）
  disclosure <项目>              声明—实测对账，生成 DISCLOSURE.md
    --postprocess <本片JSON>      使用指定外部后期登记（默认 evidence/postprocess.json）
  postprocess <项目> --request <本片JSON> 登记后期处理链与最终交付文件
    --verify | --schema request|record  复查后期登记或查询契约
  artifact <项目> [--out evidence/artifact.json] [--review evidence/artifact.json]
                                 核对实际成片、渲染输入与审片身份快照

通用选项:
  -h, --help                     显示帮助
  -v, --verbose                  输出详细日志

示例:
  node .skill/engine/src/cli/index.ts env
  node .skill/engine/src/cli/index.ts project list
  node .skill/engine/src/cli/index.ts project init my-film --title "我的片子"
  node .skill/engine/src/cli/index.ts project audit my-film
  node .skill/engine/src/cli/index.ts validate my-film
  node .skill/engine/src/cli/index.ts brief validate my-film
  node .skill/engine/src/cli/index.ts render my-film
  node .skill/engine/src/cli/index.ts disclosure my-film
  node .skill/engine/src/cli/index.ts render .research/out/probe.json   # 非项目 spec：产物落 .research/out/
`;
function printHelp(): void {
  process.stdout.write(USAGE);
}

// ---------------------------------------------------------------- env
export async function run(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, `未知命令: ${cmd}`, {
      allowed: COMMANDS,
      hint: '运行 `node .skill/engine/src/cli/index.ts --help` 查看全部命令',
    });
  }

  switch (cmd as CommandName) {
    case 'env': return cmdEnv(rest);
    case 'capabilities': process.stdout.write(JSON.stringify(capabilities(rest.includes('--schema')), null, 2) + '\n'); return 0;
    case 'voices': process.stdout.write(JSON.stringify({ provider: 'doubao', count: DOUBAO_VOICES.length, voices: DOUBAO_VOICES }, null, 2) + '\n'); return 0;
    case 'direct': return cmdDirect(rest);
    case 'prompt': return cmdPrompt(rest);
    case 'import': return cmdImport(rest);
    case 'unpack': return cmdUnpack(rest);
    case 'catalog': return cmdCatalog(rest);
    case 'assets': return cmdAssets(rest);
    case 'video': return cmdVideo(rest);
    case 'production': return cmdProduction(rest);
    case 'review': case 'credits': case 'deliver': return cmdDelivery(cmd, rest);
    case 'align': return cmdAlign(rest);
    case 'qa': return rest.includes('--layout') || rest.includes('--cuts') ? cmdLayoutQA(rest) : cmdQuality(requireTarget(rest, 'qa'));
    case 'diagnose': return cmdDiagnose(rest);
    case 'validate': return await cmdValidate(rest);
    case 'frame': return cmdFrame(rest);
    case 'storyboard': return await cmdStoryboard(rest);
    case 'render': return await cmdRender(rest);
    case 'audio': return await cmdAudio(rest);
    case 'subtitles': return cmdSubtitles(rest);
    case 'project': return cmdProject(rest);
    case 'brief': return cmdBrief(rest);
    case 'disclosure': return cmdDisclosure(rest);
    case 'postprocess': return cmdPostprocess(rest);
    case 'artifact': return cmdArtifact(rest);
  }
}
export async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof EngineError) {
      process.stderr.write(err.toLLMString() + '\n');
      process.exitCode = err.code === ERROR_CODES.NOT_IMPLEMENTED ? 2 : 1;
    } else {
      process.stderr.write(`RENDER_FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      if (process.env['VIDEO_DEBUG']) process.stderr.write(String((err as Error)?.stack ?? ''));
      process.exitCode = 1;
    }
  }
}

void main();
