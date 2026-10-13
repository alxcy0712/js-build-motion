/**
 * 语音链路探测（新用户上手 + 环境自检共用）。
 *
 * 为什么单独一个模块：`env.ts` 需要它，`audio/tts/edge.ts` 也需要它。
 * 如果让 env 直接 import audio 层，就会形成 `env → edge → env` 的循环依赖；
 * 把探测逻辑放在 utils 层，两边都只依赖它。
 *
 * 探测方式刻意是**真的去跑** `edge-tts-helper.py --probe`，而不是猜：
 * edge-tts 依赖 Python 与 `edge_tts` 模块两件外部条件，猜错的代价是
 * 用户拿到一支"没有真人配音但看不出原因"的片子。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 本模块**刻意不 import `utils/env.ts`**：
 * env 会调用本模块，edge.ts 也会调用本模块；
 * 一旦本模块反向依赖 env，就形成 `env → tts-probe → env` 的循环。
 * 根目录用和 env.ts 相同的方式自行推导（`<root>/src/utils/tts-probe.ts`）。
 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const EDGE_HELPER_PATH = join(PROJECT_ROOT, 'scripts', 'edge-tts-helper.py');

/** 优先 python3，其次 python */
export const PYTHON_CANDIDATES = ['python3', 'python'] as const;

export interface TtsProbeResult {
  readonly available: boolean;
  /** 能 import edge_tts 的解释器；不可用时为 null */
  readonly python: string | null;
  /** 面向人与模型的失败原因（含修复建议）；可用时为 null */
  readonly reason: string | null;
  readonly helperExists: boolean;
}

/**
 * 探测 edge-tts 是否可用。
 *
 * `available: false` **不是错误**：TTS 不可用时渲染会按 edge → file → mock 降级，
 * 成片仍然出得来。所以它只该产生警告，不该让环境自检失败。
 */
export function probeEdgeTts(options: { readonly timeoutMs?: number } = {}): TtsProbeResult {
  const timeout = options.timeoutMs ?? 20_000;
  const helperExists = existsSync(EDGE_HELPER_PATH);

  if (!helperExists) {
    return {
      available: false,
      python: null,
      reason: `找不到辅助脚本 ${EDGE_HELPER_PATH.replace(PROJECT_ROOT + '/', '')}`,
      helperExists,
    };
  }

  let lastReason = '未找到可用的 python 解释器';
  for (const candidate of PYTHON_CANDIDATES) {
    const r = spawnSync(candidate, [EDGE_HELPER_PATH, '--probe'], { encoding: 'utf8', timeout });
    if (r.error) {
      // ENOENT = 这个解释器根本不存在，属于正常情况（比如只有 python3）
      lastReason = `未找到可用的 python 解释器（已尝试 ${PYTHON_CANDIDATES.join(', ')}）`;
      continue;
    }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0 && out.includes('"ok": true')) {
      return { available: true, python: candidate, reason: null, helperExists };
    }
    // helper 会用 JSON 说明失败原因（通常是 edge_tts 模块缺失）
    const parsed = parseProbeJson(out);
    lastReason = parsed ?? out.trim().split('\n').slice(-1)[0] ?? `${candidate} 退出码 ${r.status}`;
  }

  return { available: false, python: null, reason: lastReason, helperExists };
}

/** helper 失败时输出 {"ok": false, "code": "...", "error": "..."} */
function parseProbeJson(out: string): string | null {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
    if (parsed.ok === false && typeof parsed.error === 'string') return parsed.error;
  } catch {
    return null;
  }
  return null;
}

/** 给人/模型看的修复建议 */
export function ttsFixHint(probe: TtsProbeResult): string {
  if (probe.available) return '语音链路可用';
  const parts = [`安装 edge-tts：\`python3 -m pip install edge-tts\``];
  if (probe.reason && /python/i.test(probe.reason)) {
    parts.unshift('先安装 Python 3（macOS: `brew install python`）');
  }
  parts.push('或跳过该依赖：把授权的配音放到 `assets/audio/voice.wav`（file provider），或接受 mock 占位音');
  return parts.join('；');
}
