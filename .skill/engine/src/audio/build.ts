/**
 * 音频总装（需求 §15）。
 *
 * 输入 ResolvedVideoSpec，输出 master.wav + 一份实测时间（供字幕使用）。
 *
 * 三条硬性行为：
 *
 * 1. **任意一轨缺失都不崩**。没有旁白 → 只有 BGM；BGM 音量为 0 → 跳过；
 *    SFX 一个都没有 → 跳过。整条链路只在"一条音轨都没有"时才报错。
 *
 * 2. **TTS 的实测时间回填给字幕**。这是字幕与配音对齐的唯一正确做法：
 *    文本本来就在手里（§17），TTS 又返回了词级时间戳，
 *    没有任何理由去做语音识别。
 *
 * 3. **每个中间产物都落盘**，便于单独试听与排查——
 *    "为什么成品里听不到配音"这类问题，没有分轨文件就只能猜。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SPEC_DEFAULTS, type ResolvedVideoSpec } from '../spec/types.ts';
import type { MeasuredNarration } from '../captions/track.ts';
import { mixAudio, measureLoudness, type MixResult } from './mixer.ts';
import type { AudioTimeline, AudioTrack } from './types.ts';
import { DEFAULT_DUCK } from './types.ts';
import { resolveBgmProvider } from './bgm/index.ts';
import { proceduralSfxProvider } from './sfx/index.ts';
import { resolveTtsProvider, type TtsProviderId } from './tts/index.ts';
import { narrationTimingIssues, timingSpecHash, verifyVoicePresence } from './verify.ts';

export interface BuildAudioOptions {
  readonly spec: ResolvedVideoSpec;
  /** 音频工作目录（中间产物都落在这里） */
  readonly workDir: string;
  readonly tts?: {
    readonly provider?: TtsProviderId;
    readonly allowNetwork?: boolean;
    readonly voiceAssetPath?: string;
  };
  readonly bgm?: {
    readonly provider?: 'procedural' | 'file';
    readonly assetResolver?: (preset: string) => string | null;
  };
  /** 是否生成音效。默认 true */
  readonly sfx?: boolean;
  readonly verbose?: boolean;
  /** Production requires real, complete, audible narration inside its shot window. */
  readonly strictNarration?: boolean;
}

export interface BuildAudioResult {
  readonly masterPath: string;
  readonly durationSeconds: number;
  readonly timeline: AudioTimeline;
  /** 键为 narration 下标。交给 createSpecRenderer 用于字幕对齐 */
  readonly captionTimings: Map<number, MeasuredNarration>;
  readonly warnings: string[];
  readonly providerInfo: { readonly tts: string; readonly bgm: string; readonly sfx: string };
  readonly mix: MixResult;
  readonly measuredLoudness: ReturnType<typeof measureLoudness>;
}

/**
 * 组装音频。
 *
 * 注意 `workDir` 会在开始时被清空——音频中间产物是**可再生产物**，
 * 残留的旧文件会让"这次到底用了哪个文件"变得无法判断。
 */
