import type { ThemeTokens } from '../types.ts';
import { CJK_PROBE, CJK_STACK, SAFE_AREA, SYSTEM_FONTS } from '../shared.ts';
/** 动感：品牌黄与蓝紫反差，形状接力、语义切点与稳定落定。 */
export const kinetic: ThemeTokens = {
  id: 'kinetic', name: '动感', summary: '深蓝黑底、品牌黄与蓝紫关系色；形状接力展示过程，短词强调结果，强弱节奏交替。',
  useWhen: '工具与机制讲解、操作结果、效率对比、产品发布；需要清楚的状态变化与关键揭示时。',
  fonts: { stack: ['Inter Tight', ...CJK_STACK], mono: ['Geist Mono'], faces: [SYSTEM_FONTS.interTight, SYSTEM_FONTS.notoSansSC, SYSTEM_FONTS.geistMono], probe: CJK_PROBE },
  palette: { bg: '#05060A', surface: '#0E1220', hairline: '#1E2440', text: '#FFFFFF', textSecondary: '#8B93B8', accent: '#FFC712', accent2: '#5B3DF5', warn: '#FF8A4C' },
  type: { vertical: { hero: 168, display: 120, title: 80, body: 44, caption: 32, micro: 26 }, horizontal: { hero: 196, display: 136, title: 88, body: 40, caption: 28, micro: 22 } },
  weight: { hero: 900, display: 800, title: 700, body: 500, caption: 600, micro: 600 },
  tracking: { hero: -0.04, display: -0.035, title: -0.02 },
  leading: 1.0, maxCharsPerScreen: { cjk: 8, latinWords: 3 },
  durations: { micro: 0.2, enter: 0.45, exit: 0.25, transition: 0.4, holdMin: 0.6, whip: 0.35 },
  springs: { text: { stiffness: 300, damping: 30 }, layout: { stiffness: 260, damping: 28 }, accent: { stiffness: 380, damping: 24 } },
  easings: { standard: [0.2, 0.8, 0.2, 1], enter: [0.16, 1, 0.3, 1], exit: [0.7, 0, 0.84, 0], camera: [0.8, 0, 0.1, 1], whip: [0.8, 0, 0.1, 1] },
  transitions: ['whipPan', 'cutOnBeat', 'glitchCut', 'scaleThrough', 'maskWipeUp'],
  treatments: { grain: { opacity: 0.04, fps: 30 }, glow: { blur: 60, opacity: 0.6, targets: ['accent', 'text'] }, vignette: 0.6, depth: { blurFar: 10, parallax: [1, 0.6, 0.2] }, motionBlur: { samples: 8, shutter: 0.5 }, drift: { scaleTo: 1.06, seconds: 3 }, paper: 'none' },
  textReveal: { opacityEase: [0.16, 1, 0.3, 1], positionSpring: { stiffness: 380, damping: 28 }, rise: 40, blurFrom: 8, scaleFrom: 1.04, opacityDuration: 0.25, exitDuration: 0.2, stagger: 0.04, unit: 'word', allowOvershoot: true, maxOvershoot: 0.04, firstScreen: 'instant' },
  liveness: { layers: ['drift', 'parallax', 'grain'], maxStillSeconds: 0.35, minMotionPx: 1.5, parallaxAmplitudePx: 14, parallaxPeriod: 4 },
  safeArea: SAFE_AREA, bpm: 128,
};
