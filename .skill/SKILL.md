---
name: video-director
description: 在独立项目中制作或修改视频，涵盖编剧、导演、绘制、配音与验收。通用能力更新使用核心维护流程。
---

# 视频制作

每次制作、修改或维护先读取[创作主线](references/motion-language.md#创作主线)与[个人视频包装规范](references/visual-identity.md)，再根据用户意图、受众和参考设计风格、构图、镜头、节奏与特效。交付清楚、有吸引力、视听同步的成片。预设与原型按需选用。

把推荐落实为观众可见、可听的事件，按“创作选择 → 状态与镜头编排 → 完整动态粗剪 → 重点镜头样片 → 主片 → 当前编码审片”推进。先在粗剪中验证整体构图变化、连续动作和快慢节奏，再扩展精修。用户已认可的内容、节奏和明确委托持续沿用；每项质量判断注明实际观察范围与成片身份。

## 统一入口

以下封存入口适用于 macOS ARM64；Linux 团队按根 [AGENTS.md 的手建流程](../AGENTS.md#linux-团队手建流程)执行初始化、记录、备份与命令，其余创作和验收规范继续适用。

```bash
node .skill/scripts/video.mjs start <slug> --idea "用户原文" --theme <minimal|kinetic>
node .skill/scripts/video.mjs backup
node .skill/scripts/video.mjs <slug> capabilities --schema
```

用户一句话即可启动。新片按[创作问答](references/intake.md)解析需求、呈现推荐组合并取得本片主题选择，再用 `start --theme` 保存首次原文与固定主题，立即补齐初始化前的问答。剩余重要选择有回答或明确委托后制定计划、制作素材与开发画面。已有影片先backup并指定slug。所有制作命令经同一入口执行，通用命令使用exec。本片生成文件全部归入projects/<slug>/，运行时与共享核心按版本隔离。

恢复已有影片时，先读本片 `AGENTS.md`、`brand.json`、`prompt-history.jsonl`、`NOTES.md` 与 `evidence/events.md`、`evidence/review.md`，核对主题、已确认选择和未完验收；执行以本片 `guide/` 与固定运行时为版本依据。核心升级通过明确的维护任务实施。

通用流程从当前输入、表达任务、素材和实际工具能力推导制作方案，题材、风格、声音与镜头组合在本片落实。核心的代码、规范、模板和测试独立于生成区；projects/清空后，核心校验、契约查询、测试和新片初始化仍使用自带依赖与虚构夹具运行。具体项目的选择、限制、例外、审片结论与维护过程归入生成区，可迁移规则及其验证方法在对应通用规范中完整保存。

配音默认使用 edge-tts。豆包语音以用户明确声明使用为启用条件；已有声明按本片授权范围沿用，执行 audio 或 render 时显式传入 `--tts-provider doubao`。用户仅提供 API Key 或查询音色目录时，配音仍沿用 edge-tts。豆包音色目录、鉴权与接口匹配见[音视频与验收](references/execution.md)。

## 按需读取

- 开始与改片：[工作区](references/workspace.md)，保存沟通原文、输入与项目记录。
- 新片开工：[创作问答](references/intake.md)，依据当次提示词生成问题、推荐答案与制作组合。
- 设计判断、参考学习与方法验证：[设计学习](references/design-learning.md)，按作品目的选择评价标准，以同内容对照检验形式选择，区分偏好、观察与机制假设。
- 四种输入与权威计划：[Production 创作权威与恢复](references/production.md)，固定 requested、作用域与版本，模型编写剧本/镜头提案，通过 next/apply/resume/invalidate 计算状态和恢复，以固定帧／样本时间线 compile，rough/final 采用同一音源并分别消费代理与正式像素。
- 规划：[导演计划](references/direction.md)，用连续状态、镜头编排与动态粗剪落实关键事件。
- 风格任务与编排：[风格选择](references/styles.md#按任务选择表现方式)，区分 kinetic 的关键变化与 minimal 的稳定参照，为发布、教程和证据比较选择表现方式。
- 包装与元素选型：[个人视频包装规范](references/visual-identity.md)固定跨片识别与常用组件结构，[完整目录](references/editing-element-catalogue.md)按需检索；实际选用、实现状态和当前编码验证分别记录。
- 跨风格动效：[动效语言与制作标准](references/motion-language.md)，逐步拆解参考，将主题、台词、形变、运镜与转场对应到可见信息，按品牌黄组织色彩与阅读。
- 字幕与分镜节奏：[短字幕与语义分镜](references/captions-and-shots.md)，将长旁白拆成可读字幕，按信息推进设计焦点、动作与景别；按 TTS 时间戳切镜并填写分镜表。
- 抖音发布：[口播稿、合规与发布](references/douyin-publishing.md)，口播稿写法、合规清单、标题简介与锁定规则；封面见[统一视频封面模板](../assets/douyin-cover/README.md)。
- 比较叙事、解释任务或学习原作：[表达机制与方法卡](references/story-mechanisms.md)，按题材选机制，用推导、尺度揭示、证据串联、步骤累计、关键词强调与数据比较卡落实事件。
- 素材准备：[素材选择](references/assets.md)，核验生图工具，按镜头需求绑定固定素材版本，通过受控消费入口组合图片、视频与精确代码图形；生成视频只做角色动作，文字与屏幕内容由代码合成。
- 实现：[绘制](references/drawing.md)，查询当前契约并编写本片画面。
- 镜头与空间：[电影化运镜](references/cinematography.md)，设计叙事运镜、分层视差及三维渲染的项目内验证路径。
- 产品广告与发布节奏：[产品与体验叙事](references/product-film-language.md)，用视觉证明、尺度揭示、语义接力与快慢节奏组织镜头。
- 已知图形与技术结构：[参考与精确几何](references/reference-geometry.md)，先做主体对照与组件验证。
- 形变、连续运动与抽象转场：[动效设计](references/motion-design.md)，使用弹簧轨迹、形状接力与中间态检查。
- 相机、焦点、素材运动与读时接口：[运动能力](references/motion-breakdown.md)，按当前源码查询参数并运行本片工程样片。
- 粒子聚合：[轮廓粒子聚合](references/motion-design.md#轮廓粒子聚合)，使用形状内采样、弧线错峰汇聚与精确路径接力。
- 配音与出片：[音视频与验收](references/execution.md)，按实测时间排镜，核对实际成片与运行记录并绑定证据。
- 审片与本地交付：[成片质量](references/quality.md)，逐事件复核当前编码，记录实际完整声画观察、逐源权利与署名，通过 review/credits/deliver 绑定当前生产与成片身份，完成修正闭环。
- 项目复盘与skill进化：[核心维护](references/maintenance.md)，从本片证据提炼通用改进，并在NOTES.md登记学习状态。

用户已有授权持续有效，明确要求的视觉选择、发布、费用及访问审批按原要求执行。通用能力或标准的修改按[核心维护](references/maintenance.md)先备份、验证、seal；共享层保存可迁移方法与虚构示例，具体项目资料和复盘保存在本片。
