/**
 * 项目层 JSON Schema。
 *
 * 项目层引入两份新的结构化文件，都必须走真实 Schema 校验（需求 §13）：
 *   - `project.json`  —— 项目 manifest，引擎解析项目的唯一入口
 *   - `brief.json`    —— 提示词契约（声明层），见 task-4
 *
 * 两份 schema 与 VideoSpec schema 一样，都是**封闭**的（additionalProperties: false）：
 * 写错字段名必须报错，而不是被静默忽略——静默忽略是弱模型最难自查的失败模式。
 */

import type { Schema } from 'ajv';
import { EXTERNAL_TOOL_SCHEMA } from './tool-registry.ts';

/** 项目标识：小写字母/数字/连字符，必须与目录名一致 */
export const PROJECT_SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{1,47}$';

/**
 * 相对路径：禁止绝对路径与前导斜杠，禁止 `..` 逃逸。
 * 项目内的所有被引用文件都必须落在项目目录里（AGENTS.md 硬性规则 1）。
 */
export const PROJECT_RELATIVE_PATH_PATTERN = '^(?!/)(?!.*\\.\\.)[^\\\\]+$';

/**
 * 宽松版：只禁绝对路径与反斜杠，**不禁 `..`**。
 *
 * 刻意给 `assets[].path` 用这个：让 `..` 落到语义检查里，
 * 从而报出「素材路径逃出项目目录 + 该放哪」这种可执行的错误，
 * 而不是一条模式不匹配的 schema 消息。两条防线都保留，只是分工不同。
 */
export const PROJECT_RELATIVE_PATH_LENIENT_PATTERN = '^(?!/)[^\\\\]+$';

export const PROJECT_STATUSES = ['draft', 'production', 'complete', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_MANIFEST_SCHEMA: Schema = {
  $id: 'js-build-motion/project-manifest@0.1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'slug', 'title', 'status', 'entry'],
  properties: {
    version: { const: '0.1' },
    slug: {
      type: 'string',
      pattern: PROJECT_SLUG_PATTERN,
      description: '必须与 projects/<slug>/ 目录名一致',
    },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', maxLength: 400 },
    status: { enum: [...PROJECT_STATUSES] },
    /** 相对项目目录的 VideoSpec 路径，例如 "spec/main.json" */
    entry: { type: 'string', pattern: PROJECT_RELATIVE_PATH_PATTERN },
    director: { type: 'string', pattern: PROJECT_RELATIVE_PATH_PATTERN },
    /** 本片同步绘制模块，入口位于项目 src/ 内。 */
    drawing: { type: 'string', pattern: '^src/[^\\\\]+\\.(mjs|js|ts)$' },
    /** 相对项目目录的提示词契约路径；null 表示该项目故意不做声明对账 */
    brief: { type: ['string', 'null'], pattern: PROJECT_RELATIVE_PATH_PATTERN },
    /** 相对项目目录的成片输出目录 */
    outDir: { type: 'string', pattern: PROJECT_RELATIVE_PATH_PATTERN },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 12 },
    milestone: { type: 'string', maxLength: 24 },
    /** 该项目对应的提示词原型 id（见 prompts/archetypes/），建立 prompt↔项目 正向链接 */
    archetype: { type: ['string', 'null'], pattern: '^[a-z0-9][a-z0-9-]*$' },
  },
} as const;

// ---------------------------------------------------------------- brief

/** 画幅枚举（与 spec 的 width/height 比值必须一致） */
export const BRIEF_ASPECTS = ['9:16', '16:9', '1:1', '4:5', '2:1', '21:9'] as const;
export type BriefAspect = (typeof BRIEF_ASPECTS)[number];

/** 字幕形态声明 */
export const BRIEF_CAPTION_MODES = ['inside_frame', 'sidecar', 'both', 'none'] as const;
export type BriefCaptionMode = (typeof BRIEF_CAPTION_MODES)[number];

/** 外部素材类型 */
export const BRIEF_ASSET_KINDS = ['image', 'audio', 'video', 'font', 'document'] as const;
export type BriefAssetKind = (typeof BRIEF_ASSET_KINDS)[number];

