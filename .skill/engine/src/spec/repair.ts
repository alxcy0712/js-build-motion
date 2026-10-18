import { parseCameraPath, type CameraPath } from '../motion/camera-path.ts';
import { parseFocus, type FocusRect } from '../motion/focus.ts';
import { minShotSeconds } from '../motion/shot-timing.ts';
import { parseFootageClip, type FootageClip } from '../footage/spec.ts';
import { THEME_IDS } from '../themes/ids.ts';
import { enforceBrand, loadRuntimeBrand, type BrandConfig } from '../themes/brand.ts';
import { Ajv } from 'ajv';
import { COMPOSITION_SCHEMA, type Composition } from './motion.ts';
import { graphicIssues } from './graphic.ts';
const validateComposition = new Ajv({ allErrors: true }).compile(COMPOSITION_SCHEMA);
/**
 * 确定性自动修复（需求 §13、§42）。
 *
 * 核心主张：**语法问题不该再问一次模型。**
 * 弱模型输出里的「枚举写错、数字越界、字段缺失、拼错字段名」全部由引擎确定性修复，
 * 只有「可能改变剧情语义」的问题才停下来报给人或模型。
 *
 * 三级分类：
 *   SAFE_REPAIR —— 机械修复，不改变剧情语义（回退枚举、钳制数值、剥离未知字段）
 *   WARNING     —— 已修复但语义可能受影响，或无法修复只能降级（人物引用失效、镜头重叠）
 *   FATAL       —— 拒绝渲染（修复后没有任何可渲染的场景）
 *
 * 设计约束：**修复结果必须能通过 schema 校验**。
 * 这不是口号——validate.ts 会把修复后的 spec 再喂给 ajv 复核，
 * 不通过就说明修复层本身有漏洞，直接判 FATAL。
 */

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import {
  ACTIONS,
  BGM_KEYS,
  BGM_PRESETS,
  CAMERAS,
  CAMERA_MOVES,
  CAPTION_MODES,
  CAPTION_STYLES,
  CAPTION_LAYOUT_DEFAULTS,
  CHARACTER_PRESETS,
  CLOTHING,
  DEFAULT_CHARACTER,
  EMOTIONS,
  ENVIRONMENTS,
  HAIR_STYLES,
  LINE_STYLES,
  PALETTES,
  PAPER_KINDS,
  SFX_PRESETS,
  SPEC_DEFAULTS,
  STYLE_PRESETS,
  TRANSITIONS,
  TTS_VOICES,
  type BgmSettings,
  type CaptionSettings,
  type CaptionLayoutSettings,
  type CharacterDefinition,
  type NarrationLine,
  type ResolvedScene,
  type ResolvedVideoSpec,
  type SfxCue,
  type VideoSpec,
  IP_DEFAULT_SIZE, IP_POSITIONS, IP_SOURCE_SIZE, type IPPlacement,
} from './types.ts';
import { CAPTION_LAYOUT_SCHEMA, DIMENSION_MIN, DIMENSION_MAX, NARRATION_MAX_CHARS, NARRATION_RATE_SCHEMA, TRANSLATION_MAX_CHARS, SUPPORTED_FPS } from './schema.ts';

export type Severity = 'SAFE_REPAIR' | 'WARNING' | 'FATAL';

export interface Issue {
  readonly severity: Severity;
  /** 机器可读的问题码，便于弱模型按类修复 */
  readonly code: string;
  /** 出错位置，例如 "scenes[0].camera" */
  readonly path: string;
  readonly message: string;
  readonly allowed?: readonly string[];
  readonly from?: unknown;
  readonly to?: unknown;
  readonly hint?: string;
}

export interface RepairResult {
  readonly spec: ResolvedVideoSpec;
  readonly issues: Issue[];
}

/** 单场景最短时长（秒）。end == start 时用它兜底 */
const MIN_SCENE_SECONDS = 0.5;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

class Repairer {
  readonly issues: Issue[] = [];

  add(issue: Issue): void {
    this.issues.push(issue);
  }

