import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { loadProject, resolveInsideProject, type ProjectHandle } from '../project/manifest.ts';
import { assertContained, assertOutputTree } from '../project/paths.ts';
import { loadProjectDrawing, projectSourceHashes } from '../project/drawing.ts';
import { prepareAssetPlan, DEFAULT_ASSET_PLAN_PATH, assertAssetPlanSnapshot } from '../application/asset-plan.ts';
import { createAssetPort } from '../adapters/asset-port.ts';
import { assertProductionCurrent } from '../application/production-compilation.ts';
import { createProductionDrawing } from '../pipeline/production-drawing.ts';
import { loadSpecFile, validateSpec } from '../spec/validate.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import { createSpecRenderer } from '../pipeline/spec-renderer.ts';
import { makeFrameContext } from '../renderer/renderer.ts';
import { sha256File } from '../utils/hash.ts';
import { readNarrationTimings } from '../audio/verify.ts';
import { layoutPlanIssues } from '../layout/plan.ts';
import { frame as layoutFrame } from '../layout/tools.ts';
import { layoutSamples } from '../layout/sampling.ts';
import { inspectLayout, type LayoutIssue } from '../layout/check.ts';
import { measureElementCenter, centerDiagnostic, type ContentCenter } from '../qa/centering.ts';
import { slotSuggestions, motionLint } from '../qa/motion.ts';
import { cutSuggestions } from '../qa/cuts.ts';

