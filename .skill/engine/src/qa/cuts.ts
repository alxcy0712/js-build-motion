export interface CutWord { text:string; startSample:number; endSample:number; status:'observed'|'estimated'|'unknown'; source:string; clippedStart?:boolean; clippedEnd?:boolean }
export interface CutEvidence {
  fps:number; sampleRate:number; mapping:'verified'|'unknown';
  cuts:{id:string;frame:number;previousStartFrame:number;nextEndFrame:number}[];words:CutWord[];
}
/** Map reviewed source words through an explicit clip placement, including sample-rate conversion. */
export function mapCutWords(words:readonly CutWord[],m:{sourceStartSample:number;outputStartSample:number;durationSamples:number;sourceRate:number;outputRate:number}):CutWord[] {
  if(!Object.values(m).every(Number.isFinite)||m.sourceRate<=0||m.outputRate<=0||m.durationSamples<=0||m.sourceStartSample<0||m.outputStartSample<0)throw Error('CUT_SAMPLE_MAPPING');
  const end=m.sourceStartSample+m.durationSamples,ratio=m.outputRate/m.sourceRate;
  return words.filter(w=>w.endSample>m.sourceStartSample&&w.startSample<end).map(w=>({...w,
    startSample:Math.round(m.outputStartSample+(Math.max(w.startSample,m.sourceStartSample)-m.sourceStartSample)*ratio),
    endSample:Math.round(m.outputStartSample+(Math.min(w.endSample,end)-m.sourceStartSample)*ratio),
    ...(w.startSample<m.sourceStartSample?{clippedStart:true}:{}),...(w.endSample>end?{clippedEnd:true}:{})}));
}
export function cutSuggestions(e:CutEvidence) {
  if(!e||!Number.isFinite(e.fps)||e.fps<=0||!Number.isInteger(e.sampleRate)||e.sampleRate<=0||!['verified','unknown'].includes(e.mapping)||!Array.isArray(e.words)||!Array.isArray(e.cuts))throw Error('CUT_EVIDENCE_INVALID');
  for(const w of e.words)if(!w.text?.trim()||!w.source?.trim()||!['observed','estimated','unknown'].includes(w.status)||![w.startSample,w.endSample].every(Number.isInteger)||w.startSample<0||w.endSample<=w.startSample)throw Error('CUT_WORD_INVALID');
  const inWord=(w:CutWord,s:number)=>s>w.startSample&&s<w.endSample||(w.clippedStart===true&&s===w.startSample)||(w.clippedEnd===true&&s===w.endSample);
  const words=[...e.words].sort((a,b)=>a.startSample-b.startSample),sample=(frame:number)=>Math.round(frame*e.sampleRate/e.fps);
  return e.cuts.map(c=>{
    if(![c.frame,c.previousStartFrame,c.nextEndFrame].every(Number.isInteger)||c.previousStartFrame<0||c.previousStartFrame>=c.frame||c.frame>=c.nextEndFrame||!c.id)throw Error('CUT_RANGE_INVALID');
    const originalSample=sample(c.frame),hit=words.filter(w=>inWord(w,originalSample)),nearby=words.filter(w=>Math.abs((w.startSample+w.endSample)/2-originalSample)<e.sampleRate);
    const reliable=e.mapping==='verified'&&hit.length>0&&hit.every(w=>w.status==='observed');
    const frames=new Set<number>();
    for(const w of hit){frames.add(Math.floor(w.startSample/e.sampleRate*e.fps));frames.add(Math.ceil(w.endSample/e.sampleRate*e.fps));}
    const pauses=[];
    for(let i=1;i<words.length;i++){const a=words[i-1]!,b=words[i]!;if(b.startSample>a.endSample&&Math.abs((a.endSample+b.startSample)/2-originalSample)<=e.sampleRate*.5){const at=Math.round((a.endSample+b.startSample)/2/e.sampleRate*e.fps);frames.add(at);pauses.push({startSample:a.endSample,endSample:b.startSample});}}
    const candidates=[...frames].filter(f=>f>c.previousStartFrame&&f<c.nextEndFrame&&!words.some(w=>inWord(w,sample(f)))).sort((a,b)=>Math.abs(a-c.frame)-Math.abs(b-c.frame)).slice(0,4).map(f=>({
      frame:f,time:f/e.fps,sample:sample(f),deltaFrames:f-c.frame,deltaSamples:sample(f)-originalSample,
      previousFrames:f-c.previousStartFrame,nextFrames:c.nextEndFrame-f,
      audioImpact:'proposal only: audio samples remain unchanged; applying to a source clip changes consumed audio and requires anchor/reading/tail revalidation',requiresConfirmation:true,
    }));
    return {id:c.id,code:hit.length?'CUT_INSIDE_WORD':'CUT_WORD_REVIEW',severity:reliable?'error':'review',status:hit.length?(reliable?'confirmed':'pending'):'pending',
      original:{frame:c.frame,time:c.frame/e.fps,sample:originalSample},words:hit,nearby,pauses,candidates:hit.length?candidates:[],
      basis:reliable?'observed word range and verified output-sample mapping':'estimated/unknown timing or word-free interval requires listening evidence',applied:false};
  });
}
