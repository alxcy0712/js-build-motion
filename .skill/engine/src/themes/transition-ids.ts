/** Shared vocabulary for schema, themes and the renderer. */
export const LEGACY_TRANSITION_IDS = ['cut', 'fade', 'dissolve', 'wipe', 'iris', 'zoom', 'grid', 'glitch', 'tokenize'] as const;
export const THEME_TRANSITION_IDS = ['blurDissolve', 'riseFade', 'maskWipeUp', 'scaleThrough', 'cutOnBeat', 'whipPan', 'glitchCut', 'zoomIntoElement', 'lineScan', 'paperFlip', 'inkBleed'] as const;
export const TRANSITIONS = [...LEGACY_TRANSITION_IDS, ...THEME_TRANSITION_IDS] as const;
export type TransitionId = (typeof THEME_TRANSITION_IDS)[number];
export type Transition = (typeof TRANSITIONS)[number];
