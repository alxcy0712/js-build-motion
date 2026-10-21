import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { activeAt, elementIssues, layoutPlanIssues, regionAt, type LayoutElement, type LayoutPlan, type Matrix, type Protection, type Rect } from './plan.ts';
export const IDENTITY: Matrix = [1,0,0,1,0,0];
export const rectPath = (r: Rect): Path2D => { const p = new Path2D(); p.rect(r.x,r.y,r.width,r.height); return p; };
export const pathBounds = (p: Path2D): Rect => ({ x:p.bounds.left, y:p.bounds.top, width:p.bounds.width, height:p.bounds.height });
export const matrixOf = (ctx: CanvasRenderingContext2D): Matrix => { const m=ctx.getTransform(); return [m.a,m.b,m.c,m.d,m.e,m.f]; };
export function multiply(a: Matrix, b: Matrix): Matrix { return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]; }
export const mapRect = (r: Rect, m: Matrix): Rect => pathBounds(rectPath(r).transform([...m]));
export interface TraceDraw extends LayoutElement {
  text?: string; operation: string; bounds: Rect; visible: Rect; alpha: number; matrix: Matrix;
  outputSpace: 'output'; sourceBounds: Rect; clipped: boolean; confidence: 'exact' | 'bounds';
  color?: string; scene?: string; phase?: string; order: number; protection?: Protection;
  /** Non-enumerable geometry in surface coordinates; JSON reports carry bounds. */
  geometry: Path2D; original: Path2D;
}
interface TraceState { time: number; scene?: string; phase?: string; plan: LayoutPlan; element?: LayoutElement; skip: boolean }
export interface LayoutTrace {
  draws: TraceDraw[]; limitations: Set<string>; state: TraceState;
  reset(time: number, plan?: LayoutPlan): void;
  protect(region: Protection, mapping?: Matrix): void;
}
// Copied project components and the frozen engine must share surface identity.
const surfaceKey = Symbol.for('js-build-motion.layout-trace');
const surfaces: WeakMap<object, LayoutTrace> = ((globalThis as any)[surfaceKey] ??= new WeakMap<object, LayoutTrace>());
function paint(style: unknown): { alpha: number; color?: string; exact: boolean } {
  if (typeof style !== 'string') return {alpha:1,exact:false};
  const rgba = style.match(/^rgba?\(([^)]+)\)$/), hex = style.match(/^#([0-9a-f]+)$/i);
  if (rgba) return {alpha:rgba[1]!.split(',').length===4?Number(rgba[1]!.split(',')[3]):1,color:style,exact:true};
  if (hex) return {alpha:hex[1]!.length===8?parseInt(hex[1]!.slice(6),16)/255:hex[1]!.length===4?parseInt(hex[1]!.slice(3).repeat(2),16)/255:1,color:style,exact:true};
  return {alpha:style==='transparent'?0:1,color:style,exact:style==='transparent'};
}
const hasShadow=(ctx:CanvasRenderingContext2D):boolean=>paint(ctx.shadowColor).alpha>0&&(ctx.shadowBlur>0||ctx.shadowOffsetX!==0||ctx.shadowOffsetY!==0);
function geometry(draw: Omit<TraceDraw,'geometry'|'original'>, visible: Path2D, original: Path2D): TraceDraw {
  return Object.defineProperties(draw,{geometry:{value:visible},original:{value:original}}) as TraceDraw;
}
/** Declarations only affect opt-in tracing; pixels and callback invocation stay unchanged. */
export function withLayout<T>(ctx: CanvasRenderingContext2D, element: LayoutElement | string, draw: () => T): T {
  const trace=surfaces.get(ctx.canvas); if (!trace) return draw();
  const e=typeof element==='string'?trace.state.plan.elements?.find(e=>e.id===element):element;
  if (!e) throw Error(`LAYOUT_ELEMENT_UNKNOWN: ${element}`);
  const issues=elementIssues(e); if (issues.length) throw Error(`LAYOUT_DECLARATION: ${issues.join('; ')}`);
  const old=trace.state.element;trace.state.element=e;
  try { return draw(); } finally { trace.state.element=old; }
}
export function layoutScope<T>(ctx: CanvasRenderingContext2D, state: Partial<TraceState>, draw: () => T): T {
  const trace=surfaces.get(ctx.canvas);if(!trace)return draw();
  const previous=trace.state;trace.state={...previous,...state};try{return draw();}finally{trace.state=previous;}
}
/** Opt-in Canvas tracing. Filled paths/glyphs and clips are exact; stroke/filter/bitmap interiors stay review candidates. */
export function trackLayout(ctx: CanvasRenderingContext2D): LayoutTrace {
  const existing=surfaces.get(ctx.canvas);if(existing)return existing;
  let clip=rectPath({x:0,y:0,width:ctx.canvas.width,height:ctx.canvas.height}), stack:Path2D[]=[], path=new Path2D(), pathMatrix:Matrix=IDENTITY, mixed=false;
  const trace:LayoutTrace={draws:[],limitations:new Set(),protect(r,mapping){
    if(r.scene!==this.state.scene||!activeAt(r.interval,this.state.time))return;
    if(r.space==='source'&&!mapping)throw Error('PROTECTION_SOURCE_MAPPING_REQUIRED');
    addProtected(r,mapping??(r.space==='world'?matrixOf(ctx):IDENTITY),clip);
  },state:{time:0,plan:{},skip:false},reset(time,plan={}){this.draws.length=0;this.limitations.clear();this.state={time,plan,skip:false};clip=rectPath({x:0,y:0,width:ctx.canvas.width,height:ctx.canvas.height});stack=[];path=new Path2D();mixed=false;}};
  surfaces.set(ctx.canvas,trace);
  const wrap=(method:string, after:(args:any[])=>void) => { const original=(ctx as any)[method].bind(ctx); (ctx as any)[method]=(...args:any[])=>{const result=original(...args);after(args);return result;}; };
  wrap('reset',()=>{clip=rectPath({x:0,y:0,width:ctx.canvas.width,height:ctx.canvas.height});stack=[];path=new Path2D();mixed=false;trace.draws.length=0;});
  wrap('save',()=>stack.push(clip));wrap('restore',()=>{clip=stack.pop()??clip;});
  wrap('beginPath',()=>{path=new Path2D();mixed=false;pathMatrix=matrixOf(ctx);});
  for(const name of ['moveTo','lineTo','bezierCurveTo','quadraticCurveTo','conicCurveTo','arcTo','arc','ellipse','rect','roundRect','closePath']) wrap(name,args=>{
    const m=matrixOf(ctx);if(path.edges.length===0)pathMatrix=m;
    else if(m.some((v,i)=>Math.abs(v-pathMatrix[i]!)>1e-6))mixed=true;
    (path as any)[name](...args);
  });
  const currentPath=(args:any[]):Path2D=>{
    if(args[0] instanceof Path2D)return args[0].simplify(args[1]??'nonzero').transform([...matrixOf(ctx)]);
    if(mixed)trace.limitations.add('path built under changing transforms: bounds require raster review');
    return path.simplify(typeof args[0]==='string'?args[0]:'nonzero').transform([...pathMatrix]);
  };
  wrap('clip',args=>{clip=clip.intersect(currentPath(args));});
  const add=(p:Path2D,operation:string,options:Partial<TraceDraw>={})=>{
    const {state}=trace;if(state.skip)return;
    const e=state.element,style=paint(operation.startsWith('stroke')?ctx.strokeStyle:ctx.fillStyle);
    const alpha=options.alpha??ctx.globalAlpha*style.alpha;
    if(alpha<=0)return;
    const visible=p.intersect(clip),bounds=pathBounds(p);
    const confidence=options.confidence??(style.exact&&!mixed&&ctx.filter==='none'&&!hasShadow(ctx)&&ctx.globalCompositeOperation==='source-over'?'exact':'bounds');
    if(confidence==='bounds')trace.limitations.add('stroke, shadow, filter, gradient, bitmap alpha or composite mode requires pixel review');
    const full=bounds.x<=0&&bounds.y<=0&&bounds.width>=ctx.canvas.width&&bounds.height>=ctx.canvas.height;
    const record=geometry({id:e?.id??`${state.scene??'screen'}:auto-${trace.draws.length}`,role:e?.role??(options.text?'text':full?'background':'shape'),
      space:e?.space??'world',...e,operation,bounds,visible:pathBounds(visible),alpha,matrix:matrixOf(ctx),outputSpace:'output',sourceBounds:bounds,
      clipped:p.difference(clip).bounds.width>0.5,confidence,color:style.color,scene:state.scene,phase:state.phase,order:trace.draws.length,...options},visible,p);
    trace.draws.push(record);
  };
  for(const name of ['fillRect','strokeRect'] as const)wrap(name,([x,y,width,height])=>{
    const pad=name==='strokeRect'?ctx.lineWidth/2:0;
    add(rectPath({x:x-pad,y:y-pad,width:width+2*pad,height:height+2*pad}).transform([...matrixOf(ctx)]),name,name==='strokeRect'?{confidence:'bounds'}:{});
  });
  for(const name of ['fill','stroke'] as const)wrap(name,args=>{
    let p=currentPath(args);
    if(name==='stroke'){const b=pathBounds(p),m=matrixOf(ctx),pad=ctx.lineWidth/2*Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[2],m[3]));p=rectPath({x:b.x-pad,y:b.y-pad,width:b.width+2*pad,height:b.height+2*pad});}
    add(p,name,name==='stroke'?{confidence:'bounds'}:{});
  });
  for(const name of ['fillText','strokeText'] as const)wrap(name,([text,x,y,maxWidth])=>{
    if(!String(text).trim())return;
    const outline=maxWidth===undefined?ctx.outlineText(String(text)):ctx.outlineText(String(text),maxWidth);
    if (!outline) { const m=ctx.measureText(String(text));trace.limitations.add('font outline unavailable');add(rectPath({x:x-m.actualBoundingBoxLeft,y:y-m.actualBoundingBoxAscent,width:m.actualBoundingBoxLeft+m.actualBoundingBoxRight,height:m.actualBoundingBoxAscent+m.actualBoundingBoxDescent}).transform([...matrixOf(ctx)]),name,{text:String(text),confidence:'bounds'});return; }
    let p=outline.transform([...multiply(matrixOf(ctx),[1,0,0,1,x,y])]);
    if(name==='strokeText'){
      const b=pathBounds(p),m=matrixOf(ctx),pad=ctx.lineWidth/2,px=pad*Math.hypot(m[0],m[2]),py=pad*Math.hypot(m[1],m[3]);
      p=rectPath({x:b.x-px,y:b.y-py,width:b.width+2*px,height:b.height+2*py});
    }
    add(p,name,{text:String(text),...(name==='strokeText'?{confidence:'bounds' as const}:{})});
  });
  wrap('putImageData',()=>{if(!trace.state.skip)trace.limitations.add('putImageData bypasses path tracking; direct pixel writes require pixel review');});
  wrap('clearRect',([x,y,width,height])=>{
    const cleared=rectPath({x,y,width,height}).transform([...matrixOf(ctx)]).intersect(clip);
    trace.draws=trace.draws.map(d=>geometry({...d,visible:pathBounds(d.geometry.difference(cleared))},d.geometry.difference(cleared),d.original));
    if(x===0&&y===0&&width===ctx.canvas.width&&height===ctx.canvas.height&&matrixOf(ctx).every((v,i)=>v===IDENTITY[i]))trace.draws.length=0;
  });
  const addProtected=(r:Protection,m:Matrix,target:Path2D)=>{
    const b=regionAt(r,trace.state.time),padding=r.padding??0;
    const local=rectPath({x:b.x-padding,y:b.y-padding,width:b.width+2*padding,height:b.height+2*padding});
    const original=local.transform([...m]),p=original.intersect(target);
    trace.draws.push(geometry({id:r.id,role:r.kind==='caption'?'caption':'shape',required:true,space:r.space,operation:'protect',
      bounds:pathBounds(original),visible:pathBounds(p),sourceBounds:b,alpha:ctx.globalAlpha,matrix:m,outputSpace:'output',
      clipped:original.difference(target).bounds.width>0.5,confidence:r.status==='confirmed'?'exact':'bounds',scene:r.scene,phase:trace.state.phase,
      order:trace.draws.length,protection:r},p,original));
  };
  wrap('drawImage',([image,...coords])=>{
    if(trace.state.skip)return;
    const [sx,sy,sw,sh,dx,dy,dw,dh]=coords.length===8?coords:[0,0,image.width,image.height,coords[0],coords[1],coords[2]??image.width,coords[3]??image.height];
    const mapping=multiply(matrixOf(ctx),[dw/sw,0,0,dh/sh,dx-sx*dw/sw,dy-sy*dh/sh]);
    const crop=rectPath({x:sx,y:sy,width:sw,height:sh}),destination=rectPath({x:dx,y:dy,width:dw,height:dh}).transform([...matrixOf(ctx)]),target=destination.intersect(clip);
    const source=surfaces.get(image);
    if(source){
      if(ctx.filter!=='none'||hasShadow(ctx)||ctx.globalCompositeOperation!=='source-over')trace.limitations.add('filtered, shadowed or composited offscreen surface requires pixel review');
      for(const limit of source.limitations)trace.limitations.add(limit);
      for(const d of [...source.draws]){
        const fixed=d.protection?.space==='output';
        const original=fixed?d.original:d.original.transform([...mapping]),p=fixed?d.geometry.intersect(clip):d.geometry.intersect(crop).transform([...mapping]).intersect(target);
        trace.draws.push(geometry({...d,bounds:pathBounds(original),visible:pathBounds(p),matrix:fixed?d.matrix:multiply(mapping,d.matrix),alpha:d.alpha*ctx.globalAlpha,
          clipped:d.clipped||original.difference(p).bounds.width>0.5,order:trace.draws.length,
          confidence:ctx.filter==='none'&&!hasShadow(ctx)&&ctx.globalCompositeOperation==='source-over'?d.confidence:'bounds'},p,original));
      }
    }else add(destination,'drawImage',{sourceBounds:{x:sx,y:sy,width:sw,height:sh},role:trace.state.element?.role??'media',alpha:ctx.globalAlpha,confidence:'bounds'});
    for(const r of trace.state.plan.protections??[]){
      if(r.target!==trace.state.element?.id||r.scene!==trace.state.scene||!activeAt(r.interval,trace.state.time))continue;
      const m=r.space==='source'?mapping:r.space==='world'?matrixOf(ctx):IDENTITY;
      addProtected(r,m,r.space==='output'?clip:target);
    }
  });
  return trace;
}

/** Manually reviewed world/screen region; source coordinates require an explicit source-to-surface matrix. */
export function protectLayout(ctx:CanvasRenderingContext2D,region:Protection,mapping?:Matrix):void {
  const trace=surfaces.get(ctx.canvas);if(!trace)return;
  const issues=layoutPlanIssues({protections:[region]});if(issues.length)throw Error('PROTECTION_DECLARATION: '+issues.join('; '));
  trace.protect(region,mapping);
}
