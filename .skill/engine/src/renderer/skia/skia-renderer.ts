/**
 * Skia 渲染后端。
 *
 * 与上层的关系：实现 `Renderer` 接口，但**不把 Skia 泄漏到 VideoSpec**（需求 §8）。
 * 未来替换 CanvasKitRenderer / SVGRenderer 时，只需再实现一次 `Renderer`。
 *
 * 为什么是 skia-canvas（而非 @napi-rs/canvas）：
 *   实测 @napi-rs/canvas 渲染中文出豆腐块，CJK 回退失效。
 *   像素与编码路径由 test/pipeline.test.ts 验证。
 */

import { Canvas } from 'skia-canvas';
import type { CanvasRenderingContext2D } from 'skia-canvas';

import type { FrameBuffer, FrameContext, Renderer } from '../renderer.ts';

/**
 * 绘制回调。
 *
 * 契约（需求 §5）：**必须把整帧画满**——本渲染器不做跨帧状态保留，
 * 每一帧都是独立且完整的画。这也是「任意帧可独立渲染」的前提。
 */
export type SkiaDrawFn = (ctx: CanvasRenderingContext2D, rc: FrameContext) => void;

export interface SkiaRendererOptions {
  readonly width: number;
  readonly height: number;
  readonly draw: SkiaDrawFn;
  /**
   * 每帧绘制前是否先用底色铺满。
   * 默认 true：防止某个场景漏画背景导致「上一帧的残影」，
   * 这类 bug 在视频里表现为闪烁，极难定位。代价约 0.1ms/帧。
   */
  readonly fillBackground?: boolean;
  readonly backgroundColor?: string;
}

export class SkiaRenderer implements Renderer {
  readonly kind = 'skia';
  readonly width: number;
  readonly height: number;

  private readonly canvas: Canvas;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly draw: SkiaDrawFn;
  private readonly fillBackground: boolean;
  private readonly backgroundColor: string;
  private disposed = false;

  constructor(options: SkiaRendererOptions) {
    this.width = options.width;
    this.height = options.height;
    this.draw = options.draw;
    this.fillBackground = options.fillBackground ?? true;
    this.backgroundColor = options.backgroundColor ?? '#000000';

    this.canvas = new Canvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * 渲染单帧。
   *
   * 无状态：不读取 this 上的任何跨帧可变字段，因此
   * `renderFrame(0)` / `renderFrame(57)` / `renderFrame(240)` 可以按任意顺序、
   * 在任意进程中被独立调用（§5、§31）。
   */
  renderFrame(rc: FrameContext): FrameBuffer {
    if (this.disposed) throw new Error('SkiaRenderer 已 dispose');

    const ctx = this.ctx;
    // 重置可能被上一帧的绘制代码改坏的状态。不依赖绘图代码自觉 save/restore。
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';

    if (this.fillBackground) {
      ctx.fillStyle = this.backgroundColor;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    this.draw(ctx, rc);

    // raw 返回 RGBA8 行优先缓冲，像素序为 RGBA。
    const data = this.canvas.toBufferSync('raw');
    return { data, width: this.width, height: this.height, stride: this.width * 4 };
  }

  /** 调试用：把当前画布编码为 PNG（绝不进正式渲染循环，PNG 编码约 133ms/帧） */
  toPng(): Buffer {
    return this.canvas.toBufferSync('png');
  }

  dispose(): void {
    this.disposed = true;
  }
}