export const BRIEF_ASSET_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['path', 'kind', 'license'],
  properties: {
    path: { type: 'string', pattern: PROJECT_RELATIVE_PATH_LENIENT_PATTERN },
    kind: { enum: [...BRIEF_ASSET_KINDS] },
    license: { type: 'string', minLength: 1, maxLength: 200 },
    source: { type: 'string', maxLength: 500 },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    provenance: {
      type: 'object', additionalProperties: false, required: ['tools'],
      properties: { tools: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } } },
    },
  },
} as const;

/** 输入素材条目（参考片 / 资料 / 品牌资产 / 既有音频） */
const INPUT_ITEM_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['note'],
  properties: {
    url: { type: 'string', maxLength: 500 },
    note: { type: 'string', minLength: 1, maxLength: 300 },
    license: { type: 'string', maxLength: 200 },
  },
};

/**
 * 提示词契约（brief.json）。
 *
 * 设计原则：
 * 「外部轮数、长度、已有资产、工具限制、自主探索额度」是五个**独立**变量，
 * 而「one prompt / 纯代码 / 零外部素材 / 无人修改」是四个**独立**声称。
 * 因此这五类信息在 schema 里必须分开存放，不能合并成一个自由文本字段——
 * 一旦合并，就无法对账，只能靠人反复解释。
 */
export const BRIEF_SCHEMA: Schema = {
  $id: 'js-build-motion/brief@0.1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'archetype', 'intent', 'deliverable', 'tools', 'claims'],
  properties: {
    version: { const: '0.1' },
    /** 采用的提示词原型 id（prompts/archetypes/<id>.brief.json） */
    archetype: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,47}$' },
    /** 提示词的原始意图，保留原文。 */
    intent: { type: 'string', minLength: 8, maxLength: 600 },
    audience: { type: 'string', minLength: 1, maxLength: 200 },

    /** 交付规格：必须与 spec 的 video 段对得上，否则对账阶段会失败 */
    deliverable: {
      type: 'object',
      additionalProperties: false,
      required: ['duration', 'aspect'],
      properties: {
        duration: { type: 'number', exclusiveMinimum: 0, maximum: 1800 },
        aspect: { enum: [...BRIEF_ASPECTS] },
        fps: { type: 'integer', minimum: 1, maximum: 120 },
        captions: { enum: [...BRIEF_CAPTION_MODES] },
      },
    },

    /** 输入边界：这些东西进入过制作过程（无论是否出现在成片里） */
    inputs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        referenceClips: { type: 'array', maxItems: 20, items: INPUT_ITEM_SCHEMA },
        documents: { type: 'array', maxItems: 20, items: INPUT_ITEM_SCHEMA },
        brandAssets: { type: 'array', maxItems: 20, items: INPUT_ITEM_SCHEMA },
        audio: { type: 'array', maxItems: 20, items: INPUT_ITEM_SCHEMA },
      },
    },

    /** 项目内、有明确授权与哈希的素材（会参与对账与披露） */
    assets: {
      type: 'array',
      maxItems: 50,
      items: BRIEF_ASSET_SCHEMA,
    },

    /** 工具边界：allowed 是白名单，forbidden 是显式禁止 */
    tools: {
      type: 'object',
      additionalProperties: false,
      required: ['allowed'],
      properties: {
        allowed: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
        forbidden: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        external: { type: 'array', maxItems: 50, items: EXTERNAL_TOOL_SCHEMA },
      },
    },

    /** 四项独立声称：不可互相替代，也不可合并成一句话 */
    claims: {
      type: 'object',
      additionalProperties: false,
      required: ['humanRounds', 'pureCode', 'zeroExternalAssets', 'humanRevision'],
      properties: {
        /** 人类指令轮数。null = 未记录（此时不得对外声称 "one prompt"） */
        humanRounds: { type: ['integer', 'null'], minimum: 1, maximum: 999 },
        /** 画面是否全部由代码绘制（视觉渲染路径） */
        pureCode: { type: 'boolean' },
        /** 是否零外部素材（输入边界） */
        zeroExternalAssets: { type: 'boolean' },
        /** 是否经过人工修改（审片与交付过程） */
        humanRevision: { type: 'boolean' },
      },
    },

    /** 验收条件：人写的检查项，渲染后由人逐条确认 */
    acceptance: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
    notes: { type: 'string', maxLength: 2000 },
  },
} as const;
