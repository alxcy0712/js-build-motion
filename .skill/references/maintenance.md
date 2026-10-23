# 核心维护

仅按用户明确的通用能力/标准任务维护 .skill。单片定制进入项目，已有影片继续固定运行时。维护前核对分支、工作区改动、目标差异与授权；先备份，编辑最小权威范围，检查调用闭包及保留行为，再封存。默认宿主为macOS ARM64、Node24和固定FFmpeg/ffprobe，其他宿主适配作为独立维护。

## 权威位置

下表源码路径相对 .skill/engine/src；规范在 .skill/references，公共来源集中根README。

| 职责 | 唯一入口 |
|---|---|
| 创作、风格、布局、画法、字幕 | motion、direction、style-and-identity、layout-and-quality、drawing、captions |
| 问答、工作区、媒体、配音、发布与Linux | workflow |
| VideoSpec与绘制状态 | spec/types.ts、schema.ts、graphic.ts、motion.ts、repair.ts |
| 项目/brief/导演 | project/schema.ts、brief.ts、director.ts |
| 原件接收 | project/import.ts、application/import.ts、adapters/import-files.ts |
| 一层ZIP | project/unpack.ts、application/unpack.ts、adapters/unpack-zip.ts |
| 目录/观察/权利/历史政策 | project/catalog.ts、catalog-legacy-policy.ts、application/catalog.ts |
| 单图OCR | project/ocr.ts、adapters/ocr-raster.ts、ocr-tsv.ts、inspection-ocr.ts |
| ASR与通用音频 | project/asr.ts、audio-input.ts；adapters/asr-*、audio-*、inspection-asr.ts |
| 批准稿对齐 | project/alignment.ts、adapters/alignment-json.ts、alignment-map.ts、application/alignment.ts |
| 受限媒体探测与租约 | adapters/inspection.ts、project-lease.ts |
| 视频准备/发布 | project/video-preparation.ts、adapters/video-prepare.ts、video-frames.ts、application/video.ts、video-publication.ts |
| 素材选用与消费 | project/asset-plan.ts、ports/assets.ts、application/asset-plan.ts、adapters/asset-port.ts、asset-usage.ts |
| Production权威/授权/状态/时间线 | project/production.ts、production-policy.ts、production-view.ts、production-timeline.ts、application/production.ts |
| 绘制/转场/主题/IP | pipeline/spec-renderer.ts、theme-transitions.ts、themes/transition-ids.ts、themes/、drawing/ |
| Three.js预渲染/主题舞台 | three/render.mjs、browser.mjs、stage.mjs；three/example.mjs为本片可复制示例 |
| 生成片段抠像/变速/合成 | footage/ |
| 字幕/字体/安全区 | captions/、themes/shared.ts、themes/fonts.ts |
| 声音/编码 | audio/、ffmpeg/ |
| CLI | cli/index.ts分发至environment、render、project、media及专用production/delivery模块 |
| 工具事实、记录、恢复、隔离、原文 | project/tool-registry.ts、run-log.ts、attempt.ts、isolation.ts、prompt-history.ts |
| 原编码/后期/披露 | project/artifact.ts、postprocess.ts、disclosure.ts |
| 审片/权利/本地交付 | project/delivery.ts、review-validation.ts、application/delivery-context.ts、delivery.ts |
| 固定运行时与媒体工具身份 | .skill/engine/workspace.mjs、native-media.mjs、scripts/seal-linux.mjs及依赖锁 |
| 初始化/guide选择/组件 | .skill/scripts/video.mjs、start-linux.mjs、guide-files.mjs、.skill/assets/components.json |
| 核心备份/封存/检查 | .skill/scripts/core.mjs、seal.mjs、check.mjs、docs-check.mjs、native-runner.mjs |
| 模板/回归/依赖 | .skill/assets/project、.skill/engine/test、assets、node_modules、scripts |

原始TS由Node直接执行，依赖每包一个版本；组件从唯一源复制并重写引用。公开枚举、动态import/worker、脚本、注册、模板和人工按需入口一起查。合并时保留各模块版本/失败语义；政策历史哈希及工具闭包变化须明确迁移。

## 检查与封存

