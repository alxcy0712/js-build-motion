import type { ThemeTokens } from '../types.ts';
import { CJK_PROBE, CJK_STACK, SAFE_AREA, SYSTEM_FONTS } from '../shared.ts';
/** 手绘/蜡笔：暖纸底、蜡笔笔触与描线生长，可与个人 IP 同框。 */
export const crayon: ThemeTokens = {
  id: 'crayon', name: '手绘蜡笔', summary: '米白纸纹底、蜡笔粗颗粒笔触、手写感圆体、按笔画生长描线；允许轻微俏皮过冲。',
  useWhen: '个人 IP 出镜、生活类比、“用计算机思维想现实”的故事型讲解；与蜡笔画 Skill 产出的插画同框。',
  fonts: { stack: ['Noto Sans CJK SC', 'Inter'], faces: [SYSTEM_FONTS.notoSansSC, SYSTEM_FONTS.inter], probe: CJK_PROBE },
  palette: { bg: '#F6F1E7', surface: '#EFE6D4', text: '#2B2622', textSecondary: '#6E6458', accent: '#E8603C', blue: '#3D7DD8', yellow: '#F2B632', green: '#5DA35D', line: '#2B2622' },
  type: { vertical: { hero: 124, display: 92, title: 68, body: 44, caption: 34, micro: 28 }, horizontal: { hero: 140, display: 104, title: 72, body: 38, caption: 28, micro: 22 } },
  weight: { hero: 900, display: 800, title: 700, body: 500, caption: 500, micro: 500 },
  tracking: {}, leading: 1.25, maxCharsPerScreen: { cjk: 12, latinWords: 5 },
  durations: { micro: 0.3, enter: 0.7, exit: 0.4, transition: 0.8, holdMin: 1.4, strokeGrow: 0.9, boil: 0.125 },
  springs: { text: { stiffness: 180, damping: 18 }, layout: { stiffness: 140, damping: 18 }, accent: { stiffness: 220, damping: 16 } },
  easings: { standard: [0.33, 0, 0.2, 1], enter: [0.22, 1, 0.36, 1], exit: [0.55, 0, 1, 0.45], camera: [0.45, 0, 0.55, 1] },
  transitions: ['paperFlip', 'maskWipeUp', 'riseFade', 'cutOnBeat'],
  treatments: { grain: { opacity: 0.08, fps: 8 }, glow: { blur: 0, opacity: 0, targets: [] }, vignette: 0.15, depth: { blurFar: 0, parallax: [1, 0.8] }, motionBlur: { samples: 1, shutter: 0 }, drift: { scaleTo: 1.01, seconds: 6 }, paper: 'rough' },
  textReveal: { opacityEase: [0.22, 1, 0.36, 1], positionSpring: { stiffness: 180, damping: 18 }, rise: 20, blurFrom: 0, scaleFrom: 0.92, opacityDuration: 0.3, exitDuration: 0.3, stagger: 0.06, unit: 'char', allowOvershoot: true, maxOvershoot: 0.06 },
  liveness: { layers: ['boil', 'drift', 'parallax', 'grain'], maxStillSeconds: 0.5, minMotionPx: 0.6, parallaxAmplitudePx: 4, parallaxPeriod: 7 },
  safeArea: SAFE_AREA, bpm: 100,
};
