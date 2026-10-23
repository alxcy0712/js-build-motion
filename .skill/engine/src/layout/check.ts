import { Path2D } from 'skia-canvas';
import { activeAt, type LayoutPlan, type Rect } from './plan.ts';
import { rectPath, pathBounds, type LayoutTrace, type TraceDraw } from './trace.ts';
import { VERTICAL_SHORT_LAYOUT } from '../themes/shared.ts';
export interface LayoutIssue {
  code: string; severity: 'error' | 'review' | 'coverage'; frame: number; time: number;
  elements: string[]; text: string[]; spaces: string[]; bounds: Rect[]; area: number; ratio: number;
  basis: string; preview: { frame: number; region: Rect | null };
}
function area(p: Path2D): number {
  const b=pathBounds(p);if(b.width<=0||b.height<=0)return 0;
  const nx=Math.min(40,Math.max(1,Math.ceil(b.width))),ny=Math.min(40,Math.max(1,Math.ceil(b.height)));
  let n=0;for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)if(p.contains(b.x+(x+.5)*b.width/nx,b.y+(y+.5)*b.height/ny))n++;
  return b.width*b.height*n/(nx*ny);
}
const text = (d: TraceDraw): boolean => d.text!==undefined;
const intersect = (a: Rect,b: Rect): boolean => a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const contained = (a: Rect,b: Rect): boolean => a.x>=b.x-.5&&a.y>=b.y-.5&&a.x+a.width<=b.x+b.width+.5&&a.y+a.height<=b.y+b.height+.5;
const equal = (a: Rect,b: Rect): boolean => ['x','y','width','height'].every(k=>Math.abs(a[k as keyof Rect]-b[k as keyof Rect])<.5);
export function inspectLayout(trace: Pick<LayoutTrace,'draws'|'limitations'>, options: { frame:number; fps:number; width:number; height:number; safe:Rect; plan?:LayoutPlan }): { ok:boolean; status:'pass'|'error'|'pending'; issues:LayoutIssue[]; draws:number; limitations:string[] } {
  const {frame,fps,width,height,safe}=options,time=frame/fps,plan=options.plan??{},issues:LayoutIssue[]=[];
  const all=trace.draws.filter(d=>d.alpha>=.15&&d.visible.width>0&&d.visible.height>0), canvas={x:0,y:0,width,height};
  const add=(code:string,severity:LayoutIssue['severity'],elements:TraceDraw[],basis:string,p?:Path2D,ratio=0)=>{
    const region=p?pathBounds(p):elements[0]?.bounds??null;
    issues.push({code,severity,frame,time,elements:elements.map(d=>d.id),text:elements.flatMap(d=>d.text?[d.text]:d.protection?[d.protection.kind]:[]),
      spaces:elements.map(d=>`${d.space??'world'} → output`),bounds:elements.map(d=>d.bounds),area:p?area(p):0,ratio,basis,preview:{frame,region}});
  };
  const hidden=(d:TraceDraw):boolean=>all.some(o=>o.order>d.order&&o.role==='background'&&o.alpha>=.999&&o.confidence==='exact'&&o.scene!==d.scene&&contained(d.visible,o.visible));
  const visible=all.filter(d=>!hidden(d));
  const effectiveAlpha=(d:TraceDraw,p:Path2D)=>all.filter(o=>o.order>d.order&&!text(o)&&!o.protection&&o.confidence==='exact'&&contained(pathBounds(p),o.visible)).reduce((a,o)=>a*(1-o.alpha),d.alpha);
  const allowed=(a:TraceDraw,b:TraceDraw,p:Path2D):boolean=>{
    for(const [d,target] of [[a,b],[b,a]]){
      const o=d!.overlay;if(!o||o.target!==target!.id||!activeAt(o.interval,time)||!contained(pathBounds(p),o.region))continue;
      if(a.protection||b.protection||a.role==='caption'||b.role==='caption')continue;
      if(text(a)&&text(b)&&(a.reading!==false||b.reading!==false))continue;
      if(text(target!)&&target!.reading!==false&&d!.order>target!.order)continue;
      return true;
    }return false;
  };
  for(const d of trace.draws.filter(d=>d.alpha>=.15)){
    if(d.interval&&!activeAt(d.interval,time))add('LAYOUT_INTERVAL_MISMATCH','review',[d],'draw is visible outside its declared half-open interval');
    if(d.protection?.status==='unverified')add('PROTECTION_UNVERIFIED','coverage',[d],d.protection.source);
    if(hidden(d))continue;
    if(text(d)&&d.role!=='decoration'&&d.role!=='background') {
      const limit=d.role==='caption'?{...canvas,x:safe.x,width:safe.width}:safe;
      if(d.visible.width>0&&(d.bounds.x<limit.x-1e-6||d.bounds.y<limit.y-1e-6||d.bounds.x+d.bounds.width>limit.x+limit.width+1e-6||d.bounds.y+d.bounds.height>limit.y+limit.height+1e-6))add('TEXT_SAFE_AREA',d.confidence==='exact'?'error':'review',[d],
        'visible text ink crosses the platform safe area; captions share its horizontal margins',d.original.difference(rectPath(limit)));
    }
    if(height>width&&!text(d)&&d.role!=='caption'&&d.role!=='background'&&d.role!=='decoration') {
      const buttons=rectPath({x:safe.x+safe.width,y:safe.y,width:width-safe.x-safe.width,height:height-safe.y});
      const overlap=d.geometry.intersect(buttons);
      if(area(overlap)>.5) {
        if(d.required)add('BUTTON_ZONE_INTRUSION',d.confidence==='exact'?'error':'review',[d],
          'required graphic enters the reserved right-side button column, including visible entry frames',overlap);
        else if(d.id.includes(':auto-'))add('BUTTON_ZONE_SEMANTICS_REQUIRED','coverage',[d],
          'declare whether this button-column graphic is required content or decoration',overlap);
      }
    }
    let boundary=typeof d.boundary==='object'?d.boundary:d.boundary==='safe'||(!d.boundary&&d.required&&text(d)&&d.role!=='caption')?safe:canvas;
    if(d.boundary==='parent'){
      const parent=all.find(p=>p.id===d.parent&&p.scene===d.scene&&!text(p));
      if(!parent){add('PARENT_NOT_TRACED','coverage',[d],'declared container is absent');continue;} boundary=parent.visible;
    }
    if(d.required&&activeAt(d.interval,time)&&(d.clipped||!contained(d.bounds,boundary)))add('REQUIRED_CONTENT_CLIPPED',d.confidence==='exact'?'error':'review',[d],'required geometry crosses its canvas, clip, safe area or container',d.original.difference(rectPath(boundary)));
  }
  for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++){
    const a=visible[i]!,b=visible[j]!;
    if(!intersect(a.visible,b.visible))continue;
    if(!a.protection&&!b.protection){
      const backdrop=[a,b].find(d=>d.role==='background'||d.role==='decoration'),other=backdrop===a?b:a;
      if(backdrop&&(!text(other)||other.reading===false||backdrop.order<other.order))continue;
    }
    if(a.protection?.target===b.id||b.protection?.target===a.id)continue;
    if(a.id===b.id&&a.scene===b.scene&&(a.role==='caption'||b.role==='caption'))continue;
    if(text(a)&&text(b)&&a.text===b.text&&equal(a.bounds,b.bounds)&&a.scene===b.scene)continue;
    const p=a.geometry.intersect(b.geometry),overlap=area(p);if(overlap<.5)continue;
    const ratio=overlap/Math.max(.5,Math.min(area(a.geometry),area(b.geometry)));
    const protectedDraw=a.protection?a:b.protection?b:undefined;
    if(protectedDraw){
      const other=protectedDraw===a?b:a;
      if(other.protection||other.order<protectedDraw.order)continue;
      add('PROTECTED_OCCLUSION',protectedDraw.protection!.status==='confirmed'&&other.confidence==='exact'?'error':'review',[a,b],`confirmed target ${protectedDraw.protection!.kind}; source: ${protectedDraw.protection!.source}; overlay intent does not waive protection`,p,ratio);continue;
    }
    if(allowed(a,b,p))continue;
    const exact=a.confidence==='exact'&&b.confidence==='exact';
    if(text(a)&&text(b)){
      if(effectiveAlpha(a,p)<.15||effectiveAlpha(b,p)<.15)continue;
      add(a.scene!==b.scene?'TRANSITION_TEXT_OVERLAP':'TEXT_OVERLAP',exact?'error':'review',[a,b],'visible glyph outlines intersect; area and ratio are sampled ink estimates',p,ratio);continue;
    }
    const t=text(a)?a:text(b)?b:undefined,s=t===a?b:a;
    if(!t)continue;
    if(t.parent===s.id&&contained(t.bounds,s.visible)&&s.order<t.order)continue;
    if(t.id===s.id&&s.order<t.order)continue;
    if(s.role==='media'&&s.order<t.order)continue;
    if(s.order>t.order&&t.reading!==false){add('TEXT_OCCLUDED',exact?'error':'review',[t,s],'later paint covers readable glyphs',p,ratio);continue;}
    if(!contained(t.bounds,s.visible)&&area(t.geometry.difference(s.geometry))>.5)add('TEXT_SHAPE_EDGE',exact?'error':'review',[t,s],'glyphs cross a painted shape edge',p,ratio);
    else if(s.order<t.order&&t.parent!==s.id&&s.role!=='caption')add('CONTAINMENT_REVIEW','review',[t,s],'contained text: declare its parent or a targeted overlay',p,ratio);
  }
  // Caption plate plus padding is a reservation, including earlier scene content.
  const captions=new Map<string,TraceDraw[]>();
  for(const d of visible.filter(d=>d.role==='caption'))captions.set(d.id,[...(captions.get(d.id)??[]),d]);
  for(const group of captions.values()){
    const box=group.map(d=>d.visible).reduce((a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.max(a.x+a.width,b.x+b.width)-Math.min(a.x,b.x),height:Math.max(a.y+a.height,b.y+b.height)-Math.min(a.y,b.y)}));
    const reserve=rectPath({x:box.x-8,y:box.y-8,width:box.width+16,height:box.height+16});
    for(const d of visible.filter(d=>d.endCard)) {
      const gap=box.y-d.bounds.y-d.bounds.height,minimum=VERTICAL_SHORT_LAYOUT.bigTextSubtitleGap*height/1920;
      if(gap<minimum-1e-6)add('ENDCARD_CAPTION_GAP',d.confidence==='exact'?'error':'review',[d,group[0]!],
        `end card to caption gap ${gap.toFixed(2)}px is below ${minimum.toFixed(2)}px`);
    }
    for(const d of visible){if(d.role==='caption'||d.role==='background'||d.role==='decoration'||d.role==='media'||d.protection)continue;
      if(!text(d)&&!d.required)continue;const p=d.geometry.intersect(reserve);if(area(p)>.5)add('CAPTION_OCCLUSION',d.confidence==='exact'?'error':'review',[d,group[0]!],'content enters the caption plate and 8 output-pixel reservation',p);}
  }
  for(const r of plan.protections??[])if(activeAt(r.interval,time)&&!all.some(d=>d.protection?.id===r.id))add('PROTECTION_NOT_TRACED','coverage',[],`${r.id}: ${r.scene}/${r.target}, ${r.source}; attachment absent or outside the visible crop`);
  for(const req of plan.requirements??[])if(trace.draws.some(d=>d.scene===req.scene))for(const kind of req.kinds)if(!all.some(d=>d.scene===req.scene&&d.protection?.kind===kind&&d.protection.status==='confirmed')&&!(kind==='caption'&&captions.size))add('PROTECTION_COVERAGE_MISSING','coverage',[],`${req.scene}: confirmed ${kind} region required`);
  for (const d of all.filter(d => d.role === 'media')) if (!(plan.protections ?? []).some(r => r.target === d.id && r.scene === d.scene && activeAt(r.interval,time))) add('MEDIA_PROTECTION_UNDECLARED','coverage',[d],'source subjects require reviewed regions; bitmap interiors have no semantic coverage');
  const errors=issues.some(i=>i.severity==='error'),pending=issues.some(i=>i.severity!=='error')||trace.limitations.size>0;
  return {ok:!errors,status:errors?'error':pending?'pending':'pass',issues,draws:all.length,limitations:[...trace.limitations,'sampled frames only; bitmap/path-encoded text and undetected source subjects need reviewed protection regions']};
}
