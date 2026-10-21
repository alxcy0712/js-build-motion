import type { SceneRenderContext } from '../../src/drawing/scenes/registry.ts';
/** Four fictional shots: source collision, camera attachment, slot handoff, title dissolve. */
export const layoutFixtureSpec = {
  video: { width: 540, height: 960, fps: 30, duration: 4, seed: 12 }, style: { theme: 'minimal', vignette: 0 },
  scenes: ['notes', 'machine', 'question', 'answer'].map((id, i) => ({ id, start: i, end: i + 1,
    environment: 'theme_stage', cameraMove: 'static', transition: i === 3 ? 'dissolve' : 'cut' })),
  captions: { enabled: false }, audio: { narration: [], bgm: { volume: 0 }, sfx: [] },
};
export function drawBrokenLayout({ ctx, scene, time, noText }: SceneRenderContext): void {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 540, 960);
  ctx.font = '32px sans-serif'; ctx.fillStyle = '#f5f5f7';
  if (scene.id === 'notes' && !noText) { ctx.fillText('A measured result', 60, 300); ctx.fillText('Source: test notes', 60, 312); }
  if (scene.id === 'machine') {
    ctx.save(); ctx.translate(-45 * (time - 1), -35 * (time - 1)); ctx.fillStyle = '#444'; ctx.fillRect(45, 250, 380, 300); ctx.restore();
    if (!noText) { ctx.fillStyle = '#ffc712'; ctx.fillText('Machine label', 70, 250); }
  }
  if (scene.id === 'question' && !noText) {
    ctx.fillText('First question', 60, 300);
    if (time >= 2.4) { ctx.fillStyle = '#ffc712'; ctx.fillText('Second question', 60, 300); }
  }
  if (scene.id === 'answer' && !noText) ctx.fillText('Final answer', 60, 300);
}

export async function fixedLayoutDrawer() {
  const {withLayout,matrixOf}=await import('../../src/layout/trace.ts');
  const {frame,stack,anchor,follow}=await import('../../src/layout/tools.ts');
  return (c:SceneRenderContext):void=>{
    const {ctx,scene,time,noText}=c;ctx.fillStyle='#000';ctx.fillRect(0,0,540,960);
    ctx.font='32px sans-serif';ctx.fillStyle='#f5f5f7';
    const canRead=!noText&&c.transitionPhase!=='leaving'&&(c.transitionPhase!=='entering'||(c.transitionProgress??1)>=.5);
    if(scene.id==='notes'&&canRead){
      const boxes=stack({...frame(540,960).safe,y:260},[44,36],20);
      withLayout(ctx,{id:'body',role:'text',required:true},()=>ctx.fillText('A measured result',boxes[0]!.x,boxes[0]!.y+32));
      withLayout(ctx,{id:'source',role:'source',required:true},()=>ctx.fillText('Source: test notes',boxes[1]!.x,boxes[1]!.y+28));
    }
    if(scene.id==='machine'){
      const machine={x:45,y:300,width:380,height:260};ctx.save();ctx.translate(-45*(time-1),0);
      const label=follow(anchor(machine,'top',18),matrixOf(ctx));
      withLayout(ctx,{id:'machine',role:'shape',required:true,boundary:'canvas'},()=>{ctx.fillStyle='#444';ctx.fillRect(machine.x,machine.y,machine.width,machine.height);});ctx.restore();
      if(canRead)withLayout(ctx,{id:'label',role:'text',required:true,space:'screen'},()=>{ctx.fillStyle='#ffc712';ctx.textAlign='center';ctx.fillText('Machine label',label.x,label.y);});
    }
    if(scene.id==='question'&&canRead){const first=time<2.4;withLayout(ctx,{id:first?'first':'second',role:'text',required:true,slot:'title',interval:{start:first?2:2.4,end:first?2.4:3}},()=>ctx.fillText(first?'First question':'Second question',60,300));}
    if(scene.id==='answer'&&canRead)withLayout(ctx,{id:'answer',role:'text',required:true},()=>ctx.fillText('Final answer',60,300));
  };
}