  /** 剥离不在白名单内的键，逐个记为 SAFE_REPAIR */
  stripUnknown(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const from = obj[key];
      delete obj[key];
      this.add({
        severity: 'SAFE_REPAIR',
        code: 'UNKNOWN_FIELD',
        path: path ? `${path}.${key}` : key,
        message: `未知字段，已忽略`,
        from,
        hint: `允许的字段: ${allowed.join(' | ')}`,
      });
    }
  }

  /** 枚举取值：非法则回退默认值，并附上允许值 */
  enumValue<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
    path: string,
  ): T {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    if (value !== undefined) {
      this.add({
        severity: 'SAFE_REPAIR',
        code: 'INVALID_ENUM',
        path,
        message: `取值不受支持，已回退为 ${fallback}`,
        allowed: allowed as readonly string[],
        from: value,
        to: fallback,
      });
    }
    return fallback;
  }

  /** 有界数值：缺失用默认值，非数字或越界则钳制 */
  numberValue(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
    path: string,
    options: { integer?: boolean } = {},
  ): number {
    if (value === undefined) return fallback;
    if (!isFiniteNumber(value)) {
      this.add({
        severity: 'SAFE_REPAIR',
        code: 'NOT_A_NUMBER',
        path,
        message: `不是有效数字，已回退为 ${fallback}`,
        from: value,
        to: fallback,
      });
      return fallback;
    }
    let v = options.integer ? Math.round(value) : value;
    if (v < min) {
      this.add({ severity: 'SAFE_REPAIR', code: 'VALUE_CLAMPED', path, message: `小于下限，已提升为 ${min}`, from: v, to: min });
      v = min;
    } else if (v > max) {
      this.add({ severity: 'SAFE_REPAIR', code: 'VALUE_CLAMPED', path, message: `超过上限，已压低为 ${max}`, from: v, to: max });
      v = max;
    }
    return v;
  }

  boolValue(value: unknown, fallback: boolean, path: string): boolean {
    if (typeof value === 'boolean') return value;
    if (value !== undefined) {
      this.add({
        severity: 'SAFE_REPAIR',
        code: 'NOT_A_BOOLEAN',
        path,
        message: `不是布尔值，已回退为 ${fallback}`,
        from: value,
        to: fallback,
      });
    }
    return fallback;
  }

  fatal(code: string, path: string, message: string, hint?: string): void {
    this.add({ severity: 'FATAL', code, path, message, ...(hint ? { hint } : {}) });
  }

  warn(issue: Omit<Issue, 'severity'>): void {
    this.add({ ...issue, severity: 'WARNING' });
  }
}

/** 修复入口。输入是任意 JSON 值（不信任其形状）。 */
export interface RepairOptions { readonly brand?: BrandConfig }

export function repairSpec(input: unknown, options: RepairOptions = {}): RepairResult {
  const r = new Repairer();

  if (!isPlainObject(input)) {
    r.fatal('SPEC_NOT_OBJECT', '', 'VideoSpec 必须是一个 JSON 对象');
    throw fatalFrom(r);
  }

  r.stripUnknown(input, ['version', 'video', 'style', 'characters', 'scenes', 'audio', 'captions'], '');

  const version = typeof input['version'] === 'string' ? (input['version'] as string) : SPEC_DEFAULTS.version;
  const video = repairVideo(input['video'], r);
  const repairedStyle = repairStyle(input['style'], r);
  const rawStyle = input['style'];
  const requestedTheme = typeof rawStyle === 'string' ? rawStyle
    : isPlainObject(rawStyle) && typeof rawStyle['theme'] === 'string' ? (rawStyle['theme'] as string) : undefined;
  const brand = options.brand ?? loadRuntimeBrand();
  const decision = brand ? enforceBrand(requestedTheme, brand) : { theme: repairedStyle.theme, violation: null };
  if (decision.violation?.action === 'reject') {
    r.fatal('BRAND_THEME_LOCKED', 'style.theme', `本片固定主题为 ${decision.theme}，请求值为 ${decision.violation.requested}；请让 style.theme 与本片 brand.json 一致。更换本片主题须先明确迁移范围与验证方案，并保留原版本；账号默认仅影响之后的新片。`);
  } else if (decision.violation) {
    r.add({ severity: 'WARNING', code: 'BRAND_THEME_LOCKED', path: 'style.theme', message: `本片风格为 ${decision.theme}，已覆盖本片请求的 ${decision.violation.requested}`, from: decision.violation.requested, to: decision.theme });
  }
  const style = { ...repairedStyle, theme: decision.theme };
  const characters = repairCharacters(input['characters'], r);
  const scenes = repairScenes(input['scenes'], characters, video, r);
  const captions = repairCaptions(input['captions'], r);
  const audio = repairAudio(input['audio'], video, scenes, r);

  const spec: ResolvedVideoSpec = { version, video, style, characters, scenes, audio, captions };

  if (r.issues.some((i) => i.severity === 'FATAL')) throw fatalFrom(r);
  return { spec, issues: r.issues };
}

function fatalFrom(r: Repairer): EngineError {
  const fatal = r.issues.filter((i) => i.severity === 'FATAL');
  const first = fatal[0];
  return new EngineError(ERROR_CODES.SPEC_INVALID, first?.message ?? 'VideoSpec 无法修复', {
    details: {
      path: first?.path ?? '',
      code: first?.code ?? 'SPEC_INVALID',
      // 附带全部问题，便于弱模型一次改完
      issues: r.issues.map(serializeIssue),
    },
    ...(first?.hint ? { hint: first.hint } : {}),
  });
}

