import type { ThemeTokens } from '../types.ts';
import { CJK_PROBE, CJK_STACK, SAFE_AREA, SYSTEM_FONTS } from '../shared.ts';
/** 极简：黑底、品牌黄、清楚的对象关系与稳定阅读。 */
export const minimal: ThemeTokens = {
  id: 'minimal', name: '极简', summary: '近黑背景、品牌黄强调当前焦点；精简标签、局部状态变化与稳定阅读。',
  useWhen: '机制解释、证据对照、观点表达与品牌片尾；需要少量动作和清楚信息层级时。',
  fonts: { stack: ['Inter', ...CJK_STACK], mono: ['Geist Mono'], faces: [SYSTEM_FONTS.inter, SYSTEM_FONTS.notoSansSC, SYSTEM_FONTS.geistMono], probe: CJK_PROBE },
  palette: { bg: '#000000', bgRaised: '#0B0B0D', surface: '#161618', hairline: '#2A2A2E', text: '#F5F5F7', textSecondary: '#86868B', textTertiary: '#4A4A4F', accent: '#FFC712', accent2: '#5B3DF5', light: '#5E9BFF' },
  type: { vertical: { hero: 132, display: 96, title: 72, body: 44, caption: 32, micro: 26 }, horizontal: { hero: 156, display: 112, title: 80, body: 40, caption: 28, micro: 22 } },
  weight: { hero: 700, display: 700, title: 600, body: 500, caption: 500, micro: 500 },
  tracking: { hero: -0.035, display: -0.03, title: -0.02, body: -0.005 },
  leading: 1.12, maxCharsPerScreen: { cjk: 10, latinWords: 4 },
  durations: { micro: 0.3, enter: 0.9, exit: 0.45, transition: 0.7, holdMin: 1.2, holdHero: 1.8, reveal: 1.3, endCard: 2.4 },
  springs: { text: { stiffness: 100, damping: 25 }, layout: { stiffness: 90, damping: 19 }, accent: { stiffness: 200, damping: 24 } },
  easings: { standard: [0.25, 0.1, 0.25, 1], enter: [0.16, 1, 0.3, 1], exit: [0.7, 0, 0.84, 0], camera: [0.4, 0, 0.2, 1] },
  transitions: ['blurDissolve', 'riseFade', 'maskWipeUp', 'scaleThrough', 'zoomIntoElement', 'cutOnBeat'],
  treatments: { grain: { opacity: 0.03, fps: 24 }, glow: { blur: 120, opacity: 0.3, targets: ['accent', 'subject'] }, vignette: 0.55, depth: { blurFar: 6, parallax: [1, 0.5, 0.1] }, motionBlur: { samples: 1, shutter: 0 }, drift: { scaleTo: 1.03, seconds: 5 }, paper: 'none' },
  textReveal: { opacityEase: [0.16, 1, 0.3, 1], positionSpring: { stiffness: 100, damping: 25 }, rise: 24, blurFrom: 12, scaleFrom: 0.98, opacityDuration: 0.6, exitDuration: 0.45, stagger: 0.12, unit: 'line', allowOvershoot: false, maxOvershoot: 0 },
  liveness: { layers: ['drift', 'parallax', 'lightSweep', 'grain'], maxStillSeconds: 0.5, minMotionPx: 0.6, parallaxAmplitudePx: 6, parallaxPeriod: 9, lightSweep: { period: 7, opacity: 0.05 } },
  safeArea: SAFE_AREA, bpm: 96,
};
