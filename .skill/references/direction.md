# 导演计划

新片先完成[创作问答](workflow.md)，沿用用户已明确的要求与创意委托。在 NOTES.md 写清观众应记住的一件事、主视觉、叙事主轴、材质与光线、字体和声音气质。重要视觉选择按已有审批要求处理。事实、素材与技术结构按[素材选择](workflow.md)和[精确几何](drawing.md)核对。

各类风格的动效段落按[共用动效标准](motion.md)设计。每镜先回答主题、台词／镜头意义、动作与运镜选择三个问题，再写观众应看见的证据；相邻镜头的接力须能说明信息或情绪作用。

## 从内容到连续状态

先为核心承诺设计“起始状态 → 触发 → 可见变化 → 结果”，再决定构图和文字。以同一对象、变量、任务或空间关系串起段落；把输入、选择、压缩、检验、失败、结果等动词落实到画面。标题承担提问、转折或结论，主要信息由事件发展呈现。把观众要读的内容和要看的动作排出先后。

默认维护一张分镜主表，普通镜头短行表达，复杂镜头补局部说明：

| 镜头 ID / 大致时段 | 表达与情绪 | visualIntent：画面具体发生什么 | 与下一镜的关系 | 必要声画锚点 |
|---|---|---|---|---|

先按意义变化与视觉事件拆原句，再安排镜头；标点、字数与固定拍数分别用于各自的局部排版或音乐需求。`visualIntent` 写清必要的起点、动作和结果，由模型落实为本片 `src/` 或明确选用的图元。数字成为台阶时，实际画面须有阶梯关系、接触和跨阶动作。

Production 项目直接采用 `shots.items`（purpose、visualIntent、nextRelation、events）及 timeline，`production/plan.md` 单向生成这张主表；`evidence/events.md` 保存局部实现索引和验收目标。采用上游 director.json 时，模型将其稳定镜头 ID、完整意图及已验证安排提交 `production apply`，此后当前 bundle 负责执行；上游修订再次 apply、重编译。普通 Director 项目沿用 direct compile。精确帧数、样本位置归 timeline 和代码，审片问题归 review。

把全片镜头并排比较，辨认持续重复的构图。连续三镜都沿用相同的标题区、中央卡片和页脚时，检查其叙事用途，并为需要推进的段落改写空间关系或主体状态。品牌统一通过颜色、字体、形状和运动语法保持；各镜按内容组织版面。技术讲解保留必要的坐标、标签和证据口径。

短促的宣传段可从每 2–4 秒一次有效信息变化试排，长讲解按因果、动作和阅读安排。有效变化包括关系被揭示、动作取得结果、尺度或焦点发生改变；背景粒子、循环漂浮和进度条计入氛围。静镜与长停留写清观众正在理解或感受什么。旁白、字幕和镜头各自分段，完整台词可以跨视觉切点，详见[语义分镜](captions.md)。

## 两级动态预演

