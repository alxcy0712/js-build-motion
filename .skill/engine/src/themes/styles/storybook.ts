import type { ThemeTokens } from '../types.ts';
import { CJK_PROBE, SAFE_AREA, SYSTEM_FONTS } from '../shared.ts';
/** 水彩绘本：原引擎的默认外观，现降级为可选风格之一；场景色仍由 style.palette 决定。 */
export const storybook: ThemeTokens = {
  id: 'storybook', name: '水彩绘本', summary: '原有 watercolor_storybook：冷暖室内外、纸纹、软墨线，色值来自 drawing/styles/palette.ts。',
  useWhen: '温情叙事、雨夜/窗边类氛围短片、儿童或情绪向内容；需要沿用旧项目外观时。',
  fonts: { stack: ['Noto Serif CJK SC', 'Noto Sans CJK SC'], faces: [SYSTEM_FONTS.notoSerifSC, SYSTEM_FONTS.notoSansSC], probe: CJK_PROBE },
  palette: { bg: '#151d33', surface: '#5c4030', text: '#F4E9D8', textSecondary: '#B8A58C', accent: '#ffcf7a' },
  type: { vertical: { hero: 112, display: 84, title: 64, body: 44, caption: 36, micro: 28 }, horizontal: { hero: 128, display: 96, title: 68, body: 38, caption: 30, micro: 22 } },
  weight: { hero: 700, display: 700, title: 600, body: 400, caption: 400, micro: 400 },
  tracking: {}, leading: 1.35, maxCharsPerScreen: { cjk: 16, latinWords: 8 },
  durations: { micro: 0.35, enter: 1.0, exit: 0.6, transition: 1.0, holdMin: 1.6 },
  springs: { text: { stiffness: 90, damping: 22 }, layout: { stiffness: 70, damping: 18 }, accent: { stiffness: 120, damping: 20 } },
  easings: { standard: [0.37, 0, 0.63, 1], enter: [0.33, 1, 0.68, 1], exit: [0.32, 0, 0.67, 0], camera: [0.65, 0, 0.35, 1] },
  transitions: ['blurDissolve', 'inkBleed', 'riseFade'],
  treatments: { grain: { opacity: 0.06, fps: 12 }, glow: { blur: 80, opacity: 0.35, targets: ['subject'] }, vignette: 0.4, depth: { blurFar: 3, parallax: [1, 0.5] }, motionBlur: { samples: 1, shutter: 0 }, drift: { scaleTo: 1.02, seconds: 8 }, paper: 'rough' },
  textReveal: { opacityEase: [0.33, 1, 0.68, 1], positionSpring: { stiffness: 90, damping: 22 }, rise: 16, blurFrom: 4, scaleFrom: 1, opacityDuration: 0.8, exitDuration: 0.6, stagger: 0.2, unit: 'line', allowOvershoot: false, maxOvershoot: 0 },
  liveness: { layers: ['drift', 'parallax', 'grain'], maxStillSeconds: 0.5, minMotionPx: 0.5, parallaxAmplitudePx: 16, parallaxPeriod: 10 },
  safeArea: SAFE_AREA, bpm: 72,
};
