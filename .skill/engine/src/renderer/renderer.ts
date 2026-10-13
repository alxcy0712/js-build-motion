/**
 * 渲染器抽象（需求 §8）。
 *
 * 关键设计：**VideoSpec 与渲染后端解耦**。
 * 上层只依赖这里的接口；换成 CanvasRenderer / CanvasKitRenderer / SVGRenderer
 * 时 VideoSpec 不需要任何改动。
 *
 * 同一份「帧上下文」也是确定性的唯一输入来源——
 * 渲染函数不得读取系统时钟或全局随机源。
 */

/**
 * 单帧渲染所需的全部输入。
 *
 * 这是确定性渲染契约的核心：给定相同的 FrameContext，
 * 渲染器必须产出逐像素相同的结果，且**不依赖任何前置帧**。
 */
export interface FrameContext {
  /** 帧号，从 0 开始。同一帧无论何时渲染都必须一致。 */
  readonly frameIndex: number;
  /** 总帧数，供「整片进度」类动画使用 */
  readonly totalFrames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /** 该视频的随机种子。渲染器内部所有随机都必须由它派生 */
  readonly seed: number;
  /** frameIndex / fps，秒。派生值，不累积 */
  readonly time: number;
}

/** 渲染器输出的像素缓冲（RGBA8，行优先，无 padding） */
export interface FrameBuffer {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  /** 每行字节数 = width * 4 */
  readonly stride: number;
}

/**
 * 渲染器接口。
 *
 * `renderFrame` 刻意是**同步**的：异步会让「随机访问任意帧」的实现
 * 容易退化成「必须按顺序 await」，而顺序无关性正是并行渲染的前提（§31）。
 */
export interface Renderer {
  readonly width: number;
  readonly height: number;
  readonly kind: string;
  /** 渲染第 ctx.frameIndex 帧。必须是 ctx 的纯函数。 */
  renderFrame(ctx: FrameContext): FrameBuffer;
  dispose(): void;
}

/** 构造 FrameContext 的唯一入口，避免各处以不同方式拼装 */
export function makeFrameContext(params: {
  frameIndex: number;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
  seed: number;
}): FrameContext {
  const { frameIndex, totalFrames, fps, width, height, seed } = params;
  return Object.freeze({
    frameIndex,
    totalFrames,
    fps,
    width,
    height,
    seed,
    time: frameIndex / fps,
  });
}

/** yuv420p 要求宽高为偶数，否则 FFmpeg 会静默改尺寸或直接失败 */
export function assertEvenDimensions(width: number, height: number): void {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(
      `yuv420p 要求宽高为偶数，收到 ${width}x${height}。` +
        '请在 spec 中调整为偶数尺寸（例如 1080x1920）。',
    );
  }
}