function serializeIssue(i: Issue): Record<string, unknown> {
  return {
    severity: i.severity,
    code: i.code,
    path: i.path,
    message: i.message,
    ...(i.allowed ? { allowed: i.allowed } : {}),
    ...(i.from !== undefined ? { from: i.from } : {}),
    ...(i.to !== undefined ? { to: i.to } : {}),
  };
}

// ---------------------------------------------------------------- video

function repairVideo(raw: unknown, r: Repairer): VideoSpec['video'] {
  const d = SPEC_DEFAULTS.video;
  if (raw !== undefined && !isPlainObject(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path: 'video', message: '应为对象，已使用默认值', from: raw });
  }
  const o = isPlainObject(raw) ? raw : {};
  r.stripUnknown(o, ['width', 'height', 'fps', 'duration', 'seed'], 'video');

  let width = r.numberValue(o['width'], DIMENSION_MIN, DIMENSION_MAX, d.width, 'video.width', { integer: true });
  let height = r.numberValue(o['height'], DIMENSION_MIN, DIMENSION_MAX, d.height, 'video.height', { integer: true });

  // yuv420p 要求宽高为偶数。机械修正，不改剧情语义。
  for (const [key, value, set] of [
    ['video.width', width, (v: number) => { width = v; }],
    ['video.height', height, (v: number) => { height = v; }],
  ] as const) {
    if (value % 2 !== 0) {
      const fixed = value + 1;
      r.add({
        severity: 'SAFE_REPAIR',
        code: 'ODD_DIMENSION',
        path: key,
        message: `${value} 不是偶数，yuv420p 需要偶数尺寸，已调整为 ${fixed}`,
        from: value,
        to: fixed,
      });
      set(fixed);
    }
  }

  const fps = repairFps(o['fps'], r);
  const duration = r.numberValue(o['duration'], 0.1, 600, d.duration, 'video.duration');
  const seed = r.numberValue(o['seed'], 0, 4294967295, d.seed, 'video.seed', { integer: true });

  return { width, height, fps, duration, seed };
}

function repairFps(raw: unknown, r: Repairer): number {
  const d = SPEC_DEFAULTS.video.fps;
  if (raw === undefined) return d;
  if (typeof raw === 'number' && (SUPPORTED_FPS as readonly number[]).includes(raw)) return raw;
  r.add({
    severity: 'SAFE_REPAIR',
    code: 'UNSUPPORTED_FPS',
    path: 'video.fps',
    message: `不支持的帧率，已回退为 ${d}`,
    allowed: SUPPORTED_FPS.map(String),
    from: raw,
    to: d,
  });
  return d;
}

// ---------------------------------------------------------------- headline

/** 相机路径 / 焦点 / 素材片段 / 文字停留时长。纯结构校验，素材文件存在性在渲染器创建时检查。 */
function repairShotMotion(item: Record<string, unknown>, path: string, r: Repairer, duration: number): { cameraPath?: CameraPath; focus?: FocusRect; footage?: FootageClip } {
  const out: { cameraPath?: CameraPath; focus?: FocusRect; footage?: FootageClip } = {};
  const cam = parseCameraPath(item['cameraPath'], `${path}.cameraPath`, duration);
  for (const i of cam.issues) i.fatal ? r.fatal(i.code, i.path, i.message) : r.warn({ code: i.code, path: i.path, message: i.message });
  if (cam.value) out.cameraPath = cam.value;
  const focus = parseFocus(item['focus']);
  if (typeof focus === 'string') r.fatal('FOCUS_INVALID', `${path}.focus`, focus); else if (focus) out.focus = focus;
  if (item['footage'] !== undefined) {
    const clip = parseFootageClip(item['footage'], `${path}.footage`);
    for (const i of clip.issues) r.fatal(i.code, i.path, i.message);
    if (clip.value) out.footage = clip.value;
  }
  if (item['environment'] === 'footage' && item['footage'] === undefined) r.fatal('FOOTAGE_REQUIRED', `${path}.footage`, 'environment=footage 需要 footage: { src }');
  const headline = Array.isArray(item['headline']) ? item['headline'].filter((x): x is string => typeof x === 'string') : typeof item['headline'] === 'string' ? [item['headline']] : [];
  if (headline.length) {
    const need = minShotSeconds(typeof item['kicker'] === 'string' ? [item['kicker'], ...headline] : headline, { max: Infinity });
    if (duration + 1e-6 < need) r.warn({ code: 'SHOT_TOO_SHORT_FOR_TEXT', path: `${path}.end`, message: `本屏文字约需 ${need.toFixed(1)}s 才能读完，镜头只有 ${duration.toFixed(1)}s`, hint: '延长镜头、删字，或拆成两屏（motion/shot-timing.ts planShotTimings）' });
  }
  return out;
}

