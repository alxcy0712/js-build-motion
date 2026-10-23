/** 工具能力与状态的唯一注册表，供契约校验、capabilities 和披露使用。 */

export type ToolStatus = 'adopted' | 'candidate' | 'rejected' | 'unregistered' | 'external';

export type ToolKind =
  /** 代码渲染器：画面由代码逐帧画出 */
  | 'renderer'
  /** 语音合成 */
  | 'tts'
  /** 配乐 */
  | 'bgm'
  /** 音效 */
  | 'sfx'
  /** 媒体处理/探测（ffmpeg、ffprobe） */
  | 'media'
  /** 素材获取 */
  | 'fetcher'
  /** 语音识别 */
  | 'asr'
  /** 外部视觉模型：像素不是代码画出来的 */
  | 'external-visual'
  /** 图形/剪辑软件 */
  | 'editor';

export interface ToolEntry {
  /** 稳定 id，写进 brief.json 与 run.json */
  readonly id: string;
  /** 人类可读名 */
  readonly label: string;
  readonly kind: ToolKind;
  readonly status: ToolStatus;
  /** agent 在素材准备阶段调用；当前会话的接口可用性另行核验。 */
  readonly execution?: 'agent';
  /** 是否依赖网络或外部服务 */
  readonly network: boolean;
  /**
   * 输出是否逐字节可复现。
   * `edge-tts` 是 `false`——实测同一句文本两次合成波形不同（波形哈希记录在 measured）。
   * 这个字段决定 DISCLOSURE 里"确定性"能说到哪一步。
   */
  readonly byteReproducible: boolean;
}

/** 本片声明的外部工具；登记描述事实，执行支持仍由调用方核验。 */
export type ExternalTool = Omit<ToolEntry, 'status' | 'execution'>;

export const EXTERNAL_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'label', 'kind', 'network', 'byteReproducible'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
    label: { type: 'string', minLength: 1, maxLength: 160 },
    kind: { enum: ['renderer', 'tts', 'bgm', 'sfx', 'media', 'fetcher', 'asr', 'external-visual', 'editor'] },
    network: { type: 'boolean' }, byteReproducible: { type: 'boolean' },
  },
} as const;

