# 独立视频制作工作区

GitHub 共享范围为通用研究、制作核心、说明与完整 `assets/`，包含用户授权的[个人 IP 源素材](assets/personal-ip/README.md)和[视频封面模板](assets/douyin-cover/README.md)。`projects/` 的影片、候选素材、用户沟通原文和本机记录，以及 `.pi/` 的 agent 运行记录保存在本地；依赖副本、核心备份与敏感配置按 `.gitignore` 排除。源码审查路径与验证边界见 [REVIEW.md](REVIEW.md)。提交和推送检查通过 `git config core.hooksPath .githooks` 启用；准备共享前执行 `node .githooks/check-publish.mjs --worktree`，提交后执行 `node .githooks/check-publish.mjs --history HEAD`。

在当前文件夹直接与 agent 描述主题、时长、画幅和配音需求。先按 [AGENTS.md](AGENTS.md) 确定执行角色：Grok Bot 团队根据选题与文字制作视频或图文，本地 Agent 处理用户电脑上的原片、素材库与相关补充。两端按各自职责和授权使用 [.skill/SKILL.md](.skill/SKILL.md) 的通用制作契约。支持 AGENTS.md 的宿主自动加载入口；其他模型加载这两个文件后按对应角色执行。

```text
.research/       通用理念、研究方法与验证条件
.skill/          唯一核心：规则、引擎源码、依赖、模板与回归检查
assets/          可提交的个人 IP 源素材、衣柜、动画与视频封面模板
projects/        每支影片的独立代码、素材、证据与成片
.pi/            本机 agent 运行记录
.skill-backups/  最近两次完整核心备份
AGENTS.md        agent 入口
README.md        用户入口
```

每次渲染保存到 `projects/<slug>/out/renders/<attemptId>/final.mp4`，默认便捷副本为 `out/<slug>.mp4`，当前成片以本片 `run.json` 为准。初始化复制本片运行时、所选组件及规范快照；本片扩展在自己的 src/ 实现。题材与参考资料影响本片设计，通用核心保持固定。文件权威位置与维护步骤见 [核心维护](.skill/references/maintenance.md)。

Agent 按[创作问答](.skill/references/intake.md)取得本片主题选择后使用唯一命令入口。下例假定用户已选择 `minimal`：

```bash
node .skill/scripts/video.mjs start my-film --idea "制作一支 30 秒的讲解视频" --theme minimal
node .skill/scripts/video.mjs my-film capabilities
node .skill/scripts/video.mjs my-film voices
node .skill/scripts/video.mjs my-film import --source "/path/to/selected input"
node .skill/scripts/video.mjs my-film unpack --import <importId> --path <archive-relative-path>
node .skill/scripts/video.mjs my-film env --json
node .skill/scripts/video.mjs my-film direct compile
node .skill/scripts/video.mjs my-film render
```

声音定稿后可用 `my-film audio lock` 保存声音包，后续 `my-film render --audio-lock <返回路径>` 沿用声音与实测时间。命令用法、文件来源和每次渲染的身份绑定见[音视频与验收](.skill/references/execution.md)。已有影片沿用初始化时的固定运行时。

配音默认使用 edge-tts。用户明确声明使用豆包语音后，执行 `audio` 或 `render` 时显式传入 `--tts-provider doubao`。`voices` 返回豆包公版音色的名称、ID、语种、模型资源与接口；启用豆包后，导演计划的 `voice` 或原生规格的 `audio.narration[].voice` 可填写目录中的 ID，例如 `zh_female_vv_uranus_bigtts`，自动匹配对应的模型与流式接口，四个抽象音色使用对应的默认豆包音色。运行时通过 `DOUBAO_API_KEY` 提供凭据。