function repairHeadline(item: Record<string, unknown>, path: string, r: Repairer, outputWidth = 1080, outputHeight = 1920): { headline?: string[]; kicker?: string; ip?: IPPlacement; ipExpression?: string } {
  const out: { headline?: string[]; kicker?: string; ip?: IPPlacement; ipExpression?: string } = {};
  const raw = item['headline'];
  if (raw !== undefined) {
    const list = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 40));
    if (list.length > 3) r.add({ severity: 'WARNING', code: 'HEADLINE_TOO_LONG', path: `${path}.headline`, message: '每屏最多 3 行，已截断', from: raw });
    if (list.length) out.headline = list.slice(0, 3);
  }
  if (typeof item['kicker'] === 'string' && item['kicker'].trim()) out.kicker = item['kicker'].trim().slice(0, 40);
  const ip = item['ip'];
  if (ip === true) {
    // 旧写法 ip: true：不再默认放大出镜，改为小尺寸身份署名，并提示补充 role
    out.ip = { role: 'identity', size: IP_DEFAULT_SIZE.identity, position: 'bottom-center' };
    r.add({ severity: 'WARNING', code: 'IP_ROLE_REQUIRED', path: `${path}.ip`, message: 'ip 需写成 { role: "identity"|"actor", size?, position? }；已按身份署名（288px）处理', from: true });
  } else if (isPlainObject(ip)) {
    const role = ip['role'];
    if (role !== 'identity' && role !== 'actor') r.fatal('IP_ROLE_INVALID', `${path}.ip.role`, 'ip.role 须为 identity 或 actor');
    else {
      const ref = outputHeight >= outputWidth ? 1080 : 1920;
      const size = typeof ip['size'] === 'number' ? ip['size'] : IP_DEFAULT_SIZE[role];
      const effective = size * outputWidth / ref;
      if (!(size >= 64)) r.fatal('IP_SIZE_INVALID', `${path}.ip.size`, 'ip.size 须 ≥ 64');
      else if (effective > IP_SOURCE_SIZE + 1e-6) {
        r.fatal('IP_UPSCALE', `${path}.ip.size`, `IP 实际显示 ${Math.round(effective)}px 超过源素材 ${IP_SOURCE_SIZE}px：IP 是小幅美术，不允许放大（建议 256–384）`);
      } else {
        const position = (IP_POSITIONS as readonly unknown[]).includes(ip['position']) ? ip['position'] as IPPlacement['position'] : 'bottom-center';
        const placement: IPPlacement = { role, size, position };
        if (position === 'custom') {
          const x = Number(ip['x']), y = Number(ip['y']);
          if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) r.fatal('IP_POSITION_INVALID', `${path}.ip`, 'position=custom 需要 0–1 的 x、y');
          placement.x = x; placement.y = y;
        }
        const ex = ip['expression'];
        if (typeof ex === 'string' && /^[a-z0-9_-]{1,24}$/.test(ex)) placement.expression = ex;
        out.ip = placement;
      }
    }
  } else if (ip !== undefined && ip !== false) {
    r.add({ severity: 'SAFE_REPAIR', code: 'IP_IGNORED', path: `${path}.ip`, message: '无法识别的 ip，已忽略（默认不出现 IP）', from: ip });
  }
  if (typeof item['ipExpression'] === 'string' && /^[a-z0-9_-]{1,24}$/.test(item['ipExpression'])) out.ipExpression = item['ipExpression'];
  return out;
}

// ---------------------------------------------------------------- style

function repairStyle(raw: unknown, r: Repairer): VideoSpec['style'] {
  const d = SPEC_DEFAULTS.style;
  // 简写：style: "minimal" 等价于 { theme: "minimal" }
  if (typeof raw === 'string' && (THEME_IDS as readonly string[]).includes(raw)) raw = { theme: raw };
  if (raw !== undefined && !isPlainObject(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path: 'style', message: '应为对象，已使用默认值', from: raw });
  }
  const o = isPlainObject(raw) ? raw : {};
  r.stripUnknown(o, ['theme', 'preset', 'palette', 'paper', 'line'], 'style');

  // 缺整个 style 不记为问题——它本来就有默认值（§11：残缺也要能出片）
  return {
    theme: r.enumValue(o['theme'], THEME_IDS, d.theme, 'style.theme'),
    preset: r.enumValue(o['preset'], STYLE_PRESETS, d.preset, 'style.preset'),
    palette: r.enumValue(o['palette'], PALETTES, d.palette, 'style.palette'),
    paper: r.enumValue(o['paper'], PAPER_KINDS, d.paper, 'style.paper'),
    line: r.enumValue(o['line'], LINE_STYLES, d.line, 'style.line'),
  };
}