```bash
node .skill/scripts/video.mjs backup
# 完成授权改动与针对性回归
node .skill/scripts/check.mjs --docs
node .skill/scripts/check.mjs --engine
node .skill/scripts/seal.mjs
node .skill/scripts/check.mjs --native
node .skill/scripts/check.mjs --standalone
```

模式分别执行并记命令、退出码、packageId、日志和实际覆盖。候选稳定后运行全量；seal后源码再改须重seal和复核。native在独立核心副本执行真实统一入口、隔离/移根/固定运行时与媒体链，原仓库备份历史保持原样。standalone仅复制完整.skill到空目录，禁止读取原projects，先验证全量测试，再初始化/查契约；ps查询受控进程状态，临时运行时退出清理。系统权限仍按宿主执行。

docs检查源文件链接/锚点，并按guide-files的实际七篇清单投影新片AGENTS/evidence/guide后再检查。可达性与语义一致性分别验证；新macOS/Linux入口及必读规则需走查。通用测试独立于已有项目，临时夹具放.research/out，仅清理本轮文件；过程日志/哈希/版本结论留本地projects/.maintenance。

常规统一入口先备份完整.skill，成功后轮转至两份；失败保留既有快照并停止。恢复前备份当前核心，所选快照解压到空目录核验，再替换并检查。任务指定保留历史备份时，在独立维护副本验证备份流程。

| 改动链 | 必需回归 |
|---|---|
| 默认绘制/主题/字幕/转场 | 固定spec/seed/字体/音源与参数，编码后逐帧/PCM比较；中文、IP、片尾、运动极值和连续窗口 |
| Three.js预渲染 | `check.mjs --three`：本机浏览器、主题/字体、sRGB像素、透明底、GLB与纹理、乱序求帧、项目沙箱、移根、失败回执及五秒编码/完整解码；浏览器独立安装，升级后重验 |
| OCR | 固定语言/物理闭包/动态别名，白底1:1 PPM、TSV重放、UTF-8词定位；历史政策、双语/空图、坏输入/配额/恢复 |
| ASR/音频/对齐 | 完整容器、原率PCM及唯一canonical重放；0.5检查/0.2对齐的启闭ASR、历史继承、截断成功反例、外部引用、协调哈希篡改、取消/配额/移根/恢复 |
| 视频与素材消费 | 原结构/帧/PTS/有理范围、RGBA/proxy/原声重放、固定FFmpeg工具身份；成功receipt准入与三中断落点；已知像素/声音oracle的start/import/catalog/prepareDrawing/render/disclosure/artifact链 |
| Production/交付 | 四输入、固定requested、稳定引用、作用域/当前审批、视图CAS、固定检查；prepared/发布/成功回执中断恢复，实际消费失效与未消费保留，当前编码/全片观察/权利/署名绑定 |

测试中的partial、未知动态IO、零消费、权利/语义/构图/连续性分别验证。真实宿主门禁绑定同一核心身份，工具内部IO、RSS、跨宿主稳定性、在线服务和主观试听只记录实际验证范围。

## 复盘与知识收敛

用户明确授权学习时读取指定项目原文、NOTES、代码、审片与当前编码，将“现象→原因→修正→验证→归宿”对应。原因区分复现与假设，通用方法保存原理、适用条件、反例和检查；单片偏好、建议时长、素材/成片身份及未决项留项目。设计判断按[motion](motion.md#设计判断与有条件的方法)，模型归因需同条件证据；工程、视觉、理解、传播与试听各有证据。

保留仍适用的方法、分类和入口，删除/替换先迁独有规则再核对调用。共享前检查用户原文、个人路径、素材哈希、执行日期/次数、单片结论与项目依赖。公开作者/链接/致谢仅在根README；通用研究方法已归本规范，.research/out仅作检查临时区。核心、模板、配置和文档均独立于生成区。

完成备份、适用回归、seal及隔离验证后，在指定项目NOTES追加学习状态learned、日期、packageId、证据、吸收改进和成片待办；evidence/skill-learning.json记录同事实与来源路径/SHA、修改文件和检查。NOTES来源哈希取学习段落前正文。新项目pending；新增反馈/代码/审片变化时追加pending并学习差异，成片修订和试听另记状态。