选定的普通文件或目录可通过 `my-film import --source <来源>` 保存到本片 `inputs/original/<importId>/`。本片导入政策、固定清单与执行回执记录字节身份，成功后原子更新批次索引；`my-film import --verify <importId>` 核对已入库副本。已入库 ZIP 可用 `my-film unpack --import <importId> --path <清单内相对路径>` 保存独立的一层展开版本，`my-film unpack --verify <unpackId>` 复查其父原件和成员身份；展开默认限额、回执和格式范围见[显式展开](.skill/references/workspace.md#已入库-zip-显式展开)。文件位置、限额配置与读取权限见[原件入库](.skill/references/workspace.md#原件入库)。

已登记图片与视频可通过 `my-film assets --schema plan` 建立镜头需求与固定版本选择，`my-film video --request inputs/video-request.json` 的生产 0.2 请求按整数 PTS 选段准备交付帧、独立低清预览代理和缺省保留的选段原声，资源政策可显式采用。标准 `render` 在输入快照中调用 `prepareDrawing({ assets })`，消费回执与披露绑定原件、派生文件和实际操作；原声时间线、覆盖与恢复见[素材需求与消费](.skill/references/assets.md#镜头需求版本选择与实际消费)及[视频准备](.skill/references/workspace.md#有界视频准备)。历史项目继续沿自己的固定版本。

四种输入（照片/视频文件夹、文案、标题、视频与稿件）可显式采用 [Production 创作权威与恢复](.skill/references/production.md)。`my-film production init --request inputs/production-init.json` 保存固定原始要求与本次模型解释，`production next/apply/resume/invalidate/view` 提供作用域校验、版本提交、可读视图和中断恢复；`production --schema init|proposal` 输出权威填写契约。`changes.timeline` 保存整数帧、48k 样本、固定音源与剪接位置，`production --schema timeline` 提供填写契约；`production compile --profile rough|final` 派生并核验当前规格，`render --profile rough|final` 分别消费低清代理和正式源像素，原声、旁白、音乐与音效按同一位置独立混音。完整声画审片与交付沿对应证据验收，历史影片继续使用初始化时的固定版本。

正式 Production 编码通过 `my-film review --subject` 读取当前审片对象，`review --request evidence/structured-review.json` 核对完整观测与九项结论，`credits --request evidence/credits.json` 核对逐源本地用途与必要署名。`deliver --request evidence/delivery-request.json` 在全部必需门禁通过后保存独立交付包、清单和成功回执，`deliver --verify current` 同时复查来源与副本。各命令的 `--schema` 输出填写契约；文件变化、观察缺口及权利缺口进入待审，方法与范围见[结构化审片与本地交付](.skill/references/quality.md#结构化审片与本地交付)。

已登记的16 kHz单声道 PCM16 WAV 与批准稿可通过 `my-film align --catalog <catalogId> --asset <assetId> --version <assetVersion> --script inputs/alignment-script.json` 建立独立对齐版本。`align --schema script` 查询批准稿契约，`align --verify <alignmentId>` 重放定位图，`align --recover` 恢复已停止运行的回执。词或汉字时间保存 estimated/unknown 与 null confidence；原稿文字、原始音频和历史结果各自固定，配额与覆盖定义见[有界词与汉字对齐](.skill/references/workspace.md#有界词与汉字对齐)。

用户可以只给一句话。Agent 按[创作问答](.skill/references/intake.md)解析需求、呈现推荐组合，集中提出通常1–3个关键问题。取得本片主题选择后，用 `start --theme` 保存首次原文与固定主题，随即按对话顺序补齐此前问答；`needs-intake` 提示继续处理剩余选择。时长、画幅、语气等可逆默认值合并说明；重要选择有回答或明确委托后进入制作，已有选择与委托持续沿用。后续沟通继续追加原文与记录时间，渲染记录保存当时的哈希与条目数。多行原文可直接传入 `--idea`，用户已有输入文件可用 `--idea-file`；追加命令与格式见[工作区规范](.skill/references/workspace.md#沟通原文)。

[素材选择](.skill/references/assets.md)按镜头组合生图、官方矢量和精确代码图形，先核验当前会话的实际生图接口。复杂场景优先评估生成素材，技术结构依据可靠参考验证。图片及所有候选版本、模型、纹理、参考下载、预览、截图、日志与临时文件归入本片目录。

[风格选择](.skill/references/styles.md#账号默认与每片风格选择)：账号默认 `minimal`，每片通过 `start --theme` 传入已确认的 `minimal` 或 `kinetic`，spec 与本片 `brand.json` 保持一致。主题差异见[任务与编排](.skill/references/styles.md#按任务选择表现方式)，镜头与时序按[导演计划](.skill/references/direction.md)和[字幕与分镜](.skill/references/captions-and-shots.md)执行。

[个人视频包装规范](.skill/references/visual-identity.md)固定品牌黄、文字层级、标注、资料卡、人物条与收尾的跨片规则；[完整元素目录](.skill/references/editing-element-catalogue.md)提供 17 类、154 项元素与 23 组处理方式供按需选用。新片自动复制规范，选用和实现状态进入分镜记录，统一风格进入审片检查；具体组件画法与视听效果按实际实现和样片验收。

制作文件统一归入 `projects/<slug>/`：成片、抽帧、预览与临时缓存写入本片 `out/`，素材保存在本片 `assets/`。统一入口按本片 manifest 解析输出路径；维护检查的临时产物放 `.research/out/` 并在检查后清理。字体先找 `.skill/engine/assets/fonts/`，再找 `JBM_FONT_DIRS` 和本机系统字体目录（macOS / Linux / Windows），不依赖任何固定机器路径。

[电影化运镜](.skill/references/cinematography.md)把推拉、跟拍、环绕、焦点转移和遮挡接力转成逐镜设计，并用代表性短样片与编码主片复核。three.js 已登记为备选，当前共享运行时为 Skia Canvas 2D；需要三维的本片按[绘制规范](.skill/references/drawing.md)先验证 WebGL、依赖及固定时间导帧，再记录实际采用的路径。

本工作区的质量目标是适合社交媒体发布并达到商业项目的制作水平。[成片质量规范](.skill/references/quality.md) 将其落实为叙事推进、视觉一致性、镜头承接、讲解同步、移动端可读性与完整视听验收。公开来源提供方法线索，具体采用与实测证据保存在项目中。

[产品与体验叙事](.skill/references/product-film-language.md)组织视觉证明、尺度揭示、语义接力与快慢节奏；[动效设计](.skill/references/motion-design.md)约束形状接力、负空间与中间态；[参考与精确几何](.skill/references/reference-geometry.md)通过独立依据与像素检查验证结构。通用理念与研究方法见[研究索引](.research/README.md)。

[创作主线](.skill/references/motion-language.md#创作主线)是跨会话共用的设计依据；新会话从根 AGENTS.md 与 .skill/SKILL.md 进入，已有影片再按本片 AGENTS.md 恢复用户选择、固定版本和待验收项。[品牌黄色彩系统](.skill/references/styles.md#品牌黄色彩系统)围绕 #FFC712 设计明暗、撞色与近似色关系，主体和证据承担讲解。

[设计判断与参考学习](.skill/references/design-learning.md)把作品目的、形式选择和实际观察连接起来；提供研究参考、作出创作选择、复盘更新的三段提示词。需要学习新方法时，按下方[设计学习来源](#设计学习来源)选取资料，将小对照嵌入已有动态预演，方法保留适用条件与支持范围。

每次入口执行前自动验证和备份 .skill/，最多保留两份成功快照；已有影片继续使用初始化时的固定运行时。进入不同影片时始终指定其 slug。

当前运行条件为 macOS ARM64、Node 24、FFmpeg/ffprobe；Edge 在线配音需要 Python/edge-tts>=7.3.1，可用 `python3 -m pip install --upgrade 'edge-tts>=7.3.1'` 更新握手与日期解析支持。豆包在线配音需要 Python/websockets>=14 与 `DOUBAO_API_KEY`，预制配音使用本片授权的真实 voice.wav。JS 生产依赖与字体已内置。系统沙箱覆盖制作入口启动的进程及后代，编辑器与其他文件工具的访问范围由宿主管理。

维护检查：`node .skill/scripts/check.mjs --docs` 检查本地文档链接、标题锚点及新片 guide 路径；`--engine` 验证引擎行为；`--standalone` 仅复制完整 `.skill/`，在隔离已有生成区的空工作区中运行引擎测试、四种输入初始化与契约查询；`--native` 验证备份、恢复、独立项目、系统隔离与真实音视频。通用升级按核心维护规范先备份、验证，再重新 seal。

## 致谢

感谢以下创作者、研究者、维护者和社区公开分享作品、方法、代码与文档。这些资料帮助本项目建立动效表达、生成式绘制、制作流程与验证方法。每项列出具体借鉴点和项目中的对应位置，方便继续追溯原始贡献。

### 创作与动效方法

| 作者或团队 | 原始来源 | 借鉴点与项目对应位置 |
|---|---|---|
| **0xMovez** | [动效制作流程分享](https://x.com/0xMovez/status/2104216919033192746) | 状态编排、纯时间求值、解析弹簧、声音时间轴与渲染后审查；见[表达机制](.skill/references/story-mechanisms.md)与[动效设计](.skill/references/motion-design.md)。 |
| **Pluvio9yte** | [分层动作与受力设计分享](https://x.com/Pluvio9yte/status/2105533742907605209?s=20) | 主次错时、动量接续、受力设计、光源一致性与节奏协同；见[表达机制](.skill/references/story-mechanisms.md)与[动效设计](.skill/references/motion-design.md)。 |
| **OpenDesign 团队** | [Motion 发布片](https://x.com/OpenDesignHQ/status/2111023212129829086)、[工具界面中的演示录屏](https://x.com/OpenDesignHQ/status/2111029430080725196) | 两条视频的主体画面序列在全片抽样中一致；参考聚焦于主体保持、全貌揭示、颜色分段与形状接力。全片抽样与关键窗口连续帧支持构图及中间态研究，正常速度声画评价另行记录；见[共用动效标准](.skill/references/motion-language.md)。发布帖的模型效果声明保留为作者陈述。 |
| **Josef Albers、Josef and Anni Albers Foundation** | [Interaction of Color](https://www.albersfoundation.org/alberses/teaching/interaction-of-color) | 从相邻色、面积和背景情境观察色彩关系；本项目据此设计品牌黄的场景对照检查，具体色组由本项目独立选择，见[色彩系统](.skill/references/styles.md#品牌黄色彩系统)。 |
| **BUCK、Blue Studio 与各项目制作团队** | [Comfy Brand Refresh](https://www.buck.co/work/comfy-brand-refresh)、[IBM Sustainability](https://www.buck.co/work/ibm-sustainability) | 项目文字说明支持从产品逻辑生成形状语言、让同一视觉系统涵盖克制与强表现、以局部到整体关系组织信息；见[共用动效标准](.skill/references/motion-language.md)。完整作者名单保留于来源页面。 |
| **Tyler Hobbs** | [How to Hack a Painting](https://www.tylerxhobbs.com/words/how-to-hack-a-painting)、[生成式水彩绘制方法](https://www.tylerxhobbs.com/words/a-guide-to-simulating-watercolor-paint-with-generative-art) | 生成式绘画、低透明度叠层、轮廓扰动与自然材质观察；[水彩绘制模块](.skill/engine/src/drawing/art/watercolor.ts)采用低透明度叠层与轮廓扰动。 |
| **Grant Sanderson / 3Blue1Brown** | [Fourier Transforms](https://www.3blue1brown.com/lessons/fourier-transforms/) | 稳定的视觉编码、可追踪的变量、参数变化与结果联动；见[表达机制](.skill/references/story-mechanisms.md)。 |
| **Ordinary Folk、School of Motion 与参与创作者**，包括创意指导 **Jorge R. Canedo E.** | [School of Motion Manifesto 与完整制作名单](https://www.ordinaryfolk.co/project/school-of-motion-manifesto) | 从简单形状逐步发展复杂度，让视觉变化承托内容进展；见[表达机制](.skill/references/story-mechanisms.md)与[产品与体验叙事](.skill/references/product-film-language.md)。 |
| **Oscar Hudson 与《Bounce》制作团队**：Apple、TBWA\Media Arts Lab、Pulse Films、Framestore | [Bounce 与完整制作名单](https://www.oneclub.org/awards/adcawards/-award/35329/bounce/) | 通过空间规则、人物动作与环境响应表达产品带来的体验；见[表达机制](.skill/references/story-mechanisms.md)与[产品与体验叙事](.skill/references/product-film-language.md)。 |
| **花叔 Huashu / alchaincyf 与 huashu-art-motion 贡献者** | [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) | 艺术风格配方、按解释任务选择动画语法、语义触发与连续帧诊断；本项目的学习整理见[艺术绘制与解说动画方法](.research/art-and-explainer-animation.md)。 |

花叔项目在[原项目致谢](https://github.com/alchaincyf/huashu-art-motion#致谢)中记录了 **Tak（[@cherry_mx_reds](https://x.com/cherry_mx_reds)）**的《Art History Speedrun》作为创作起点。这里同时保留这条上游出处，具体贡献以原项目说明为准。

### 封面与字体排版

| 作者或团队 | 原始来源 | 借鉴点与项目对应位置 |
|---|---|---|
| **Pentagram、Domenic Lippa 与设计团队** | [London Design Festival 2025](https://www.pentagram.com/work/london-design-festival-2025) | 用稳定的识别色、字体和排版系统适配多种媒介；[统一视频封面模板](assets/douyin-cover/README.md)沿用固定配色与信息层级，独立设计两个画幅的图文构图。 |
| **A1 Gallery 与所收录网站的创作者** | [Typographic Portfolio](https://www.a1.gallery/websites/typographic-portfolio) | 大标题、有限字体层级与留白之间的关系；[统一视频封面模板](assets/douyin-cover/README.md)采用标题优先、实际字形对齐与独立的个人 IP 区域。具体网站作者可通过画廊原始条目追溯。 |

### 案例整理与工程研究

| 维护者与贡献者 | 原始来源 | 借鉴点与项目对应位置 |
|---|---|---|
| **opusvideo、Awesome Claude Video 贡献者及所收录作品的原作者** | [awesome-claude-video](https://github.com/opusvideo/awesome-claude-video) | 带来源的公开视频案例、原始提示词与制作路径线索，为制作输入和案例研究提供参照；见[制作输入](.skill/engine/src/project/brief.ts)。作品作者与完整出处可继续通过原仓库追溯。 |
| **athemeroy 与 Awesome Claude 5.5 Videos 贡献者** | [awesome-claude-5-5-videos](https://github.com/athemeroy/awesome-claude-5-5-videos)，原名 awesome-opus-5-5-videos；[研究方法](https://github.com/athemeroy/awesome-claude-5-5-videos/blob/main/docs/methodology.zh-CN.md)、[提示词矩阵](https://github.com/athemeroy/awesome-claude-5-5-videos/blob/main/docs/prompt-matrix.zh-CN.md) | 对照提示词与结果，区分公开披露、可见结果、工程证据和分析推断，分别记录输入、工具、人工修改与成果声明；见[制作输入](.skill/engine/src/project/brief.ts)、[披露记录](.skill/engine/src/project/disclosure.ts)与[运行记录](.skill/engine/src/project/run-log.ts)。 |

### 动效案例与提示词研究

| 作者或整理者 | 公开来源 | 借鉴点与项目对应位置 |
|---|---|---|
| **Prompt Motion / @p4nthera_** | [案例库](https://prompt-motion.com/)、[展演模板](https://prompt-motion.com/templates/showreel) | 提炼内容概念、状态顺序与检查步骤，区分展演节奏和解释读时；见[风格任务与编排](.skill/references/styles.md#按任务选择表现方式)。模板参数按内容选用。 |
| **zero / @twoclipping** | [Shape morphing through UI states](https://prompt-motion.com/twoclipping-5cba86) | 同一容器保持身份、内容独立进退；见[状态联动与容器交接](.skill/references/motion-design.md#状态联动与容器交接)。 |
| **ultima / @ultimaxbt** | [Orange dot motion system](https://prompt-motion.com/ultimaxbt-bbebf5) | 贯穿对象在文字、图形和章节间接力；见[动效语言](.skill/references/motion-language.md)。具体实现以视频观察核对。 |
| **testarossa / @rossaxbt** | [White ball UI motion loop](https://prompt-motion.com/rossaxbt-94583b) | 提示词中的状态联动、操作反馈和闭环检查；见[产品与体验叙事](.skill/references/product-film-language.md)。 |
| **Parker Rex / @ParkerRex** | [Token bucket rate limiter](https://prompt-motion.com/parkerrex-1a54fe) | 稳定空间内并列展示状态、事件与历史，作为 minimal 机制讲解的取样参照；见[风格任务与编排](.skill/references/styles.md#按任务选择表现方式)。 |
| **Prompt Motion 编辑者** | [讲解提示词分析](https://prompt-motion.com/blog/ai-explainer-video-prompts)、[产品片提示词分析](https://prompt-motion.com/blog/ai-launch-video-prompts)、[效果约束分析](https://prompt-motion.com/blog/make-ai-motion-graphics-look-less-ai) | 将主题细化为过程、可见证明和具体视觉约束；见[创作问答](.skill/references/intake.md)。样本互动数据用于研究背景，因果与质量判断需要独立证据。 |

上述条目的作品与提示词归各自作者所有；本项目独立编写通用方法和虚构示例。具体取样范围与采用证据按[核心维护](.skill/references/maintenance.md)归档，实际素材复用逐项核对许可。

### 设计学习来源

按当前问题选取资料，公开来源集中在此归因。以下入口提供作品档案、研究文章、过程方法和课程；本项目将其转译为[条件化设计方法](.skill/references/design-learning.md)，实际影片的节奏、声音与观众效果通过本片观察验证。课程内容与访问条件在实际使用时核对。

| 研究问题 | 作者／机构与原始入口 | 学习用途与边界 |
|---|---|---|
| 色彩怎样随关系改变？ | **Josef Albers、Josef and Anni Albers Foundation**：[Interaction of Color](https://www.albersfoundation.org/alberses/teaching/interaction-of-color) | 色彩实验与直接观察的教学说明；练习固定主色、改变背景和邻色，沿用前文色彩系统归因。 |
| 展开顺序怎样组织观看？ | **Dawn Delbanco、The Metropolitan Museum of Art**：[Chinese Handscrolls](https://www.metmuseum.org/essays/chinese-handscrolls) | 手卷逐段显现与观看者控制进度的研究；迁移到影片时重新设计时长与回看条件。 |
| 尺度变化怎样连接知识？ | **Charles and Ray Eames、Eames Office**：[Powers of Ten](https://www.eamesoffice.com/the-work/powers-of-ten/) | 官方档案提供版本与尺度旅程背景；用于提出保留位置参照的候选方法，具体时序以实际观看为依据。 |
| 怎样探索问题并比较方案？ | **Design Council**：[The Double Diamond](https://www.designcouncil.org.uk/resources/the-double-diamond/) | 理解与界定问题、发展不同解法、小规模检验；本项目把关键选择的对照纳入已有粗剪流程。 |
| 怎样把分析变成制作练习？ | **Pixar、Khan Academy**：[Pixar in a Box](https://www.pixar.com/pixar-in-a-box) | 官方合作课程入口，将艺术、科学与数学联系到动画制作；按当前问题选择练习。 |
| 怎样细读不同电影传统？ | **David Thorburn、MIT OpenCourseWare**：[The Film Experience](https://ocw.mit.edu/courses/21l-011-the-film-experience-fall-2013/) | 课程、讲义与作业支持跨时代、跨地区的影片比较；片段分析保留所用版本和实际观看范围。 |

### 官方文档与开源基础

感谢以下文档作者和维护社区，让制作规则能够对应可查阅、可验证的技术依据：

- **Adobe 教程团队**：[Tracking Shots](https://www.adobe.com/creativecloud/video/production/cinematography/camera-shots-and-angles/tracking-shot.html)，支持[电影化运镜](.skill/references/cinematography.md)中的叙事目的、主体跟随与场面调度研究。
- **Apple Motion 文档团队**：[相机行为](https://support.apple.com/guide/motion/add-camera-behaviors-motn17c69ccb/mac)与[相机控制](https://support.apple.com/guide/motion/camera-controls-motn17c68cdf/mac)，支持[电影化运镜](.skill/references/cinematography.md)中的相机行为与参数研究。
- **three.js 贡献者与文档团队**：[相机](https://threejs.org/manual/pages/cameras.html)与[实用技巧](https://threejs.org/manual/pages/tips.html)，支持[绘制规范](.skill/references/drawing.md)中的三维候选路径、投影与固定时间导帧研究。
- **YouTube 帮助文档团队**：[观众留存分析](https://support.google.com/youtube/answer/9314415?hl=en)，支持[研究方法](.research/README.md)中对重看、兴趣与理解困难的审慎判断。
- **W3C WAI**：[文字对比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)与[闪烁阈值](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)，为[色彩与阅读检查](.skill/references/styles.md#品牌黄色彩系统)提供参考；项目的编码画面、手机观看与实际闪烁范围另行核验。

感谢本项目所用的工具与字体：

- **Christian Swinehart / samizdatco 与 [skia-canvas](https://github.com/samizdatco/skia-canvas) 贡献者**：Canvas 2D 渲染基础。
- **Evgeny Poberezkin 与 [Ajv](https://github.com/ajv-validator/ajv) 贡献者**：JSON Schema 校验基础。
- **[Node.js](https://nodejs.org/) 与 [FFmpeg](https://ffmpeg.org/) 贡献者社区**：脚本运行、音视频编码、混音与探测。
- **rany2 与 [edge-tts](https://github.com/rany2/edge-tts) 贡献者**：在线配音工具；[7.3.0](https://github.com/rany2/edge-tts/releases/tag/7.3.0) 的新版握手和 [7.3.1](https://github.com/rany2/edge-tts/releases/tag/7.3.1) 的日期解析修复为依赖下限依据。
- **火山引擎豆包语音文档团队**：[公版音色列表](https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh)、[双向流式 WebSocket](https://docs.volcengine.com/docs/DoubaoVoice/WebSocketBidirectionalStreaming-V3?lang=zh) 与 [单向流式 HTTP](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)，提供[音色目录](.skill/engine/src/audio/tts/doubao-voices.ts)和[豆包配音适配](.skill/engine/src/audio/tts/doubao.ts)的接口依据。
- **[websockets](https://websockets.readthedocs.io/) 贡献者**：豆包流式配音的 Python WebSocket 客户端。
- **LXGW（霞鹜）、FONTWORKS 与字体贡献者**：[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)及其上游 Klee One 为中文画面提供字体基础。

后续新增参考继续补充作者、原始链接和具体借鉴点；复用代码、字体或素材时保留各自许可证与署名要求。

### 艺术绘制与解说动画的研究引用

huashu-art-motion 的以下文档与实现用于追溯材料配方、解释任务、语义同步、导帧与诊断方法。方法整理见[艺术绘制与解说动画研究](.research/art-and-explainer-animation.md)，执行能力按本项目契约独立实现和验证。

- [风格配方索引](https://github.com/alchaincyf/huashu-art-motion/blob/main/references/%E9%A3%8E%E6%A0%BC%E9%85%8D%E6%96%B9/INDEX.md)
- [纯代码绘制](https://github.com/alchaincyf/huashu-art-motion/blob/main/references/04-%E7%BA%AF%E4%BB%A3%E7%A0%81%E7%BB%98%E5%88%B6.md)
- [水墨配方](https://github.com/alchaincyf/huashu-art-motion/blob/main/references/%E9%A3%8E%E6%A0%BC%E9%85%8D%E6%96%B9/17_ink.md)
- [绘画库](https://github.com/alchaincyf/huashu-art-motion/blob/main/scripts/engine/lib/paint.js)
- [梵高场景](https://github.com/alchaincyf/huashu-art-motion/blob/main/scripts/engine/scenes/09_postimp.js)
- [视频动画语法](https://github.com/alchaincyf/huashu-art-motion/blob/main/references/09-%E8%A7%86%E9%A2%91%E5%8A%A8%E7%94%BB%E8%AF%AD%E6%B3%95.md)
- [拆解方法](https://github.com/alchaincyf/huashu-art-motion/blob/main/references/01-%E6%8B%86%E8%A7%A3.md)
- [拆解脚本](https://github.com/alchaincyf/huashu-art-motion/blob/main/scripts/analyze/breakdown.py)
- [口播整片方法](https://github.com/alchaincyf/huashu-art-motion/blob/main/references/12-%E5%8F%A3%E6%92%AD%E6%95%B4%E7%89%87%E4%B8%8E%E7%BB%8F%E9%AA%8C%E5%9B%9E%E6%B5%81.md)
- [片段运行时](https://github.com/alchaincyf/huashu-art-motion/blob/main/scripts/engine/clip.js)
- [渲染器](https://github.com/alchaincyf/huashu-art-motion/blob/main/scripts/engine/render.py)
- [QA 实现](https://github.com/alchaincyf/huashu-art-motion/blob/main/scripts/qa.py)

ZIP 解析使用 [yauzl](https://github.com/thejoshwolfe/yauzl)（Josh Wolfe，MIT），借鉴中央目录、逐条读取和原始成员流接口；发行版与传递依赖固定在引擎的 zip-dependencies.lock.json，随核心清单核验。ZIP/ZIP64、编码、数据描述符、CRC32 与对象属性的结构依据为 [PKWARE ZIP 格式规范](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)。本片应用层独立补足路径、资源、结构、CRC32、SHA-256 和发布生命周期检查。

素材目录的技术证据、内容观察和权利记录按固定素材版本保存；默认限额、定位与恢复约定见[工作区规范](.skill/references/workspace.md#素材目录与可定位记录)。媒体探测使用 [FFprobe](https://ffmpeg.org/ffprobe.html)、[FFmpeg](https://ffmpeg.org/ffmpeg.html) 的固定参数与实际时间戳，协议/格式准入依据其[协议文档](https://ffmpeg.org/ffmpeg-protocols.html)和[格式文档](https://ffmpeg.org/ffmpeg-formats.html)。

文档原生解析使用 [PDF.js](https://github.com/mozilla/pdf.js)（pdfjs-dist 6.4.299，Apache-2.0）、[saxes](https://github.com/lddubeau/saxes)（6.0.0，ISC）及 [xmlchars](https://github.com/lddubeau/xmlchars)（2.2.0，MIT）。PDF 文本提取复用既有 Skia 的 DOMMatrix/Path2D；DOCX 包核验复用既有 yauzl。精确发行包与 integrity 保存在 `.skill/engine/document-dependencies.lock.json`，格式、限额和观察契约见[工作区规范](.skill/references/workspace.md#文档原生文本与定位图)。

显式文档OCR采用同一固定PDF发行和Skia Canvas，渲染生命周期参考[固定版本Node示例](https://github.com/mozilla/pdf.js/blob/v6.4.299/examples/node/pdf2png/pdf2png.mjs)与[viewport/render接口](https://github.com/mozilla/pdf.js/blob/v6.4.299/src/display/api.js)。项目独立实现经典PDF对象/页树闭包、有限解压与资源/画布准入、DOCX全包CRC及正文嵌图出现定位，并从固定原件逐字节重放所选栅格；使用与覆盖约定见[扫描PDF与DOCX嵌图OCR](.skill/references/workspace.md#扫描-pdf-与-docx-嵌图-ocr)。

PNG/JPEG 单图 OCR 使用 [Tesseract 5.5.0](https://github.com/tesseract-ocr/tesseract/tree/5.5.0)（Apache-2.0）、[Leptonica](https://github.com/DanBloomberg/leptonica) 与现有 FFmpeg，固定 TSV、语言/PSM/坐标规则依据 [Tesseract 命令行文档](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)和[初始化实现](https://github.com/tesseract-ocr/tesseract/blob/5.5.0/src/ccmain/tessedit.cpp)。静态 PNG/动画边界依据 [PNG 规范](https://www.w3.org/TR/png-3/)，编码方向控制依据 [FFmpeg 视频选项](https://ffmpeg.org/ffmpeg.html#Video-Options)。项目独立实现有界结构准入、整数白底合成、严格 TSV、定位图与词区域观察，使用规则见[单图 OCR](.skill/references/workspace.md#单图-ocr-与词区域)。

语言数据采用官方 [tessdata_fast 4.1.0](https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0)，固定 commit 65727574dfcd264acbb0c3e07860e4e9e9b22185（Apache-2.0，许可保存在 .skill/engine/assets/ocr/LICENSE）。Git 共享恢复到 .skill/engine/assets/ocr/tessdata/ 的两个独立文件：

| 文件与固定来源 | 字节数 | SHA-256 |
|---|---:|---|
| [eng.traineddata](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/eng.traineddata) | 4,113,088 | 7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2 |
| [chi_sim.traineddata](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/chi_sim.traineddata) | 2,469,156 | a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730 |

两个语言文件的 secondary 清单为空；固定语言参数排除 chi_sim_vert。物理 native 文件、动态库逻辑别名、模型 Git blob/SHA-256 与参数保存在 .skill/engine/ocr-dependencies.lock.json。二进制语言数据路径被精确 Git 忽略，完整运行时仍包含模型并进入 seal、备份和新片快照。恢复后先核对字节数与摘要；宿主 native 变化通过明确核心维护重新核对闭包、离线检查并 seal。已有影片继续沿用原运行时。

macOS 进程组清理参考 [Apple 公开 XNU 的信号实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)：仅含待回收僵尸进程的组可能返回 EPERM。工具清理在短时预算内重发整个组的终止信号，成功或 ESRCH 后完成；持续权限错误使当前批次拒绝，回归同时验证活跃后代终止。

WAV 输入转写采用 [whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037)（MIT）和 [OpenAI Whisper](https://github.com/openai/whisper) multilingual base 模型（MIT）。固定源码 commit 为 d1be6fde11ac6e0407606b4e42fe72d34add8037，模型修订为 5359861c739e955e79d9a303bcbc70fb988958b1；模型恢复到 .skill/engine/assets/asr/models/ggml-base.bin，147,951,465 B，SHA-256 60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe，下载见[固定模型](https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin)。

本地 stdout 适配补丁保存于 [.skill/engine/assets/asr/stdout-stream.patch](.skill/engine/assets/asr/stdout-stream.patch)，SHA-256 b9516c14d6a02e2adf5a4214c52eef28b4dcc2276a50b1562c06e0164a613073；它将 JSON 输出绑定既有 stdout 流，保持受限管道消费。下载固定源码后以 patch -p1 应用，CMake Release 构建 whisper-cli：BUILD_SHARED_LIBS、GGML_BACKEND_DL、GGML_METAL、GGML_ACCELERATE、GGML_BLAS、GGML_OPENMP、GGML_NATIVE、WHISPER_COREML、WHISPER_COMMON_FFMPEG 与 GGML_STATIC 全设 OFF，构建 --target whisper-cli -j4。程序恢复到 assets/asr/bin/whisper-cli，核对 asr-dependencies.lock.json 的字节数/摘要及实际系统库闭包，保留完整许可并通过本地维护后 seal。固定依赖规则见[WAV ASR](.skill/references/workspace.md#有界-wav-asr-与段级建议稿)。

原生音频读取编入 [miniaudio](https://github.com/mackron/miniaudio)（David Reid，MIT No Attribution / public domain）与 [stb_vorbis](https://github.com/nothings/stb)（Sean Barrett，MIT / public domain）；实际固定 notice 与上游/模型许可保存于 .skill/engine/assets/asr/licenses/。模型和原生程序采用精确 Git 忽略，完整核心、备份和新片快照继续封装这两份独立文件；CPU 转写结果以实际文本、采样定位和调用回执作为证据。

词级对齐复用同一固定程序与模型，采用[固定 CLI 的完整 JSON token 输出](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/examples/cli/cli.cpp)和实验性 token 时间。批准稿与识别词采用有界、单调精确匹配；所有最优匹配都包含且目标唯一的单位才获得估计范围。同 token 内的多个汉字共享供应方范围，定位图保存适用局限与听音状态。

常见音频容器采用固定 FFmpeg 7.1 工具闭包。[FFmpeg demuxer 文档](https://ffmpeg.org/ffmpeg-formats.html)与[该版本 MP3 demuxer 源码](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavformat/mp3dec.c)提供输入选项、Xing 元数据和跳过样本的实现依据；[RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html)提供 FLAC 头、子帧、残差、填充与 CRC 位置依据。本项目独立实现完整 RIFF/MP3/FLAC/ISO BMFF 结构准入、包边界与完整解码帧样本 oracle，再从完整原件重建 PCM 和规范波形。显式音频政策和复用规则见[有界常见音频容器](.skill/references/workspace.md#有界常见音频容器)。