// ----------------------------------------------------------- characters

function repairCharacters(raw: unknown, r: Repairer): CharacterDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_ARRAY', path: 'characters', message: '应为数组，已忽略', from: raw });
    return [];
  }

  const out: CharacterDefinition[] = [];
  const seen = new Set<string>();

  raw.forEach((item, i) => {
    const path = `characters[${i}]`;
    if (!isPlainObject(item)) {
      r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path, message: '元素应为对象，已丢弃', from: item });
      return;
    }
    r.stripUnknown(item, ['id', 'preset', 'hair', 'clothing', 'x', 'y'], path);

    const rawId = item['id'];
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `char_${i}`;
    if (typeof rawId !== 'string' || rawId.length === 0) {
      r.add({ severity: 'SAFE_REPAIR', code: 'MISSING_ID', path: `${path}.id`, message: `缺少 id，已生成 ${id}`, to: id });
    }
    if (seen.has(id)) {
      r.warn({
        code: 'DUPLICATE_CHARACTER_ID',
        path: `${path}.id`,
        message: `人物 id 重复 (${id})，已丢弃后出现的定义`,
        from: id,
        hint: '每个人物应有唯一 id，场景通过 id 引用它',
      });
      return;
    }
    seen.add(id);

    const def: CharacterDefinition = {
      id,
      preset: r.enumValue(item['preset'], CHARACTER_PRESETS, DEFAULT_CHARACTER.preset, `${path}.preset`),
      hair: r.enumValue(item['hair'], HAIR_STYLES, DEFAULT_CHARACTER.hair, `${path}.hair`),
      clothing: r.enumValue(item['clothing'], CLOTHING, DEFAULT_CHARACTER.clothing, `${path}.clothing`),
    };
    if (item['x'] !== undefined) def.x = r.numberValue(item['x'], 0, 1, 0.5, `${path}.x`);
    if (item['y'] !== undefined) def.y = r.numberValue(item['y'], 0, 1, 0.7, `${path}.y`);
    out.push(def);
  });

  return out;
}

// ---------------------------------------------------------------- scenes

