import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { Canvas, FontLibrary, type CanvasRenderingContext2D } from 'skia-canvas';
import { join } from 'node:path';
import { getTheme } from '../themes/registry.ts';
import { registerThemeFonts } from '../themes/fonts.ts';
import { drawThemeTransition, isThemeTransition, themeTransitionDuration } from './theme-transitions.ts';
import { applyMicroMotion, drawTreatments } from './theme-treatments.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
/**
 * 将VideoSpec或本片drawScene求值为像素，统一处理相机、转场和字幕。
 * 场景、局部时间与进度由frameIndex计算，支持任意顺序的独立帧渲染。
 */

import { SkiaRenderer } from '../renderer/skia/skia-renderer.ts';
import type { Renderer, FrameContext } from '../renderer/renderer.ts';
import type {
  CharacterDefinition,
  Environment,
  ResolvedScene,
  ResolvedVideoSpec,
} from '../spec/types.ts';
import { normalizedProgress } from '../timeline/frame.ts';
import { cameraFor, applyCamera, applyCameraPose } from '../drawing/primitives/camera.ts';
import { evaluateCameraPath } from '../motion/camera-path.ts';
import { openFootage, type FrameSource } from '../footage/clip.ts';
import {
  IMPLEMENTED_ENVIRONMENTS,
  getSceneRenderer,
  type SceneRenderContext,
} from '../drawing/scenes/rain-window.ts';
import { getPalette } from '../drawing/styles/palette.ts';
import { buildCaptionTrack, type CaptionCue, type MeasuredNarration } from '../captions/track.ts';
import { drawCaptions } from '../captions/render.ts';
import { hashString, mulberry32 } from '../animation/random.ts';
import { registerProjectFonts, resolveFontFamily } from '../utils/env.ts';
import { trackTextBounds, type TextDraw } from '../drawing/primitives/text-bounds.ts';

/** 转场专用中性色：与暗场主题的暖白/橙色一致，不依赖调色板名称。 */
const TRANSITION_INK = '#fff0d7';
const TRANSITION_ACCENT = '#f1aa65';
/** 有混合过程的转场；cut 与 fade 不需要预绘上一镜头。 */
const BLENDED_TRANSITIONS = ['dissolve', 'wipe', 'iris', 'zoom', 'grid', 'glitch', 'tokenize'] as const;

export interface SpecRendererOptions {
  readonly spec: ResolvedVideoSpec;
  /** 覆盖输出尺寸（预览用）。默认取 spec.video 的尺寸 */
  readonly width?: number;
  readonly height?: number;
  /** 渲染期一次性告警（同一场景只报一次，避免逐帧刷屏） */
  readonly onWarning?: (message: string) => void;
  /** 是否绘制字幕。默认跟随 spec.captions.enabled；显式 false 可关闭（黄金帧测试用） */
  readonly captions?: boolean;
  /**
   * 字幕时间覆盖（来自 TTS 的实测时间）。键为 narration 下标。
   * 缺失的下标会自动回退到确定性估算，因此可以只提供一部分。
   */
  readonly captionCues?: readonly CaptionCue[];
  readonly measuredNarration?: ReadonlyMap<number, MeasuredNarration>;
  /** 本片绘制函数；镜头、转场、字幕继续由统一管线处理。 */
  readonly drawScene?: (context: SceneRenderContext, frame: FrameContext) => void;
  /** Opt-in glyph bounds for source-frame diagnostics. */
  readonly trackText?: boolean;
  /** 素材片段（environment = footage）的根目录；src 只能指向其内部。默认 process.cwd() */
  readonly assetRoot?: string;
  /** 视频素材抽帧缓存目录；默认 output/.cache/footage */
  readonly footageCacheDir?: string;
}

/**
 * 解析某一时刻生效的场景。
 *
 * 语义：**后开始的场景胜出**（与 repair 层的 WARNING 文案一致）。
 * 时刻早于第一个场景时仍然返回第一个场景——总比给用户一帧纯背景好。
 */
