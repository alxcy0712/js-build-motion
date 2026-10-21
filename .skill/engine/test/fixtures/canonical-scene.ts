import type { CanvasRenderingContext2D } from 'skia-canvas';
import type { FrameContext } from '../../src/renderer/renderer.ts';
import { mulberry32 } from '../../src/animation/random.ts';
export const CANONICAL_WIDTH = 540, CANONICAL_HEIGHT = 960;
export function drawCanonicalBackdrop(ctx: CanvasRenderingContext2D, rc: FrameContext): void {
  ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, rc.width, rc.height);
  const random = mulberry32(4242);ctx.fillStyle = '#383838';
  for (let i=0;i<64;i++) ctx.fillRect(random()*rc.width,random()*rc.height,2,2);
}
export function drawCanonicalScene(ctx: CanvasRenderingContext2D, rc: FrameContext): void {
  drawCanonicalBackdrop(ctx, rc); const random = mulberry32(rc.seed);
  for(let i=0;i<3;i++) { const phase=random()*Math.PI*2;
    ctx.fillStyle=['#FFC712','#5B3DF5','#F5F5F7'][i]!;
    ctx.beginPath();ctx.arc(rc.width*(0.25+i*0.25)+Math.sin(rc.time+phase)*20,rc.height*(0.3+i*0.15),30+i*8,0,Math.PI*2);ctx.fill(); }
  ctx.fillStyle='#fff';ctx.font='600 32px sans-serif';ctx.fillText(`f${rc.frameIndex}`,24,rc.height-40);
}
