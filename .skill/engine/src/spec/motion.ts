/** Small, composable drawing vocabulary shared by the director compiler and renderer. */
import { GRAPHIC_SCHEMA, type GraphicElement } from './graphic.ts';
export const BACKDROPS = ['studio', 'night', 'sunrise'] as const;
export const MOTIFS = ['none', 'orbit', 'growth', 'burst'] as const;
export interface Composition {
  backdrop: typeof BACKDROPS[number];
  motif: typeof MOTIFS[number];
  title: string;
  subtitle?: string;
  bpm: number;
  elements?: GraphicElement[];
}
export const COMPOSITION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['backdrop', 'motif', 'title', 'bpm'],
  properties: {
    backdrop: { enum: [...BACKDROPS] }, motif: { enum: [...MOTIFS] },
    title: { type: 'string', minLength: 1, maxLength: 48 },
    subtitle: { type: 'string', maxLength: 100 },
    bpm: { type: 'number', minimum: 40, maximum: 200 },
    elements: GRAPHIC_SCHEMA,
  },
} as const;