function repairScenes(
  raw: unknown,
  characters: CharacterDefinition[],
  video: VideoSpec['video'],
  r: Repairer,
): ResolvedScene[] {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    r.fatal(
      'NO_SCENES',
      'scenes',
      '没有任何场景，无法渲染',
      '至少提供一个场景，例如 { "id":"s1","start":0,"end":8,"environment":"rain_window" }',
    );
    return [];
  }
  if (!Array.isArray(raw)) {
    r.fatal('SCENES_NOT_ARRAY', 'scenes', 'scenes 必须是数组');
    return [];
  }

  const knownIds = new Set(characters.map((c) => c.id));
  const out: ResolvedScene[] = [];

  raw.forEach((item, i) => {
    const path = `scenes[${i}]`;
    if (!isPlainObject(item)) {
      r.warn({ code: 'NOT_AN_OBJECT', path, message: '场景元素应为对象，已丢弃', from: item });
      return;
    }
    r.stripUnknown(
      item,
      ['id', 'start', 'end', 'environment', 'camera', 'cameraMove', 'transition', 'character', 'action', 'emotion', 'composition', 'headline', 'kicker', 'ip', 'ipExpression', 'cameraPath', 'focus', 'footage'],
      path,
    );

    const rawId = item['id'];
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `scene_${i}`;
    if (typeof rawId !== 'string' || rawId.length === 0) {
      r.add({ severity: 'SAFE_REPAIR', code: 'MISSING_ID', path: `${path}.id`, message: `缺少 id，已生成 ${id}`, to: id });
    }

    let start = r.numberValue(item['start'], 0, 600, 0, `${path}.start`);
    let end = r.numberValue(item['end'], 0, 600, start + MIN_SCENE_SECONDS, `${path}.end`);

    if (end < start) {
      // 作者意图几乎肯定是「起止写反了」——交换可保留原意时长，比猜测新时长更忠实
      const [a, b] = [end, start];
      start = a;
      end = b;
      r.add({
        severity: 'SAFE_REPAIR',
        code: 'SCENE_REVERSED',
        path: `${path}`,
        message: `end 早于 start，已交换（保留原时长）`,
        from: { start: b, end: a },
        to: { start: a, end: b },
      });
    } else if (end === start) {
      const fixed = Math.min(video.duration, start + MIN_SCENE_SECONDS);
      r.warn({
        code: 'SCENE_ZERO_LENGTH',
        path: `${path}`,
        message: `场景时长为 0，已扩展到 ${MIN_SCENE_SECONDS}s（时长是语义决定，请确认）`,
        from: 0,
        to: fixed - start,
      });
      end = fixed;
    }

    // 越界钳制
    if (start >= video.duration) {
      r.warn({
        code: 'SCENE_OUT_OF_RANGE',
        path: `${path}`,
        message: `场景起点 ${start}s 超出视频时长 ${video.duration}s，已丢弃该场景`,
        from: start,
        hint: '确认 start/end 与 video.duration 的关系',
      });
      return;
    }
    if (end > video.duration) {
      r.add({
        severity: 'SAFE_REPAIR',
        code: 'SCENE_CLAMPED',
        path: `${path}.end`,
        message: `超出视频时长，已截断到 ${video.duration}s`,
        from: end,
        to: video.duration,
      });
      end = video.duration;
    }

    // 人物引用
    let character: string | undefined;
    const rawChar = item['character'];
    if (rawChar !== undefined) {
      if (typeof rawChar === 'string' && knownIds.has(rawChar)) {
        character = rawChar;
      } else {
        // 不能静默换人：凭空造一个人物会改变剧情。丢掉引用并明确告警。
        r.warn({
          code: 'UNKNOWN_CHARACTER',
          path: `${path}.character`,
          message: `引用了不存在的人物 "${String(rawChar)}"，该场景将不出现人物`,
          allowed: characters.length ? characters.map((c) => c.id) : ['(未定义任何人物)'],
          from: rawChar,
          hint: '在 characters 中定义该 id，或改用已有 id',
        });
        character = undefined;
      }
    }

    let composition: Composition | undefined;
    if (item['composition'] !== undefined) {
      if (!validateComposition(item['composition'])) {
        r.fatal('COMPOSITION_INVALID', `${path}.composition`, JSON.stringify(validateComposition.errors), '按 capabilities 的 composition schema 修正；视觉意图需要显式修正');
      } else {
        composition = item['composition'] as Composition;
        for (const message of graphicIssues(composition.elements ?? [])) r.fatal('GRAPHIC_INVALID', `${path}.composition.elements`, message);
      }
    }
    if (composition && item['environment'] !== 'motion_stage') {
      r.fatal('COMPOSITION_ENVIRONMENT', `${path}.environment`, 'composition 仅由 motion_stage 环境绘制');
    }
    if (item['environment'] === 'motion_stage' && !composition) {
      r.fatal('COMPOSITION_REQUIRED', `${path}.composition`, 'motion_stage 需要 composition');
    }
    out.push({
      ...(composition ? { composition } : {}),
      id,
      start,
      end,
      environment: r.enumValue(item['environment'], ENVIRONMENTS, 'rain_window', `${path}.environment`),
      camera: r.enumValue(item['camera'], CAMERAS, SPEC_DEFAULTS.scene.camera, `${path}.camera`),
      cameraMove: r.enumValue(item['cameraMove'], CAMERA_MOVES, SPEC_DEFAULTS.scene.cameraMove, `${path}.cameraMove`),
      transition: r.enumValue(item['transition'], TRANSITIONS, SPEC_DEFAULTS.scene.transition, `${path}.transition`),
      action: r.enumValue(item['action'], ACTIONS, SPEC_DEFAULTS.scene.action, `${path}.action`),
      emotion: r.enumValue(item['emotion'], EMOTIONS, SPEC_DEFAULTS.scene.emotion, `${path}.emotion`),
      character,
      ...repairHeadline(item, path, r, video.width, video.height),
      ...repairShotMotion(item, path, r, end - start),
    });
  });

  if (out.length === 0) {
    r.fatal('NO_RENDERABLE_SCENES', 'scenes', '所有场景都不可渲染（越界或格式错误）');
    return [];
  }

  out.sort((a, b) => a.start - b.start);

  // 重叠：可能是刻意的（转场），但 M0 的渲染语义是「后开始的场景胜出」，
  // 需要让作者知道这一点，否则会以为画面是叠加的
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as ResolvedScene;
    const cur = out[i] as ResolvedScene;
    if (cur.start < prev.end) {
      r.warn({
        code: 'SCENES_OVERLAP',
        path: `scenes[${i}]`,
        message: `与前一场景重叠 ${(prev.end - cur.start).toFixed(2)}s；渲染时后开始的场景优先，前一个会被截断`,
        from: prev.end,
        to: cur.start,
      });
    }
  }

  // 空隙：会只显示背景，通常不是本意
  const first = out[0] as ResolvedScene;
  if (first.start > 0.001) {
    r.warn({
      code: 'TIMELINE_GAP',
      path: 'scenes',
      message: `视频开头有 ${first.start.toFixed(2)}s 没有任何场景`,
    });
  }
  const last = out[out.length - 1] as ResolvedScene;
  if (video.duration - last.end > 0.001) {
    r.warn({
      code: 'TIMELINE_GAP',
      path: 'scenes',
      message: `视频结尾有 ${(video.duration - last.end).toFixed(2)}s 没有任何场景`,
    });
  }

  return out;
}

