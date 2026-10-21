import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { Canvas, FontLibrary, type CanvasRenderingContext2D } from 'skia-canvas';
import { join } from 'node:path';
import { getTheme } from '../themes/registry.ts';
import { registerThemeFonts, trackFontUsage, type FontUsage } from '../themes/fonts.ts';
import { drawTransition, drawTransitionFade, isThemeTransition, transitionDuration, isBlendedTransition } from './theme-transitions.ts';
import { applyMicroMotion, drawTreatments } from './theme-treatments.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
/**
 * 将VideoSpec或本片drawScene求值为像素，统一处理相机、转场和字幕。
 * 场景、局部时间与进度由frameIndex计算，支持任意顺序的独立帧渲染。
 */

import { SkiaRenderer } from '../renderer/skia/skia-renderer.ts';
import type { Renderer, FrameContext } from '../renderer/renderer.ts';
import type {
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
} from '../drawing/scenes/registry.ts';
import { getPalette } from '../drawing/styles/palette.ts';
import { buildCaptionTrack, type CaptionCue, type MeasuredNarration } from '../captions/track.ts';
import { drawCaptions } from '../captions/render.ts';
import { registerProjectFonts, resolveFontFamily } from '../utils/env.ts';
import { trackTextBounds, type TextDraw } from '../drawing/primitives/text-bounds.ts';

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
  /** 视频素材抽帧缓存目录；默认本片输出区的 .cache/footage */
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

/**
 * 构造一个由 VideoSpec 驱动的渲染器。
 *
 * 返回的 Renderer 可以直接交给 `renderVideo()` 走 rawvideo → FFmpeg 管道。
 */
