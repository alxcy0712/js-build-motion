# 当前独立影片

沟通原文保存在prompt-history.jsonl，制作目标与设计记录在NOTES.md、director.json和brief.json。assets/保存制作素材，prompt中转文件在原文入库后清理。

新片先按guide/intake.md用模型解析一句话需求，推导风格、叙事主轴与记忆点，呈现推荐组合并集中提出关键问题；重要选择有回答或明确委托后进入制作。按guide/direction.md编排连续状态与镜头，完整动态粗剪验证全片构图和节奏，正式素材样片验证重点动作与运镜。素材按guide/assets.md组合，技术验收与创作验收按guide/quality.md分别记录。

规范从guide/按需读取：workspace.md管理记录与隔离，intake.md问答，direction.md规划，assets.md选择素材，drawing.md实现及三维路径验证，cinematography.md运镜，product-film-language.md产品广告参考，execution.md出片，quality.md审片。

全部生成文件保存在本片：素材、参考、模型与纹理放assets/，代码及依赖副本放src/，分镜、截图与检查记录放evidence/，成片与临时产物放out/，工具临时目录使用out/.tmp/。固定宿主位置的工具输出立即迁入本片后登记和引用。

NOTES.md的skill学习状态从pending开始；经明确授权的复盘、核心升级与验证后登记learned、版本、证据和成片待办，按guide/maintenance.md执行。

从仓库根使用node .skill/scripts/video.mjs <本片slug> <command>，通用命令使用exec。入口验证并备份核心，系统沙箱覆盖制作进程及后代；宿主文件工具按本片边界访问。

本片src/及组件副本可编辑，.engine/保留初始化版本。画面按种子、规格和帧号求值。run.json与DISCLOSURE.md由引擎生成，审查缺口保留pending。通用升级使用明确的核心维护任务；用户已有授权与明确审批要求继续适用。
