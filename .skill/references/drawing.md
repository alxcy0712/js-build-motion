# 本片绘制

按内容选择 elements、关键帧、组件副本或本片代码实现画面，主体、场景、材质与轨迹可由模型独立设计。图元与动画字段通过 capabilities --schema 查询；组件复制到 src/components/ 后可独立修改。内置字段使用已登记枚举，自绘通过下述同步入口实现，浏览器／WebGL 等路径按[预渲染流程](#三维渲染与空间镜头)验证后合成。个人识别与可调默认沿用[规则作用范围](style-and-identity.md#规则的作用范围)。

素材按[素材选择](workflow.md)组合生成图片与精确代码图形。图片在初始化阶段加载，逐帧绘制同步读取已准备好的素材；生成、下载及异步准备在绘制循环之外完成。

自定义入口在project.json中配置drawing: "src/draw.mjs"，模块导出同步drawScene(context, frame)。context提供ctx、width、height、scene、progress、seed；frame提供帧号、fps和整片时间。ctx为共享Canvas 2D上下文，progress为当前镜头进度，转场可能求值两个镜头。

`context.noText` 为 true 时只绘制场景底层与主体，文字在其余调用中绘制；`riseFade` 等转场使用这份无字画面承接两层文字的进退。

`transitionPhase` 表示本次求值的 `entering`、`stable`、`leaving` 或 `handoff`，`transitionProgress` 为当前转场的 0–1 进度。交接底层调用同时带 `noText: true`；现有 `textHold`、`textCarriedIn` 表示主题转场的文字承接。普通 fade 按实际淡黑区间给出进入／离开阶段。旧层退出与新层进入由本片安排；同位标题在两层均可读时进入重叠检查。

帧由seed、规格、帧号和登记输入确定；随机数使用固定种子，乱序求值同帧一致。素材和字体使用本片文件。构图、材质、动作与特效由本片需求决定。

绘制入口接管镜头内容，统一管线处理相机、转场、字幕、音频和编码。复杂需求可在本片实现并用实际帧与动作预览验证。

## 受控素材准备

配置 AssetPlan 后，绘制模块可导出 `async prepareDrawing({ assets })`，返回同步绘制函数。准备阶段通过 useId 调用 `assets.read`、`assets.image` 或 `assets.video`；绘制阶段使用准备好的图片/视频句柄。render 在实际输入快照中完成准备，帧函数返回 Promise 时明确拒绝。

```js
export async function prepareDrawing({ assets }) {
  const image = await assets.image('HeroImage');
  return ({ ctx, width, height }) => {
    image.draw(ctx, { x: 0, y: 0, width, height });
  };
}
```

图片句柄提供 width、height 和同步 draw；视频句柄提供 width、height、frames、fps、frame(index) 与 draw(ctx, index, target)。frame 返回该帧的独立 RGBA 副本；draw 保留现有相机/转场上下文，按计划的裁框和适配方式合成。帧号从本片时间确定，乱序求值保持同帧一致。消费记录区分准备读取、帧访问与绘制，覆盖与披露口径见 [素材需求与消费](workflow.md#视频准备与实际消费)。

生产 0.2 视频句柄读取交付 RGBA 的单帧，预览代理保留自己的尺寸与身份。原声沿同一选段和 clip placement 进入音频时间线；明确静音、原件无声和保留原声各自记录。资源预算不足时根据实际所需数量分段准备当前镜头素材，保留原件与已成功结果。

连续动作可在初始化时选择 `--components camera,spring,random`，组件与依赖复制到本片。`springTrack` 的连续目标见[动效设计](drawing.md)；`applyCameraPose` 的焦点、分层和固定字幕见[电影化运镜](direction.md)。本片绘制按逻辑画幅排布，先缩放到实际编码尺寸；多画幅交付时分别重新构图并验证阅读区。

## 可选布局与追踪

初始化可选 `--components layout,layout-trace,motion-tokens,camera-path`；默认组件集合沿用 easing、random。布局 helper 返回坐标，字体、颜色与既有默认画面沿用主题。`frame(w,h)` 提供 canvas、safe、contentBox 和画布 center；竖屏阅读区与画布中心各有坐标。`stack`／`row` 顺序排布，`grid(box,6,1,8)` 提供可选六列与 8px 间隙；`anchor(box,edge,gap)` 返回锚点，`slot(name,contentBox)` 提供 title、visual、body、source、footer 的试排区域。全画幅背景使用 canvas，关键文字按适用 safe 或 parent 检查。

```js
import { frame, stack, follow } from './components/layout.ts';
import { withLayout, matrixOf } from './components/layout-trace.ts';

export function drawScene({ ctx, width, height, noText, transitionPhase }) {
  const [body, source] = stack(frame(width, height).contentBox, [80, 32], 16);
  if (noText || transitionPhase === 'leaving') return;
  ctx.font = '32px sans-serif'; ctx.fillStyle = '#ffffff';
  withLayout(ctx, { id: 'body', role: 'text', required: true, boundary: 'safe' },
    () => ctx.fillText('观察对象的变化', body.x, body.y + 40));
  ctx.font = '20px sans-serif';
  withLayout(ctx, { id: 'source', role: 'source', required: true, boundary: 'safe' },
    () => ctx.fillText('来源：本片实测', source.x, source.y + 24));
  // 世界层绘制时保存 matrixOf(ctx)，还原屏幕变换后使用 follow(锚点, 矩阵)。
}
```

`withLayout(ctx, declaration, draw)` 为单次绘制登记 id、role、parent、required、space、scene、interval、boundary、slot、reading。role 支持 text、shape、caption、source、media、decoration、background；parent 指向先绘制的容器。也可将声明放入 `VideoSpec.layout.elements`，使用 `withLayout(ctx, 'id', draw)`。interval 使用整片秒数 `[start,end)`，声明描述可见时段；绘制函数负责实际启闭。overlay 指定 intent（emphasis／annotation／transition）、target、最终输出 region 和 interval；与目标无关的泛化声明进入复核。

QA 自动追踪主管线画布。自建离屏画布初始化调用 `trackLayout(ctx)`，每次重绘前 `trace.reset(time, plan)`；通过 `layoutScope(ctx,{scene:'shot'},draw)` 指定镜头。保留缓存画布的 trace，合成 drawImage 会传递字形、图形、裁切、变换与透明度。复制组件与固定引擎共享同进程的追踪表。普通 render 省略追踪，声明包装只执行绘制回调。

原视频保护区放 `layout.protections`，关联唯一 scene、target 元素 id、来源 source、可信状态 confirmed／unverified、有效 interval、坐标 space，以及 rect 或有序 keyframes。source 表示原图像素，world 经过当前 Canvas 变换，screen 表示当前合成面坐标，output 固定在最终输出坐标；转场合成继续映射前三种。关键帧在相邻时间线性插值，首尾保持最近值。切镜后为新镜头重新登记附着关系。

```json
{"protections":[{"id":"button","kind":"target","target":"screen-video","scene":"demo","space":"source","source":"人工核对原片按钮区域","status":"confirmed","interval":{"start":0,"end":2},"keyframes":[{"at":0,"rect":{"x":120,"y":80,"width":100,"height":40}},{"at":2,"rect":{"x":150,"y":80,"width":100,"height":40}}]}],"requirements":[{"scene":"demo","kinds":["target","cursor"]}]}
```

以 `withLayout(ctx,{id:'screen-video',role:'media'},()=>ctx.drawImage(...))` 包装素材的实际绘制，保护区自动经过源裁框、目标缩放、相机与 clip。人工世界坐标可调用 `protectLayout(ctx, region)`；source 手动登记需显式传入 `multiply(matrixOf(ctx),sourceMapping(source,destination))`。确认依据、关键帧和动态核验保存在本片 evidence。保护区检查范围见[布局 QA](layout-and-quality.md#渲染期布局-qa)。

## 三维渲染与空间镜头

当前共享运行时使用Canvas 2D。需要三维几何、环绕、空间推拉、爆炸分层或透视遮挡时，评估capabilities中登记的三维候选工具并验证本片路径；普通二维图形按已有绘制路径实现。

先核验本轮浏览器/WebGL、依赖和导帧能力，将本片场景代码与所需依赖副本放src/，模型与纹理放assets/。先做小场景，验证加载、固定时间渲染和导出帧。验证成功后通过本片exec脚本预渲染到assets/内的帧序列或视频，再交给已有合成与编码流程；依赖与输出继续遵守[项目边界](workflow.md)。素材预渲染与同步drawScene分别处理，三维渲染与现有画面合成各指定相机控制位置。

空间观感使用透视投影，需要保持尺寸关系的视图采用正交投影。固定尺寸、像素比、随机种子、相机与材质，按frameIndex/fps求值后执行实际渲染；导帧紧接渲染，核对绘制缓冲区清除、捕获时序、空白帧、颜色、透明边缘与尺寸。

记录实际版本、项目脚本、输入哈希、帧序列与编码结果，再声明本片实际采用的工具。共享能力表继续表示核心的集成状态，本片证据表示已验证的使用路径；跨GPU/宿主的逐字节重现按实测范围陈述。运镜设计与短样片验收见[电影化运镜](direction.md)。

已知主体按[参考与精确几何](drawing.md)先完成静态对照、技术关系和多尺寸验证。形变与手绘效果按[动效设计](drawing.md)准备轮廓对应、接力对象和中间态；contour 与 visual-check 为按需复制的组件。

粒子汇聚成标志或图形时，可在初始化选择 `--components particle-assembly`，自动复制 easing、random 依赖。按[轮廓粒子聚合](drawing.md#轮廓粒子聚合)准备形状内采样与弧线轨迹，逐帧按绝对时间求值，再由精确路径完成实体接力。

图片需要等比留白或裁切时，按需复制image-fit组件并调用fitImage；源裁框、目标框和量尺依据按[图片与量尺](drawing.md)核对。主体、次层、相机及声效使用同一事件时间轴；连续受力按固定时间求值，光影随实际空间关系绘制，选用机制及验收按[动效设计](drawing.md)登记。

字幕版面可在DirectorPlan的captionLayout或VideoSpec的captions设置fontScale（短边字号比例）、translationScale（译文字号比例）、maxWidth（画幅宽度比例）。1080宽竖屏可从40px主字、25px译文试排：fontScale=40/1080、translationScale=0.625、maxWidth=0.78。省略bottomInset时，外框中轴线位于77.5%屏高，单行、多行与双语共用该轴，字形上下居中；本片已确认位置覆盖时可显式设置bottomInset比例。按[字幕几何](captions.md#字幕外框与底部)结合平台UI、最长双语句与主体避让复核，预览按画幅同比缩放。

## 参考图与精确几何

已知品牌、角色或技术结构先做静态主体样张，再排动作。输入、采用范围、视角和来源写入本片 NOTES.md；原始文件留在 assets/，并排、叠图和局部放大留在 evidence/。辨识度与材料连接关系进入 brief.acceptance。

## 从输入到绘制

| 输入 | 实现路径 | 先核对 |
|---|---|---|
| 官方 SVG / 矢量 | 保留 viewBox、完整 path、孔洞、fill-rule、变换，使用 Path2D | 外轮廓、负空间、比例、朝向 |
| 照片 / 位图角色 | 标出边界框、头尾、眼、鳍、关节；沿轮廓分段拟合 Bézier | 大轮廓和地标位置，再处理材质 |
| 技术照片 / 原理图 | 明确俯视、沿轴剖面、横切和投影；拆出材料、端子、导线、绝缘、孔槽 | 接触、分隔、贯通、包覆、工序前后 |

已有精确路径时直接绘制。位图转曲线先看二值剪影，逐段调整控制点；尖角、拐点和圆滑段采用对应切线。投影作为最后的坐标变换，标签和测试点从同一几何模型投影。栅介质、侧墙、焊盘和通孔有独立形状，绘制顺序与遮挡须可复核。

Canvas 2D 同步入口可用 `ctx.fill(new Path2D(pathData), fillRule)`。精确路径的绘制与变换示例：

```js
// pathData、viewBox、fillRule 来自本片 SVG，在初始化时读取。
const shape = new Path2D(pathData);
function drawMark(ctx, x, y, width) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(width / viewBox.width, width / viewBox.width);
  ctx.translate(-viewBox.x, -viewBox.y);
  ctx.fillStyle = '#4D6BFE';
  ctx.fill(shape, fillRule);
  ctx.restore();
}
```

多路径、孔洞、SVG 变换逐项保留。共享 Canvas 2D 几何，生产继续使用已有渲染器；其他二维入口与 WebGL 画法各按契约核对。初始化载入素材，drawScene 同步求值，同帧由输入和帧号确定。

## 位图裁切、尺度与量尺

产品、角色与精确结构的位图采用等比缩放。先确定实际源裁框，再选择contain保留完整内容或cover等比裁切；源宽高比与目标框不同时由留白或裁切解决。分别计算`sx = 目标宽 / 源裁宽`、`sy = 目标高 / 源裁高`，记录`sx / sy`核对形状比例。设计性的拉伸、拖影等按本片意图标明，落定状态核对约定比例。

证据截图默认采用完整原图与 contain，保留上下文及原始比例。划线、圈框、聚焦和隐私遮挡先在原图坐标登记，再与原件共用同一缩放和平移；局部放大同时保留全貌参照与对应位置。隐私采用独立遮挡层，并验证遮挡在进入、缩放与转场中持续覆盖。实景和 B-roll 按镜头任务取景，证据中的数值、限定和关系完整保留。

初始化可选`image-fit`组件。`fitImage(source, target, 'contain' | 'cover')`返回源框与目标框，直接用于Canvas的九参数drawImage；源框坐标来自实际图像或已选裁框：

```js
const { source: s, destination: d } = fitImage(
  { x: 0, y: 0, width: image.width, height: image.height },
  { x: 120, y: 240, width: 800, height: 1000 }, 'cover',
);
ctx.drawImage(image, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
```

量尺的端点、方向、单位与被测对象采用同一几何依据。屏幕英寸以屏幕矩形的对角线表达，机身高度、厚度及部件间距各标明自己的口径；透视图可配独立正视测量示意。比较前核对尺度、基准和测量口径，示意比例明确标注。用非正方形素材和已知圆形或网格验证裁切比例，再从编码特写复核。

## 精度与细节

将“细致”写成可见部件与关系：品牌的嘴、眼、尾；器件的源漏、栅介质、侧墙、接触；电路的端子、焊盘、走线、过孔。每条线写清语义。PCB、封装基板、芯片版图、器件剖面各有尺度与结构，进入细节时用局部放大接力。

关键薄层在最终尺寸下清楚分离，必要时教学放大并标注。重复结构使用实际部件的实例，布线采用端子到端子的路径，交叉点按层与过孔表达。结构验证之后加材质和光照。规定最小线宽、间隔、薄层厚度、图例对比度，检查 1080p 与手机宽度；关键结构丢失时放大主体或做特写。

## 组件级验证

1. **独立参照**：登记参考版本、哈希、视角、包围盒、地标和容差。先写预期，再实现绘制。
2. **形状核对**：同视口比较透明 mask，记录 IoU、缺失、多余区域；眼、嘴、尖角和孔洞另设局部检查。阈值按输入质量和用途约定；官方路径采用高精度，位图拟合结合地标误差与审图。
3. **技术核对**：必须连接的端子、隔开的材料、贯通的通孔、包覆的沟道有几何断言及最终像素探针。预期依据参考独立填写，测试读取绘制所用几何。注入断线、缺失介质、孔洞填死、错位，确认能报错。
4. **运动核对**：起点、25%、50%、75%、终点和事件附近取样；检查旋转、遮挡、中间态、乱序同帧一致。静态锁定后加动作，地标与技术不变量持续满足。
5. **成片核对**：编码视频提取相同时间和区域，复核压缩后的间隔、颜色、文字；播放短预览查看速度与承接。

start 的 `--components` 可选 `visual-check`，本片通过 exec 运行测试。`compareMasks` 比较配准的透明 mask，`colorCoverage` 检查成片中的材料或间隔。报告附输入、源码、视频哈希、帧号、尺寸、区域、阈值、实际值、失败原因。IoU 提供轮廓证据，探针提供选定结构证据；实际审图继续评估身份、解释、质感。

同条件对照保持脚本、镜长、配音、画幅、编码参数和取样时刻一致，保留原版及声音排程。纯视觉改片按[音视频流程](workflow.md)复用原音轨，检查最终音频包哈希一致。每轮记录问题、修改、验证。关键主体的轮廓、结构、手机可读性、编码后验证满足本片约定后确认视觉验收。

## 形状接力

每段写出接力关系，如轮廓拉长成线、圆孔放大成为下一场景窗口、导线延伸成为电路路线。保留可追踪焦点，开始、最大变形、落定分别排时序。描线、形变、负空间遮罩、遮挡换景、匹配剪切可组合。

| 方法 | 实现重点 | 复核重点 |
|---|---|---|
| 闭合轮廓形变 | 同坐标、同绕向、按弧长等量重采样，匹配起点与语义地标 | 交叉、面积塌缩、孔洞、身份 |
| 手绘线条变化 | 从基准轮廓沿法线有界扰动，按约 8–12 次/秒保持笔触 | 辨识度、位移上限、时间量化、乱序一致 |
| 拖影 / 拉伸 | 沿运动方向变形，落定恢复基准，特征独立分层 | 最大变形、落定、描边厚度 |
| 负空间 / 窗口 | 孔洞中心接续下一镜中心，扩展覆盖画面 | 孔径、边缘、方向 |
| 点线面 / 阵列 | 描线成面，面分裂成实例，按索引或距离错开启动 | 层级、节奏密度、数量与含义 |
| 景深 / 隧道 | 多层框、孔、线以统一焦点递进 | 深度排序、方向、裁切与阅读区 |

可选 `contour`：`prepareMorph(from, to, count)` 准备闭合外轮廓的弧长采样、绕向、循环起点；`morphContour(pair, progress)` 插值；`boilContour(base, time, {seed, amount, rate})` 给出有界笔触变化。自动起点按距离选择，语义地标要求明确时在本片分段对应。孔洞、分离部件、开曲线、拓扑改变各自处理；合并或分裂可借助遮挡中间态和分层动画。

品牌与技术关系采用[精确几何](drawing.md)约束。品牌可在整体平移、旋转、揭幕中保持路径；技术剖面在材料分隔和连接成立的条件下过渡。手绘幅度受最小间隔与地标容差约束。

多边形变化先画起始、最大变形、结束三个状态，按语义地标对应顶点；再检查全部过渡帧的边交叉、窄缝、面积和遮罩覆盖。合并／分裂时明确各部分的归属，通过分层或遮挡建立中间态。速度方向、轮廓、视觉重心至少保留一项可追踪线索；文字在容器稳定并取得足够空间后进入。接续的理解收益尚待判断时，在已有样片中按[小对照](motion.md#设计判断与有条件的方法)比较简单切法。

## 现实物理与图形表达

在事件表按主体或图层注明采用写实物理、教学示意或抽象图形，并给出模型依据、简化条件和验收点。同镜混合时分别核对各层的规则与空间对应。多边形形变承担抽象关系；写实对象的运动服从其材质、受力和空间条件。

| 场景 | 设计与实现依据 | 复核 |
|---|---|---|
| 刚体与接触 | 保持局部几何尺寸，明确质心、支点和碰撞表面；附着部件与世界标签随物体变换，屏幕标注追踪对应锚点 | 穿透、悬空、接触点滑动、关联部件错位 |
| 重力／抛掷／碰撞 | 明确坐标方向、比例、初速度、重力与阻尼；恒重力自由飞行用解析轨迹，复杂系统用固定步长预计算 | 飞行轨迹、接触发生时刻、冲量与能量变化符合所设模型 |
| 滚动／铰接 | 纯滚动按无滑动条件约束位移与转角；关节保留转轴和杆长 | 轮地接触、方向、转动半径和限位 |
| 弹性与流体 | 按材质约束回弹、体积、阻尼和形变范围；不可压缩模型检查体积守恒 | 最大变形、回弹衰减、边界及落定 |
| 光与空间 | 明确光源与相机的静止状态或运动轨迹，按空间关系更新遮挡和接触阴影 | 镜头运动时透视、反射、阴影连续，主体身份稳定 |

教学示意注明时间压缩、尺度变化或理想化条件，变量、单位与因果先后保持准确。抽象图形遵循本片建立的视觉规则。匀速输送、匀角速旋转等动作在本片绘制中使用相应线性时间函数，界面弹簧用于适合的视觉响应；主题 easing token 沿用其校验契约。真实单向过程按正向因果播放，回放用于明确的二次拆解。固定时间求帧与随机种子规则贯穿三种表达。

## 轮廓粒子聚合

适用于平面标志、图标、文字轮廓和图解部件的“分散 → 汇聚 → 成形”。粒子云提供方向和节奏，描边提早建立辨识度，精确路径承担落定形状。立体绕行、真实碰撞与流体运动需要相应的空间或物理模型。

可选 `particle-assembly` 提供 `prepareParticleAssembly(options)` 与 `particleAssemblyAt(assembly, seconds)`。初始化时在形状紧包围框内做固定种子采样，`contains(x, y)` 使用与最终绘制相同的路径、填充规则和局部坐标，支持孔洞与分离部件。每粒子固定起点、终点、半径与启动差；`bend` 是共享的一号贝塞尔控制点，`approach` 是相对各自终点的二号控制点偏移。五次缓动沿三次贝塞尔曲线求位置，两端速度归零。时间单位为秒，几何与半径均为局部绘制单位。

```js
import { Canvas, Path2D } from '../.engine/node_modules/skia-canvas/lib/index.js';
import { prepareParticleAssembly, particleAssemblyAt } from './components/particle-assembly.ts';
import { smootherstep } from './components/easing.ts';

// 虚构方环；初始化一次，两个同绕向子路径以 evenodd 保留孔洞。
const shape = new Path2D('M0 0H100V100H0Z M30 30H70V70H30Z');
const probe = new Canvas(1, 1).getContext('2d');
const assembly = prepareParticleAssembly({
  bounds: {x: 0, y: 0, width: 100, height: 100},
  contains: (x, y) => probe.isPointInPath(shape, x, y, 'evenodd'),
  source: {x: -110, y: 120, width: 180, height: 60},
  bend: [-20, 30], approach: [-28, 26], count: 360, seed: 'square-ring',
  radius: [.35, .7], start: .15, duration: 2, stagger: .55,
});

function drawAssembly(ctx, time) {
  const solid = smootherstep(1.8, 3, time);
  const outline = smootherstep(.9, 1.7, time) * (1 - smootherstep(2.3, 3, time));
  ctx.save();
  ctx.fillStyle = ctx.strokeStyle = '#276b62';
  for (const p of particleAssemblyAt(assembly, time)) {
    ctx.globalAlpha = .8 * p.opacity * (1 - solid);
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = outline * .5; ctx.lineWidth = .25; ctx.stroke(shape);
  ctx.globalAlpha = solid; ctx.fill(shape, 'evenodd');
  ctx.restore();
}
```

本例数值仅用于试排。按主体投影面积与最小特征调粒子数、半径和密度；`source`、`bend`、`approach` 共同决定流向，薄线束可顺同一流向辅助构图。背景光场、线束、粒子、轮廓、实体各自分层，主体相关层共享变换。移动主体时对整组应用相机或对象变换，保持终点与路径吻合；装饰线遇到眼孔、开口等识别特征时分段或按图层遮挡处理。

安排最晚到达时间 `start + duration + stagger` 早于实体完全显现；粒子透明度乘 `1 - solid`，描边在实体落定前淡出。自由飞行可经过负空间，落定帧以原始精确路径校验孔洞和轮廓。渐显区间以主体辨识度和密度推进为依据，给成形结果安排稳定停留。准备函数最多尝试 `count × 200` 次；采样不足时检查填充规则、坐标和包围框，细小分离部件可按部件分别准备再合成。

验证相同 seed 和时间的乱序求值一致、粒子终点位于形状内部、端点落定及中间状态有限。渲染包含孔洞与分离部件的短样片，连续检查汇聚、描边和实体交接；落定掩模与独立原路径对比。按目标画幅检查密度、边缘溢出和负空间，结合[时序与验证](direction.md#两级动态预演)检查实际编码节奏。数值检查、抽帧和连续观看分别记录范围。

## 信息卡与清单分拍

适用条件：单镜约 4 秒以上、画面以信息卡、价格档、时间线、清单或示意图标注为主的解说镜头。

- **按语义推进**：新增数字、档位、印章或结论默认在对应关键词处进入；已有比较基准、坐标和必要全貌可先建立，再按词高亮或更新局部。推进与阅读用途按[防死帧](style-and-identity.md#防死帧)验收。
- **错相与落定**：主卡建立 → 次级数字/标签回应 → 印章或结论落定；按材质与语义选择缓动，阅读标签优先平稳落定，完整结果保留读时。
- **与字幕错开**：大字或新卡进场避开上一句字幕的淡出尾段，避免短暂叠字。
- **验证**：在该镜内按关键词抽 3–5 帧，核对信息推进和完整结果的读时；`dead-frame-qa` 的静止候选结合 reading hold、观察与情绪停留逐段判断。

## 连续目标与解析弹簧


可选组件 `spring` 提供 `spring(seconds, {stiffness, damping, mass})` 与 `springTrack(seconds, keys, options)`，支持欠阻尼、临界阻尼和过阻尼。keys 为严格递增的 `[秒, 目标值]`；第一项表示初值，后续目标的阶跃响应叠加，保留运动途中改目标的位移与速度连续性。同一轨迹的参数保持一致，按固定时间直接求值。

```js
import { springTrack } from './components/spring.ts';
const stops = [[0, 180], [0.6, 620], [0.95, 420], [2.2, 760]];
const x = springTrack(time, stops, { stiffness: 180, damping: 24, mass: 1 });
```

时间单位为秒，输出保留自然过冲；图形位置、边缘和宽度按各自轨迹取值。宽高、相机 zoom 与阅读文字优先试临界阻尼 `damping = 2 * sqrt(stiffness * mass)`，材质需要弹性时再降低阻尼。物理落定为渐近过程，停留区间按可见误差安排；闭环同时核对接缝的位置、速度与内容。时间取模提供循环时钟，首尾状态由设计保持连续。

保留主体、次级响应与相机之间的启动差。线性运动、缓动、弹簧和静止按事件含义选择，科学数值、刚性尺寸及连接遵循内容约束。容器与文字的交接按下节执行。

## 跨镜连续状态

适用于同一对象的选中、换目标、局部揭示与形变接力。为对象指定身份、世界坐标和覆盖相邻镜头的绝对时间函数，两侧绘制都从该函数取状态；目标键保留完整历史。主对象、关联部件和世界标签共享变换，屏幕字幕与来源单独绘制。逐镜局部时间用于明确重新开始的事件，连续轨迹使用全片时间。

连续对象按 `context.time` 求值。`springTrack` 保存完整目标历史；相机 zoom 可在对数空间求值后 `Math.exp` 恢复。每层用 `save → applyCameraPose → draw → restore`，屏幕文字在 restore 后绘制。相邻镜头的管线使用 `static` 与 `cut`。

本例的换目标发生在前一动作完成前，解析弹簧保留接续位置和速度。相机指定一个权威控制位置；本片对象接力承担跨镜变化时，管线采用 `static` 与 `cut`。采用整镜转场时，把其变换和镜内动作放入同一时序检查。`cameraPath` 的逐段缓动适合安排明确起落的镜头，跨段仍需核对接续速度。

按因果安排旧内容退出、主体运动、容器形变、相机跟随和新标签进入；形状的语义地标建立对应，孔洞与分离部件分别处理。完整结果的读时从最后一项内容清楚、外形落定开始计算。分别比较稳定切镜与连续接力，保留实际收益和适用范围。

切点及换目标两侧按固定时间步长估算位置、尺度和速度，并检查身份、轮廓、乱序求帧及最大变形；正常速度和手机尺寸复核注意力、落定与读时。轨迹成立后再比较原生 30／60fps。局部时间采样从同一时间函数重求运动图层，声明快门秒数、样本数和硬切边界；阅读文字、字幕与科学数值按当前时刻清楚绘制。帧率、采样和连续性各保留自己的证据。

## 状态联动与容器交接

适用于控件演示、流程节点、进度、计数和图表。先定义权威状态，再从同一时刻的状态派生位置、填充、数值与标签；记录单位、上下界、离散或连续的含义。真实数据按来源更新，装饰回弹作用于承载图形。数量与完成状态按实际事件推进，连续比例按同一参数求值。

以下虚构控件在 0.8–1.6 秒从 0 调至 100，位置、填充和显示值共享同一进度。初始化项目时包含 `easing` 组件，将函数放入本片 `src/`：

```js
const progress = smootherstep(0.8, 1.6, time);
const state = { knobX: 120 + 600 * progress, fillWidth: 600 * progress, value: Math.round(100 * progress) };
```

本例表示已知端点间的演示变化，真实操作延迟和测量值按实际来源排程。标签锚点使用 `knobX`，边缘处按字形外框调整并保留连接线索；最终 `100` 从 1.6 秒起保留完整读时。拖动演示期间由指针位置直接确定控件值，释放后的回弹在本片保留释放位置和速度并验证接续。

容器交接分别安排外形、内容、标签和相机的时间：旧内容退出 → 容器取得新尺寸 → 新内容进入 → 结果稳定。容器尺寸由当前和目标内容的实测外框确定，进退时使用本地裁切。需要伸缩的指示条可错开前后边缘的轨迹，逐帧核对正宽度、圆角和目标覆盖。全屏遮罩在交接帧覆盖变换后的四角，并预留抗锯齿边缘。

验证乱序求帧一致；在触发、换目标、文字交接与落定处取连续帧，检查数值与图形对应、标签锚定、内容遮挡、四角漏底和结果读时。连续切换目标可复用 `springTrack`，稳定阅读可使用静镜，品牌路径与技术结构继续按各自几何约束核验。

## 分层、受力与光

重点动作按内容选用下表，在evidence/events.md记录对象、触发帧、受力或表达依据，以及落定结果。按前景、中景、背景及主体、次主体分清职责；需要联动的刚性部件、标签与量尺共享几何变换，注意力交接和次级响应各自安排时间。

| 能力 | 适用与实现 | 编码验收 |
|---|---|---|
| 分层错相 | 主体建立事件，次层回应，相机跟随或揭示；时间差按注意力和因果确定 | 比较每层开始、峰值、落定，复核焦点、遮挡和阅读区 |
| 完整动作 | 有冲击或弹性的对象安排预备、加速、接触、回弹及次级响应；刚性产品保留尺寸，形变由适合的材质承担 | 接触成立，最大变形受几何约束，落定回到目标，结果有停留 |
| 动量接续 | 连续运动保留接续位置与速度方向；有意停顿、碰撞、剪切分别写出理由 | 切点两侧按固定帧步长估算位移与速度，连续预览检查跳变 |
| 明确受力 | 重力、惯性、弹簧或波动用解析时间函数或固定步长预计算；随机变化由seed和帧号决定 | 乱序求值同帧一致，力的方向、响应传播和衰减清楚 |
| 统一光照 | 同空间确定主光方向，高光、倒影和影子随物体、相机及光源关系变化；次级震动沿对象传导 | 阴影接触与方向一致，细节微动有原因，关键文字和解释坐标稳定 |

采用空间错相、过冲或速度变化时，从上表选择承担本镜内容的机制；稳定阅读镜头保留清楚的坐标与落定。参考规则的来源及实际观看范围见[表达机制](motion.md)。

文字、坐标、量尺和技术图形密集的镜头，先检验硬切或局部对象接力。采用整页叠化时连续检查完整混合区间，核对中间态的文字、轮廓、基准线和焦点；发现重影时调整图层、标签替换时序或切法。科学坐标与变量身份在局部变化中保持可追踪。

先渲染 2–6 秒预览，检查起点、四分点、中点、终点、切点两侧。报告帧号、参数、地标位移、间隔、确定性；连续播放检查速度、拖影、停留。极值处检查自交、孔洞闭合、薄层消失、遮罩露边、主体或文字裁切。保存可复现预览和编码取样，修正后进入全片。

## 自定义材料的可复查规则

材料设计分别指定背景、道具与主体的色板、笔触方向、造型、叠层顺序和用途；小部件保留地标与最小特征。固定采样位置和随机种子，以连续时间改变方向场、光照或整体变换；低频线稿扰动使用量化时间。跨渲染上下文核对混合模式、滤镜、字体、加载与导帧。正式主体静帧、运动极值和连续样片分别检查材料一致性与编码细节。共享运行时提供主题质感和 Canvas 图元；定制材料在本片实现。