// ------------------------------------------------------------- captions

function repairCaptions(raw: unknown, r: Repairer): CaptionSettings {
  const d = SPEC_DEFAULTS.captions;
  if (raw !== undefined && !isPlainObject(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path: 'captions', message: '应为对象，已使用默认值', from: raw });
  }
  const o = isPlainObject(raw) ? raw : {};
  const layout: CaptionLayoutSettings = {};
  const fields = Object.keys(CAPTION_LAYOUT_SCHEMA) as Array<keyof CaptionLayoutSettings>;
  r.stripUnknown(o, ['enabled', 'style', 'mode', ...fields], 'captions');
  for (const field of fields) {
    if (o[field] === undefined) continue;
    const range = CAPTION_LAYOUT_SCHEMA[field];
    layout[field] = r.numberValue(o[field], range.minimum, range.maximum, CAPTION_LAYOUT_DEFAULTS[field], `captions.${field}`);
  }
  return {
    enabled: r.boolValue(o['enabled'], d.enabled, 'captions.enabled'),
    style: r.enumValue(o['style'], CAPTION_STYLES, d.style, 'captions.style'),
    mode: r.enumValue(o['mode'], CAPTION_MODES, d.mode, 'captions.mode'),
    ...layout,
  };
}

// ---------------------------------------------------------------- audio

function repairAudio(
  raw: unknown,
  video: VideoSpec['video'],
  scenes: ResolvedScene[],
  r: Repairer,
): ResolvedVideoSpec['audio'] {
  const d = SPEC_DEFAULTS.bgm;
  if (raw !== undefined && !isPlainObject(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path: 'audio', message: '应为对象，已使用默认值', from: raw });
  }
  const o = isPlainObject(raw) ? raw : {};
  r.stripUnknown(o, ['narration', 'bgm', 'sfx', 'loudness'], 'audio');

  return {
    narration: repairNarration(o['narration'], video, r),
    bgm: repairBgm(o['bgm'], r),
    sfx: repairSfx(o['sfx'], video, r),
    loudness: r.numberValue(o['loudness'], -30, -6, SPEC_DEFAULTS.loudness, 'audio.loudness'),
  };
}

function repairNarration(raw: unknown, video: VideoSpec['video'], r: Repairer): NarrationLine[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_ARRAY', path: 'audio.narration', message: '应为数组，已忽略', from: raw });
    return [];
  }

  const out: NarrationLine[] = [];
  raw.forEach((item, i) => {
    const path = `audio.narration[${i}]`;
    if (!isPlainObject(item)) {
      r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path, message: '元素应为对象，已丢弃', from: item });
      return;
    }
    r.stripUnknown(item, ['start', 'voice', 'text', 'translation', 'rate'], path);

    const rawText = item['text'];
    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
      r.warn({ code: 'EMPTY_NARRATION', path: `${path}.text`, message: '旁白文本为空，已丢弃该条', from: rawText });
      return;
    }
    const text = rawText.trim();

    // 超长不致命：字幕引擎会换行。但一行塞太多字在竖屏安全区里观感很差。
    if (text.length > NARRATION_MAX_CHARS) {
      r.warn({
        code: 'NARRATION_TOO_LONG',
        path: `${path}.text`,
        message: `旁白 ${text.length} 字，超过建议上限 ${NARRATION_MAX_CHARS} 字；字幕会自动换行但可能占满画面`,
        from: text.length,
        to: NARRATION_MAX_CHARS,
        hint: `建议拆分：一条旁白控制在 ${NARRATION_MAX_CHARS} 字以内，长内容拆成多条`,
      });
    }

    let start = r.numberValue(item['start'], 0, video.duration, 0, `${path}.start`);
    if (start >= video.duration) {
      r.warn({
        code: 'NARRATION_OUT_OF_RANGE',
        path: `${path}.start`,
        message: `起始时间 ${start}s 超出视频时长，已丢弃该条`,
        from: start,
      });
      return;
    }
    if (start < 0) start = 0;

    out.push({
      start,
      voice: r.enumValue(item['voice'], TTS_VOICES, 'female_calm', `${path}.voice`),
      text,
      ...(item['rate'] === undefined ? {} : { rate: r.numberValue(item['rate'], NARRATION_RATE_SCHEMA.minimum, NARRATION_RATE_SCHEMA.maximum, SPEC_DEFAULTS.narrationRate, `${path}.rate`, { integer: true }) }),
      ...repairTranslation(item['translation'], `${path}.translation`, r),
    });
  });

  return out;
}

