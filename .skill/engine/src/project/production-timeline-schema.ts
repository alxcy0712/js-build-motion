import { Ajv } from 'ajv';
import { COMPOSITION_SCHEMA, type Composition } from '../spec/motion.ts';
import { CAMERAS, CAMERA_MOVES, TRANSITIONS } from '../spec/types.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';

const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' } as const;
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positive = { ...integer, minimum: 1 } as const;
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const path = { type: 'string', minLength: 1, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' } as const;
const object = <P extends Record<string, unknown>>(properties: P) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const array = <S>(items: S) => ({ type: 'array', items, maxItems: 1000 }) as const;
const nullable = <S>(value: S) => ({ anyOf: [value, { type: 'null' }] }) as const;
const choices = <T extends string>(...values: T[]) => ({ enum: values }) as const;
const gain = { type: 'number', minimum: 0, maximum: 4 } as const;
const shot = object({ shotId: id, startFrame: integer, endFrame: positive, composition: COMPOSITION_SCHEMA,
  camera: { enum: [...CAMERAS] }, cameraMove: { enum: [...CAMERA_MOVES] }, transition: { enum: [...TRANSITIONS] } });
const clip = object({ placementId: id, useId: id, startFrame: integer, endFrame: positive,
  sourceStartFrame: integer, gain, mute: { type: 'boolean' } });
const word = object({ pointId: id, text: { type: 'string', minLength: 1 }, startSample: integer, endSample: positive,
  basis: choices('observed', 'estimated', 'unknown') });
const beat = object({ pointId: id, sample: integer, basis: choices('observed', 'authored', 'estimated', 'unknown') });
const take = object({ takeId: id, kind: choices('voice', 'bgm', 'sfx'), lineId: nullable(id),
  file: object({ path, bytes: positive, sha256: hash }), sampleRate: { const: 48000 }, durationSamples: positive,
  words: array(word), beats: array(beat) });
const placement = object({ placementId: id, takeId: id, startSample: integer, inSample: integer,
  outSample: positive, gain, mute: { type: 'boolean' } });
const eventBase = object({ eventId: id, shotId: id, prepareFrame: integer, visibleFrame: integer, peakFrame: integer,
  completeFrame: integer, readingEndFrame: integer, anchor: nullable(object({ kind: choices('word', 'beat'),
    placementId: id, pointId: id, phase: choices('visible', 'peak'),
    offsetSamples: { ...integer, minimum: -Number.MAX_SAFE_INTEGER }, precision: choices('hard', 'soft') })) });
const event = { ...eventBase, properties: { ...eventBase.properties, animation: choices('schedule', 'emphasis') } } as const;
const readingGroup = object({ groupId: id, eventIds: { ...array(id), minItems: 1, uniqueItems: true },
  minFrames: integer, endFrame: integer });
const caption = object({ lineId: id, startFrame: integer, endFrame: positive });

/** Integer frames and 48 kHz samples are authority; all intervals are half open. */
export const PRODUCTION_TIMELINE_SCHEMA = object({ version: { const: '0.1' }, sourceHash: hash, durationFrames: positive,
  shots: { ...array(shot), minItems: 1 }, clips: array(clip), takes: array(take), placements: array(placement),
  events: array(event), readingGroups: array(readingGroup), captionCues: array(caption) });
type Data<S> = S extends { const: infer C } ? C : S extends { enum: readonly (infer E)[] } ? E :
  S extends { anyOf: readonly (infer V)[] } ? Data<V> : S extends { type: 'null' } ? null :
  S extends { type: 'object', properties: infer P } ? { [K in keyof P]: Data<P[K]> } :
  S extends { type: 'array', items: infer I } ? Data<I>[] : S extends { type: 'string' } ? string :
  S extends { type: 'integer' | 'number' } ? number : S extends { type: 'boolean' } ? boolean : unknown;
export type ProductionTimeline = Omit<Data<typeof PRODUCTION_TIMELINE_SCHEMA>, 'shots' | 'events'> & {
  shots: (Omit<Data<typeof shot>, 'composition'> & { composition: Composition })[];
  events: (Data<typeof eventBase> & { animation?: 'schedule' | 'emphasis' })[];
};
const check = new Ajv({ allErrors: true, strict: true, strictRequired: false }).compile(PRODUCTION_TIMELINE_SCHEMA);
export function validateProductionTimeline(value: unknown): ProductionTimeline {
  if (!check(value)) throw Error('PRODUCTION_TIMELINE_INVALID: ' + collectSchemaErrors(check, value).join('; '));
  return value as ProductionTimeline;
}