export async function buildAudio(options: BuildAudioOptions): Promise<BuildAudioResult> {
  const { spec, workDir } = options;
  const warnings: string[] = [];

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const tracks: AudioTrack[] = [];
  const captionTimings = new Map<number, MeasuredNarration>();
  const duration = spec.video.duration;

  // ---------------------------------------------------------- VOICE
  let ttsId = '(none)';
  if (spec.audio.narration.length > 0) {
    const selection = await resolveTtsProvider({
      ...(options.tts?.provider ? { preferred: options.tts.provider } : {}),
      allowNetwork: options.tts?.allowNetwork ?? true,
      ...(options.tts?.voiceAssetPath ? { voiceAssetPath: options.tts.voiceAssetPath } : {}),
    });
    ttsId = selection.provider.id;
    if (options.strictNarration && ttsId === 'mock') throw new Error('NARRATION_REQUIRED: 正式制作需要真实配音，mock 仅用于测试');
    if (options.strictNarration && ttsId === 'file' && spec.audio.narration.length > 1) throw new Error('NARRATION_REQUIRED: 单文件配音 provider 无法映射多句脚本，请使用逐句 TTS');
    if (selection.fallbackReason) {
      warnings.push(`TTS 回退：${selection.fallbackReason}`);
    }

    for (let i = 0; i < spec.audio.narration.length; i++) {
      const line = spec.audio.narration[i]!;
      const rate = line.rate ?? SPEC_DEFAULTS.narrationRate;
      const outPath = join(workDir, `voice-${String(i).padStart(3, '0')}.wav`);
      try {
        const result = await selection.provider.synthesize({
          text: line.text,
          voice: line.voice,
          rate: `${rate >= 0 ? '+' : ''}${rate}%`,
          seed: spec.video.seed + i * 131,
          outPath,
        });

        // 实测时间回填字幕：词级时间戳是相对音频起点的，这里换算成绝对时间
        const absoluteWords = result.words?.map((w) => ({
          text: w.text,
          start: line.start + w.start,
          end: line.start + w.end,
        }));
        captionTimings.set(i, {
          start: line.start,
          end: line.start + (result.durationSeconds || 0),
          ...(absoluteWords ? { words: absoluteWords } : {}),
        });

        tracks.push({
          kind: 'voice',
          path: result.path,
          start: line.start,
          gain: 1,
          sourceDuration: result.durationSeconds,
          ...(result.words ? {} : { duckUnderVoice: false }),
        });
      } catch (err) {
        if (options.strictNarration) throw new Error(`NARRATION_MISSING: 第 ${i + 1} 条旁白失败：${err instanceof Error ? err.message : String(err)}`);
        // 单条旁白失败不应该让整部片子做不出来——降级 + 明确告警
        warnings.push(
          `第 ${i + 1} 条旁白合成失败，已跳过：${err instanceof Error ? err.message : String(err)}`,
        );
        captionTimings.delete(i);
      }
    }
  }

  const timingIssues = narrationTimingIssues(spec, captionTimings);
  writeFileSync(join(workDir, 'narration-timing.json'), JSON.stringify({ specHash: timingSpecHash(spec), timings: [...captionTimings], issues: timingIssues }, null, 2) + '\n');
  if (options.strictNarration && timingIssues.length) throw new Error(timingIssues.join('\n'));

  // ---------------------------------------------------------- BGM
  let bgmId = '(none)';
  const bgmSpec = spec.audio.bgm;
  if (bgmSpec.volume > 0) {
    const { provider, fallbackReason } = await resolveBgmProvider({
      ...(options.bgm?.provider ? { preferred: options.bgm.provider } : {}),
      ...(options.bgm?.assetResolver ? { assetResolver: options.bgm.assetResolver } : {}),
    });
    bgmId = provider.id;
    if (fallbackReason) warnings.push(`BGM 回退：${fallbackReason}`);

    try {
      const asset = await provider.render({
        ...(bgmSpec.bpm !== undefined ? { bpm: bgmSpec.bpm } : {}),
        preset: bgmSpec.preset,
        key: bgmSpec.key ?? 'C',
        durationSeconds: duration,
        seed: spec.video.seed + 7919,
        outPath: join(workDir, 'bgm.wav'),
      });
      tracks.push({
        kind: 'bgm',
        path: asset.path,
        start: 0,
        gain: bgmSpec.volume,
        sourceDuration: asset.durationSeconds,
        fadeIn: bgmSpec.fadeIn,
        fadeOut: bgmSpec.fadeOut,
        duckUnderVoice: bgmSpec.duckUnderNarration,
      });
    } catch (err) {
      if (options.strictNarration) throw new Error(`BGM_REQUIRED: ${err instanceof Error ? err.message : String(err)}`);
      warnings.push(`BGM 生成失败，已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------- SFX
  let sfxId = '(none)';
  const wantSfx = options.sfx ?? true;
  if (wantSfx && spec.audio.sfx.length > 0) {
    sfxId = proceduralSfxProvider.id;
    for (let i = 0; i < spec.audio.sfx.length; i++) {
      const cue = spec.audio.sfx[i]!;
      if (cue.volume <= 0) continue;
      const remaining = duration - cue.start;
      if (remaining <= 0.05) continue;

      // 循环类环境音（雨/风）铺满剩余时长；一次性音效按固定时长生成
      const isAmbience = cue.preset === 'soft_rain' || cue.preset === 'heavy_rain' || cue.preset === 'wind';
      const sfxDuration = isAmbience ? remaining : Math.min(1.6, remaining);

      try {
        const asset = await proceduralSfxProvider.render({
          preset: cue.preset,
          durationSeconds: sfxDuration,
          seed: spec.video.seed + i * 977,
          outPath: join(workDir, `sfx-${String(i).padStart(3, '0')}-${cue.preset}.wav`),
        });
        tracks.push({
          kind: 'sfx',
          path: asset.path,
          start: cue.start,
          gain: cue.volume,
          sourceDuration: asset.durationSeconds,
          // 环境音首尾各留一段淡入淡出，避免突然出现/消失
          ...(isAmbience ? { fadeIn: Math.min(1.5, sfxDuration * 0.2), fadeOut: Math.min(2, sfxDuration * 0.25) } : {}),
        });
      } catch (err) {
        warnings.push(`音效 ${cue.preset} 生成失败，已跳过：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (tracks.length === 0) {
    throw new Error(
      'RENDER_FAILED: 没有任何可混音的音轨（无旁白、BGM 音量为 0、无音效）。' +
        '若确实需要无声视频，请显式跳过音频构建而不是走到这里。',
    );
  }

  // ---------------------------------------------------------- 混音
  const timeline: AudioTimeline = {
    tracks,
    durationSeconds: duration,
    loudnessLufs: spec.audio.loudness,
    truePeakDb: -1.5,
    masterPath: join(workDir, 'master.wav'),
    masterSampleRate: 48000,
  };

  const mix = mixAudio(timeline, {
    duck: DEFAULT_DUCK,
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });

  const measuredLoudness = measureLoudness(timeline.masterPath, spec.audio.loudness);
  if (options.strictNarration) {
    const presence = verifyVoicePresence(timeline.masterPath, tracks.filter(t => t.kind === 'voice'));
    writeFileSync(join(workDir, 'voice-presence.json'), JSON.stringify(presence, null, 2) + '\n');
    if (presence.some(p => !p.ok)) throw new Error('NARRATION_INAUDIBLE: 混音缺少可识别的旁白信号，见 voice-presence.json');
  }

  return {
    masterPath: timeline.masterPath,
    durationSeconds: duration,
    timeline,
    captionTimings,
    warnings,
    providerInfo: { tts: ttsId, bgm: bgmId, sfx: sfxId },
    mix,
    measuredLoudness,
  };
}

/** 导出被闪避后的 BGM 干声，用于验证闪避确实生效（见 test/audio.test.ts） */
export function exportDuckedBgmStem(timeline: AudioTimeline, outPath: string): string {
  const bgmOnly: AudioTimeline = { ...timeline, masterPath: outPath };
  mixAudio(bgmOnly, { duckedBgmOnly: true, codec: 'pcm_s16le' });
  return outPath;
}
