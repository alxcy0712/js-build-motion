import { THEME_IDS } from '../themes/ids.ts';
import { COMPOSITION_SCHEMA } from './motion.ts';
/**
 * VideoSpec 的 JSON Schema（需求 §13）。
 *
 * 关键点：**schema 由 types.ts 的枚举数组生成**，不手写第二份枚举列表。
 * 这样「TS 类型允许的取值」与「schema 允许的取值」不可能不一致——
 * 不需要代码生成，也不需要一致性测试。
 *
 * 其他设计取舍：
 *   - `additionalProperties: false`：拼错的字段名要能被发现，而不是被静默忽略。
 *     未知字段由 repair 层剥离并记为 SAFE_REPAIR（不致命，但必须可见）。
 *   - `required` 只保留 `video` 与 `scenes`：其余全有默认值，
 *     残缺的模型输出仍能进入修复流程而不是直接失败（§11）。
 *   - fps 用闭集而不是范围：帧率是「选」不是「造」，同时保证音频采样能被整除。
 */

import {
  BGM_KEYS,
  BGM_PRESETS,
  CAMERAS,
  CAMERA_MOVES,
  CAPTION_MODES,
  CAPTION_STYLES,
  ENVIRONMENTS,
  PALETTES,
  SFX_PRESETS,
  TRANSITIONS,
  TTS_VOICES,
} from './types.ts';

/** M0 支持的帧率闭集。24 与 30 都能被 48kHz 整除（2000 / 1600 采样/帧） */
export const SUPPORTED_FPS = [12, 15, 24, 25, 30, 60] as const;

/** 尺寸范围。上限限制逐帧 raw 像素管道的内存与传输负载。 */
export const DIMENSION_MIN = 64;
export const DIMENSION_MAX = 4096;

const enumSchema = (values: readonly string[]): Record<string, unknown> => ({
  type: 'string',
  enum: [...values],
});

const number_ = (opts: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'number',
  ...opts,
});

const integer = (opts: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'integer',
  ...opts,
});

export const CAPTION_LAYOUT_SCHEMA = {
  fontScale: { type: 'number', minimum: 0.015, maximum: 0.1 },
  translationScale: { type: 'number', minimum: 0.35, maximum: 1 },
  maxWidth: { type: 'number', minimum: 0.4, maximum: 0.92 },
  bottomInset: { type: 'number', minimum: 0, maximum: 0.35 },
} as const;

export const NARRATION_RATE_SCHEMA = { type: 'integer', minimum: -50, maximum: 100 } as const;

/**
 * 单条旁白的最大字数。
 *
 * 超长不是渲染错误（字幕引擎会自动换行），但一条 120 字以上的旁白
 * 在半屏宽的竖屏安全区里必然要占 6 行以上，观感很差——
 * 因此记为 WARNING 并建议拆句，而不是静默接受。
 */
export const NARRATION_MAX_CHARS = 120;

/**
 * 双语字幕第二行的最大字符数。
 *
 * 比旁白宽松得多，因为这一行**不参与 TTS**：它只影响版面。
 * 英译文按字符算远少于中文的信息量，用旁白的上限会把正常的译文误判成超长。
 * 上限与导演计划的 `narrationTranslation.maxLength` 保持一致，避免两份契约各自定价。
 */
export const TRANSLATION_MAX_CHARS = 300;

