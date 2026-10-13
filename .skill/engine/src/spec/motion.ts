/** Small, composable drawing vocabulary shared by the director compiler and renderer. */
import { GRAPHIC_SCHEMA, type GraphicElement } from './graphic.ts';
export const BACKDROPS = ['studio', 'night', 'sunrise'] as const;
export const MOTIFS = ['none', 'orbit', 'growth', 'burst'] as const;
export const GESTURES = ['idle', 'bounce', 'wave', 'walk', 'celebrate', 'think'] as const;
export const MOODS = ['happy', 'curious', 'worried'] as const;
export interface MotionActor {
  id: string;
  x: number;
  y: number;
  scale: number;
  gesture: typeof GESTURES[number];
  mood: typeof MOODS[number];
}
export interface Composition {
  backdrop: typeof BACKDROPS[number];
  motif: typeof MOTIFS[number];
  title: string;
  subtitle?: string;
  bpm: number;
  actors: MotionActor[];
  elements?: GraphicElement[];
}
export const COMPOSITION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['backdrop', 'motif', 'title', 'bpm', 'actors'],
  properties: {
    backdrop: { enum: [...BACKDROPS] }, motif: { enum: [...MOTIFS] },
    title: { type: 'string', minLength: 1, maxLength: 48 },
    subtitle: { type: 'string', maxLength: 100 },
    bpm: { type: 'number', minimum: 40, maximum: 200 },
    elements: GRAPHIC_SCHEMA,
    actors: { type: 'array', maxItems: 5, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'x', 'y', 'scale', 'gesture', 'mood'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 40 },
        x: { type: 'number', minimum: 0.15, maximum: 0.85 },
        y: { type: 'number', minimum: 0.48, maximum: 0.76 },
        scale: { type: 'number', minimum: 0.5, maximum: 1.3 },
        gesture: { enum: [...GESTURES] }, mood: { enum: [...MOODS] },
      },
    } },
  },
} as const;
