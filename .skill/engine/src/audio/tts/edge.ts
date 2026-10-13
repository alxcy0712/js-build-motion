/**
 * Edge TTS provider（需求 §16）。
 *
 * 定位：**默认的"开箱可用"TTS**。免费、无需 API Key、中文音色自然，
 * 而且能返回词级时间戳——这是它相对其他免费方案的关键优势。
 *
 * ⚠️ 风险（必须知情）：
 *   它调用的是逆向自 Edge 浏览器"大声朗读"的非官方接口，不是 Azure 官方 API。
 *   微软随时可能改动；商用授权处于灰色地带。
 *   因此：
 *     - 界面（TTSProvider）与实现严格分离，换 provider 不改调用方
 *     - `isAvailable()` 必须真的探测，不允许假设它一定在
 *     - 失败时让 resolveTtsProvider 自动回退到 file/mock，而不是让整条管线崩掉
 *
 * 音色映射：DSL 里暴露的是抽象音色名（female_calm 等），
 * 具体服务商的音色 ID 只存在于这里——这样换 provider 时 DSL 不用改，
 * 模型也不需要在 prompt 里记住一堆微软音色名。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AbstractTtsVoice } from '../../spec/types.ts';
import { EDGE_HELPER_PATH, probeEdgeTts } from '../../utils/tts-probe.ts';
import type { TTSProvider, TTSRequest, TTSResult, WordTiming } from '../types.ts';

/** 抽象音色 → Edge 音色 ID */
export const EDGE_VOICE_MAP: Readonly<Record<AbstractTtsVoice, string>> = {
  female_calm: 'zh-CN-XiaoxiaoNeural',
  female_lively: 'zh-CN-XiaoyiNeural',
  male_calm: 'zh-CN-YunyangNeural',
  male_lively: 'zh-CN-YunxiNeural',
};

// 辅助脚本路径与 python 探测都从 utils 层共用（env 自检也要用它）：
// 两边各自实现一份「哪个 python 能 import edge_tts」只会造成两套不同答案。
const HELPER = EDGE_HELPER_PATH;
const PROBE_TTL_MS = 60_000;

let probeCache: { at: number; ok: boolean; python: string | null } | null = null;

/** 探测结果缓存，避免每次都起两个 python 进程 */
function pythonForEdge(): string | null {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.python;
  const python = probeEdgeTts().python;
  probeCache = { at: now, ok: python !== null, python };
  return python;
}

export interface EdgeTtsOptions {
  /** 语速，默认 '+8%'。中文旁白略快一点听起来更自然 */
  readonly rate?: string;
  /** 子进程超时（毫秒） */
  readonly timeoutMs?: number;
}

interface HelperOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly durationSeconds?: number;
  readonly words?: readonly WordTiming[];
}

export function createEdgeTtsProvider(options: EdgeTtsOptions = {}): TTSProvider {
  const rate = options.rate ?? '+8%';
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    id: 'edge',
    requiresNetwork: true,

    isAvailable: async (): Promise<boolean> => pythonForEdge() !== null,

    synthesize: async (req: TTSRequest): Promise<TTSResult> => {
      const python = pythonForEdge();
      if (!python) {
        throw new Error('TTS_PROVIDER_UNAVAILABLE: 找不到可用的 edge-tts（python 模块缺失或脚本缺失）');
      }

      if (!Object.hasOwn(EDGE_VOICE_MAP, req.voice)) throw new Error('TTS_VOICE_UNSUPPORTED: 默认 Edge 配音使用抽象音色；用户明确声明豆包后，通过 --tts-provider doubao 启用该音色');
      const voice = EDGE_VOICE_MAP[req.voice as AbstractTtsVoice];
      const jsonPath = `${req.outPath}.words.json`;
      mkdirSync(dirname(req.outPath), { recursive: true });

      const r = spawnSync(
        python,
        [
          HELPER,
          '--text', req.text,
          '--voice', voice,
          `--rate=${req.rate ?? rate}`,
          '--out-audio', req.outPath,
          '--out-json', jsonPath,
        ],
        { encoding: 'utf8', timeout: timeoutMs },
      );

      const stdout = (r.stdout ?? '').trim();
      let outcome: HelperOutcome | null = null;
      if (stdout) {
        try {
          outcome = JSON.parse(stdout.split('\n').pop() ?? '') as HelperOutcome;
        } catch {
          outcome = null;
        }
      }

      if (r.error) {
        throw new Error(`TTS_PROVIDER_UNAVAILABLE: 调用 edge-tts 失败: ${r.error.message}`);
      }
      if (!outcome?.ok) {
        const stderrText = (r.stderr ?? '').trim();
        const detail = outcome?.error ?? (stderrText.length > 0 ? stderrText : `退出码 ${r.status}`);
        throw new Error(`TTS_PROVIDER_UNAVAILABLE: ${detail}`);
      }
      if (!existsSync(req.outPath)) {
        throw new Error('TTS_PROVIDER_UNAVAILABLE: 辅助脚本报告成功但音频文件不存在');
      }

      // 词级时间戳从 json 读回；缺失时不报错——调用方会回退到文本估算
      let words: readonly WordTiming[] | undefined;
      try {
        const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as { words?: WordTiming[] };
        if (parsed.words?.length) words = parsed.words;
      } catch {
        words = undefined;
      }

      return {
        path: req.outPath,
        durationSeconds: outcome.durationSeconds ?? 0,
        sampleRate: 24_000, // Edge TTS 输出 24kHz 单声道 MP3
        ...(words ? { words } : {}),
      };
    },
  };
}

/** 清掉探测缓存（测试用） */
export function resetEdgeProbeCache(): void {
  probeCache = null;
}
