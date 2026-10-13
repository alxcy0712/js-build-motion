/**
 * BGM provider 注册表（需求 §19）。
 *
 * 默认用程序化合成器；file provider 用于挂载项目内授权素材；
 * AI 音乐生成只预留位置——M0 不引入（§40）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BGMProvider, BGMRequest, AudioAsset } from '../types.ts';
import { writeBgmWav, SAMPLE_RATE } from './procedural.ts';

/** 程序化合成：零版权、确定性、时长精确。默认 provider */
export const proceduralBgmProvider: BGMProvider = {
  id: 'procedural',
  requiresNetwork: false,
  isAvailable: async () => true,
  render: async (req: BGMRequest): Promise<AudioAsset> => {
    mkdirSync(dirname(req.outPath), { recursive: true });
    writeBgmWav(
      { preset: req.preset, key: req.key, seed: req.seed, durationSeconds: req.durationSeconds, ...(req.bpm !== undefined ? { bpm: req.bpm } : {}) },
      req.outPath,
    );
    return {
      path: req.outPath,
      durationSeconds: req.durationSeconds,
      sampleRate: SAMPLE_RATE,
    };
  },
};

/**
 * 从文件加载 BGM。用于：
 *   - 使用授权音乐素材
 *   - 未来接入 AI 生成的整首音乐（生成一次，作为资产挂进 spec）
 * 时长由调用方保证（素材短于视频时由混音层循环/裁切）。
 */
export function createFileBgmProvider(resolvePath: (preset: string) => string | null): BGMProvider {
  return {
    id: 'file',
    requiresNetwork: false,
    isAvailable: async () => true,
    render: async (req: BGMRequest): Promise<AudioAsset> => {
      const src = resolvePath(req.preset);
      if (!src || !existsSync(src)) {
        throw new Error(`AUDIO_ASSET_NOT_FOUND: 找不到 BGM 素材 ${req.preset} -> ${src ?? '(未配置)'}`);
      }
      return { path: src, durationSeconds: req.durationSeconds, sampleRate: SAMPLE_RATE };
    },
  };
}

export interface BgmProviderSelection {
  readonly provider: BGMProvider;
  readonly fallbackReason?: string;
}

/**
 * 选择 BGM provider。
 * 与 TTS 不同，程序化合成永远可用，所以这里不会"失败"——
 * 只有在显式指定 file 且素材缺失时才回退，并把原因带出去。
 */
export async function resolveBgmProvider(options: {
  readonly preferred?: 'procedural' | 'file';
  readonly assetResolver?: (preset: string) => string | null;
}): Promise<BgmProviderSelection> {
  if (options.preferred === 'file' && options.assetResolver) {
    const provider = createFileBgmProvider(options.assetResolver);
    const probe = options.assetResolver('quiet_piano');
    if (probe && existsSync(probe)) return { provider };
    return {
      provider: proceduralBgmProvider,
      fallbackReason: `音频素材缺失（探测 ${probe ?? '(未配置)'}），已回退到程序化合成`,
    };
  }
  return { provider: proceduralBgmProvider };
}
