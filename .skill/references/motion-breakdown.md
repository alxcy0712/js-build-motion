# 运动能力与分镜接口

本文件索引当前运行时的相机、焦点、素材运动与文字时序接口。创作判断沿用[共用动效标准](motion-language.md)，镜头设计见[电影化运镜](cinematography.md)，形变实现见[动效设计](motion-design.md)。参数预设提供试排起点；采用范围由本片内容、真实声音和当前编码检查确定。

## 能力与权威位置

以下源码路径相对本片 `.engine/`；新增画法在本片 `src/` 及组件副本实现。

| 任务 | 当前接口 | 使用与验证 |
|---|---|---|
| 关键帧相机 | `src/motion/camera-path.ts`：`cameraPath`、`push`、`cameraMove` | 以镜头内秒数排关键帧；检查注视点、起止速度、最大缩放与安全区 |
| 分层视差 | `src/drawing/primitives/camera.ts`：`applyCameraPose` | 远景、主体和前景采用不同视差；固定信息层单独保持稳定 |
| 焦点钻入 | `src/motion/focus.ts`：`focus`、`focusCenter`、`zoomToFill` | 上一镜标出接力对象，下一镜使用允许的 `zoomIntoElement`；连续检查交接两侧 |
| 图片与视频运动 | `src/footage/`：`footage`、`crop`、`kenBurns`、`speed`、`color` | 核对素材身份、比例、裁切和变速后的连续性；登记资产按[受控消费](assets.md#镜头需求版本选择与实际消费)绑定 |
| 文字读时 | `src/motion/shot-timing.ts`：`readingSeconds`、`minShotSeconds`、`planShotTimings` | 排程预设含进入与落定并受上下限限制；`SHOT_TOO_SHORT_FOR_TEXT` 按完整估计读时告警，多行结果按实际阅读拆分或调整 |
| 旁白切点 | 同上：`gapMidpointCuts`、`phraseCut` | 使用实际词／句时间；按[字幕与分镜](captions-and-shots.md)保存意义和完整结果读时 |
| 音乐拍点 | `src/audio/beat-grid.ts`：`beatGrid`、`snapCutsToBeats`、`addCutAccents` | 使用明确 BPM 与 origin，记录切点偏移；操作与试听见[音视频流程](execution.md) |
| 轮廓形变 | `src/drawing/primitives/contour.ts`：`prepareMorph`、`morphContour` | 重采样、方向与地标对应后检查中间态；方法见[形状接力](motion-design.md#形状接力) |

包装组件的选用和实现状态统一记入[个人包装](visual-identity.md)的选用表。以实际能力查询和源码确认可调用接口，样片和主片分别记录观察。

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

`cameraPath` 优先于镜头的 `cameraMove`，由该路径独立控制相机。需要固定参照时，`motion_stage` 和 `theme_stage` 使用 `cameraMove: "static"` 并省略 `cameraPath`，页面与背景保持固定坐标，进场、划线和语义聚焦分别按事件发生，见[稳定阅读](styles.md#防死帧)。二维横移与旋转可以表达空间提示；真实三维绕行按[三维路径](drawing.md)验证投影和遮挡。

## 执行与检查

素材 `src` 相对 `createSpecRenderer({ assetRoot })` 指定的素材根；受控消费继续使用本片固定版本和回执。辅助脚本及默认素材帧缓存沿用本片 manifest.outDir，默认位于 `out/`；核心探针使用临时检查区。

```bash
node .skill/scripts/video.mjs <slug> exec node .engine/scripts/motion-smoke.ts out/motion-smoke vertical
node .skill/scripts/video.mjs <slug> exec node .engine/scripts/theme-preview.ts out/theme-preview
node .skill/scripts/video.mjs <slug> exec node .engine/scripts/theme-smoke.ts out/theme-smoke minimal kinetic
```

这些命令生成虚构内容的工程样片。按本片使用的主题、画幅与素材另行检查语义、正常速度运动、完整读时及连续转场；最终验收见[成片质量](quality.md)。