export const VIDEO_SPEC_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://js-build-motion/schema/video-spec-0.1.json',
  title: 'VideoSpec',
  type: 'object',
  additionalProperties: false,
  required: ['video', 'scenes'],
  properties: {
    version: { type: 'string' },

    video: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'duration'],
      properties: {
        width: integer({ minimum: DIMENSION_MIN, maximum: DIMENSION_MAX }),
        height: integer({ minimum: DIMENSION_MIN, maximum: DIMENSION_MAX }),
        fps: { type: 'integer', enum: [...SUPPORTED_FPS] },
        duration: number_({ exclusiveMinimum: 0, maximum: 600 }),
        seed: integer({ minimum: 0, maximum: 4294967295 }),
      },
    },

    style: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: enumSchema(THEME_IDS),
        palette: enumSchema(PALETTES),
        vignette: { type: 'number', minimum: 0, maximum: 1 },
      },
    },

    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 120,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'start', 'end', 'environment'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40 },
          start: number_({ minimum: 0 }),
          end: number_({ minimum: 0 }),
          environment: enumSchema(ENVIRONMENTS),
          composition: COMPOSITION_SCHEMA,
          camera: enumSchema(CAMERAS),
          cameraMove: enumSchema(CAMERA_MOVES),
          transition: enumSchema(TRANSITIONS),
          headline: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 40 } },
          kicker: { type: 'string', minLength: 1, maxLength: 40 },
          ip: {
            type: 'object', additionalProperties: false, required: ['role'],
            properties: {
              role: { type: 'string', enum: ['identity', 'actor'] },
              size: { type: 'number', minimum: 64, maximum: 512 },
              position: { type: 'string', enum: ['bottom-center', 'bottom-left', 'bottom-right', 'center', 'custom'] },
              x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
              expression: { type: 'string', pattern: '^[a-z0-9_-]{1,24}$' },
            },
          },
          ipExpression: { type: 'string', pattern: '^[a-z0-9_-]{1,24}$' },
          cameraPath: {
            type: 'object', additionalProperties: false, required: ['keys'],
            properties: {
              keys: {
                type: 'array', minItems: 2, maxItems: 24,
                items: {
                  type: 'object', additionalProperties: false, required: ['t'],
                  properties: {
                    t: { type: 'number', minimum: 0 }, x: { type: 'number', minimum: -0.5, maximum: 1.5 }, y: { type: 'number', minimum: -0.5, maximum: 1.5 },
                    zoom: { type: 'number', minimum: 0.5, maximum: 8 }, rotate: { type: 'number', minimum: -45, maximum: 45 },
                    ease: { anyOf: [{ const: 'hold' }, { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } }] },
                  },
                },
              },
            },
          },
          focus: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, w: { type: 'number', minimum: 0.01, maximum: 1 }, h: { type: 'number', minimum: 0.01, maximum: 1 } } },
          footage: {
            type: 'object', additionalProperties: false, required: ['src'],
            properties: {
              src: { type: 'string', minLength: 1, maxLength: 260 }, in: { type: 'number', minimum: 0 }, speed: { type: 'number', minimum: 0.25, maximum: 4 },
              fit: { type: 'string', enum: ['cover', 'contain'] },
              crop: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
              kenBurns: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'object' }, to: { type: 'object' }, ease: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } } } },
              color: { type: 'object', additionalProperties: false, properties: { exposure: { type: 'number' }, contrast: { type: 'number' }, saturation: { type: 'number' }, temperature: { type: 'number' }, vignette: { type: 'number' } } },
            },
          },
        },
      },
    },

    audio: {
      type: 'object',
      additionalProperties: false,
      properties: {
        narration: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              start: number_({ minimum: 0 }),
              voice: enumSchema(TTS_VOICES),
              rate: NARRATION_RATE_SCHEMA,
              text: { type: 'string', minLength: 1, maxLength: 500 },
              translation: { type: 'string', minLength: 1, maxLength: 500 },
            },
          },
        },
        bgm: {
          type: 'object',
          additionalProperties: false,
          properties: {
            preset: enumSchema(BGM_PRESETS),
            bpm: number_({ minimum: 40, maximum: 200 }),
            key: enumSchema(BGM_KEYS),
            volume: number_({ minimum: 0, maximum: 1 }),
            fadeIn: number_({ minimum: 0, maximum: 30 }),
            fadeOut: number_({ minimum: 0, maximum: 30 }),
            duckUnderNarration: { type: 'boolean' },
          },
        },
        sfx: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'preset'],
            properties: {
              start: number_({ minimum: 0 }),
              preset: enumSchema(SFX_PRESETS),
              volume: number_({ minimum: 0, maximum: 1 }),
            },
          },
        },
        loudness: number_({ minimum: -30, maximum: -6 }),
      },
    },

    captions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        style: enumSchema(CAPTION_STYLES),
        mode: enumSchema(CAPTION_MODES),
        ...CAPTION_LAYOUT_SCHEMA,
      },
    },
  },
};
