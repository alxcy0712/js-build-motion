import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { trackLayout, withLayout, matrixOf, mapRect } from '../src/layout/trace.ts';
import { inspectLayout } from '../src/layout/check.ts';
import { frame, follow, sourceMapping } from '../src/layout/tools.ts';
import { layoutPlanIssues, type LayoutPlan } from '../src/layout/plan.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { layoutFixtureSpec, drawBrokenLayout } from './fixtures/layout-scenes.ts';
function fixture(plan:LayoutPlan={}) {
  const canvas=new Canvas(400,300),ctx=canvas.getContext('2d'),trace=trackLayout(ctx);trace.reset(.5,plan);trace.state.scene='shot';
  ctx.font='30px sans-serif';ctx.fillStyle='#fff';
  const report=()=>inspectLayout(trace,{frame:15,fps:30,width:400,height:300,safe:{x:20,y:20,width:360,height:260},plan});
  return {canvas,ctx,trace,report};
}
test('unrelated glyphs collide, low alpha is filtered, clipping and tracing preserve pixels',()=>{
  const {ctx,report,trace}=fixture();ctx.fillText('Alpha',40,100);ctx.fillText('Beta',40,100);
  assert.ok(report().issues.some(i=>i.code==='TEXT_OVERLAP'&&i.severity==='error'&&i.area>0));
  trace.reset(.5);ctx.globalAlpha=.1;ctx.fillText('Alpha',40,100);ctx.globalAlpha=1;ctx.fillText('Beta',40,100);assert.equal(report().ok,true);
  trace.reset(.5);ctx.save();ctx.beginPath();ctx.rect(0,0,20,300);ctx.clip();ctx.fillText('Hidden',40,100);ctx.restore();ctx.fillText('Beta',40,100);assert.equal(report().ok,true);
});
test('own parent, underlining and targeted translucent highlight retain readable content',()=>{
  const {ctx,report}=fixture();
  withLayout(ctx,{id:'card',role:'shape'},()=>{ctx.fillStyle='#333';ctx.fillRect(20,40,300,120);});
  withLayout(ctx,{id:'highlight',role:'shape',overlay:{intent:'emphasis',target:'label',region:{x:20,y:40,width:300,height:120},interval:{start:0,end:1}}},()=>{ctx.fillStyle='#995500';ctx.fillRect(40,65,150,40);});
  withLayout(ctx,{id:'label',role:'text',parent:'card',required:true,boundary:'parent'},()=>{ctx.fillStyle='#fff';ctx.fillText('Alpha',40,100);});
  withLayout(ctx,{id:'underline',role:'shape',overlay:{intent:'annotation',target:'label',region:{x:20,y:40,width:300,height:120},interval:{start:0,end:1}}},()=>ctx.fillRect(40,110,80,2));
  assert.equal(report().ok,true,JSON.stringify(report()));
});
test('required glyph clipping, parent overflow, later opaque cover and shape-edge crossing are errors',()=>{
  for(const mode of ['clip','parent','cover','edge']){
    const {ctx,report}=fixture();
    withLayout(ctx,{id:'card',role:'shape'},()=>{ctx.fillStyle='#333';ctx.fillRect(20,40,65,120);});ctx.fillStyle='#fff';
    if(mode==='clip'){ctx.beginPath();ctx.rect(0,0,60,300);ctx.clip();}
    withLayout(ctx,{id:'text',role:'text',required:true,...(mode==='parent'?{parent:'card',boundary:'parent' as const}:{})},()=>ctx.fillText('Overflow',40,100));
    if(mode==='cover')withLayout(ctx,{id:'lid',role:'shape'},()=>ctx.fillRect(40,70,100,40));
    assert.equal(report().ok,false,mode);
  }
});
test('protected source keyframes follow source crop, destination scale, camera and clip; overlays cannot waive protection',()=>{
  const plan:LayoutPlan={protections:[{id:'face',kind:'face',target:'clip',scene:'shot',space:'source',source:'manual reviewed frame',status:'confirmed',interval:{start:0,end:1},keyframes:[{at:0,rect:{x:20,y:20,width:20,height:20}},{at:1,rect:{x:40,y:20,width:20,height:20}}]}]};
  const {ctx,trace,report}=fixture(plan),source=new Canvas(100,100);
  ctx.translate(10,5);ctx.scale(2,2);
  withLayout(ctx,{id:'clip',role:'media'},()=>ctx.drawImage(source,20,0,80,100,0,0,80,100));
  const region=trace.draws.find(d=>d.id==='face')!;assert.deepEqual(region.visible,{x:30,y:45,width:40,height:40});
  withLayout(ctx,{id:'cover',role:'shape',overlay:{intent:'annotation',target:'face',region:{x:0,y:0,width:400,height:300},interval:{start:0,end:1}}},()=>ctx.fillRect(10,20,20,20));
  assert.ok(report().issues.some(i=>i.code==='PROTECTED_OCCLUSION'&&i.severity==='error'));
  trace.reset(.5,plan);trace.state.scene='other';withLayout(ctx,{id:'clip',role:'media'},()=>ctx.drawImage(source,0,0));
  assert.ok(report().issues.some(i=>i.code==='PROTECTION_NOT_TRACED'));assert.equal(trace.draws.some(d=>d.id==='face'),false);
});
test('unknown source protection is pending; caption reservations detect intrusion',()=>{
  const {ctx,report}=fixture({requirements:[{scene:'shot',kinds:['cursor','reading']}]});
  ctx.fillText('content',40,100);
  withLayout(ctx,{id:'caption',role:'caption',space:'screen'},()=>{ctx.fillStyle='#222';ctx.fillRect(30,90,200,60);ctx.fillStyle='#fff';ctx.fillText('caption',40,130);});
  assert.ok(report().issues.some(i=>i.code==='CAPTION_OCCLUSION'));
  assert.equal(report().issues.filter(i=>i.code==='PROTECTION_COVERAGE_MISSING').length,2);
});
test('offscreen source paths are transformed and cropped with their composite alpha',()=>{
  const src=fixture(),dst=fixture();src.ctx.fillText('Source',20,100);dst.ctx.translate(10,5);dst.ctx.scale(.5,.5);dst.ctx.globalAlpha=.4;
  dst.ctx.drawImage(src.canvas,10,0,200,200,0,0,200,200);
  const d=dst.trace.draws.find(d=>d.text==='Source')!;assert.ok(Math.abs(d.alpha-.4)<1e-6);
  assert.ok(Math.abs(d.bounds.x-(src.trace.draws[0]!.bounds.x/2+5))<.01);
});
test('declarations reject invalid time, parent cycles and protection spanning a cut',()=>{
  assert.ok(layoutPlanIssues({elements:[{id:'x',role:'text',parent:'x'}]}).length);
  assert.ok(layoutPlanIssues({elements:[{id:'x',role:'text',overlay:{intent:'annotation'}}]}).length);
  assert.throws(()=>validateSpec({...layoutFixtureSpec,layout:{protections:[{id:'p',kind:'face',target:'c',scene:'notes',source:'manual',status:'confirmed',space:'source',rect:{x:0,y:0,width:10,height:10},interval:{start:0,end:2}}]}}),/one shot/);
});
test('four broken synthetic shots reproduce layout and transition errors; trace is pixel transparent',()=>{
  const spec=validateSpec(layoutFixtureSpec).spec!;
  const traced=createSpecRenderer({spec,drawScene:drawBrokenLayout,trackLayout:true}),plain=createSpecRenderer({spec,drawScene:drawBrokenLayout});
  try{for(const at of [.6,1.6,2.6,3.1]){
    const rc=makeFrameContext({frameIndex:Math.round(at*30),totalFrames:120,fps:30,width:540,height:960,seed:12});
    assert.deepEqual(traced.renderFrame(rc).data,plain.renderFrame(rc).data);
    const report=inspectLayout(traced.layoutTrace()!,{frame:rc.frameIndex,fps:30,width:540,height:960,safe:frame(540,960).safe});
    assert.equal(report.ok,false,JSON.stringify({at,report}));
  }}finally{traced.dispose();plain.dispose();}
});
test('transition phases distinguish outgoing, incoming, noText base and steady passes',()=>{
  const spec=validateSpec({...layoutFixtureSpec,scenes:layoutFixtureSpec.scenes.map((s,i)=>({...s,transition:i===3?'riseFade':'cut'}))}).spec!;
  const calls:any[]=[];const r=createSpecRenderer({spec,drawScene:c=>calls.push({phase:c.transitionPhase,noText:c.noText,held:c.textHold,carried:c.textCarriedIn})});
  try{r.renderFrame(makeFrameContext({frameIndex:93,totalFrames:120,fps:30,width:540,height:960,seed:12}));assert.deepEqual(new Set(calls.map(c=>c.phase)),new Set(['entering','leaving','handoff']));calls.length=0;r.renderFrame(makeFrameContext({frameIndex:110,totalFrames:120,fps:30,width:540,height:960,seed:12}));assert.equal(calls[0].phase,'stable');}finally{r.dispose();}
});
test('safe and content coordinates differ from canvas focus; label follows shared transform',()=>{
  const f=frame(1080,1920);assert.equal(f.center.x,540);assert.equal(f.safe.x+f.safe.width/2,492);
  const {ctx}=fixture();ctx.translate(20,30);ctx.scale(2,2);assert.deepEqual(follow({x:10,y:5},matrixOf(ctx)),{x:40,y:40});
  assert.deepEqual(mapRect({x:20,y:30,width:40,height:20},sourceMapping({x:20,y:30,width:40,height:20},{x:50,y:60,width:80,height:40})),{x:50,y:60,width:80,height:40});
});

