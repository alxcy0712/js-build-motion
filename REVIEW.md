# ChatGPT Pro 项目审查入口

此共享包包含通用研究、视频制作核心、规范、模板、测试源码与完整 `assets/`，其中包括用户授权的个人 IP 源素材和视频封面模板。每支影片的工作区、用户原文、候选素材、成片、`.pi/` 运行记录、本机依赖、维护记录与原 Git 历史保存在本地。共享副本采用独立的首次提交历史。

## 阅读顺序

1. [README.md](README.md) 和 [AGENTS.md](AGENTS.md)：使用入口、授权边界和项目约定。
2. [.skill/SKILL.md](.skill/SKILL.md)、[创作问答](.skill/references/intake.md)、[方向设计](.skill/references/direction.md)：一句话输入如何成为风格、叙事与镜头选择。
3. [入口脚本](.skill/scripts/video.mjs)、[核心封装](.skill/scripts/core.mjs)、[工作区与系统隔离](.skill/engine/workspace.mjs)：初始化、备份、版本固定与进程边界。
4. [导演计划](.skill/engine/src/project/director.ts)、[逐帧绘制与转场](.skill/engine/src/pipeline/spec-renderer.ts)、[渲染管线](.skill/engine/src/pipeline/render-video.ts)：计划到编码的实际实现。
5. [质量规范](.skill/references/quality.md)、[电影化运镜](.skill/references/cinematography.md)、[动效设计](.skill/references/motion-design.md)、[产品与体验叙事](.skill/references/product-film-language.md)，随后阅读 `.skill/engine/test/` 与 `.skill/scripts/native-check.mjs`。

## 审查目标

请依据本包源码和规范，提出按影响排序的具体问题。每项给出文件与行号、实际触发条件、用户影响、最小修复方案和验证方式。将代码证据、外部研究、设计推断及需要成片验证的判断分别说明。涉及外部资料时优先使用原作者作品、官方文档和研究论文，附可核对的链接。

- 创作能力：模型如何从一句话自主推导合适的风格与叙事，在关键反问中给出针对本片的推荐；哪些规则仍可能造成固定选项或过多问答。
- 画面质量：运镜、形状接力、手绘动作和素材融合如何进入实际编码画面；如何验证镜头推进、移动端阅读和记忆点。
- 工程正确性：版本固定、确定性、素材消费记录、音画时序、声明与实际能力是否一致。
- 安全与复现：系统沙箱及其子进程、文件链接、上传边界、依赖和字体的获取方式，有哪些明确缺口。

## 验证与运行边界

引擎测试验证制作行为；原生检查覆盖备份恢复、独立影片、文件隔离及子进程、确定性帧和真实音视频。审查者可从测试源码核对覆盖范围，并在具备运行条件的环境中执行检查。执行结果与环境信息保存在本地维护记录。

本包用于源码审查。完整运行时要求 macOS ARM64、Node 24、FFmpeg/ffprobe、Python/edge-tts、JS 依赖与字体。`.skill/manifest.json` 包含本机已封装运行时的哈希，`node_modules/` 与字体二进制被排除；从 GitHub 克隆后，运行前需要恢复这些文件，或在明确的核心维护任务中安装依赖、获取字体、运行检查并重新 seal。在线 TTS 和图像生成仍依赖实际可用的服务与授权。

## Git 上传检查

在共享副本执行 `git config core.hooksPath .githooks` 启用检查。`node .githooks/check-publish.mjs --worktree` 检查可加入的工作文件；`--staged` 检查完整索引；`--history HEAD` 检查分支可达的历史。pre-commit 使用索引内容，pre-push 检查实际推送的分支历史并拒绝内部引用。报告只输出路径、类别和行号。

检查覆盖本地影片与记录、`.pi/`、依赖、凭据文件、常见服务密钥、认证 URL、Webhook、JWT、个人目录及大文件。`assets/` 的 PNG、WebP、JPEG 验证扩展名和文件边界，并检查文字与 EXIF/XMP/IPTC 元数据；图片中的可读字节也参加凭据扫描，AI 来源证明继续保留。规则用于发现已知形式；公开前仍应审阅差异。Git 钩子设置属于本机配置，新克隆需要执行上述配置命令。

`node --test .githooks/check-publish.test.mjs` 运行共享边界回归，包含实际提交拦截和向临时本地远程推送时的历史凭据拦截。共享副本的提交身份按发布要求设置。