export const TOOL_REGISTRY: readonly ToolEntry[] = [
  // ---------------------------------------------------------------- 渲染器
  { id: 'skia-canvas', label: '自写渲染器（skia-canvas + Canvas 2D）', kind: 'renderer', status: 'adopted', network: false, byteReproducible: true },
  { id: 'html-canvas', label: 'HTML/CSS/SVG/Canvas（浏览器内绘制）', kind: 'renderer', status: 'candidate', network: false, byteReproducible: false },
  { id: 'remotion', label: 'Remotion', kind: 'renderer', status: 'candidate', network: false, byteReproducible: false },
  { id: 'p5js', label: 'p5.js', kind: 'renderer', status: 'candidate', network: false, byteReproducible: false },
  { id: 'threejs', label: 'Three.js / WebGL（本地 Chrome 预渲染）', kind: 'renderer', status: 'adopted', execution: 'agent', network: false, byteReproducible: false },
  { id: 'blender', label: 'Blender Python', kind: 'renderer', status: 'candidate', network: false, byteReproducible: true },
  { id: 'manim', label: 'Manim', kind: 'renderer', status: 'candidate', network: false, byteReproducible: true },
  { id: 'motion-canvas', label: 'Motion Canvas', kind: 'renderer', status: 'candidate', network: false, byteReproducible: false },
  { id: 'playwright', label: 'Playwright', kind: 'renderer', status: 'rejected', network: false, byteReproducible: false },
  { id: 'puppeteer', label: 'Puppeteer', kind: 'renderer', status: 'rejected', network: false, byteReproducible: false },
  { id: 'hyperframes', label: 'HyperFrames', kind: 'renderer', status: 'candidate', network: false, byteReproducible: false },

  // ---------------------------------------------------------------- 语音
  { id: 'edge-tts', label: 'edge-tts', kind: 'tts', status: 'adopted', network: true, byteReproducible: false },
  { id: 'doubao-tts', label: '豆包语音合成', kind: 'tts', status: 'adopted', network: true, byteReproducible: false },
  { id: 'elevenlabs', label: 'ElevenLabs', kind: 'tts', status: 'candidate', network: true, byteReproducible: false },
  { id: 'qwen3-tts', label: 'Qwen3-TTS', kind: 'tts', status: 'candidate', network: false, byteReproducible: false },
  { id: 'cosyvoice', label: 'CosyVoice', kind: 'tts', status: 'candidate', network: false, byteReproducible: false },
  { id: 'kokoro', label: 'Kokoro', kind: 'tts', status: 'candidate', network: false, byteReproducible: false },
  { id: 'gemini-tts', label: 'Gemini TTS', kind: 'tts', status: 'candidate', network: true, byteReproducible: false },
  { id: 'azure-speech', label: 'Azure Speech', kind: 'tts', status: 'candidate', network: true, byteReproducible: false },

  // ---------------------------------------------------------------- 音乐与音效
  { id: 'procedural-bgm', label: '代码生成配乐', kind: 'bgm', status: 'adopted', network: false, byteReproducible: true },
  { id: 'procedural-sfx', label: '代码生成音效', kind: 'sfx', status: 'adopted', network: false, byteReproducible: true },
  { id: 'suno', label: 'Suno', kind: 'bgm', status: 'candidate', network: true, byteReproducible: false },
  { id: 'fluidsynth', label: 'FluidSynth', kind: 'bgm', status: 'candidate', network: false, byteReproducible: true },

  // ---------------------------------------------------------------- 媒体处理
  { id: 'ffmpeg', label: 'FFmpeg', kind: 'media', status: 'adopted', network: false, byteReproducible: true },
  { id: 'ffprobe', label: 'ffprobe', kind: 'media', status: 'adopted', network: false, byteReproducible: true },
  { id: 'libass', label: 'ASS + FFmpeg（libass）', kind: 'media', status: 'candidate', network: false, byteReproducible: true },
  { id: 'yt-dlp', label: 'yt-dlp', kind: 'fetcher', status: 'candidate', network: true, byteReproducible: false },
  { id: 'whisper-cpp-input-asr', label: 'whisper.cpp（输入 WAV 段级建议稿）', kind: 'asr', status: 'adopted', network: false, byteReproducible: false },
  { id: 'whisper', label: 'Whisper（ASR）', kind: 'asr', status: 'rejected', network: false, byteReproducible: false },

  // Agent 准备生成图片并固定为本片素材，代码渲染器读取已保存的文件。
  { id: 'imagegen', label: 'Agent 生图工具（按当前会话核验）', kind: 'external-visual', status: 'adopted', execution: 'agent', network: true, byteReproducible: false },

  // ------------------------------------------- 未登记：会出现，但本项目不做
  { id: 'seedance', label: 'Seedance', kind: 'external-visual', status: 'unregistered', network: true, byteReproducible: false },
  { id: 'minimax-h3', label: 'MiniMax H3', kind: 'external-visual', status: 'unregistered', network: true, byteReproducible: false },
  { id: 'kling', label: 'Kling', kind: 'external-visual', status: 'unregistered', network: true, byteReproducible: false },
  { id: 'comfyui', label: 'ComfyUI', kind: 'external-visual', status: 'unregistered', network: false, byteReproducible: false },
  { id: 'midjourney', label: 'Midjourney', kind: 'external-visual', status: 'unregistered', network: true, byteReproducible: false },
  { id: 'nano-banana', label: 'Nano Banana', kind: 'external-visual', status: 'unregistered', network: true, byteReproducible: false },
  { id: 'after-effects', label: 'After Effects', kind: 'editor', status: 'unregistered', network: false, byteReproducible: false },
  { id: 'capcut', label: 'CapCut', kind: 'editor', status: 'unregistered', network: false, byteReproducible: false },
] as const;

const BY_ID = new Map(TOOL_REGISTRY.map((t) => [t.id, t]));

export function findTool(id: string, external: readonly ExternalTool[] = []): ToolEntry | undefined {
  const tool = external.find(t => t.id === id);
  return BY_ID.get(id) ?? (tool ? { ...tool, status: 'external' } : undefined);
}

export function toolIds(): string[] {
  return TOOL_REGISTRY.map((t) => t.id);
}

/** 制作流程已支持的工具 id；agent 工具的本轮可用性由当前会话核验。 */
export function adoptedToolIds(): string[] {
  return TOOL_REGISTRY.filter((t) => t.status === 'adopted').map((t) => t.id);
}

/**
 * brief 里允许出现的工具 id 全集。
 *
 * 刻意包含 `unregistered` 条目：让 "seedance 未登记" 报成
 * 「这个工具我们知道、但本项目不做」而不是「不认识这个字符串」。
 * 后者会让人以为只要拼写正确就能通过。
 */
export function knownToolIds(): string[] {
  return toolIds();
}

export function isCodeRenderer(t: ToolEntry): boolean {
  return t.kind === 'renderer' && t.status === 'adopted';
}
