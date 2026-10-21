import type { LayoutPlan, Interval } from '../layout/plan.ts';
export function slotSuggestions(plan:LayoutPlan) {
  const result=[];const elements=(plan.elements??[]).filter(e=>e.slot&&e.interval);
  for(let i=0;i<elements.length;i++)for(const b of elements.slice(i+1)){
    const a=elements[i]!;if(a.scene!==b.scene||a.slot!==b.slot)continue;
    const [old,next]=a.interval!.start<=b.interval!.start?[a,b]:[b,a];
    if(next.interval!.start>=old.interval!.end)continue;
    result.push({code:'SLOT_OCCUPIED',severity:'warning',elements:[old.id,next.id],slot:a.slot,
      before:{[old.id]:{...old.interval!},[next.id]:{...next.interval!}},
      candidates:[{action:'delay-entry',element:next.id,after:{...next.interval!,start:old.interval!.end},feasible:old.interval!.end<next.interval!.end},
        {action:'earlier-exit',element:old.id,after:{...old.interval!,end:next.interval!.start},feasible:next.interval!.start>old.interval!.start},
        {action:'alternate-region',element:next.id},{action:'reorganize-information',element:next.id}],
      basis:'same declared slot has overlapping active intervals',audioImpact:'audio unchanged; candidate changes visual-to-word alignment and available reading duration; confirm against current sound',requiresConfirmation:true});
  }return result;
}
export function motionLint(plan:LayoutPlan,scenes:readonly {id:string;cameraMove:string}[],samples:readonly {scene:string;id:string;time:number;x:number;y:number}[]=[]) {
  const issues:{code:string;severity:'warning'|'coverage';scene:string;basis:string}[]=[];
  for(const s of scenes){
    const events=(plan.motion??[]).filter(e=>e.scene===s.id),add=(code:string,basis:string,severity:'warning'|'coverage'='warning')=>issues.push({code,severity,scene:s.id,basis});
    if(!events.length)add('MOTION_COVERAGE','no explicit orchestration; drawScene motion cannot be inferred from spec camera fields','coverage');
    if(events.length>=3&&new Set(events.map(e=>e.enter)).size===1)add('UNIFORM_ENTRANCE','all declared layers use '+events[0]!.enter);
    for(const group of new Set(events.filter(e=>e.needsStagger).map(e=>e.group))) {
      const members=events.filter(e=>e.group===group);if(members.length>1&&Math.max(...members.map(e=>e.start))-Math.min(...members.map(e=>e.start))<.035)add('STAGGER_REVIEW',`group ${group??'(unnamed)'} requests layered reading with near-simultaneous entry`);
    }
    if(['subject','secondary','camera'].every(l=>events.some(e=>e.layer===l))&&Math.max(...events.map(e=>e.start))-Math.min(...events.map(e=>e.start))<.08)add('ATTENTION_COMPETITION','subject, secondary and camera begin within 80ms');
    if(events.length&&events.every(e=>e.enter==='fade')&&!events.some(e=>e.mainEvent))add('MAIN_EVENT_REVIEW','declared actions contain only fades and no content event');
    const moves=samples.filter(p=>p.scene===s.id);let changed=0;
    for(const id of new Set(moves.map(p=>p.id))){const points=moves.filter(p=>p.id===id);if(points.length>1&&(Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))>1||Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))>1))changed++;}
    if(changed&&s.cameraMove==='static')add('OBSERVED_MOTION_WITH_STATIC_CAMERA',`${changed} traced elements move; source can be object or custom camera motion`);
  }return issues;
}
/** Subtract intentional reading/wait/hold spans. Partial coverage preserves remaining stillness candidates. */
export function reviewStillness(spans:readonly Interval[],holds:LayoutPlan['holds']=[],maxStillSeconds=.5) {
  return spans.map(span=>{
    let unexplained=[{...span}];for(const hold of holds)unexplained=unexplained.flatMap(s=>hold.end<=s.start||hold.start>=s.end?[s]:[{start:s.start,end:Math.min(s.end,hold.start)},{start:Math.max(s.start,hold.end),end:s.end}].filter(s=>s.end>s.start));
    return {...span,purposes:holds.filter(h=>h.start<span.end&&h.end>span.start),unexplained:unexplained.filter(s=>s.end-s.start>maxStillSeconds),status:unexplained.some(s=>s.end-s.start>maxStillSeconds)?'review':'explained'};
  });
}
