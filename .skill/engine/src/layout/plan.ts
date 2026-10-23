import { Ajv } from 'ajv';
export interface Rect { x: number; y: number; width: number; height: number }
export type Matrix = readonly [number, number, number, number, number, number];
export interface Interval { start: number; end: number }
export type Space = 'world' | 'screen' | 'source' | 'output';
export type Role = 'text' | 'shape' | 'caption' | 'source' | 'media' | 'decoration' | 'background';
export interface LayoutElement {
  id: string; role: Role; parent?: string; required?: boolean; space?: Space; scene?: string;
  interval?: Interval; boundary?: 'canvas' | 'safe' | 'parent' | Rect; slot?: string;
  overlay?: { intent: 'emphasis' | 'annotation' | 'transition'; target: string; region: Rect; interval: Interval };
  reading?: boolean;
  /** Absolute output seconds; geometry is measured from actual drawing. */
  textMotion?: Interval & { easing?: string };
  endCard?: { part: 'avatar' | 'name' | 'slogan'; wordStart?: number; holdStart: number; holdEnd: number };
}
export type ProtectedKind = 'caption' | 'face' | 'cursor' | 'target' | 'reading';
export interface Protection {
  id: string; kind: ProtectedKind; target: string; scene: string; space: Space; source: string;
  status: 'confirmed' | 'unverified'; interval: Interval; padding?: number;
  rect?: Rect; keyframes?: { at: number; rect: Rect }[];
}
export interface MotionEvent { id: string; scene: string; group?: string; layer: 'subject' | 'secondary' | 'camera';
  enter: string; start: number; end: number; needsStagger?: boolean; mainEvent?: boolean }
