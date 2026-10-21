import type { ResolvedVideoSpec } from '../spec/types.ts';
import { getTheme } from '../themes/registry.ts';
import { transitionDuration, FADE_DURATION } from '../pipeline/theme-transitions.ts';
/** Sparse stable frames plus every encoded frame around declared events, entries, exits and cuts. */
export function layoutSamples(spec:ResolvedVideoSpec,options:{step?:number;allFrames?:boolean;from?:number;to?:number}={}) {
  const {fps,duration}=spec.video,total=Math.ceil(fps*duration),from=options.from??0,to=options.to??duration,step=options.step??.2;
  if(![from,to,step].every(Number.isFinite)||from<0||to<=from||to>duration||step<=0)throw Error('LAYOUT_SAMPLING_RANGE');
  const first=Math.ceil(from*fps),last=Math.min(total-1,Math.ceil(to*fps)-1),frames=new Set<number>();
  const add=(f:number)=>{if(f>=first&&f<=last)frames.add(f);};
  const dense=(a:number,b:number)=>{for(let f=Math.max(first,Math.floor(a*fps)-1);f<=Math.min(last,Math.ceil(b*fps)+1);f++)add(f);};
  for(let t=from;t<to;t+=step)add(Math.round(t*fps));add(first);add(last);
  const theme=getTheme(spec.style.theme);
  for(const scene of spec.scenes){const fade=scene.transition==='fade'?FADE_DURATION:0;dense(scene.start,Math.min(scene.end,scene.start+Math.max(fade,theme.durations.enter,transitionDuration(scene.transition,theme))));dense(Math.max(scene.start,scene.end-Math.max(fade,theme.durations.exit)),scene.end);}
  for(const e of spec.layout?.elements??[])if(e.interval){dense(e.interval.start-.1,e.interval.start+.1);dense(e.interval.end-.1,e.interval.end+.1);}
  for(const r of spec.layout?.protections??[]){dense(r.interval.start-.1,r.interval.start+.1);dense(r.interval.end-.1,r.interval.end+.1);for(const k of r.keyframes??[])dense(k.at-.1,k.at+.1);}
  for(const e of spec.layout?.motion??[])dense(e.start,e.end);
  for(const w of spec.layout?.windows??[])dense(w.start,w.end);
  if(options.allFrames)dense(from,to);
  return {frames:[...frames].sort((a,b)=>a-b),interval:{start:from,end:to},stepSeconds:step,allFrames:frames.size===last-first+1,
    limitations:options.allFrames?[]:['undeclared sub-sample events may be missed; add windows or --all-frames']};
}