/** Read-only rendering preparation, including committed media. No successful render receipt is published. */
export async function prepareQualityDrawing(project:ProjectHandle,spec:ResolvedVideoSpec) {
  const plan=existsSync(join(project.dir,DEFAULT_ASSET_PLAN_PATH))?await prepareAssetPlan(project.dir):null;
  const assets=createAssetPort(project.dir,plan,{attemptId:'layout-qa',inputSnapshotSha256:sha256File(project.specPath)});
  try {
    const production=existsSync(join(project.dir,'production/manifest.json'))?await assertProductionCurrent(project.dir,spec):null;
    const drawScene=production?await createProductionDrawing(production.compiled,assets.port,production.projection.profile):await loadProjectDrawing(project,assets.port);
    return {drawScene,captionCues:production?.compiled.captionCues,measuredNarration:production?.compiled.narrationTimings,
      close:()=>assets.close(),verify:async()=>{await assets.verify();if(plan)await assertAssetPlanSnapshot(project.dir,plan);}};
  } catch(error){assets.close();throw error;}
}
export async function cmdLayoutQA(argv:string[]):Promise<number> {
  const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{layout:{type:'boolean'},plan:{type:'string'},cuts:{type:'string'},from:{type:'string'},to:{type:'string'},step:{type:'string'},'all-frames':{type:'boolean'},'out-dir':{type:'string'}}});
  if(positionals.length!==1)throw Error('USAGE: qa <project> --layout [--plan evidence/layout.json] [--all-frames] | --cuts evidence/cuts.json');
  const project=loadProject(positionals[0]!),spec=validateSpec(loadSpecFile(project.specPath)).spec!;
  const outDir=assertContained(project.outDir,resolveInsideProject(project.dir,values['out-dir']??join(project.manifest.outDir,'layout-qa'),'layout QA output'));assertOutputTree(outDir);
  const specHash=sha256File(project.specPath),sources=projectSourceHashes(project.dir),extra:Record<string,string>={};
  const read=(p:string)=>{const path=resolveInsideProject(project.dir,p,'QA evidence');extra[p]=sha256File(path);return JSON.parse(readFileSync(path,'utf8'));};
  const plan=values.plan?read(values.plan):spec.layout??{};
  const invalid=layoutPlanIssues(plan,spec.scenes);if(invalid.length)throw Error('LAYOUT_INVALID: '+invalid.join('; '));
  const cuts=values.cuts?cutSuggestions(read(values.cuts)):[];
  const verify=()=>{if(sha256File(project.specPath)!==specHash||JSON.stringify(projectSourceHashes(project.dir))!==JSON.stringify(sources)||Object.entries(extra).some(([p,hash])=>sha256File(resolveInsideProject(project.dir,p,'QA evidence'))!==hash))throw Error('LAYOUT_QA_INPUT_CHANGED');};
  const issues:LayoutIssue[]=[],centers:unknown[]=[],motionSamples:{scene:string;id:string;time:number;x:number;y:number}[]=[],previews:{frame:number;bytes:Buffer}[]=[],limits=new Set<string>(),pendingFrames:number[]=[];
  const samples=layoutSamples({...spec,layout:plan},{...(values.from?{from:Number(values.from)}:{}),...(values.to?{to:Number(values.to)}:{}),...(values.step?{step:Number(values.step)}:{}),allFrames:values['all-frames']});
  if(values.layout){
    const prepared=await prepareQualityDrawing(project,spec),timing=join(project.outDir,'audio/narration-timing.json');
    if(!prepared.measuredNarration&&existsSync(timing))extra[relative(project.dir,timing)]=sha256File(timing);
    const renderer=createSpecRenderer({spec:{...spec,layout:plan},drawScene:prepared.drawScene,captionCues:prepared.captionCues,
      measuredNarration:prepared.measuredNarration??readNarrationTimings([timing],spec),trackLayout:true});
    let previous:ContentCenter|null=null,previousScene='';const sampledScenes=new Set<string>();
    try {
      for(const index of samples.frames){
        renderer.renderFrame(makeFrameContext({frameIndex:index,totalFrames:Math.ceil(spec.video.duration*spec.video.fps),fps:spec.video.fps,width:spec.video.width,height:spec.video.height,seed:spec.video.seed}));
        const trace=renderer.layoutTrace()!,report=inspectLayout(trace,{frame:index,fps:spec.video.fps,width:spec.video.width,height:spec.video.height,safe:layoutFrame(spec.video.width,spec.video.height).safe,plan});
        if(report.status==='pending')pendingFrames.push(index);
        issues.push(...report.issues);report.limitations.forEach(l=>limits.add(l));
        if(report.issues.length&&previews.length<12)previews.push({frame:index,bytes:renderer.toPng()});
        for(const d of trace.draws)if(d.alpha>=.15&&d.scene&&d.role!=='background'&&d.role!=='decoration')motionSamples.push({scene:d.scene,id:d.id,time:index/spec.video.fps,x:d.visible.x,y:d.visible.y});
        const scene=spec.scenes.find(s=>index/spec.video.fps>=s.start&&index/spec.video.fps<s.end)!;
        if(!sampledScenes.has(scene.id)&&index/spec.video.fps>=scene.start+Math.min(.9,(scene.end-scene.start)*.5)){
          const center=measureElementCenter(trace.draws,spec.video.width,spec.video.height);
          centers.push({scene:scene.id,previousScene,frame:index,...centerDiagnostic(center,previous,spec.video.width,spec.video.height)});previous=center;previousScene=scene.id;sampledScenes.add(scene.id);
        }
      }
      await prepared.verify();verify();
    }finally{renderer.dispose();prepared.close();}
  }
  verify();mkdirSync(outDir,{recursive:true});for(const p of previews)writeFileSync(join(outDir,`frame-${p.frame}.png`),p.bytes);
  const ok=!issues.some(i=>i.severity==='error')&&!cuts.some(i=>i.severity==='error');
  const report={ok,status:!ok?'error':(pendingFrames.length>0||issues.some(i=>i.severity==='coverage'||i.severity==='review')||cuts.some(i=>i.status==='pending'))?'pending':'pass',scope:'source-render-layout',specSha256:specHash,sources,evidence:extra,
    sampling:values.layout?samples:null,pendingFrames,issues,limitations:[...limits,...samples.limitations],previews:previews.map(p=>`frame-${p.frame}.png`),
    composition:centers,motion:motionLint(plan,spec.scenes,motionSamples),slots:slotSuggestions(plan),cuts,applied:false};
  writeFileSync(join(outDir,'report.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({ok,status:report.status,outDir:relative(project.dir,outDir),checkedFrames:values.layout?samples.frames.length:0,errors:issues.filter(i=>i.severity==='error').length,review:issues.filter(i=>i.severity!=='error').length,slots:report.slots,cuts},null,2)+'\n');
  return ok?0:1;
}
