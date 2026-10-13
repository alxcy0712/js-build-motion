import type { ThemeTokens } from '../types.ts';
import { CJK_PROBE, CJK_STACK, SAFE_AREA, SYSTEM_FONTS } from '../shared.ts';
/** 科技 UI / 终端：产品界面与代码为主角，硬朗弹簧、放大进元素转场。 */
export const terminal: ThemeTokens = {
  id: 'terminal', name: '科技UI/终端', summary: '#08090A 底、发丝线面板、等宽代码+无衬线标题、靛紫强调、光标打字与放大进元素。',
  useWhen: 'AI 实操教程、Prompt/代码演示、工作流拆解、“计算机思维”概念图解（输入→处理→输出）。',
  fonts: { stack: ['Inter', ...CJK_STACK], mono: ['Geist Mono', ...CJK_STACK], faces: [SYSTEM_FONTS.inter, SYSTEM_FONTS.geistMono, SYSTEM_FONTS.notoSansSC], probe: CJK_PROBE },
  palette: { bg: '#08090A', surface: '#111214', panel: '#1A1B1E', hairline: '#26272B', text: '#EDEDEF', textSecondary: '#8A8F98', accent: '#7C83FF', ok: '#4CC38A', warn: '#F2C94C', error: '#EB5757', caret: '#EDEDEF' },
  type: { vertical: { hero: 112, display: 84, title: 60, body: 40, caption: 30, micro: 26 }, horizontal: { hero: 128, display: 96, title: 64, body: 34, caption: 26, micro: 20 } },
  weight: { hero: 600, display: 600, title: 600, body: 450, caption: 500, micro: 500 },
  tracking: { hero: -0.03, display: -0.025, title: -0.015 },
  leading: 1.2, maxCharsPerScreen: { cjk: 14, latinWords: 6 },
  durations: { micro: 0.25, enter: 0.6, exit: 0.3, transition: 0.6, holdMin: 1.0, typePerChar: 0.035, caretBlink: 1.06 },
  springs: { text: { stiffness: 300, damping: 34 }, layout: { stiffness: 300, damping: 30 }, accent: { stiffness: 300, damping: 30 } },
  easings: { standard: [0.2, 0.8, 0.2, 1], enter: [0.2, 0.8, 0.2, 1], exit: [0.4, 0, 1, 1], camera: [0.65, 0, 0.35, 1] },
  transitions: ['zoomIntoElement', 'cutOnBeat', 'lineScan', 'blurDissolve'],
  treatments: { grain: { opacity: 0.025, fps: 24 }, glow: { blur: 40, opacity: 0.25, targets: ['accent'] }, vignette: 0.45, depth: { blurFar: 4, parallax: [1, 0.7] }, motionBlur: { samples: 4, shutter: 0.35 }, drift: { scaleTo: 1.02, seconds: 6 }, paper: 'none' },
  textReveal: { opacityEase: [0.2, 0.8, 0.2, 1], positionSpring: { stiffness: 300, damping: 34 }, rise: 12, blurFrom: 6, scaleFrom: 1, opacityDuration: 0.35, exitDuration: 0.25, stagger: 0.05, unit: 'line', allowOvershoot: false, maxOvershoot: 0 },
  liveness: { layers: ['drift', 'parallax', 'lightSweep', 'grain'], maxStillSeconds: 0.5, minMotionPx: 0.6, parallaxAmplitudePx: 6, parallaxPeriod: 8, lightSweep: { period: 6, opacity: 0.04 } },
  safeArea: SAFE_AREA, bpm: 110,
};
