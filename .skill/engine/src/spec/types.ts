import type { CameraPath } from '../motion/camera-path.ts';
import type { FocusRect } from '../motion/focus.ts';
import type { FootageClip } from '../footage/spec.ts';
import { DEFAULT_THEME, type ThemeId } from '../themes/ids.ts';
export { THEME_IDS, type ThemeId } from '../themes/ids.ts';
import type { Composition } from './motion.ts';
import { DOUBAO_VOICES, type DoubaoVoiceId } from '../audio/tts/doubao-voices.ts';
/**
 * VideoSpec 类型定义。
 *
 * 设计原则：
 *   1. 内置规格的枚举值由 `as const` 数组登记，供 JSON Schema 与 TS 类型共用。
 *   2. 默认值由本文件常量登记，修复规则由 repair.ts 实现，输入经校验后进入渲染。
 *   3. 本片可通过 drawing 入口和组件副本独立实现主体、场景与轨迹，
 *      并通过已验证的预渲染路径准备素材；输出沿用固定时间、来源与渲染契约。
 *
 * 枚举约束作用于内置字段；具体画法及可调默认的范围见 references/drawing.md、styles.md。
 */

// ------------------------------------------------------------------ 枚举

export const CAMERAS = ['wide', 'medium', 'medium_close', 'close', 'extreme_close'] as const;
export type Camera = (typeof CAMERAS)[number];

export const ENVIRONMENTS = ['motion_stage', 'theme_stage', 'footage'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const CAMERA_MOVES = ['static', 'slow_push', 'slow_pull', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export { TRANSITIONS, type Transition } from '../themes/transition-ids.ts';
import type { Transition } from '../themes/transition-ids.ts';

export const PALETTES = ['warm_night', 'dusk', 'dawn', 'cool_blue', 'sepia', 'mono'] as const;
export type Palette = (typeof PALETTES)[number];

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
  /** 风格层（themes/）：决定字体、色板、字号、时长、弹簧、缓动、转场与质感。场景色仍由 palette 决定。 */
  theme: ThemeId;
  palette: Palette;
  /** 暗角强度 [0,1]；0 关闭，省略时使用主题默认值。 */
  vignette?: number;
}

export const IP_ROLES = ['identity', 'actor'] as const;
export const IP_POSITIONS = ['bottom-center', 'bottom-left', 'bottom-right', 'center', 'custom'] as const;
/** IP 源素材边长（rig 头/身部件 512px）。显示尺寸不得超过它：IP 是小幅美术，不放大当主视觉。 */
export const IP_SOURCE_SIZE = 512;
export const IP_DEFAULT_SIZE = { identity: 288, actor: 384 } as const;
export interface IPPlacement {
  /** identity=身份/署名（如片尾小签名）；actor=讲解动画里的演员 */
  role: (typeof IP_ROLES)[number];
  /** 显示边长（输出像素，竖屏 1080 宽 / 横屏 1920 宽参考），≤ 512 */
  size?: number;
  position?: (typeof IP_POSITIONS)[number];
  /** position=custom 时的中心点（0–1 画面比例），y 为角色底边 */
  x?: number;
  y?: number;
  expression?: string;
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
  /** theme_stage 的屏上文字，每行一项（≤3 行，每屏字数受风格预算约束） */
  headline?: string[];
  /** theme_stage 的小标题（强调色） */
  kicker?: string;
  /** 个人 IP（assets/personal-ip）。默认不出现；只用于身份声明或讲解中的演员 */
  ip?: IPPlacement;
  /** IP 表情 id，见 assets/personal-ip/expressions.json；默认 neutral */
  ipExpression?: string;
  /** 关键帧相机（镜头内秒数；x/y 为归一化注视点）。设置后取代 cameraMove 预设 */
  cameraPath?: CameraPath;
  /** 本镜头的视觉焦点元素（归一化矩形）；下一镜头用 zoomIntoElement 时从这里钻入 */
  focus?: FocusRect;
  /** environment = footage 时的素材片段（图片/视频，相对素材根目录） */
  footage?: FootageClip;
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
  /** 显式覆盖框底距画面底部的比例；省略时外框中轴线位于画面高度的 77.5%。 */
  bottomInset?: number;
}

export const CAPTION_LAYOUT_DEFAULTS = { fontScale: 0.052, translationScale: 0.62, maxWidth: 0.84, bottomInset: undefined, centerY: 0.775 } as const;

export interface CaptionSettings extends CaptionLayoutSettings {
  enabled: boolean;
  style: CaptionStyle;
  mode: CaptionMode;
}

export interface VideoSpec {
  version: string;
  video: VideoSettings;
  style: StyleSettings;
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
    theme: DEFAULT_THEME,
    palette: 'warm_night',
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
  },
  loudness: -14,
  narrationRate: 8,
} as const satisfies Record<string, unknown>;

// ------------------------------------------------- 渲染期的「已解析」形态

/**
 * 校验 + 修复之后的 spec：所有可选字段都已填上，可直接交给渲染器。
 * 渲染器只接受 `ResolvedVideoSpec`，从而不可能遇到 undefined 分支。
 */
export interface ResolvedStyleSettings extends StyleSettings {}
export interface ResolvedScene extends Required<Omit<Scene, 'composition' | 'headline' | 'kicker' | 'ip' | 'ipExpression' | 'cameraPath' | 'focus' | 'footage'>> {
  composition?: Composition;
  headline?: string[];
  kicker?: string;
  ip?: IPPlacement;
  ipExpression?: string;
  cameraPath?: CameraPath;
  focus?: FocusRect;
  footage?: FootageClip;
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
  scenes: ResolvedScene[];
  audio: ResolvedAudioSettings;
  captions: CaptionSettings;
}