export function resolveScene(
  scenes: readonly ResolvedScene[],
  time: number,
): { scene: ResolvedScene; localTime: number } {
  const first = scenes[0];
  if (!first) throw new Error('ResolvedVideoSpec 至少应有一个场景');

  let active = first;
  for (const s of scenes) {
    if (s.start <= time) active = s;
    else break;
  }
  return { scene: active, localTime: Math.max(0, time - active.start) };
}

/** 找出场景引用的人物定义；引用失效时返回 undefined（repair 层已就此事告警过） */
export function resolveCharacter(
  spec: ResolvedVideoSpec,
  scene: ResolvedScene,
): CharacterDefinition | undefined {
  if (!scene.character) return undefined;
  return spec.characters.find((c) => c.id === scene.character);
}

/**
 * 构造一个由 VideoSpec 驱动的渲染器。
 *
 * 返回的 Renderer 可以直接交给 `renderVideo()` 走 rawvideo → FFmpeg 管道。
 */
export function createSpecRenderer(options: SpecRendererOptions): Renderer & { toPng(): Buffer; textBounds(): readonly TextDraw[] } {
  const { spec, onWarning } = options;
  const width = options.width ?? spec.video.width;
  const height = options.height ?? spec.video.height;
  const palette = getPalette(spec.style.palette);
  // 风格层：spec.style.theme 已在 repair 阶段按品牌锁解析。storybook 走原水彩外观，不加逐帧质感。
  const theme = getTheme(spec.style.theme);
  // 旧环境（rain_window / motion_stage）保持原有绘制与回归基线；风格质感作用于 theme_stage 镜头。
  const themedScene = (shot: ResolvedScene): boolean => theme.id !== 'storybook' && shot.environment === 'theme_stage';
  const themed = theme.id !== 'storybook' && spec.scenes.some(themedScene);
  const themeFonts = registerThemeFonts(theme, FontLibrary, join(PROJECT_ROOT, 'assets', 'fonts'));

  // 字幕：项目字体必须显式注册（§26）。字体缺失时 registerProjectFonts 返回未注册，
  // 此时 resolveFontFamily 会沿兜底链取系统字体，并已在环境自检里报过 FONT_NOT_FOUND。
  const fontState = registerProjectFonts();
  if (!fontState.registered) throw new EngineError(ERROR_CODES.FONT_NOT_FOUND, '渲染需要内嵌字体，请检查本片运行时的 assets/fonts/ 字体');
  const captionFontDefault = resolveFontFamily(fontState.registered);
  const captionsEnabled = options.captions ?? spec.captions.enabled;
  const cueTrack: readonly CaptionCue[] = options.captionCues ?? buildCaptionTrack(spec, {
    ...(options.measuredNarration ? { measured: options.measuredNarration } : {}),
  });

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    onWarning?.(message);
  };
  for (const f of themeFonts) if (!f.registered) warnOnce(`font:${f.family}`, `风格 ${theme.id} 的字体 ${f.family} 未找到，将回退`);
  const themeCjkFamily = themeFonts.find((f) => f.registered && /CJK|SC/.test(f.family))?.family;
  const captionFamily = themed && themeCjkFamily ? themeCjkFamily : null;

  // 提前告警未实现的环境（在设计阶段就能看到，而不是渲完才发现是占位）
  for (const scene of spec.scenes) {
    if (!options.drawScene && !IMPLEMENTED_ENVIRONMENTS.includes(scene.environment)) {
      warnOnce(
        `env:${scene.environment}`,
        `环境 "${scene.environment}" 在第 M0 阶段尚未实现，将使用确定性占位画面。` +
          `已实现: ${IMPLEMENTED_ENVIRONMENTS.join(', ')}`,
      );
    }
  }

  // 素材片段：渲染器创建时一次性打开（视频先抽帧缓存），之后每帧同步取图，保持纯 seek(t)
  const footageSources = new Map<ResolvedScene, FrameSource>();
  for (const scene of spec.scenes) {
    if (scene.environment !== 'footage' || !scene.footage) continue;
    try {
      footageSources.set(scene, openFootage(scene.footage, options.assetRoot ?? process.cwd(), spec.video.fps, scene.end - scene.start, options.footageCacheDir));
    } catch (e) { warnOnce(`footage:${scene.id}`, `镜头 ${scene.id} 素材不可用：${(e as Error).message}`); }
  }

  const captionFont = captionFamily ?? captionFontDefault;
  const outgoing = new Canvas(width, height);
  const incomingBase = new Canvas(width, height);
  const incoming = new Canvas(width, height);
  const incomingContext = incoming.getContext('2d');
  const incomingText = options.trackText ? trackTextBounds(incomingContext) : undefined;
  let mainText: ReturnType<typeof trackTextBounds> | undefined;
  const renderer = new SkiaRenderer({
    width,
    height,
    draw: (ctx, rc) => {
      if (options.trackText) { mainText ??= trackTextBounds(ctx); mainText.reset(); }
      const t = rc.time;
      const { scene, localTime } = resolveScene(spec.scenes, t);
      const drawScene = (context: CanvasRenderingContext2D, shot: ResolvedScene, noText = false): void => {
        const shotTime = Math.max(0, Math.min(shot.end - shot.start, t - shot.start));
        const progress = shot.composition
          ? shotTime / Math.max(0.001, shot.end - shot.start)
          : normalizedProgress(rc.frameIndex, rc.totalFrames);
        const camera = cameraFor(shot.cameraMove, progress);
        const footage = footageSources.get(shot);
        const sceneCtx: SceneRenderContext = {
          ctx: context, width, height, palette, scene: shot,
          character: resolveCharacter(spec, shot), time: t, sceneTime: shotTime,
          progress, seed: spec.video.seed, stylePreset: spec.style.preset, theme,
          textHold: isThemeTransition(spec.scenes[spec.scenes.indexOf(shot) + 1]?.transition ?? 'cut'),
          textCarriedIn: spec.scenes.indexOf(shot) > 0 && isThemeTransition(shot.transition),
          firstShot: spec.scenes.indexOf(shot) === 0,
          noText,
          ...(footage ? { footage } : {}),
        };
        context.save();
        if (shot.cameraPath) applyCameraPose(context, evaluateCameraPath(shot.cameraPath, shotTime, width, height, theme.easings.camera), width, height);
        else applyCamera(context, shot.composition ? { ...camera, offsetX: camera.offsetX * width / 1080, offsetY: camera.offsetY * height / 1920 } : camera, width, height);
        if (themedScene(shot)) applyMicroMotion(context, theme, shotTime, width, height);
        if (options.drawScene) {
          const result = options.drawScene(sceneCtx, rc) as unknown;
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            throw new EngineError(ERROR_CODES.RENDER_FAILED, '本片 drawScene 必须同步返回');
          }
        } else getSceneRenderer(shot.environment)(sceneCtx);
        context.restore();
      };
      const index = spec.scenes.indexOf(scene);
      const previous = spec.scenes[index - 1];
      const transitionDuration = Math.min(0.5, (scene.end - scene.start) / 3);
      const mix = Math.min(1, localTime / transitionDuration);
      const blending = (BLENDED_TRANSITIONS as readonly string[]).includes(scene.transition);
      const themeTransition = isThemeTransition(scene.transition)
        ? (theme.transitions.includes(scene.transition) ? scene.transition : (warnOnce(`tr:${scene.id}`, `转场 ${scene.transition} 不在风格 ${theme.id} 的允许列表，改用 ${theme.transitions[0]}`), theme.transitions[0]!))
        : null;
      const themeMixDur = themeTransition ? Math.min(themeTransitionDuration(themeTransition, theme), (scene.end - scene.start) / 3) : 0;
      if (previous && themeTransition && localTime < themeMixDur) {
        incomingText?.reset();
        incomingContext.clearRect(0, 0, width, height);
        drawScene(incomingContext, scene);
        drawThemeTransition(themeTransition, {
          ctx, width, height, mix: localTime / themeMixDur, theme, incoming, outgoing,
          drawPrevious: (c) => drawScene(c, previous), seed: spec.video.seed ^ index,
          ...(previous.focus ? { focus: previous.focus } : {}),
          drawIncomingBase: (c) => { c.clearRect(0, 0, width, height); drawScene(c, scene, true); }, incomingBase,
        });
      } else if (previous && mix < 1 && blending) {
        /** 新镜头先画进离屏画布，再由各转场决定怎么合上去。 */
        const incomingReady = (): void => {
          incomingText?.reset();
          incomingContext.clearRect(0, 0, width, height);
          drawScene(incomingContext, scene);
        };
        if (scene.transition === 'zoom') {
          // 旧画面被镜头推近并压暗，新画面从稍远处放大到位。
          const ease = mix * mix * (3 - 2 * mix);
          ctx.save();
          ctx.globalAlpha = 1 - 0.7 * mix;
          const push = 1 + 0.32 * mix;
          ctx.translate(width / 2, height / 2); ctx.scale(push, push); ctx.translate(-width / 2, -height / 2);
          drawScene(ctx, previous);
          ctx.restore();
          incomingReady();
          ctx.save();
          ctx.globalAlpha = Math.min(1, ease * 1.35);
          const arrive = 1.16 - 0.16 * ease;
          ctx.translate(width / 2, height / 2); ctx.scale(arrive, arrive); ctx.translate(-width / 2, -height / 2);
          ctx.drawImage(incoming, 0, 0);
          ctx.restore();
        } else {
          drawScene(ctx, previous);
          if (scene.transition === 'dissolve' || scene.transition === 'wipe' || scene.transition === 'iris') {
            incomingReady();
            ctx.save();
            if (scene.transition === 'dissolve') ctx.globalAlpha = mix;
            else {
              ctx.beginPath();
              if (scene.transition === 'wipe') ctx.rect(0, 0, width * mix, height);
              else ctx.arc(width / 2, height / 2, Math.hypot(width, height) / 2 * mix, 0, Math.PI * 2);
              ctx.clip();
            }
            ctx.drawImage(incoming, 0, 0);
            ctx.restore();
          } else if (scene.transition === 'grid') {
            // 网格式接管：每格按种子确定的次序从上方滑入，未完成的格子留一条亮边。
            incomingReady();
            const cols = 6, rows = Math.max(3, Math.round(6 * height / width));
            const cellW = width / cols, cellH = height / rows;
            const rng = mulberry32(hashString(`${scene.id}:grid`));
            const total = cols * rows;
            for (let i = 0; i < total; i++) {
              const threshold = rng();
              const p = Math.max(0, Math.min(1, (mix - threshold * 0.7) / 0.3));
              if (p <= 0) continue;
              const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
              ctx.save();
              ctx.beginPath(); ctx.rect(x, y, cellW, cellH); ctx.clip();
              ctx.globalAlpha = p;
              ctx.translate(0, (1 - p) * cellH * 0.55);
              ctx.drawImage(incoming, 0, 0);
              ctx.restore();
              if (p < 1) {
                ctx.save();
                ctx.globalAlpha = (1 - p) * 0.5; ctx.strokeStyle = TRANSITION_INK; ctx.lineWidth = 1.5;
                ctx.strokeRect(x + 0.75, y + 0.75, cellW - 1.5, cellH - 1.5);
                ctx.restore();
              }
            }
          } else if (scene.transition === 'tokenize') {
            // 逐行「重新排版」：新画面像一行行文字被重新打散再对齐，
            // 自上而下错峰落位，未落定的行保留一条亮边，读起来像词元在逐行归位。
            incomingReady();
            const rows = 7, bandH = height / rows;
            const rng = mulberry32(hashString(`${scene.id}:tokenize`));
            for (let i = 0; i < rows; i++) {
              const delay = (i / rows) * 0.34;
              const p = Math.max(0, Math.min(1, (mix - delay) / (1 - 0.34)));
              if (p <= 0) continue;
              const e = p * p * (3 - 2 * p);
              const y = i * bandH;
              const dir = rng() < 0.5 ? -1 : 1;
              ctx.save();
              ctx.beginPath(); ctx.rect(0, y, width, bandH + 1); ctx.clip();
              ctx.globalAlpha = Math.min(1, p * 1.6);
              ctx.translate((1 - e) * dir * width * 0.05, 0);
              ctx.translate(width / 2, y); ctx.scale(0.94 + 0.06 * e, 1); ctx.translate(-width / 2, -y);
              ctx.drawImage(incoming, 0, 0);
              ctx.restore();
              if (p < 1) {
                ctx.save();
                ctx.globalAlpha = (1 - p) * 0.45; ctx.fillStyle = TRANSITION_ACCENT;
                ctx.fillRect(0, y - 1.5, width, 3);
                ctx.restore();
              }
            }
          } else if (scene.transition === 'glitch') {
            // 条带位移 + 扫描光带：中段最强烈，两端回到稳定画面。
            incomingReady();
            const slices = 18, sliceH = height / slices;
            const intensity = Math.sin(Math.PI * mix);
            const coverage = Math.min(1, mix * 1.25);
            const rng = mulberry32(hashString(`${scene.id}:glitch`));
            const alpha = Math.min(1, mix * 2.2);
            for (let i = 0; i < slices; i++) {
              const roll = rng();
              const shift = (roll * 2 - 1) * intensity * width * 0.09;
              const y = i * sliceH;
              if (roll < coverage) {
                ctx.save();
                ctx.beginPath(); ctx.rect(0, y, width, sliceH + 1); ctx.clip();
                ctx.globalAlpha = alpha; ctx.translate(shift, 0); ctx.drawImage(incoming, 0, 0);
                ctx.restore();
              }
              if (roll > 0.9) {
                ctx.save();
                ctx.globalAlpha = 0.12 * intensity; ctx.fillStyle = TRANSITION_ACCENT;
                ctx.fillRect(shift * 0.6, y, width, sliceH);
                ctx.restore();
              }
            }
            ctx.save();
            ctx.globalAlpha = 0.18 * intensity; ctx.fillStyle = TRANSITION_ACCENT;
            ctx.fillRect(0, mix * height - 3, width, 6);
            ctx.globalAlpha = 0.1 * intensity; ctx.fillStyle = TRANSITION_INK;
            ctx.fillRect(0, mix * height - 9, width, 2);
            ctx.restore();
          }
        }
      } else drawScene(ctx, scene);

      // 字幕：画在场景之后、转场之前。
      // 放在转场之前是有意的——淡入淡出时字幕应该跟着画面一起淡，
      // 而不是浮在黑幕之上。
      if (captionsEnabled && cueTrack.length > 0) {
        drawCaptions({
          ctx,
          cues: cueTrack,
          time: t,
          width,
          height,
          style: spec.captions.style,
          mode: spec.captions.mode,
          layout: spec.captions,
          palette,
          fontFamily: captionFont,
          seed: spec.video.seed,
          ...(themed ? { themeColors: { text: theme.palette.text, active: theme.palette.accent, plate: theme.palette.surface, secondary: theme.palette.textSecondary } } : {}),
          ...(themed ? { layout: { ...spec.captions, bottomInset: spec.captions.bottomInset ?? theme.safeArea[height >= width ? 'vertical' : 'horizontal'].bottom / (height >= width ? 1920 : 1080) } } : {}),
        });
      }
      // 风格逐帧质感（扫光/暗角/颗粒）：每帧都画，防止死帧
      if (themedScene(scene) || (previous && themedScene(previous) && themeTransition && localTime < themeMixDur)) drawTreatments(ctx, theme, t, localTime, width, height, spec.video.seed);

      // 场景边界提示：M0 阶段用于确认时间轴切分正确，后续会被真正的转场取代
      if (scene.transition === 'fade') {
        const sinceStart = localTime;
        const untilEnd = scene.end - t;
        const fadeDur = 0.6;
        const fade = Math.max(
          sinceStart < fadeDur ? 1 - sinceStart / fadeDur : 0,
          untilEnd < fadeDur ? 1 - untilEnd / fadeDur : 0,
        );
        if (fade > 0) {
          ctx.save();
          ctx.globalAlpha = Math.min(1, Math.max(0, fade));
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        }
      }
    },
  });

  return Object.assign(renderer, { textBounds: (): readonly TextDraw[] => mainText?.draws ?? [] });
}

/** 环境是否为已实现的完整版本（供 CLI 提示） */
export function isEnvironmentImplemented(environment: Environment): boolean {
  return IMPLEMENTED_ENVIRONMENTS.includes(environment);
}
