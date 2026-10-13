import type { CanvasRenderingContext2D } from 'skia-canvas';

export interface AssetDrawTarget { x: number; y: number; width: number; height: number }
export interface PreparedAssetImage { readonly width: number; readonly height: number;
  draw(context: CanvasRenderingContext2D, target: AssetDrawTarget): void }
export interface PreparedAssetVideo { readonly width: number; readonly height: number; readonly frames: number; readonly fps: number;
  frame(index: number): Buffer; draw(context: CanvasRenderingContext2D, index: number, target: AssetDrawTarget): void }
/** Preparation is asynchronous; returned drawing/frame operations are synchronous and tied to a fixed use ID. */
export interface AssetPort { read(useId: string): Promise<Buffer>; image(useId: string): Promise<PreparedAssetImage>;
  video(useId: string, profile?: 'rough' | 'final'): Promise<PreparedAssetVideo> }