关键形式选择的收益尚待判断时，按[小对照](motion.md#设计判断与有条件的方法)在现有预演中比较同内容的解法，记录变量、观察和取舍。已有明确依据的选择直接推进，局部改片沿用认可的整体结构。

1. **完整动态粗剪**：用低分辨率、简化几何和已测配音／音乐走完整时间轴，保留计划中的对象动作、相机与切点。正常速度检查开头、段落推进、构图变化、快慢和结尾。对重复布局、入场后长时间停滞、同款切法连续使用逐段写下具体修正，再展开精修。短片可直接使用整片预览。
2. **重点镜头样片**：用正式主体与素材验证最有代表性的动作、主要运镜和相邻切点，检查极值、中间态、字幕与声音。覆盖一个普通段落，检验常规镜头的质量。状态结果清楚、身份与结构成立、景别和接力可感知、文字可读、时序连续后进入主片。

样片与粗剪可按风险交替制作。已有认可的全片结构用于局部改片时，预演覆盖改动及相邻镜头。相机控制、焦点坐标和分层方法见[电影化运镜](direction.md)；受力、形变与连续目标见[动效设计](drawing.md)。产品广告可按需研究[产品与体验叙事](motion.md)，其他题材按[表达机制](motion.md)选择。

## 关键事件与主片整合

承担核心承诺、机制解释或情绪转折的事件使用稳定 ID，记录内容依据、起始状态、主动作、结果和验收条件。观众应能看见或听见的证据写入 brief.acceptance；主片时间码关联实际编码。事件状态按 planned、sample-verified、integrated、encoded-verified 逐步更新，各状态保留其版本和观察范围。

先测真实配音的逐句与关键词时间，再定动作、镜长和阅读停留；音乐主导段按实测拍点或程序音乐的节拍原点排程。事件表使用同一绝对时间轴。每个重点事件的承诺与实际结果按[成片质量](layout-and-quality.md)复核。

## 运行时字段

通过 capabilities --schema 查询 DirectorPlan@0.1 字段与枚举。idea 保留原文，purpose 写叙事作用，visualIntent 写具体可见变化。事件表承载导演设计；复杂轨迹由本片 src/ 实现。相机指定一处控制：使用本片相机时将该镜头的管线 cameraMove 设为 static，并省略该镜的 cameraPath。

voice 选择本片音色，narrationRate 为相对正常语速的整数百分比，narrationOffset 为镜内秒数；sfx 填写镜内 offset、preset 与可选 volume。sfx: [] 用于安静镜头，省略字段沿用既有默认值。click 与 success 按实际事件使用。

brief.json 保存交付、输入来源、工具、声明与验收；humanRounds 未知时填 null。导演项目修改 director.json 后运行 direct compile；原生 VideoSpec 使用 project.json 的 entry 和 drawing。后续按[绘制](drawing.md)与[音视频流程](workflow.md)执行。

## 从参考到镜头

阅读教程时记录来源与实际阅读范围；参考影片时实际观看片段，记录时间区间、景别、相机路径、焦点、前后景、速度变化、遮挡、切点和声音。把观察与本片设计分别写入NOTES.md和evidence/。将学到的动作应用到本片主事件，按内容选用。

产品镜头的尺度揭示、焦点交接与构图接力见[产品与体验叙事](motion.md)。参考拆解分别登记屏幕中的相对运动、可判断的相机变化、主体动作与光线变化；拍摄设备和轨迹需要制作资料或实测依据。逐镜写出运动揭示了哪一个细节，以及下一镜接续的位置、轮廓、方向或功能结果。

| 方法 | 可承担的任务 | 本片实现与复核 |
|---|---|---|
| 推进 / 拉远 | 揭示细节、建立全貌或尺度 | 排出起止位置与停留；检查近远景视差、主体占比及裁切 |
| 横移跟拍 | 沿事件、物体或线路展开信息 | 主体运动与相机错开时序；检查屏幕方向与连续焦点 |
| 环绕 / 弧线 | 展示体积、材料与结构关系 | 用三维几何或已验证的多视角素材；检查遮挡与身份稳定 |
| 升降 / 俯仰 | 揭示层次、空间或规模 | 安排前景、中景与背景；检查视线目标及清楚的落定构图 |
| 焦点转移 | 在两个信息对象之间交接注意力 | 明确两个焦点与转移时间；文字和讲解关键结构保持可读 |
| 遮挡揭幕 / 匹配剪切 | 在镜头间接续位置、轮廓与动作 | 把遮挡物、接力对象与下一镜落点排在同一时间线上 |
| 快速摇移 / 速度变化 | 强调突破、冲击或情绪转折 | 配合动作与音效，保留落定和阅读时间；连续播放检查方向 |
| 推拉变焦 | 在保持主体占比时改变空间观感 | 同时排出相机距离与视场角；检查主体尺寸及背景透视 |

相机位移改变观察位置与视差；视场角或焦距改变取景范围。2D整体缩放对应画面推拉，分层素材可实现受限空间视差，三维相机适合真实空间运动。本项目按上表将运动、焦点及视场角控制用于叙事。

## 实拍 B-roll 与代码层

适用条件：官方或授权实拍作垫底、代码绘制大字/字幕/标注叠在上面（素材分配见[官方 B-roll 不重复](workflow.md#素材选择与生成视频)）。

- **字幕可读**：亮区（烟雾、车身高光、白墙）采用字幕框内底色或半透明底条维持对比。字幕外框中轴线默认位于77.5%屏高，实际字形上下居中，在平台预览中避开底部信息和右侧按钮；字幕按普通叠加层绘制，见[字幕外框与底部](captions.md#字幕外框与底部)。
- **色温**：实拍偏红/偏冷时，对代码层或实拍做轻微统一；品牌黄标注按[色彩系统](style-and-identity.md#品牌黄色彩系统)核对对比与主体分离，保留实物原色。正片构图按内容独立设计。
- **切源**：按前后事件、动作方向和焦点选择切法。连续动作核对接续位置；改变场景时明确交代新空间。甩切或叠化按语义作用和实际帧率定时，并检查中间态。
- **色带**：暗部光晕出现色带时，检查源渐变色阶、量化和压缩，试用轻微抖动/dither并复核编码结果；帧率按运动采样需求选择。

## 本片焦点相机


`camera` 组件的 `cameraFor` 保留轻幅预设；`applyCameraPose(ctx, {x, y, zoom, rotation}, width, height, parallax)` 提供按镜头设计的二维取景。x/y 为本片逻辑坐标中的相机焦点，zoom 为正缩放，rotation 为弧度；parallax=1 将焦点投到画幅中心，0 保持屏幕坐标，较小值用于远层，较大值用于前层。缩放后的图层仍须覆盖画幅。

```js
import { applyCameraPose } from './components/camera.ts';
import { springTrack } from './components/spring.ts';
const motion = { stiffness: 100, damping: 20 };
const pose = {
  x: springTrack(t, [[0, width / 2], [0.6, width * 0.72], [2.8, width / 2]], motion),
  y: height / 2,
  zoom: springTrack(t, [[0, 1], [0.6, 2.2], [2.8, 1]], motion),
};
ctx.save();
applyCameraPose(ctx, pose, width, height);
drawWorld(ctx, t); // 本片主体及其关联标签
ctx.restore();
drawOverlay(ctx, t); // 屏幕文字；管线字幕随后绘制
```

需要视差时，每层分别 save/applyCameraPose/绘制/restore，共用同一个 pose 和逻辑坐标。主体、连接线、量尺及世界标签使用相同 parallax，屏幕字幕在变换外绘制。分层取景支持二维和受限空间表达；真实环绕、透视和遮挡变化按[三维路径](drawing.md)验证。重构图依据可见发现设计，原有预设幅度继续服务轻幅镜头。

## 能力与权威位置

以下源码路径相对本片 `.engine/`；新增画法在本片 `src/` 及组件副本实现。

| 任务 | 当前接口 | 使用与验证 |
|---|---|---|
| 关键帧相机 | `src/motion/camera-path.ts`：`cameraPath`、`push`、`cameraMove` | 以镜头内秒数排关键帧；检查注视点、起止速度、最大缩放与安全区 |
| 分层视差 | `src/drawing/primitives/camera.ts`：`applyCameraPose` | 远景、主体和前景采用不同视差；固定信息层单独保持稳定 |
| 焦点钻入 | `src/motion/focus.ts`：`focus`、`focusCenter`、`zoomToFill` | 上一镜标出接力对象，下一镜使用允许的 `zoomIntoElement`；连续检查交接两侧 |
| 图片与视频运动 | `src/footage/`：`footage`、`crop`、`kenBurns`、`speed`、`color` | 核对素材身份、比例、裁切和变速后的连续性；登记资产按[受控消费](workflow.md#视频准备与实际消费)绑定 |
| 文字读时 | `src/motion/shot-timing.ts`：`readingSeconds`、`minShotSeconds`、`planShotTimings` | 排程预设含进入与落定并受上下限限制；`SHOT_TOO_SHORT_FOR_TEXT` 按完整估计读时告警，多行结果按实际阅读拆分或调整 |
| 旁白切点 | 同上：`gapMidpointCuts`、`phraseCut` | 使用实际词／句时间；按[字幕与分镜](captions.md)保存意义和完整结果读时 |
| 音乐拍点 | `src/audio/beat-grid.ts`：`beatGrid`、`snapCutsToBeats`、`addCutAccents` | 使用明确 BPM 与 origin，记录切点偏移；操作与试听见[音视频流程](workflow.md) |
| 轮廓形变 | `src/drawing/primitives/contour.ts`：`prepareMorph`、`morphContour` | 重采样、方向与地标对应后检查中间态；方法见[形状接力](drawing.md#形状接力) |

包装组件的选用和实现状态统一记入[个人包装](style-and-identity.md)的选用表。以实际能力查询和源码确认可调用接口，样片和主片分别记录观察。

## 相机与焦点参数

`cameraPath.keys[].t` 是本镜头 start 之后的秒数；`x/y` 是注视点的归一化位置，`zoom` 是倍数，`rotate` 使用角度。缺省字段继承前一关键帧；首帧缺省为画面中心、1 倍、0 度。路径按时间排序，zoom 采用对数插值；`ease` 控制到达该关键帧的缓动，`hold` 保持前一状态直到当前时点。

`focus` 的 `x/y` 表示矩形左上角，`w/h` 表示画面宽高的比例。将 focus 写在被钻入的镜头上，下一镜的转场以该对象为接力线索。`zoomToFill` 按目标覆盖比例计算放大并受最大值约束，最终构图按实际画幅复核。

下面是两个相邻镜头的字段示例，素材路径按本片实际输入替换：

```json
[
  {
    "id": "detail", "start": 0, "end": 3,
    "environment": "theme_stage", "headline": ["观察局部"],
    "cameraPath": { "keys": [{ "t": 0, "zoom": 1 }, { "t": 2.4, "zoom": 1.08 }] },
    "focus": { "x": 0.42, "y": 0.40, "w": 0.16, "h": 0.09 }
  },
  {
    "id": "evidence", "start": 3, "end": 6,
    "environment": "footage", "transition": "zoomIntoElement",
    "footage": {
      "src": "clips/sample.mp4", "in": 2, "speed": 0.75,
      "kenBurns": { "from": { "x": 0.4, "y": 0.5, "zoom": 1.1 }, "to": { "x": 0.6, "y": 0.45, "zoom": 1.2 } },
      "color": { "exposure": 0.1, "contrast": 1.05, "saturation": 1.1 }
    }
  }
]
```

`cameraPath` 优先于镜头的 `cameraMove`，由该路径独立控制相机。需要固定参照时，`motion_stage` 和 `theme_stage` 使用 `cameraMove: "static"` 并省略 `cameraPath`，页面与背景保持固定坐标，进场、划线和语义聚焦分别按事件发生，见[稳定阅读](style-and-identity.md#防死帧)。二维横移与旋转可以表达空间提示；真实三维绕行按[三维路径](drawing.md)验证投影和遮挡。

## 执行与检查

素材 `src` 相对 `createSpecRenderer({ assetRoot })` 指定的素材根；受控消费继续使用本片固定版本和回执。辅助脚本及默认素材帧缓存沿用本片 manifest.outDir，默认位于 `out/`；核心探针使用临时检查区。

```bash
node .skill/scripts/video.mjs <slug> exec node .engine/scripts/motion-smoke.ts out/motion-smoke vertical
node .skill/scripts/video.mjs <slug> exec node .engine/scripts/theme-preview.ts out/theme-preview
node .skill/scripts/video.mjs <slug> exec node .engine/scripts/theme-smoke.ts out/theme-smoke minimal kinetic
```

这些命令生成虚构内容的工程样片。按本片使用的主题、画幅与素材另行检查语义、正常速度运动、完整读时及连续转场；最终验收见[成片质量](layout-and-quality.md)。
