/** DirectorPlan is the model-facing contract. Compilation owns timing and technical defaults. */
import { Ajv } from 'ajv';
import { COMPOSITION_SCHEMA, type Composition } from '../spec/motion.ts';
import { BGM_PRESETS, CAMERA_MOVES, SFX_PRESETS, TRANSITIONS, TTS_VOICES, type BgmPreset, type CameraMove, type CaptionLayoutSettings, type NarrationLine, type SfxCue, type SfxPreset, type Transition, type TtsVoice, type ResolvedVideoSpec } from '../spec/types.ts';
import { hashString } from '../animation/random.ts';
import { CAPTION_LAYOUT_SCHEMA, NARRATION_RATE_SCHEMA, SUPPORTED_FPS } from '../spec/schema.ts';
import { validateSpec } from '../spec/validate.ts';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { graphicIssues } from '../spec/graphic.ts';

export interface DirectorPlan {
  version: '0.1';
  idea: string;
  title: string;
  aspect: '16:9' | '9:16' | '1:1';
  look: 'storybook' | 'graphic';
  bpm: number;
  /**
   * 程序化 BGM 的情绪预设。省略时为 playful（旧计划的既有行为，保持编译结果不变）。
   * 纪录片、讲解片用 curious / tender / warm_uplift 比 playful 更贴合语气。
   */
  bgmPreset?: BgmPreset;
  /**
   * 帧率。省略时为 24（旧计划的既有行为，保持编译结果不变）。
   * 取值限 SUPPORTED_FPS；拍位置按累计拍数取整到帧，避免逐镜头累积漂移。
   */
  fps?: number;
  captionLayout?: CaptionLayoutSettings;
  voice?: TtsVoice;
  narrationRate?: number;
  shots: Array<{
    purpose: string;
    beats: number;
    title: string;
    subtitle?: string;
    backdrop: Composition['backdrop'];
    motif: Composition['motif'];
    actors: Composition['actors'];
    elements?: Composition['elements'];
    visualIntent?: string;
    cameraMove?: CameraMove;
    transition?: Transition;
    narration?: string;
    /** 旁白相对本镜头起点的秒数，省略时为 0.2。 */
    narrationOffset?: number;
    /** 本镜头的事件音效；空数组表示安静，省略沿用切镜 whoosh。 */
    sfx?: Array<{ offset: number; preset: SfxPreset; volume?: number }>;
    /**
     * 双语字幕的第二行（通常是英文译文）。
     *
     * 有意与 `narration` 分开：TTS 只念 `narration`，译文只上屏。
     * 引擎不接受「让 TTS 念两遍」——那会变成两倍的配音时长。
     */
    narrationTranslation?: string;
  }>;
}
const { bpm: _bpm, ...shotVisuals } = COMPOSITION_SCHEMA.properties;
export const DIRECTOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'idea', 'title', 'aspect', 'look', 'bpm', 'shots'],
  properties: {
    version: { const: '0.1' }, idea: { type: 'string', minLength: 1, maxLength: 5000 },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    aspect: { enum: ['16:9', '9:16', '1:1'] }, look: { enum: ['storybook', 'graphic'] },
    bpm: COMPOSITION_SCHEMA.properties.bpm,
    bgmPreset: { enum: [...BGM_PRESETS] },
    fps: { enum: [...SUPPORTED_FPS] },
    captionLayout: { type: 'object', additionalProperties: false, properties: CAPTION_LAYOUT_SCHEMA },
    voice: { enum: [...TTS_VOICES] },
    narrationRate: NARRATION_RATE_SCHEMA,
    shots: { type: 'array', minItems: 1, maxItems: 120, items: {
      type: 'object', additionalProperties: false,
      required: ['purpose', 'beats', 'title', 'backdrop', 'motif', 'actors'],
      properties: {
        ...shotVisuals,
        purpose: { type: 'string', minLength: 1, maxLength: 300 },
        visualIntent: { type: 'string', minLength: 1, maxLength: 500 },
        beats: { type: 'number', minimum: 1, maximum: 32 },
        cameraMove: { enum: [...CAMERA_MOVES] }, transition: { enum: [...TRANSITIONS] },
        narration: { type: 'string', minLength: 1, maxLength: 120 },
        narrationOffset: { type: 'number', minimum: 0, maximum: 600 },
        sfx: { type: 'array', maxItems: 20, items: {
          type: 'object', additionalProperties: false, required: ['offset', 'preset'],
          properties: { offset: { type: 'number', minimum: 0, maximum: 600 }, preset: { enum: [...SFX_PRESETS] }, volume: { type: 'number', minimum: 0, maximum: 1 } },
        } },
        narrationTranslation: { type: 'string', minLength: 1, maxLength: 300 },
      },
    } },
  },
} as const;
const validator = new Ajv({ allErrors: true }).compile(DIRECTOR_SCHEMA);
export function compileDirector(raw: unknown): { plan: DirectorPlan; spec: ResolvedVideoSpec } {
  const errors = collectSchemaErrors(validator, raw);
  if (errors.length) throw new EngineError(ERROR_CODES.SPEC_INVALID, '导演计划未通过校验', {
    details: { errors }, hint: '运行 node .skill/engine/src/cli/index.ts capabilities --schema，按路径修正计划',
  });
  const plan = structuredClone(raw) as DirectorPlan;
  const fps = plan.fps ?? 24;
  const framesPerBeat = 60 * fps / plan.bpm;
  let beat = 0;
  const narration: NarrationLine[] = [];
  const sfx: SfxCue[] = [];
  const scenes = plan.shots.map((shot, i) => {
    const start = Math.round(beat * framesPerBeat) / fps;
    beat += shot.beats;
    const end = Math.round(beat * framesPerBeat) / fps;
    const ids = shot.actors.map(a => a.id);
    const visualErrors = graphicIssues(shot.elements ?? []);
    if (visualErrors.length) throw new EngineError(ERROR_CODES.SPEC_INVALID, `shots[${i}]: ${visualErrors.join('; ')}`);
    if (new Set(ids).size !== ids.length) throw new EngineError(ERROR_CODES.SPEC_INVALID, `shots[${i}].actors 的 id 重复`);
    if (shot.narrationOffset !== undefined && !shot.narration) throw new EngineError(ERROR_CODES.SPEC_INVALID, `shots[${i}].narrationOffset 需要旁白文本`);
    if (shot.narration) {
      const offset = shot.narrationOffset ?? 0.2;
      if (offset >= end - start) throw new EngineError(ERROR_CODES.SPEC_INVALID, `shots[${i}].narrationOffset 必须落在本镜头内`);
      narration.push({
        start: start + offset,
        text: shot.narration,
        voice: plan.voice ?? 'female_calm',
        ...(plan.narrationRate === undefined ? {} : { rate: plan.narrationRate }),
        ...(shot.narrationTranslation ? { translation: shot.narrationTranslation } : {}),
      });
    }
    if (shot.sfx === undefined) {
      if (i) sfx.push({ start, preset: 'whoosh', volume: 0.08 });
    } else for (const cue of shot.sfx) {
      if (cue.offset >= end - start) throw new EngineError(ERROR_CODES.SPEC_INVALID, `shots[${i}].sfx.offset 必须落在本镜头内`);
      sfx.push({ start: start + cue.offset, preset: cue.preset, volume: cue.volume ?? 0.08 });
    }
    return {
      id: `shot_${String(i + 1).padStart(3, '0')}`, start, end,
      environment: 'motion_stage', camera: 'medium',
      cameraMove: shot.cameraMove ?? 'slow_push', transition: shot.transition ?? (i ? 'dissolve' : 'cut'),
      composition: {
        backdrop: shot.backdrop, motif: shot.motif, title: shot.title, bpm: plan.bpm,
        ...(shot.subtitle ? { subtitle: shot.subtitle } : {}), actors: shot.actors,
        ...(shot.elements ? { elements: shot.elements } : {}),
      },
    };
  });
  const duration = scenes.at(-1)!.end;
  if (duration > 600) throw new EngineError(ERROR_CODES.SPEC_INVALID, '计划总时长超过 600 秒');
  const [width, height] = plan.aspect === '16:9' ? [1920, 1080] : plan.aspect === '9:16' ? [1080, 1920] : [1080, 1080];
  const result = validateSpec({
    version: '0.1', video: { width, height, fps, duration, seed: hashString(plan.idea) },
    style: { preset: plan.look === 'graphic' ? 'flat' : 'watercolor_storybook', palette: 'warm_night', paper: 'rough', line: 'soft_ink' },
    characters: [], scenes,
    audio: { narration, bgm: { preset: plan.bgmPreset ?? 'playful', bpm: plan.bpm, volume: 0.2, fadeIn: 0.3, fadeOut: 0.8, duckUnderNarration: true },
      sfx },
    captions: { enabled: narration.length > 0, style: 'boxed', mode: 'sentence', ...plan.captionLayout },
  });
  if (!result.spec || result.issues.length) throw new EngineError(ERROR_CODES.SPEC_INVALID, '编译结果需要修正', { details: { issues: result.issues } });
  return { plan, spec: result.spec };
}