export interface LayoutPlan {
  elements?: LayoutElement[]; protections?: Protection[];
  requirements?: { scene: string; kinds: ProtectedKind[] }[];
  holds?: (Interval & { purpose: 'reading' | 'hold' | 'demonstration'; reason: string })[];
  motion?: MotionEvent[]; windows?: Interval[];
}
const number = { type: 'number' }, text = { type: 'string', minLength: 1 };
const object = (properties: object, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: object) => ({ type: 'array', items });
const rect = object({ x: number, y: number, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, ['x','y','width','height']);
const interval = object({ start: { type: 'number', minimum: 0 }, end: { type: 'number', exclusiveMinimum: 0 } }, ['start','end']);
const space = { enum: ['world','screen','source','output'] }, kinds = { enum: ['caption','face','cursor','target','reading'] };
export const LAYOUT_ELEMENT_SCHEMA = object({
  id: text, role: { enum: ['text','shape','caption','source','media','decoration','background'] }, parent: text,
  required: { type: 'boolean' }, space, scene: text, interval, slot: text, reading: { type: 'boolean' },
  boundary: { anyOf: [{ enum: ['canvas','safe','parent'] }, rect] },
  textMotion: object({ ...interval.properties, easing: text }, ['start','end']),
  endCard: object({ part: { enum: ['avatar','name','slogan'] }, wordStart: { type: 'number', minimum: 0 },
    holdStart: { type: 'number', minimum: 0 }, holdEnd: { type: 'number', exclusiveMinimum: 0 } }, ['part','holdStart','holdEnd']),
  overlay: object({ intent: { enum: ['emphasis','annotation','transition'] }, target: text, region: rect, interval }, ['intent','target','region','interval']),
}, ['id','role']);
export const LAYOUT_PLAN_SCHEMA = object({
  elements: array(LAYOUT_ELEMENT_SCHEMA),
  protections: array(object({ id: text, kind: kinds, target: text, scene: text, space, source: text,
    status: { enum: ['confirmed','unverified'] }, interval, padding: { type: 'number', minimum: 0 }, rect,
    keyframes: { type: 'array', minItems: 1, items: object({ at: number, rect }, ['at','rect']) },
  }, ['id','kind','target','scene','space','source','status','interval'])),
  requirements: array(object({ scene: text, kinds: { type: 'array', minItems: 1, uniqueItems: true, items: kinds } }, ['scene','kinds'])),
  holds: array(object({ start: number, end: number, purpose: { enum: ['reading','hold','demonstration'] }, reason: text }, ['start','end','purpose','reason'])),
  motion: array(object({ id: text, scene: text, group: text, layer: { enum: ['subject','secondary','camera'] }, enter: text,
    start: number, end: number, needsStagger: { type: 'boolean' }, mainEvent: { type: 'boolean' } }, ['id','scene','layer','enter','start','end'])),
  windows: array(interval),
});
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePlan = ajv.compile(LAYOUT_PLAN_SCHEMA), validateElement = ajv.compile(LAYOUT_ELEMENT_SCHEMA);
export function elementIssues(value: unknown): string[] {
  if (!validateElement(value)) return (validateElement.errors ?? []).map(e => `${e.instancePath} ${e.message}`);
  const e = value as LayoutElement;
  const issues = [e.interval, e.overlay?.interval, e.textMotion].filter(i => i && i.end <= i.start).map(() => 'interval.end must exceed start');
  if (e.endCard && e.endCard.holdEnd <= e.endCard.holdStart) issues.push('endCard.holdEnd must exceed holdStart');
  if (e.endCard && e.endCard.part !== 'avatar' && e.endCard.wordStart === undefined) issues.push('endCard text requires wordStart');
  return issues;
}
export function layoutPlanIssues(value: unknown, scenes?: readonly { id: string; start: number; end: number }[]): string[] {
  if (!validatePlan(value)) return (validatePlan.errors ?? []).map(e => `${e.instancePath} ${e.message}`);
  const p = value as LayoutPlan, issues: string[] = [], ids = new Set<string>();
  for (const e of p.elements ?? []) {
    if (ids.has(e.id)) issues.push(`duplicate element ${e.id}`); ids.add(e.id);
    issues.push(...elementIssues(e).map(i => `${e.id}: ${i}`));
  }
  for (const e of p.elements ?? []) {
    if (e.parent && !ids.has(e.parent)) issues.push(`${e.id}: unknown parent ${e.parent}`);
    if (e.overlay && !ids.has(e.overlay.target)) issues.push(`${e.id}: unknown overlay target ${e.overlay.target}`);
    const visited = new Set([e.id]); let parent = e.parent;
    while (parent) { if (visited.has(parent)) { issues.push(`${e.id}: parent cycle`); break; } visited.add(parent); parent = p.elements?.find(n => n.id === parent)?.parent; }
  }
  const regions = new Set<string>();
  for (const r of p.protections ?? []) {
    if (regions.has(r.id)) issues.push(`duplicate protection ${r.id}`); regions.add(r.id);
    if (Boolean(r.rect) === Boolean(r.keyframes)) issues.push(`${r.id}: specify rect or keyframes`);
    if (r.interval.end <= r.interval.start) issues.push(`${r.id}: invalid interval`);
    if (scenes && !scenes.some(s => s.id === r.scene && r.interval.start >= s.start && r.interval.end <= s.end)) issues.push(`${r.id}: protection must belong to one shot`);
    if (r.keyframes?.some((k, i, a) => k.at < r.interval.start || k.at > r.interval.end || (i > 0 && k.at <= a[i-1]!.at))) issues.push(`${r.id}: ordered keyframes within interval required`);
  }
  for (const item of [...(p.elements ?? []), ...(p.motion ?? []), ...(p.requirements ?? [])]) if (scenes && item.scene && !scenes.some(s => s.id === item.scene)) issues.push(`unknown scene ${item.scene}`);
  for (const i of [...(p.holds ?? []), ...(p.windows ?? []), ...(p.motion ?? [])]) if (i.start < 0 || i.end <= i.start) issues.push('invalid time interval');
  return issues;
}
export const activeAt = (interval: Interval | undefined, time: number): boolean => !interval || (time >= interval.start && time < interval.end);
export function regionAt(r: Protection, time: number): Rect {
  if (r.rect) return r.rect;
  const keys = r.keyframes!; let a = keys[0]!;
  for (const b of keys.slice(1)) { if (time <= b.at) { const t = Math.max(0, (time-a.at)/(b.at-a.at)); return { x:a.rect.x+(b.rect.x-a.rect.x)*t, y:a.rect.y+(b.rect.y-a.rect.y)*t, width:a.rect.width+(b.rect.width-a.rect.width)*t, height:a.rect.height+(b.rect.height-a.rect.height)*t }; } a=b; }
  return a.rect;
}
