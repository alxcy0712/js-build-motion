import { spring, type SpringOptions } from '../animation/spring.ts';
import { cubicBezier, springOvershoot } from '../themes/motion.ts';
import type { ThemeTokens } from '../themes/types.ts';
export const STAGGER = { tight:.04, normal:.08, loose:.14 } as const;
const clamp = (v:number) => Math.max(0,Math.min(1,v));
export function tokenSpring(theme:ThemeTokens,role:'reading'|'accent'):SpringOptions {
  const p=theme.springs[role==='reading'?'text':'accent'],mass=p.mass??1;
  // ζ >= .75 gives <3% analytic overshoot; minimal reading uses critical damping or stronger.
  return {...p,mass,damping:Math.max(p.damping,2*Math.sqrt(p.stiffness*mass)*(role==='reading'&&theme.id==='minimal'?1:.75))};
}
export function validateMotionToken(theme:ThemeTokens,role:'reading'|'accent',p=tokenSpring(theme,role)):string[] {
  if(!(p.stiffness!>0&&p.damping!>0&&(p.mass??1)>0))return ['MOTION_TOKEN_PARAMETERS'];
  const max=role==='reading'&&theme.id==='minimal'?0:.03;
  return springOvershoot(p as Required<SpringOptions>)>max+1e-9?['MOTION_TOKEN_OVERSHOOT']:[];
}
export function enter(theme:ThemeTokens,kind:'soft'|'snap'|'pop',seconds:number,role:'reading'|'accent'='reading') {
  const duration=theme.durations.enter*(kind==='snap'?.55:1),p=clamp(seconds/duration),e=cubicBezier(theme.easings.enter)(p);
  const s=spring(Math.max(0,seconds),tokenSpring(theme,role));
  return {opacity:e,y:kind==='soft'?18*(1-e):0,scale:kind==='pop'?.94+.06*s:1,progress:kind==='pop'?s:e};
}
export function emphasis(theme:ThemeTokens,kind:'pulse'|'underline'|'scalePunch',progress:number,role:'reading'|'accent'='accent') {
  const p=clamp(progress),wave=Math.sin(Math.PI*cubicBezier(theme.easings.enter)(p));
  return {opacity:1,scale:1+(kind==='scalePunch'&&!(theme.id==='minimal'&&role==='reading')?.03*wave:0),
    intensity:kind==='pulse'?wave:0,reveal:kind==='underline'?cubicBezier(theme.easings.enter)(p):1};
}
export function exit(theme:ThemeTokens,seconds:number) {const p=cubicBezier(theme.easings.exit)(clamp(seconds/theme.durations.exit));return {opacity:1-p,y:-8*p};}
export function stagger(index:number,kind:keyof typeof STAGGER='normal'):number {if(!Number.isInteger(index)||index<0)throw Error('STAGGER_INDEX');return index*STAGGER[kind];}
/** Absolute seconds; callers retain control of sound anchors and full-result reading time. */
export function beats(start:number,reveal:number,emphasisSeconds:number,settle:number) {
  if(![start,reveal,emphasisSeconds,settle].every(Number.isFinite)||start<0||Math.min(reveal,emphasisSeconds,settle)<0)throw Error('MOTION_BEATS');
  return {reveal:{start,end:start+reveal},emphasis:{start:start+reveal,end:start+reveal+emphasisSeconds},settle:{start:start+reveal+emphasisSeconds,end:start+reveal+emphasisSeconds+settle}};
}
