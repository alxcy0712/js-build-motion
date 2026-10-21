import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { resolveFontFamily, registerProjectFonts } from '../../src/utils/env.ts';

export const MATERIAL_WIDTH = 640, MATERIAL_HEIGHT = 360, MATERIAL_FPS = 24, MATERIAL_FRAMES = 120;
export const SEMANTIC_FRAMES = { firstVisible: 12, emphasisPeak: 24, actionComplete: 72, readingEnd: 108, itemComplete: [24, 48, 72] } as const;
const font = resolveFontFamily(registerProjectFonts().registered);
const band = new Path2D(); band.rect(-130, -36, 260, 72); band.rect(-16, -10, 32, 20);
const table = new Path2D(); table.rect(24, 100, 592, 220);
const prop = new Path2D(); prop.rect(-32, -30, 64, 60);

/** Fictional marked band: compression changes its extent while three identity marks stay attached. */
export function drawMaterialScene(ctx: CanvasRenderingContext2D, frame: number, seed = 41): void {
  ctx.fillStyle = '#f6f0e3'; ctx.fillRect(0, 0, MATERIAL_WIDTH, MATERIAL_HEIGHT);
  ctx.fillStyle = '#628b80'; ctx.fill(table);
  ctx.save(); ctx.translate(88, 237);
  ctx.fillStyle = '#628b80'; ctx.fill(prop);
  ctx.strokeStyle='#244f50';ctx.lineWidth=2;ctx.beginPath();[[-32, -30], [32, -30], [32, 30], [-32, 30]].forEach(([x,y],i)=>i?ctx.lineTo(x!,y!):ctx.moveTo(x!,y!));ctx.closePath();ctx.stroke();
  ctx.restore();
  const t = Math.max(0, Math.min(1, (frame - 24) / 48)), eased = t * t * (3 - 2 * t);
  ctx.save(); ctx.translate(325 + eased * 30, 194); ctx.scale(1 - 0.35 * eased, 1);
  ctx.fillStyle = '#628b80'; ctx.fill(band);
  ctx.strokeStyle='#244f50';ctx.lineWidth=2;ctx.beginPath();[[-130, -36], [130, -36], [130, 36], [-130, 36]].forEach(([x,y],i)=>i?ctx.lineTo(x!,y!):ctx.moveTo(x!,y!));ctx.closePath();ctx.stroke();
  ctx.strokeStyle = '#244f50'; ctx.lineWidth = 2; ctx.strokeRect(-16, -10, 32, 20);
  for (const x of [-80, 0, 80]) { ctx.fillStyle = '#bf794d'; ctx.beginPath(); ctx.arc(x, 23, 4, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#244f50'; ctx.fillRect(76, -24, 4, 12);
  ctx.restore();
  ctx.fillStyle = '#244f50'; ctx.font = `600 21px "${font}"`; ctx.fillText('同一纸带，标记保持对应', 36, 55);
  if (frame >= SEMANTIC_FRAMES.firstVisible) {
    const peak = Math.max(0, 1 - Math.abs(frame - SEMANTIC_FRAMES.emphasisPeak) / 12);
    ctx.save(); ctx.translate(325, 118); ctx.scale(1 + peak * 0.12, 1 + peak * 0.12); ctx.textAlign = 'center';
    ctx.font = `700 26px "${font}"`; ctx.fillText(frame >= 72 ? '12 格' : '收拢', 0, 0); ctx.restore();
  }
  ctx.font = `500 18px "${font}"`;
  for (let i = 0; i < 3; i++) if (frame >= SEMANTIC_FRAMES.itemComplete[i]!) {
    ctx.fillStyle = '#244f50'; ctx.fillText(['输入', '变化', '结果'][i]!, 230 + i * 80, 286);
  }
}
