/**
 * 环境自检（需求 §47）。
 *
 * 目标：把「环境问题」和「代码问题」在最早时刻分开。
 * 环境问题必须抛出语义化错误码，而不是在渲染到第 800 帧时才因为少个编码器崩掉。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineError, ERROR_CODES } from './errors.ts';
import { probeEdgeTts, ttsFixHint } from './tts-probe.ts';

/**
 * skia-canvas 是原生模块，加载有成本。
 * 用 createRequire 按需同步加载，而不是顶层 import——
 * 这样 `video --help`、`video validate` 这类纯逻辑命令不必付出加载代价。
 */
const require = createRequire(import.meta.url);
type SkiaModule = typeof import('skia-canvas');
function loadSkia(): SkiaModule {
  return require('skia-canvas') as SkiaModule;
}

/** 项目根目录（由本文件位置推导：<root>/src/utils/env.ts） */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** M0 阶段要求的最低 Node 版本（需要原生 TS 类型剥离 + 稳定的 node:test） */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR_WHEN_22 = 6;

/** 项目主字体（OFL-1.1，可再分发），见 .skill/references/maintenance.md */
export const PROJECT_FONT_FAMILY = 'LXGW WenKai';
export const PROJECT_FONT_FILE = 'LXGWWenKai-Regular.ttf';

