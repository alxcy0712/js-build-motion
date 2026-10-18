# 当前独立影片

沟通原文保存在prompt-history.jsonl，制作目标与设计记录在NOTES.md、director.json和brief.json。assets/保存制作素材，prompt中转文件在原文入库后清理。

每次开始或恢复会话，先读取 [guide/motion-language.md 的创作主线](guide/motion-language.md#创作主线)与[个人视频包装规范](guide/visual-identity.md)，再核对 brand.json 的固定主题、prompt-history.jsonl 的用户选择、NOTES.md 的设计依据和 evidence/events.md、evidence/review.md 的未完项。以本片 guide/ 与固定运行时为版本依据。

初始化已写入本片主题；按guide/intake.md补齐初始化前的问答，并处理尚待决定的叙事、素材和交付选择，已确认选择与明确委托持续沿用。按guide/direction.md编排连续状态与镜头，完整动态粗剪验证全片构图和节奏，正式素材样片验证重点动作与运镜。素材按guide/assets.md组合，技术验收与创作验收按guide/quality.md分别记录。

规范从guide/按需读取：workspace.md管理记录与隔离，intake.md问答，styles.md规定主题与风格编排，motion-design.md实现形变与状态联动，direction.md规划，assets.md选择素材，drawing.md实现及三维路径验证，cinematography.md运镜，product-film-language.md产品广告参考，execution.md出片，quality.md审片。

包装选型按需查 guide/editing-element-catalogue.md；evidence/events.md 记录实际采用的组件、变体与实现状态，evidence/review.md 核对当前编码的一致性、信息层级和避让。按内容使用同一识别体系，具体主体和镜头由本片设计。

全部生成文件保存在本片：素材、参考、模型与纹理放assets/，代码及依赖副本放src/，分镜、截图与检查记录放evidence/，成片与临时产物放out/，工具临时目录使用out/.tmp/。固定宿主位置的工具输出立即迁入本片后登记和引用。

NOTES.md的skill学习状态从pending开始；经明确授权的复盘、核心升级与验证后登记learned、版本、证据和成片待办，按guide/maintenance.md执行。

从仓库根使用node .skill/scripts/video.mjs <本片slug> <command>，通用命令使用exec。入口验证并备份核心，系统沙箱覆盖制作进程及后代；宿主文件工具按本片边界访问。

本片src/及组件副本可编辑，.engine/保留初始化版本。画面按种子、规格和帧号求值。run.json与DISCLOSURE.md由引擎生成，审查缺口保留pending。通用升级使用明确的核心维护任务；用户已有授权与明确审批要求继续适用。
