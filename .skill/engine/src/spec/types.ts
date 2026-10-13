import type { Composition } from './motion.ts';
import { DOUBAO_VOICES, type DoubaoVoiceId } from '../audio/tts/doubao-voices.ts';
/**
 * VideoSpec 类型定义（需求 §11、§12）。
 *
 * 设计原则：
 *   1. **封闭词汇**——所有可选值是 `as const` 数组，模型只能「选」，不能「造」
 *   2. **全量默认值**——每个字段都有默认值，残缺的 spec 也能渲出可看的画面
 *   3. **单一事实来源**——枚举数组同时被 JSON Schema 与 TS 类型消费，
 *      因此 schema 与类型**不可能漂移**（不需要代码生成）
 *
 * 模型看到的只有「场景 / 人物 / 动作 / 镜头 / 风格 / 情绪」这类语义词汇，
 * 看不到任何 Skia / Canvas / FFmpeg 概念（§8）。
 */

// ------------------------------------------------------------------ 枚举

export const CAMERAS = ['wide', 'medium', 'medium_close', 'close', 'extreme_close'] as const;
export type Camera = (typeof CAMERAS)[number];

export const ENVIRONMENTS = [
  'rain_window',
  'motion_stage',
  'office_night',
  'bedroom',
  'city_street',
  'forest',
  'mountain',
  'ocean',
  'coffee_shop',
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const CAMERA_MOVES = ['static', 'slow_push', 'slow_pull', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const TRANSITIONS = ['cut', 'fade', 'dissolve', 'wipe', 'iris', 'zoom', 'grid', 'glitch', 'tokenize'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const STYLE_PRESETS = ['watercolor_storybook', 'ink', 'pencil', 'paper_cut', 'flat'] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

export const PALETTES = ['warm_night', 'dusk', 'dawn', 'cool_blue', 'sepia', 'mono'] as const;
export type Palette = (typeof PALETTES)[number];

export const PAPER_KINDS = ['smooth', 'rough', 'watercolor', 'kraft'] as const;
export type PaperKind = (typeof PAPER_KINDS)[number];

export const LINE_STYLES = ['none', 'soft_ink', 'ink', 'pencil'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

export const CHARACTER_PRESETS = [
  'female_young',
  'female_average',
  'male_young',
  'male_average',
  'child',
  'elder',
] as const;
export type CharacterPreset = (typeof CHARACTER_PRESETS)[number];

export const HAIR_STYLES = ['long_dark', 'long_light', 'short_dark', 'short_light', 'bun', 'ponytail'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

export const CLOTHING = [
  'beige_coat',
  'dark_coat',
  'white_shirt',
  'sweater',
  'dress',
  'school_uniform',
] as const;
export type Clothing = (typeof CLOTHING)[number];

export const ACTIONS = [
  'stand',
  'sit',
  'walk',
  'write',
  'read',
  'look_outside',
  'drink',
  'turn_head',
  'smile',
  'sleep',
] as const;
export type Action = (typeof ACTIONS)[number];

export const EMOTIONS = ['neutral', 'nostalgic', 'happy', 'sad', 'anxious', 'calm', 'hopeful'] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const ABSTRACT_TTS_VOICES = ['female_calm', 'female_lively', 'male_calm', 'male_lively'] as const;
export type AbstractTtsVoice = (typeof ABSTRACT_TTS_VOICES)[number];
export const TTS_VOICES = [...ABSTRACT_TTS_VOICES, ...DOUBAO_VOICES.map(voice => voice.id)] as const;
export type TtsVoice = AbstractTtsVoice | DoubaoVoiceId;

export const BGM_PRESETS = ['quiet_piano', 'warm_uplift', 'curious', 'tender', 'tense', 'playful'] as const;
export type BgmPreset = (typeof BGM_PRESETS)[number];

export const BGM_KEYS = ['C', 'D', 'E', 'F', 'G', 'A'] as const;
export type BgmKey = (typeof BGM_KEYS)[number];

export const SFX_PRESETS = [
  'soft_rain',
  'heavy_rain',
  'wind',
  'footsteps',
  'paper',
  'heartbeat',
  'clock',
  'whoosh',
  'click',
  'success',
] as const;
export type SfxPreset = (typeof SFX_PRESETS)[number];

export const CAPTION_STYLES = ['handwritten', 'clean', 'boxed'] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const CAPTION_MODES = ['sentence', 'word'] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];

// ---------------------------------------------------------------- 结构

export interface VideoSettings {
  width: number;
  height: number;
  fps: number;
  /** 秒 */
  duration: number;
  seed: number;
}

export interface StyleSettings {
  preset: StylePreset;
  palette: Palette;
  paper: PaperKind;
  line: LineStyle;
}

export interface CharacterDefinition {
  /** 场景通过这个 id 引用人物 */
  id: string;
  preset: CharacterPreset;
  hair: HairStyle;
  clothing: Clothing;
  /** 可选：人物在画面中的默认横向位置 [0,1] */
  x?: number;
  /** 可选：人物在画面中的默认纵向位置 [0,1]（脚底） */
  y?: number;
}

export interface Scene {
  composition?: Composition;
  id: string;
  /** 起始秒 */
  start: number;
  /** 结束秒 */
  end: number;
  environment: Environment;
  camera: Camera;
  cameraMove?: CameraMove;
  transition?: Transition;
  /** 引用 CharacterDefinition.id；缺省表示无人物 */
  character?: string;
  action?: Action;
  emotion?: Emotion;
}

export interface NarrationLine {
  /** 起始秒 */
  start: number;
  voice: TtsVoice;
  text: string;
  /** 相对正常语速的整数百分比，省略时为 +8%。 */
  rate?: number;
  /**
   * 第二语言字幕行（双语字幕）。**不参与 TTS**，只随同一条 cue 的时间轴显示。
   *
   * 之所以挂在 narration 上而不是 caption 上：双语字幕的两行必须共用
   * 同一个时间戳来源，否则中英两行会各走各的时间轴，看起来像坏掉的字幕。
   */
  translation?: string;
}

export interface BgmSettings {
  bpm?: number;
  preset: BgmPreset;
  key?: BgmKey;
  /** 0..1，相对响度 */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  duckUnderNarration: boolean;
}

export interface SfxCue {
  start: number;
  preset: SfxPreset;
  volume: number;
}

export interface AudioSettings {
  narration?: NarrationLine[];
  bgm?: BgmSettings;
  sfx?: SfxCue[];
  /** 混音后的响度目标（EBU R128） */
  loudness?: number;
}

export interface CaptionLayoutSettings {
  /** 主字幕字号占画幅短边的比例，预览随画幅缩放。 */
  fontScale?: number;
  /** 译文字号相对主字幕基准字号的比例。 */
  translationScale?: number;
  /** 字幕区最大宽度占画幅宽度的比例。 */
  maxWidth?: number;
  /** 字幕底板下沿距画面底部的比例。 */
  bottomInset?: number;
}

export const CAPTION_LAYOUT_DEFAULTS = { fontScale: 0.052, translationScale: 0.62, maxWidth: 0.84, bottomInset: 0.14 } as const;

export interface CaptionSettings extends CaptionLayoutSettings {
  enabled: boolean;
  style: CaptionStyle;
  mode: CaptionMode;
}

export interface VideoSpec {
  version: string;
  video: VideoSettings;
  style: StyleSettings;
  characters: CharacterDefinition[];
  scenes: Scene[];
  audio?: AudioSettings;
  captions?: CaptionSettings;
}

// ---------------------------------------------------------------- 默认值

/**
 * 默认值集中在此处，而不是散落在 schema / repair / 渲染各层。
 *
 * 为什么重要（§11）：弱模型的输出经常缺字段。只要默认值是「安全且体面」的，
 * 残缺的 spec 也能出片，而不是直接失败。默认值本身就是工程质量的一部分。
 */
export const SPEC_DEFAULTS = {
  version: '0.1',
  video: {
    width: 1080,
    height: 1920,
    fps: 24,
    duration: 8,
    seed: 12345,
  },
  style: {
    preset: 'watercolor_storybook',
    palette: 'warm_night',
    paper: 'rough',
    line: 'soft_ink',
  },
  captions: {
    enabled: true,
    style: 'handwritten',
    mode: 'sentence',
  },
  bgm: {
    preset: 'quiet_piano',
    key: 'C',
    volume: 0.25,
    fadeIn: 1.5,
    fadeOut: 2,
    duckUnderNarration: true,
  },
  scene: {
    camera: 'medium',
    cameraMove: 'static',
    transition: 'cut',
    action: 'stand',
    emotion: 'neutral',
  },
  loudness: -14,
  narrationRate: 8,
} as const satisfies Record<string, unknown>;

/** 默认人物：当场景引用了不存在的人物时用于兜底（并记为 WARNING） */
export const DEFAULT_CHARACTER: CharacterDefinition = {
  id: 'default',
  preset: 'female_young',
  hair: 'long_dark',
  clothing: 'beige_coat',
};

// ------------------------------------------------- 渲染期的「已解析」形态

/**
 * 校验 + 修复之后的 spec：所有可选字段都已填上，可直接交给渲染器。
 * 渲染器只接受 `ResolvedVideoSpec`，从而不可能遇到 undefined 分支。
 */
export interface ResolvedStyleSettings extends StyleSettings {}
export interface ResolvedScene extends Required<Omit<Scene, 'character' | 'composition'>> {
  character: string | undefined;
  composition?: Composition;
}
export interface ResolvedAudioSettings {
  narration: NarrationLine[];
  bgm: BgmSettings;
  sfx: SfxCue[];
  loudness: number;
}
export interface ResolvedVideoSpec {
  version: string;
  video: VideoSettings;
  style: ResolvedStyleSettings;
  characters: CharacterDefinition[];
  scenes: ResolvedScene[];
  audio: ResolvedAudioSettings;
  captions: CaptionSettings;
}