test('separately loaded component declarations share the engine trace registry',async()=>{
  const copied=await import('../src/layout/trace.ts?component-copy');
  const {ctx,trace}=fixture();copied.withLayout(ctx,{id:'copied-label',role:'source'},()=>ctx.fillText('Credit',40,100));
  assert.equal(trace.draws[0]!.id,'copied-label');assert.equal(trace.draws[0]!.role,'source');
});
test('reviewed manual regions and final-output regions retain coordinate contracts through offscreen composition',async()=>{
  const {protectLayout}=await import('../src/layout/trace.ts');
  for(const kind of ['face','cursor','target','reading','caption'] as const){
    const src=fixture(),dst=fixture();src.ctx.translate(40,20);
    protectLayout(src.ctx,{id:kind,kind,target:'object',scene:'shot',space:'world',source:'manual coordinates',status:'confirmed',interval:{start:0,end:1},rect:{x:10,y:10,width:20,height:20}});
    protectLayout(src.ctx,{id:'fixed',kind:'target',target:'output',scene:'shot',space:'output',source:'reviewed final UI',status:'confirmed',interval:{start:0,end:1},rect:{x:5,y:5,width:10,height:10}});
    dst.ctx.drawImage(src.canvas,20,10,200,150);assert.deepEqual(dst.trace.draws.find(d=>d.id===kind)!.visible,{x:45,y:25,width:10,height:10});
    assert.deepEqual(dst.trace.draws.find(d=>d.id==='fixed')!.visible,{x:5,y:5,width:10,height:10});
    dst.ctx.fillRect(45,25,10,10);assert.ok(dst.report().issues.some(i=>i.code==='PROTECTED_OCCLUSION'&&i.severity==='error'));
  }
});
test('rotated exact clips use glyph intersections; opaque later background still protects readable text',()=>{
  const {ctx,trace,report}=fixture();ctx.save();ctx.translate(200,100);ctx.rotate(Math.PI/4);ctx.beginPath();ctx.rect(0,0,10,10);ctx.clip();ctx.fillText('Outside',40,100);ctx.restore();
  ctx.fillText('Visible',40,100);assert.equal(report().ok,true);trace.reset(.5);
  ctx.fillText('Readable',40,100);ctx.fillRect(0,0,400,300);assert.ok(report().issues.some(i=>i.code==='TEXT_OCCLUDED'));
});
test('targeted non-reading transition overlay passes; dimmed earlier background text contributes no ghost conflict',()=>{
  const {ctx,report,trace}=fixture();
  withLayout(ctx,{id:'old',role:'text',reading:false},()=>ctx.fillText('Old',40,100));
  withLayout(ctx,{id:'new',role:'text',reading:false,overlay:{intent:'transition',target:'old',region:{x:0,y:0,width:400,height:300},interval:{start:0,end:1}}},()=>ctx.fillText('New',40,100));
  assert.equal(report().ok,true);trace.reset(.5);
  withLayout(ctx,{id:'context',role:'text',reading:false},()=>ctx.fillText('Context',40,100));ctx.globalAlpha=.9;ctx.fillStyle='#000';ctx.fillRect(0,0,400,300);ctx.globalAlpha=1;ctx.fillStyle='#fff';ctx.fillText('Focus',40,100);
  assert.equal(report().issues.some(i=>i.code==='TEXT_OVERLAP'),false);
});
test('fade phase exposes entry and exit and applies final visibility to diagnostics',()=>{
  const spec=validateSpec({...layoutFixtureSpec,scenes:layoutFixtureSpec.scenes.map(s=>({...s,transition:'fade'}))}).spec!;
  const phases:string[]=[];const r=createSpecRenderer({spec,trackLayout:true,drawScene:c=>{phases.push(c.transitionPhase!);c.ctx.font='30px sans-serif';c.ctx.fillStyle='#fff';c.ctx.fillText('Read',80,240);}});
  try{for(const index of [0,29]){r.renderFrame(makeFrameContext({frameIndex:index,totalFrames:120,fps:30,width:540,height:960,seed:12}));assert.equal(inspectLayout(r.layoutTrace()!,{frame:index,fps:30,width:540,height:960,safe:frame(540,960).safe}).ok,true);}assert.deepEqual(phases,['entering','leaving']);assert.ok(r.layoutTrace()!.draws.every(d=>d.alpha<.15));}finally{r.dispose();}
});

test('required offscreen glyphs remain clipped by the destination clip and unsupported blends remain pending',()=>{
  const src=fixture(),dst=fixture();withLayout(src.ctx,{id:'required',role:'text',required:true,boundary:'canvas'},()=>src.ctx.fillText('Crop',40,100));
  dst.ctx.save();dst.ctx.beginPath();dst.ctx.rect(0,0,50,300);dst.ctx.clip();dst.ctx.drawImage(src.canvas,0,0);dst.ctx.restore();
  assert.ok(dst.report().issues.some(i=>i.code==='REQUIRED_CONTENT_CLIPPED'&&i.severity==='error'));
  dst.trace.reset(.5);dst.ctx.globalCompositeOperation='multiply';dst.ctx.drawImage(src.canvas,0,0);assert.equal(dst.report().status,'pending');
});
