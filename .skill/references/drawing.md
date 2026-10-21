# 本片绘制

按内容选择 elements、关键帧、组件副本或本片代码实现画面，主体、场景、材质与轨迹可由模型独立设计。图元与动画字段通过 capabilities --schema 查询；组件复制到 src/components/ 后可独立修改。内置字段使用已登记枚举，自绘通过下述同步入口实现，浏览器／WebGL 等路径按[预渲染流程](#三维渲染与空间镜头)验证后合成。个人识别与可调默认沿用[规则作用范围](styles.md#规则的作用范围)。

素材按[素材选择](assets.md)组合生成图片与精确代码图形。图片在初始化阶段加载，逐帧绘制同步读取已准备好的素材；生成、下载及异步准备在绘制循环之外完成。

自定义入口在project.json中配置drawing: "src/draw.mjs"，模块导出同步drawScene(context, frame)。context提供ctx、width、height、scene、progress、seed；frame提供帧号、fps和整片时间。ctx为共享Canvas 2D上下文，progress为当前镜头进度，转场可能求值两个镜头。

`context.noText` 为 true 时只绘制场景底层与主体，文字在其余调用中绘制；`riseFade` 等转场使用这份无字画面承接两层文字的进退。

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

图片句柄提供 width、height 和同步 draw；视频句柄提供 width、height、frames、fps、frame(index) 与 draw(ctx, index, target)。frame 返回该帧的独立 RGBA 副本；draw 保留现有相机/转场上下文，按计划的裁框和适配方式合成。帧号从本片时间确定，乱序求值保持同帧一致。消费记录区分准备读取、帧访问与绘制，覆盖与披露口径见 [素材需求与消费](assets.md#镜头需求版本选择与实际消费)。

生产 0.2 视频句柄读取交付 RGBA 的单帧，预览代理保留自己的尺寸与身份。原声沿同一选段和 clip placement 进入音频时间线；明确静音、原件无声和保留原声各自记录。资源预算不足时根据实际所需数量分段准备当前镜头素材，保留原件与已成功结果。

连续动作可在初始化时选择 `--components camera,spring,random`，组件与依赖复制到本片。`springTrack` 的连续目标见[动效设计](motion-design.md)；`applyCameraPose` 的焦点、分层和固定字幕见[电影化运镜](cinematography.md)。本片绘制按逻辑画幅排布，先缩放到实际编码尺寸；多画幅交付时分别重新构图并验证阅读区。

## 三维渲染与空间镜头

当前共享运行时使用Canvas 2D。需要三维几何、环绕、空间推拉、爆炸分层或透视遮挡时，评估capabilities中登记的三维候选工具并验证本片路径；普通二维图形按已有绘制路径实现。

先核验本轮浏览器/WebGL、依赖和导帧能力，将本片场景代码与所需依赖副本放src/，模型与纹理放assets/。先做小场景，验证加载、固定时间渲染和导出帧。验证成功后通过本片exec脚本预渲染到assets/内的帧序列或视频，再交给已有合成与编码流程；依赖与输出继续遵守[项目边界](workspace.md)。素材预渲染与同步drawScene分别处理，三维渲染与现有画面合成各指定相机控制位置。

空间观感使用透视投影，需要保持尺寸关系的视图采用正交投影。固定尺寸、像素比、随机种子、相机与材质，按frameIndex/fps求值后执行实际渲染；导帧紧接渲染，核对绘制缓冲区清除、捕获时序、空白帧、颜色、透明边缘与尺寸。

记录实际版本、项目脚本、输入哈希、帧序列与编码结果，再声明本片实际采用的工具。共享能力表继续表示核心的集成状态，本片证据表示已验证的使用路径；跨GPU/宿主的逐字节重现按实测范围陈述。运镜设计与短样片验收见[电影化运镜](cinematography.md)。

已知主体按[参考与精确几何](reference-geometry.md)先完成静态对照、技术关系和多尺寸验证。形变与手绘效果按[动效设计](motion-design.md)准备轮廓对应、接力对象和中间态；contour 与 visual-check 为按需复制的组件。

粒子汇聚成标志或图形时，可在初始化选择 `--components particle-assembly`，自动复制 easing、random 依赖。按[轮廓粒子聚合](motion-design.md#轮廓粒子聚合)准备形状内采样与弧线轨迹，逐帧按绝对时间求值，再由精确路径完成实体接力。

图片需要等比留白或裁切时，按需复制image-fit组件并调用fitImage；源裁框、目标框和量尺依据按[图片与量尺](reference-geometry.md)核对。主体、次层、相机及声效使用同一事件时间轴；连续受力按固定时间求值，光影随实际空间关系绘制，选用机制及验收按[动效设计](motion-design.md)登记。

字幕版面可在DirectorPlan的captionLayout或VideoSpec的captions设置fontScale（短边字号比例）、translationScale（译文字号比例）、maxWidth（画幅宽度比例）。1080宽竖屏可从40px主字、25px译文试排：fontScale=40/1080、translationScale=0.625、maxWidth=0.78。省略bottomInset时，外框中轴线位于77.5%屏高，单行、多行与双语共用该轴，字形上下居中；本片已确认位置覆盖时可显式设置bottomInset比例。按[字幕几何](captions-and-shots.md#字幕外框与底部)结合平台UI、最长双语句与主体避让复核，预览按画幅同比缩放。