export function createSpecRenderer(options: SpecRendererOptions): Renderer & { toPng(): Buffer; textBounds(): readonly TextDraw[]; fontUsage(): FontUsage } {
  const { spec, onWarning } = options;
  const width = options.width ?? spec.video.width;
  const height = options.height ?? spec.video.height;
  const palette = getPalette(spec.style.palette);
  // 风格层：spec.style.theme 已在 repair 阶段按品牌锁解析。
  const baseTheme = getTheme(spec.style.theme);
  const theme = spec.style.vignette === undefined ? baseTheme
    : { ...baseTheme, treatments: { ...baseTheme.treatments, vignette: spec.style.vignette } };
  // 风格质感作用于 theme_stage 镜头。
  const themedScene = (shot: ResolvedScene): boolean => shot.environment === 'theme_stage';
  const themed = spec.scenes.some(themedScene);
  const themeFonts = registerThemeFonts(theme, FontLibrary, join(PROJECT_ROOT, 'assets', 'fonts'));
  for (const font of themeFonts) if (!font.registered) {
    throw new EngineError(ERROR_CODES.FONT_NOT_FOUND, `主题 ${theme.id} 需要内嵌字体 ${font.family}，请按 README 恢复 assets/fonts/ 中的固定文件`);
  }

  // 原有绘图组件继续显式注册项目字体；字幕使用上面注册的主题中文黑体。
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
  const themeCjkFamily = themeFonts.find((f) => f.registered && /CJK|SC/.test(f.family))?.family;

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

  const captionFont = themeCjkFamily ?? captionFontDefault;
  const usedFontFamilies = new Set<string>(), fontContexts = new WeakSet<CanvasRenderingContext2D>();
  const trackFonts = (ctx: CanvasRenderingContext2D): void => {
    if (fontContexts.has(ctx)) return;
    trackFontUsage(ctx, usedFontFamilies); fontContexts.add(ctx);
  };
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
      trackFonts(ctx);
      if (options.trackText) { mainText ??= trackTextBounds(ctx); mainText.reset(); }
      const t = rc.time;
      const { scene, localTime } = resolveScene(spec.scenes, t);
      const drawScene = (context: CanvasRenderingContext2D, shot: ResolvedScene, noText = false): void => {
        trackFonts(context);
        const shotTime = Math.max(0, Math.min(shot.end - shot.start, t - shot.start));
        const progress = shot.composition
          ? shotTime / Math.max(0.001, shot.end - shot.start)
          : normalizedProgress(rc.frameIndex, rc.totalFrames);
        const camera = cameraFor(shot.cameraMove, progress);
        const footage = footageSources.get(shot);
        const sceneCtx: SceneRenderContext = {
          ctx: context, width, height, palette, scene: shot,
          time: t, sceneTime: shotTime,
          progress, seed: spec.video.seed, theme,
          textHold: isThemeTransition(spec.scenes[spec.scenes.indexOf(shot) + 1]?.transition ?? 'cut'),
          textCarriedIn: spec.scenes.indexOf(shot) > 0 && isThemeTransition(shot.transition),
          firstShot: spec.scenes.indexOf(shot) === 0,
          noText,
          ...(footage ? { footage } : {}),
        };
        context.save();
        if (shot.cameraPath) applyCameraPose(context, evaluateCameraPath(shot.cameraPath, shotTime, width, height, theme.easings.camera), width, height);
        else applyCamera(context, shot.composition ? { ...camera, offsetX: camera.offsetX * width / 1080, offsetY: camera.offsetY * height / 1920 } : camera, width, height);
        if (themedScene(shot) && shot.cameraMove !== 'static' && !shot.cameraPath) applyMicroMotion(context, theme, shotTime, width, height);
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
      const duration = Math.min(transitionDuration(scene.transition, theme), (scene.end - scene.start) / 3);
      const mix = Math.min(1, localTime / duration);
      const blending = isBlendedTransition(scene.transition);
      const themeTransition = isThemeTransition(scene.transition) ? scene.transition : null;
      if (themeTransition && !theme.transitions.includes(themeTransition)) {
        warnOnce(`tr:${scene.id}`, `风格 ${theme.id} 默认推荐 ${theme.transitions.join(' | ')}；使用显式转场 ${themeTransition}，请核对连续性与读时。`);
      }
      if (previous && mix < 1 && blending) {
        incomingText?.reset();
        incomingContext.clearRect(0, 0, width, height);
        drawScene(incomingContext, scene);
        drawTransition(scene.transition, {
          ctx, width, height, mix, theme, incoming, outgoing, sceneId: scene.id,
          drawPrevious: (c) => drawScene(c, previous), seed: spec.video.seed ^ index,
          ...(previous.focus ? { focus: previous.focus } : {}),
          drawIncomingBase: (c) => { c.clearRect(0, 0, width, height); drawScene(c, scene, true); }, incomingBase,
        });
      } else drawScene(ctx, scene);

      // 主题质感作用于完整场景，字幕随后叠加。
      const themedFrame = themedScene(scene) || (previous && themedScene(previous) &&
        (blending && mix < 1));
      if (themedFrame) {
        drawTreatments(ctx, theme, t, localTime, width, height, spec.video.seed);
      }
      // 字幕：画在场景之后、淡出之前。
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
        });
      }

      if (scene.transition === 'fade') drawTransitionFade(ctx, width, height, localTime, scene.end - t);
    },
  });

  return Object.assign(renderer, {
    textBounds: (): readonly TextDraw[] => mainText?.draws ?? [],
    fontUsage: (): FontUsage => ({
      registered: [...themeFonts.filter((font) => font.file).map((font) => ({ family: font.family, absPath: font.file!, registered: font.registered })),
        { family: fontState.family, absPath: fontState.filePath, registered: fontState.registered }],
      families: [...usedFontFamilies].sort(),
    }),
  });
}

/** 环境是否为已实现的完整版本（供 CLI 提示） */
export function isEnvironmentImplemented(environment: Environment): boolean {
  return IMPLEMENTED_ENVIRONMENTS.includes(environment);
}