/** 兜底字体链：主字体缺失时依次尝试；全部失败则报 FONT_NOT_FOUND */
export const FALLBACK_FONT_FAMILIES = ['Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'sans-serif'] as const;

export interface ToolInfo {
  available: boolean;
  version: string | null;
  command: string;
}

/**
 * 读取依赖包的实际版本。
 *
 * 用于 `run.json` 的实测遥测：披露里的 "画面由 skia-canvas 逐帧绘制" 必须带版本号，
 * 而版本号只能从磁盘读，不能写死在文档里（否则升级后文档就开始说谎）。
 */
export function dependencyVersion(name: string): string | null {
  // 直接读 node_modules 下的 package.json：
  // `require('<pkg>/package.json')` 会被部分包的 exports 字段拦掉（skia-canvas 就是如此），
  // 而版本号是披露里必须有的实测事实，不能因为解析策略拿不到。
  try {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface EnvReport {
  ok: boolean;
  node: { version: string; supported: boolean; required: string };
  ffmpeg: ToolInfo & { encoders: Record<string, boolean>; audioFilters: Record<string, boolean> };
  ffprobe: ToolInfo;
  /**
   * 语音链路。
   *
   * 为什么环境自检要报它：缺 Python / edge_tts 不会让渲染失败，
   * 只会静默降级为 mock 占位音——而用户只会看到"渲染成功"。
   * 把实际会用的 provider 与原因写在环境报告里，这个问题就变成一眼可见的。
   */
  tts: {
    /** 此刻渲染真正会用的 provider */
    effective: 'edge' | 'file' | 'mock';
    edge: { available: boolean; python: string | null; reason: string | null };
    voiceAsset: { path: string; exists: boolean };
    fixHint: string;
  };
  fonts: {
    family: string;
    filePath: string;
    fileExists: boolean;
    registered: boolean;
    fallbackToSystem: boolean;
  };
  paths: {
    projectRoot: string;
    outDir: string;
    outWritable: boolean;
    assetsFontsDir: string;
  };
  warnings: string[];
  errors: string[];
}

const VIDEO_ENCODERS = ['libx264', 'libx265', 'h264_videotoolbox', 'hevc_videotoolbox'] as const;
const AUDIO_FILTERS = [
  'sidechaincompress', 'amix', 'afade', 'adelay', 'aresample',
  'loudnorm', 'volume', 'apad', 'atrim', 'asplit', 'amerge', 'dynaudnorm',
] as const;

function probeTool(command: string, versionFlag = '-version'): ToolInfo {
  const r = spawnSync(command, [versionFlag], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { available: false, version: null, command };
  const first = (r.stdout || r.stderr || '').split('\n')[0]?.trim() ?? '';
  const m = first.match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
  return { available: true, version: m?.[1] ?? first, command };
}

function nodeSupported(version: string): boolean {
  const [majS, minS] = version.replace(/^v/, '').split('.');
  const major = Number(majS);
  const minor = Number(minS);
  if (!Number.isFinite(major)) return false;
  if (major > MIN_NODE_MAJOR) return true;
  if (major < MIN_NODE_MAJOR) return false;
  return minor >= MIN_NODE_MINOR_WHEN_22;
}

/** 检测可用编码器/滤镜。解析 `ffmpeg -encoders` / `-filters` 的真实输出，不做硬编码假设。 */
function detectCapabilities(): { encoders: Record<string, boolean>; audioFilters: Record<string, boolean> } {
  const encOut = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  const filOut = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '';
  const has = (text: string, name: string): boolean =>
    new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(text);
  return {
    encoders: Object.fromEntries(VIDEO_ENCODERS.map((n) => [n, has(encOut, n)])),
    audioFilters: Object.fromEntries(AUDIO_FILTERS.map((n) => [n, has(filOut, n)])),
  };
}

/**
 * 显式注册项目字体（需求 §26：禁止依赖系统字体）。
 * 幂等：重复调用不会抛错。
 *
 * @param filePath 可注入，便于测试「字体缺失」分支而不用真的删除文件。
 */
export function registerProjectFonts(filePath?: string): EnvReport['fonts'] {
  const target = filePath ?? join(PROJECT_ROOT, 'assets', 'fonts', PROJECT_FONT_FILE);
  const fileExists = existsSync(target);
  const base: EnvReport['fonts'] = {
    family: PROJECT_FONT_FAMILY,
    filePath: target,
    fileExists,
    registered: false,
    fallbackToSystem: false,
  };
  if (!fileExists) return base;

  // 动态加载：避免 `video --help` 这种纯文本命令也去加载原生模块
  const { FontLibrary } = loadSkia();
  const families = FontLibrary.families;
  if (!families.includes(PROJECT_FONT_FAMILY)) {
    FontLibrary.use(PROJECT_FONT_FAMILY, [target]);
  }
  return { ...base, registered: FontLibrary.families.includes(PROJECT_FONT_FAMILY) };
}

/** 选择实际用于渲染的字族：项目字体优先，否则沿兜底链找系统字体 */
export function resolveFontFamily(registered: boolean): string {
  if (registered) return PROJECT_FONT_FAMILY;
  const { FontLibrary } = loadSkia();
  for (const fam of FALLBACK_FONT_FAMILIES) {
    if (FontLibrary.families.includes(fam)) return fam;
  }
  return 'sans-serif';
}

function checkOutWritable(outDir: string): boolean {
  try {
    mkdirSync(outDir, { recursive: true });
    const probe = join(outDir, '.write-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface CheckEnvironmentOptions {
  /**
   * true：任何环境缺失都是硬错误（抛 EngineError）。渲染/导出类命令必须使用 true。
   * false：只收集到 warnings，返回完整报告。`video env` 使用 false。
   */
  strict?: boolean;
  /** 是否验证输出目录可写（默认 true） */
  checkOutput?: boolean;
  /** 独立影片工作区的输出目录。 */
  outDir?: string;
  /**
   * 是否探测语音链路（默认 true）。
   * 探测会起一次 python 子进程；测试与不需要配音的场景可关掉。
   */
  checkTts?: boolean;
  /** 覆盖字体文件路径（测试用；正常调用不传） */
  fontFile?: string;
}

export function checkEnvironment(options: CheckEnvironmentOptions = {}): EnvReport {
  const { strict = false, checkOutput = true, checkTts = true, fontFile } = options;
  const warnings: string[] = [];
  const errors: string[] = [];

  // --- Node ---
  const nodeVersion = process.version;
  const supported = nodeSupported(nodeVersion);
  if (!supported) {
    errors.push(`Node ${nodeVersion} 过低，需要 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR_WHEN_22}`);
  }

  // --- ffmpeg / ffprobe ---
  const ffmpeg = probeTool('ffmpeg');
  const ffprobe = probeTool('ffprobe');
  if (!ffmpeg.available) errors.push('未找到 ffmpeg');
  if (!ffprobe.available) errors.push('未找到 ffprobe');

  const caps = ffmpeg.available
    ? detectCapabilities()
    : { encoders: {}, audioFilters: {} as Record<string, boolean> };

  if (ffmpeg.available) {
    if (!caps.encoders['libx264']) {
      errors.push('ffmpeg 缺少 libx264 编码器（M0 默认视频编码器）');
    }
    const missingFilters = AUDIO_FILTERS.filter((f) => !caps.audioFilters[f]);
    if (missingFilters.length) {
      errors.push(`ffmpeg 缺少音频滤镜: ${missingFilters.join(', ')}`);
    }
  }

  // --- 字体 ---
  const fonts = registerProjectFonts(fontFile);
  if (!fonts.fileExists) {
    const msg =
      `项目字体缺失: ${fonts.filePath}。` +
      (strict
        ? '严格模式下拒绝回退到系统字体——那会使渲染结果依赖当前机器，破坏确定性与黄金帧测试。'
        : '将回退到系统字体，跨机器渲染结果可能不一致。') +
      ' 检查本片运行时的 assets/fonts/ 字体。';
    // 严格模式（渲染类命令）下字体缺失是硬错误：回退到系统字体会静默改变像素输出。
    // 非严格模式（`video env`）下只提醒，便于用户先看到完整环境报告。
    if (strict) errors.push(msg);
    else warnings.push(msg);
  }
  const assetsFontsDir = join(PROJECT_ROOT, 'assets', 'fonts');
  if (fonts.fileExists && !fonts.registered) {
    errors.push(`字体文件存在但注册失败: ${fonts.filePath}`);
  }

  // --- 路径 ---
  // 探测非项目产物的落点：仓库根的 out/ 兼容层已删除（task-11），
  // 非项目 spec（探针 / 引擎级夹具）的产物一律落 .research/out/（AGENTS.md 硬性规则 1）。
  // 项目渲染不需要在这里探测：每个项目有自己的 outDir，渲染时自己建。
  const outDir = options.outDir ?? (basename(PROJECT_ROOT) === '.engine'
    ? join(dirname(PROJECT_ROOT), 'out') : resolve(PROJECT_ROOT, '../../.research/out'));
  const outWritable = checkOutput ? checkOutWritable(outDir) : true;
  if (!outWritable) {
    errors.push(`输出目录不可写: ${outDir}`);
  }

  const ok = errors.length === 0;

  // --- 语音链路（降级不报错，但必须报告）---
  // 环境自检不在这里"修"任何东西：它只把「现在到底能做什么配音」说清楚。
  const ttsProbe = checkTts ? probeEdgeTts() : { available: false, python: null, reason: '已跳过检查', helperExists: true };
  const voiceAssetPath = join(PROJECT_ROOT, 'assets', 'audio', 'voice.wav');
  const voiceAssetExists = existsSync(voiceAssetPath);
  const effective: EnvReport['tts']['effective'] = ttsProbe.available
    ? 'edge'
    : voiceAssetExists
      ? 'file'
      : 'mock';
  const tts: EnvReport['tts'] = {
    effective,
    edge: { available: ttsProbe.available, python: ttsProbe.python, reason: ttsProbe.reason },
    voiceAsset: { path: voiceAssetPath, exists: voiceAssetExists },
    fixHint: ttsFixHint(ttsProbe),
  };
  if (checkTts && effective !== 'edge') {
    warnings.push(
      `语音链路降级为 ${effective}（edge-tts ${ttsProbe.available ? '可用' : '不可用'}：${ttsProbe.reason ?? '未知'}）。` +
        ` 修复：${tts.fixHint}`,
    );
  }

  const report: EnvReport = {
    ok,
    node: { version: nodeVersion, supported, required: `>=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR_WHEN_22}` },
    ffmpeg: { ...ffmpeg, ...caps },
    ffprobe,
    fonts,
    tts,
    paths: { projectRoot: PROJECT_ROOT, outDir, outWritable, assetsFontsDir },
    warnings,
    errors,
  };

  if (strict && !ok) {
    const code = !supported
      ? ERROR_CODES.NODE_VERSION_UNSUPPORTED
      : !ffmpeg.available
        ? ERROR_CODES.FFMPEG_NOT_FOUND
        : !ffprobe.available
          ? ERROR_CODES.FFPROBE_NOT_FOUND
          : !fonts.registered && !fonts.fileExists
            ? ERROR_CODES.FONT_NOT_FOUND
            : !fonts.registered
              ? ERROR_CODES.FONT_NOT_FOUND
              : !outWritable
                ? ERROR_CODES.OUTPUT_NOT_WRITABLE
                : ERROR_CODES.ENCODER_NOT_AVAILABLE;
    throw new EngineError(code, errors[0] ?? '环境检查未通过', {
      details: { errors, warnings },
      hint: '运行 `node .skill/engine/src/cli/index.ts env` 查看完整环境报告',
    });
  }

  return report;
}

/** 列出 assets/fonts 下已存在的字体文件（诊断用） */
export function listProjectFontFiles(): string[] {
  const dir = join(PROJECT_ROOT, 'assets', 'fonts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(ttf|otf|ttc|otc)$/i.test(f));
}
