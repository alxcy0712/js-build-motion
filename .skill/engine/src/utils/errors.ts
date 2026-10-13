/**
 * 语义化错误体系。
 *
 * 设计目标（对应需求 §42）：错误信息必须对 Coding Agent / 弱模型友好——
 * 即输出「错误码 + 出错位置 + 允许值」，使 flash 级模型无需读源码即可自修。
 */

export const ERROR_CODES = {
  /** VideoSpec 未通过 schema 校验，且无法安全修复 */
  SPEC_INVALID: 'SPEC_INVALID',
  /** VideoSpec 文件不存在或不是合法 JSON */
  SPEC_UNREADABLE: 'SPEC_UNREADABLE',
  /** 找不到 ffmpeg 可执行文件 */
  FFMPEG_NOT_FOUND: 'FFMPEG_NOT_FOUND',
  /** 找不到 ffprobe 可执行文件 */
  FFPROBE_NOT_FOUND: 'FFPROBE_NOT_FOUND',
  /** 找不到所需编码器 */
  ENCODER_NOT_AVAILABLE: 'ENCODER_NOT_AVAILABLE',
  /** 找不到所需项目字体文件，或字体未成功注册 */
  FONT_NOT_FOUND: 'FONT_NOT_FOUND',
  /** 字体缺少所需字形（会出豆腐块） */
  FONT_GLYPH_MISSING: 'FONT_GLYPH_MISSING',
  /** TTS provider 不可用 */
  TTS_PROVIDER_UNAVAILABLE: 'TTS_PROVIDER_UNAVAILABLE',
  /** 音频素材文件缺失 */
  AUDIO_ASSET_NOT_FOUND: 'AUDIO_ASSET_NOT_FOUND',
  /** 渲染过程失败 */
  RENDER_FAILED: 'RENDER_FAILED',
  /** 输出目录不可写 */
  OUTPUT_NOT_WRITABLE: 'OUTPUT_NOT_WRITABLE',
  /** Node 版本过低 */
  NODE_VERSION_UNSUPPORTED: 'NODE_VERSION_UNSUPPORTED',
  /** 命令行用法错误 */
  CLI_USAGE: 'CLI_USAGE',
  /** 找不到项目目录 / project.json */
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  /** project.json 不合法 */
  PROJECT_INVALID: 'PROJECT_INVALID',
  /** brief.json 不合法 */
  BRIEF_INVALID: 'BRIEF_INVALID',
  /** brief 声明与实测遥测冲突（声明—实测对账失败） */
  BRIEF_CONFLICT: 'BRIEF_CONFLICT',
  /** 项目输入越界：引用了其它项目、本项目产物目录或项目目录之外的路径 */
  PROJECT_ISOLATION_VIOLATION: 'PROJECT_ISOLATION_VIOLATION',
  /** 缺少 run.json，无法做声明对账 */
  RUN_LOG_MISSING: 'RUN_LOG_MISSING',
  /** 功能尚未实现（附带负责该功能的里程碑） */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface EngineErrorOptions {
  /** 结构化上下文，例如 { path: 'scenes[0].camera', got: 'aaa' } */
  details?: Record<string, unknown>;
  /** 允许值列表或修复建议 */
  allowed?: readonly string[];
  /** 面向人或模型的一句话修复建议 */
  hint?: string;
  cause?: unknown;
}

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly allowed: readonly string[] | undefined;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: EngineErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'EngineError';
    this.code = code;
    this.details = options.details;
    this.allowed = options.allowed;
    this.hint = options.hint;
  }

  /**
   * 生成给 LLM / Coding Agent 看的纯文本。
   * 刻意不使用堆栈——堆栈对弱模型是噪声，反而降低自修成功率。
   */
  toLLMString(): string {
    const lines: string[] = [`${this.code}: ${this.message}`];
    if (this.details) {
      for (const [k, v] of Object.entries(this.details)) {
        lines.push(`  ${k}: ${formatValue(v)}`);
      }
    }
    if (this.allowed?.length) {
      lines.push(`  Allowed: ${this.allowed.join(' | ')}`);
    }
    if (this.hint) lines.push(`  Hint: ${this.hint}`);
    return lines.join('\n');
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.allowed ? { allowed: this.allowed } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 未实现的功能：附带负责该功能的任务 id，便于追踪而不是留下无主 TODO */
export function notImplemented(what: string, taskId: string): never {
  throw new EngineError(ERROR_CODES.NOT_IMPLEMENTED, `${what} 尚未实现`, {
    details: { plannedIn: taskId },
    hint: `该能力在里程碑 ${taskId} 中实现`,
  });
}
