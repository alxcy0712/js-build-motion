/**
 * 音频层的契约（需求 §15、§16、§19）。
 *
 * 三条设计原则：
 *
 * 1. **三类音轨从一开始就独立存在**（VOICE / BGM / SFX）。
 *    即使 M0 的 SFX 只有雨声，结构也不能晚补——补结构意味着要改动混音、
 *    时间轴、DSL 三处，成本远高于一开始就留好位置。
 *
 * 2. **provider 化**。TTS 与 BGM 都不允许绑定到某一家服务：
 *    TTS 尤其重要——本项目默认用的 Edge TTS 是非官方接口，随时可能失效；
 *    BGM 则可能在"程序化合成"和"神经音乐生成"之间切换。
 *    接口定下来之后，换实现不改调用方。
 *
 * 3. **任何一轨都可以缺失**。没有 TTS 就用预制音频、没有 BGM 就只出配音，
 *    整条链路不能因为某一轨缺失而崩掉。
 */

import type { BgmKey, BgmPreset, SfxPreset, TtsVoice } from '../spec/types.ts';

// ------------------------------------------------------------ 通用

export interface AudioAsset {
  /** 落地文件的绝对路径 */
  readonly path: string;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  /** 已知响度（LUFS）；未知则为 undefined，混音阶段仍会统一标准化 */
  readonly loudnessLufs?: number;
}

export interface WordTiming {
  readonly text: string;
  /** 相对音频起点的秒数 */
  readonly start: number;
  readonly end: number;
}

/** 句级时间（服务按句返回时提供）：用于按句切镜、句间空档与字幕分条。 */
export interface SentenceTiming {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

// ------------------------------------------------------------ TTS

export interface TTSRequest {
  readonly text: string;
  readonly voice: TtsVoice;
  /** 语速，形如 '+8%'。provider 不支持时可忽略 */
  readonly rate?: string;
  /** 确定性：同一 seed + text 必须产出同一音频（Mock 用得到） */
  readonly seed: number;
  /** 输出路径（由调用方决定，provider 不自行选择目录） */
  readonly outPath: string;
}

export interface TTSResult extends AudioAsset {
  /**
   * 词级时间戳。**这是卡拉OK字幕的唯一可靠来源**（§17）。
   * provider 不提供时为 undefined —— 调用方应回退到文本时长估算，
   * 而不是去做语音识别。
   */
  readonly words?: readonly WordTiming[];
  /** 句级时间；provider 不提供时为 undefined */
  readonly sentences?: readonly SentenceTiming[];
}

export interface TTSProvider {
  readonly id: string;
  /** true 表示需要网络；离线场景应优先选择不需要网络的 provider */
  readonly requiresNetwork: boolean;
  isAvailable(): Promise<boolean>;
  synthesize(request: TTSRequest): Promise<TTSResult>;
}

// ------------------------------------------------------------ BGM

export interface BGMRequest {
  readonly bpm?: number;
  readonly preset: BgmPreset;
  readonly key: BgmKey;
  /** 需要的时长（秒）。程序化合成器可以精确按时长生成 */
  readonly durationSeconds: number;
  readonly seed: number;
  readonly outPath: string;
}

export interface BGMProvider {
  readonly id: string;
  readonly requiresNetwork: boolean;
  isAvailable(): Promise<boolean>;
  render(request: BGMRequest): Promise<AudioAsset>;
}

// ------------------------------------------------------------ SFX

export interface SFXRequest {
  readonly preset: SfxPreset;
  /** 期望时长（秒）。程序化音效可按时长生成或截断 */
  readonly durationSeconds: number;
  readonly seed: number;
  readonly outPath: string;
}

export interface SFXProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  render(request: SFXRequest): Promise<AudioAsset>;
}

// ------------------------------------------------------- 混音时间轴

export type TrackKind = 'voice' | 'bgm' | 'sfx' | 'original';

/**
 * 一条已经落到磁盘上的音轨，以及它在主时间轴上的位置。
 *
 * 注意 `start` 是**时间轴位置**，不是文件内的偏移——
 * 同一个文件可以被复用多次（例如同一个 whoosh 音效在不同时刻出现）。
 */
export interface AudioTrack {
  readonly kind: TrackKind;
  readonly path: string;
  /** 在视频时间轴上的起始秒 */
  readonly start: number;
  /** Exact placement and trim in the mixer's 48k sample domain. */
  readonly startSample?: number;
  readonly sourceStartSample?: number;
  readonly sourceEndSample?: number;
  /** 线性增益。1 = 不变 */
  readonly gain: number;
  /** 素材自身时长 */
  readonly sourceDuration: number;
  readonly fadeIn?: number;
  readonly fadeOut?: number;
  /**
   * 是否被 voice 闪避。通常只有 BGM 为 true。
   * SFX 也允许被闪避（例如旁白盖过雷声），但默认关。
   */
  readonly duckUnderVoice?: boolean;
}

export interface AudioTimeline {
  readonly tracks: readonly AudioTrack[];
  /** 目标总时长（= 视频时长），master 会被裁到这个长度 */
  readonly durationSeconds: number;
  /** EBU R128 目标响度 */
  readonly loudnessLufs: number;
  readonly truePeakDb: number;
  readonly masterPath: string;
  readonly masterSampleRate: number;
}

/**
 * 闪避参数。刻意暴露成参数而不是硬编码，
 * 因为"闪避够不够"取决于素材，必须能调。
 */
export interface DuckSettings {
  /** 侧链触发阈值 0..1 */
  readonly threshold: number;
  readonly ratio: number;
  /** 毫秒 */
  readonly attack: number;
  readonly release: number;
}

export const DEFAULT_DUCK: DuckSettings = {
  threshold: 0.04,
  ratio: 12,
  attack: 8,
  release: 320,
};
