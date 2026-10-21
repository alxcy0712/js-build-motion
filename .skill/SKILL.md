---
name: video-director
description: 在独立项目中制作或修改视频，涵盖编剧、导演、绘制、配音与验收。通用能力更新使用核心维护流程。
---

# 视频制作

每次制作、修改或维护先读[创作主线](references/motion.md#创作主线)与[风格/个人识别](references/style-and-identity.md)，按内容、受众和参考设计主体、构图、镜头与声音。推进创作选择→状态编排→全片动态粗剪→正式素材重点样片→主片→当前编码审片；每项判断绑定实际观察范围和成片身份。

macOS ARM64使用统一入口；[Linux手建流程](references/workflow.md#linux-手建入口)使用独立源码、对应平台依赖和手动校验。按根AGENTS的执行角色、授权及个人配音约定操作。

```bash
node .skill/scripts/video.mjs start <slug> --idea "用户原文" --theme <minimal|kinetic>
node .skill/scripts/video.mjs backup
node .skill/scripts/video.mjs <slug> capabilities --schema
```

新片按workflow取得主题选择及逐片片尾答复，start保存首次原文后立即补齐问答；其余重要选择已有回答或明确委托再进入剧本、素材和开发。已有影片先backup，读取本片AGENTS、brand、prompt-history、NOTES、events/review，沿用固定.engine与guide。制作命令统一入口，通用命令用exec；生成/候选/日志/临时文件全部归本片，动态画法编辑本片src和组件副本。

| 当前工作 | 按需读取 |
|---|---|
| 创作、参考学习、表达机制与方法验证 | [motion](references/motion.md) |
| 导演计划、运镜、状态编排与动态预演 | [direction](references/direction.md) |
| 全画幅、主体尺度、文字安全区、审片和本地交付 | [layout-and-quality](references/layout-and-quality.md) |
| minimal/kinetic、字体/色彩、包装、IP与片尾 | [style-and-identity](references/style-and-identity.md) |
| 同步绘制、精确几何、形变、粒子、材料及三维验证 | [drawing](references/drawing.md) |
| TTS分镜、中文语义事件、字幕边界和完整读时 | [captions](references/captions.md) |
| 问答、工作区、入库/目录/媒体、Production、声音、编码、发布、Linux | [workflow](references/workflow.md) |
| 已明确授权的通用修改/项目学习、测试、隔离与seal | [maintenance](references/maintenance.md) |

默认Edge配音；豆包需明确启用并传--tts-provider doubao，本地个人音色已有授权按根AGENTS优先。工具和源码独立于projects，空生成区仍支持检查/初始化。用户已有选择与授权持续有效，明确的视觉选择、费用、发布、访问和破坏性动作审批按原要求保留；核心修改先备份、验证再seal。
