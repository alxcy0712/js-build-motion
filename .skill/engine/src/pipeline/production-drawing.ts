import type { AssetPort, PreparedAssetImage, PreparedAssetVideo } from '../ports/assets.ts';
import type { CompiledProductionTimeline } from '../project/production-timeline.ts';
import type { ProjectSceneDrawer } from '../project/drawing.ts';
import { getSceneRenderer } from '../drawing/scenes/rain-window.ts';
import { drawGraphics } from '../drawing/scenes/graphics.ts';

/** Prepare fixed media once; integer frame access remains synchronous and order independent. */
export async function createProductionDrawing(compiled: CompiledProductionTimeline, assets: AssetPort,
  profile: 'rough' | 'final' = compiled.profile): Promise<ProjectSceneDrawer> {
  if (!compiled.spec || compiled.conflicts.some(c => c.severity === 'hard')) throw Error('PRODUCTION_DRAWING_TIMELINE_INVALID');
  const media = new Map<string, PreparedAssetImage | PreparedAssetVideo>();
  for (const clip of compiled.clips) {
    const prepared = media.get(clip.useId) ?? (clip.kind === 'video' ? await assets.video(clip.useId, profile) : await assets.image(clip.useId));
    if (clip.kind === 'video') {
      const video = prepared as PreparedAssetVideo;
      if (video.fps !== compiled.spec.video.fps || clip.sourceStartFrame + clip.endFrame - clip.startFrame > video.frames) throw Error('PRODUCTION_CLIP_FRAME_RANGE_INVALID: ' + clip.placementId);
    }
    media.set(clip.useId, prepared);
  }
  return (context, frame) => {
    const start = Math.round(context.scene.start * frame.fps), end = Math.round(context.scene.end * frame.fps);
    const index = Math.max(start, Math.min(end - 1, frame.frameIndex));
    const active = compiled.clips.filter(clip => clip.startFrame <= index && index < clip.endFrame);
    if (!active.length) { getSceneRenderer(context.scene.environment)(context); return; }
    const target = { x: 0, y: 0, width: context.width, height: context.height };
    for (const clip of active) {
      const prepared = media.get(clip.useId)!;
      if (clip.kind === 'video') (prepared as PreparedAssetVideo).draw(context.ctx, clip.sourceStartFrame + index - clip.startFrame, target);
      else (prepared as PreparedAssetImage).draw(context.ctx, target);
    }
    drawGraphics(context.ctx, context.scene.composition?.elements ?? [], context.progress, context.width, context.height);
  };
}
