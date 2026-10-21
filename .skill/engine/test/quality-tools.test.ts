import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Canvas} from 'skia-canvas';
import {createFixtureProject} from './fixtures/project.ts';
import {PROJECT_ROOT} from '../src/utils/env.ts';
import {layoutFixtureSpec,fixedLayoutDrawer} from './fixtures/layout-scenes.ts';
import {createSpecRenderer} from '../src/pipeline/spec-renderer.ts';
import {makeFrameContext} from '../src/renderer/renderer.ts';
import {validateSpec} from '../src/spec/validate.ts';
import {layoutSamples} from '../src/layout/sampling.ts';
import {inspectLayout} from '../src/layout/check.ts';
import {frame} from '../src/layout/tools.ts';
import {slotSuggestions,motionLint,reviewStillness} from '../src/qa/motion.ts';
import {cutSuggestions,mapCutWords,type CutEvidence} from '../src/qa/cuts.ts';
import {getTheme} from '../src/themes/registry.ts';
import {enter,emphasis,validateMotionToken,stagger,beats} from '../src/motion/tokens.ts';
import {DitherCache,drawTreatments} from '../src/pipeline/theme-treatments.ts';
import {measureContentCenter,centerDiagnostic} from '../src/qa/centering.ts';

test('fixed fixture passes every frame including titles handed across a dissolve',async()=>{
  const spec=validateSpec(layoutFixtureSpec).spec!,renderer=createSpecRenderer({spec,drawScene:await fixedLayoutDrawer(),trackLayout:true});
  try{for(let i=0;i<120;i++){
    renderer.renderFrame(makeFrameContext({frameIndex:i,totalFrames:120,fps:30,width:540,height:960,seed:12}));
    const report=inspectLayout(renderer.layoutTrace()!,{frame:i,fps:30,width:540,height:960,safe:frame(540,960).safe});
    assert.equal(report.ok,true,JSON.stringify({i,issues:report.issues}));
  }}finally{renderer.dispose();}
});
test('sampling densifies known one-frame windows and transition boundaries',()=>{
  const spec=validateSpec({...layoutFixtureSpec,layout:{windows:[{start:1.31,end:1.35}]}}).spec!;
  const s=layoutSamples(spec);assert.ok(s.frames.includes(40));assert.ok(s.frames.includes(90));assert.ok(s.frames.includes(89));
  assert.equal(layoutSamples(spec,{allFrames:true}).frames.length,120);assert.throws(()=>layoutSamples(spec,{step:0}),/RANGE/);
});
test('slot alternatives and cut suggestions preserve source input and carry audio/reading consequences',()=>{
  const plan:any={elements:[{id:'old',role:'text',slot:'title',interval:{start:0,end:2}},{id:'new',role:'text',slot:'title',interval:{start:1.7,end:3}}]};
  const old=JSON.stringify(plan),slots=slotSuggestions(plan);assert.equal(slots.length,1);assert.equal(slots[0]!.candidates[0]!.after!.start,2);assert.equal(JSON.stringify(plan),old);
  const e:CutEvidence={fps:30,sampleRate:48000,mapping:'verified',cuts:[{id:'cut',frame:30,previousStartFrame:0,nextEndFrame:90}],words:[{text:'orbit',startSample:43200,endSample:52800,status:'observed',source:'reviewed waveform'}]};
  const before=JSON.stringify(e),report=cutSuggestions(e)[0]!;assert.equal(report.severity,'error');assert.equal(report.original.sample,48000);assert.equal(report.applied,false);assert.ok(report.candidates.every(c=>Math.abs(c.deltaSamples)===4800&&c.requiresConfirmation));assert.equal(JSON.stringify(e),before);
  assert.equal(cutSuggestions({...e,mapping:'unknown'})[0]!.severity,'review');assert.equal(cutSuggestions({...e,words:e.words.map(w=>({...w,status:'estimated'}))})[0]!.status,'pending');
  const trimmed=mapCutWords(e.words,{sourceStartSample:0,outputStartSample:0,durationSamples:48000,sourceRate:48000,outputRate:48000});
  assert.equal(trimmed[0]!.clippedEnd,true);assert.equal(cutSuggestions({...e,words:trimmed})[0]!.severity,'error');
  assert.deepEqual(mapCutWords(e.words,{sourceStartSample:24000,outputStartSample:96000,durationSamples:48000,sourceRate:48000,outputRate:48000})[0],{...e.words[0],startSample:115200,endSample:124800});
});
test('motion lint uses explicit events and observed transforms; partial holds preserve unexplained stillness',()=>{
  const plan:any={motion:['subject','secondary','camera'].map((layer,i)=>({id:String(i),scene:'shot',group:'steps',needsStagger:true,layer,enter:'fade',start:0,end:.5}))};
  const codes=motionLint(plan,[{id:'shot',cameraMove:'static'}],[{scene:'shot',id:'node',time:0,x:0,y:0},{scene:'shot',id:'node',time:1,x:10,y:0}]).map(i=>i.code);
  for(const code of ['UNIFORM_ENTRANCE','STAGGER_REVIEW','ATTENTION_COMPETITION','MAIN_EVENT_REVIEW','OBSERVED_MOTION_WITH_STATIC_CAMERA'])assert.ok(codes.includes(code));
  const r=reviewStillness([{start:0,end:4}],[{start:0,end:2,purpose:'reading',reason:'read result'}]);assert.deepEqual(r[0]!.unexplained,[{start:2,end:4}]);
  assert.equal(reviewStillness([{start:0,end:2}],[{start:0,end:2,purpose:'demonstration',reason:'wait for UI'}])[0]!.status,'explained');
});
test('optional minimal reading tokens remain monotonic and accent springs stay below 3 percent',()=>{
  for(const theme of [getTheme('minimal'),getTheme('kinetic')]){
    assert.deepEqual(validateMotionToken(theme,'accent'),[]);
    let prev=0;for(let t=0;t<3;t+=.005){const a=enter(theme,'pop',t,'accent');assert.ok(a.progress<=1.03);if(theme.id==='minimal'){const r=enter(theme,'pop',t);assert.ok(r.progress<=1&&r.progress>=prev);prev=r.progress;assert.equal(emphasis(theme,'scalePunch',t,'reading').scale,1);}}
  }
  assert.ok(validateMotionToken(getTheme('minimal'),'accent',{stiffness:100,damping:1}).length);assert.equal(stagger(2,'normal'),.16);assert.equal(beats(1,.3,.2,.4).settle.end,1.9);
});
test('opaque dither cache matches the legacy readback across colors, dimensions, seed and tick; bounded lifecycle',()=>{
  const cache=new DitherCache(),theme=getTheme('minimal');
  for(const [w,h,seed,t] of [[64,96,1,0],[64,96,1,.5],[96,64,73,.5],[64,96,1,0]]){
    const a=new Canvas(w!,h!),b=new Canvas(w!,h!);
    for(const canvas of [a,b]){const g=canvas.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,w!,h!);const grad=g.createLinearGradient(0,0,w!,h!);grad.addColorStop(0,'#000001');grad.addColorStop(1,'#fffefa');g.fillStyle=grad;g.fillRect(0,0,w!,h!);g.fillStyle='#FFC712';g.fillRect(0,0,16,12);}
    drawTreatments(a.getContext('2d'),theme,t!,t!,w!,h!,seed!);drawTreatments(b.getContext('2d'),theme,t!,t!,w!,h!,seed!,cache);assert.deepEqual(b.toBufferSync('raw'),a.toBufferSync('raw'));
  }
  assert.ok(cache.stats().hits>0);for(let i=0;i<3;i++)cache.mask(1080,1920,i);assert.ok(cache.stats().bytes<=cache.maximumBytes);cache.clear();assert.equal(cache.stats().bytes,0);
});
test('weighted center ignores transparent pixels and reports composition as diagnostics',()=>{
  const c=new Canvas(100,100),g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(70,20,20,20);const pixels=g.getImageData(0,0,100,100);pixels.data.set([255,255,255,0],0);
  const center=measureContentCenter({width:100,height:100,data:pixels.data})!;assert.equal(center.center.x,80);assert.equal(centerDiagnostic(center,null,100,100).status,'review');assert.equal(centerDiagnostic(null,null,100,100).status,'coverage');
});
test('QA CLI renders an instantaneous declared window and writes proposals without editing inputs',()=>{
  const f=createFixtureProject();try{
    const spec={...layoutFixtureSpec,layout:{windows:[{start:1.31,end:1.35}]}};writeFileSync(f.specPath,JSON.stringify(spec));mkdirSync(join(f.dir,'src'),{recursive:true});
    const draw="export function drawScene({ctx,time}){ctx.font='30px sans-serif';ctx.fillStyle='#fff';ctx.fillText('Alpha',80,240);if(time>=1.31&&time<1.35)ctx.fillText('Beta',80,240);}";
    writeFileSync(join(f.dir,'src/draw.mjs'),draw);writeFileSync(join(f.dir,'project.json'),JSON.stringify({...f.manifest,drawing:'src/draw.mjs'}));
    const before=readFileSync(f.specPath),result=spawnSync(process.execPath,[join(PROJECT_ROOT,'src/cli/index.ts'),'qa',f.dir,'--layout'],{encoding:'utf8'});
    assert.equal(result.status,1,result.stderr+result.stdout);const report=JSON.parse(readFileSync(join(f.dir,'out/layout-qa/report.json'),'utf8'));assert.ok(report.issues.some((i:any)=>i.frame===40&&i.code==='TEXT_OVERLAP'));assert.equal(report.applied,false);assert.deepEqual(readFileSync(f.specPath),before);assert.equal(readFileSync(join(f.dir,'src/draw.mjs'),'utf8'),draw);
    const cuts={fps:30,sampleRate:48000,mapping:'verified',cuts:[{id:'boundary',frame:30,previousStartFrame:0,nextEndFrame:90}],words:[{text:'sample',startSample:43200,endSample:52800,status:'observed',source:'manual waveform'}]};
    mkdirSync(join(f.dir,'evidence'),{recursive:true});const cutPath=join(f.dir,'evidence/cuts.json');writeFileSync(cutPath,JSON.stringify(cuts));
    const checked=spawnSync(process.execPath,[join(PROJECT_ROOT,'src/cli/index.ts'),'qa',f.dir,'--cuts','evidence/cuts.json'],{encoding:'utf8'});
    assert.equal(checked.status,1,checked.stderr);assert.equal(readFileSync(cutPath,'utf8'),JSON.stringify(cuts));assert.deepEqual(readFileSync(f.specPath),before);
    writeFileSync(join(f.dir,'src/draw.mjs'),"export function drawScene({ctx}){const g=ctx.createLinearGradient(0,0,400,300);g.addColorStop(0,'#123');g.addColorStop(1,'#456');ctx.fillStyle=g;ctx.fillRect(0,0,540,960);}");
    const pending=spawnSync(process.execPath,[join(PROJECT_ROOT,'src/cli/index.ts'),'qa',f.dir,'--layout','--from','0','--to','0.1'],{encoding:'utf8'});
    assert.equal(pending.status,0,pending.stderr);const pendingReport=JSON.parse(readFileSync(join(f.dir,'out/layout-qa/report.json'),'utf8'));assert.equal(pendingReport.status,'pending');assert.ok(pendingReport.pendingFrames.length>0);
  }finally{f.cleanup();}
});