/**
 * 第二语言字幕行。
 *
 * 比正文宽松：它不是朗读文本，长一点只影响版面，不影响 TTS。
 * 但空串或非字符串仍然当作「没有」，避免渲染层拿到空行后多留一段空白。
 */
function repairTranslation(raw: unknown, path: string, r: Repairer): { translation?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    r.warn({ code: 'EMPTY_TRANSLATION', path, message: '双语字幕的第二行不是有效文本，已忽略', from: raw });
    return {};
  }
  const translation = raw.trim();
  if (translation.length > TRANSLATION_MAX_CHARS) {
    r.warn({
      code: 'TRANSLATION_TOO_LONG',
      path,
      message: `双语字幕第二行 ${translation.length} 字符，超过上限 ${TRANSLATION_MAX_CHARS}；会影响版面可读性`,
      from: translation.length,
      to: TRANSLATION_MAX_CHARS,
    });
  }
  return { translation };
}

function repairBgm(raw: unknown, r: Repairer): BgmSettings {
  const d = SPEC_DEFAULTS.bgm;
  if (raw !== undefined && !isPlainObject(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path: 'audio.bgm', message: '应为对象，已使用默认值', from: raw });
  }
  const o = isPlainObject(raw) ? raw : {};
  r.stripUnknown(o, ['preset', 'key', 'volume', 'fadeIn', 'fadeOut', 'duckUnderNarration', 'bpm'], 'audio.bgm');

  return {
    ...(o['bpm'] !== undefined ? { bpm: r.numberValue(o['bpm'], 40, 200, 96, 'audio.bgm.bpm') } : {}),
    preset: r.enumValue(o['preset'], BGM_PRESETS, d.preset, 'audio.bgm.preset'),
    key: r.enumValue(o['key'], BGM_KEYS, d.key, 'audio.bgm.key'),
    volume: r.numberValue(o['volume'], 0, 1, d.volume, 'audio.bgm.volume'),
    fadeIn: r.numberValue(o['fadeIn'], 0, 30, d.fadeIn, 'audio.bgm.fadeIn'),
    fadeOut: r.numberValue(o['fadeOut'], 0, 30, d.fadeOut, 'audio.bgm.fadeOut'),
    duckUnderNarration: r.boolValue(o['duckUnderNarration'], d.duckUnderNarration, 'audio.bgm.duckUnderNarration'),
  };
}

function repairSfx(raw: unknown, video: VideoSpec['video'], r: Repairer): SfxCue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_ARRAY', path: 'audio.sfx', message: '应为数组，已忽略', from: raw });
    return [];
  }
  const out: SfxCue[] = [];
  raw.forEach((item, i) => {
    const path = `audio.sfx[${i}]`;
    if (!isPlainObject(item)) {
      r.add({ severity: 'SAFE_REPAIR', code: 'NOT_AN_OBJECT', path, message: '元素应为对象，已丢弃', from: item });
      return;
    }
    r.stripUnknown(item, ['start', 'preset', 'volume'], path);

    const start = r.numberValue(item['start'], 0, video.duration, 0, `${path}.start`);
    if (start >= video.duration) {
      r.warn({ code: 'SFX_OUT_OF_RANGE', path: `${path}.start`, message: `起始时间超出视频时长，已丢弃`, from: start });
      return;
    }
    out.push({
      start,
      preset: r.enumValue(item['preset'], SFX_PRESETS, 'soft_rain', `${path}.preset`),
      volume: r.numberValue(item['volume'], 0, 1, 0.3, `${path}.volume`),
    });
  });
  return out;
}

/** 供测试与外部工具使用：把 spec 的枚举词汇表整体导出 */
export const SPEC_VOCABULARY = {
  camera: CAMERAS,
  environment: ENVIRONMENTS,
  cameraMove: CAMERA_MOVES,
  transition: TRANSITIONS,
  action: ACTIONS,
  emotion: EMOTIONS,
  stylePreset: STYLE_PRESETS,
  palette: PALETTES,
  paper: PAPER_KINDS,
  line: LINE_STYLES,
  characterPreset: CHARACTER_PRESETS,
  hair: HAIR_STYLES,
  clothing: CLOTHING,
  ttsVoice: TTS_VOICES,
  bgmPreset: BGM_PRESETS,
  bgmKey: BGM_KEYS,
  sfxPreset: SFX_PRESETS,
  captionStyle: CAPTION_STYLES,
  captionMode: CAPTION_MODES,
  fps: SUPPORTED_FPS,
} as const;
