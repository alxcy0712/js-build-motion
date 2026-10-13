# 核心维护与文件权威位置

只有用户明确要求修改通用能力或标准时维护 .skill/。题材、用户参考与单片定制进入 projects/<slug>/。普通制作通过固定核心初始化和运行本片。

| 需要修改的内容 | 唯一权威位置 |
|---|---|
| 制作标准与按需加载 | .skill/SKILL.md |
| 布局与隔离标准 | .skill/references/workspace.md |
| 导演、绘制、音视频流程 | .skill/references/ 对应主题文件 |
| VideoSpec 词汇与结构 | .skill/engine/src/spec/types.ts、schema.ts |
| 图元与组合动画契约 | .skill/engine/src/spec/graphic.ts、motion.ts |
| 项目 manifest 与 brief 契约 | .skill/engine/src/project/schema.ts |
| 原件接收身份、政策与回执契约 | .skill/engine/src/project/import.ts |
| 原件入库编排与文件适配 | .skill/engine/src/application/import.ts、adapters/import-files.ts |
| 展开身份、政策、清单与回执契约 | .skill/engine/src/project/unpack.ts |
| ZIP 展开编排与受控解析 | .skill/engine/src/application/unpack.ts、adapters/unpack-zip.ts |
| 素材目录、观察、权利与探测政策契约 | .skill/engine/src/project/catalog.ts |
| OCR 词区域、栅格/定位图与依赖身份契约 | .skill/engine/src/project/ocr.ts |
| OCR 有界图像准入、TSV 与原生适配 | .skill/engine/src/adapters/ocr-raster.ts、ocr-tsv.ts、inspection-ocr.ts |
| 文档单位、定位图与 worker 契约 | .skill/engine/src/project/document.ts |
| 文档受限 worker、PDF、DOCX 与 Office 原生解析 | .skill/engine/src/adapters/inspection-document.ts、document-worker.ts、document-pdf.ts、document-docx.ts、document-office.ts |
| 文档 OCR 选择、栅格、词区域与命令身份契约 | .skill/engine/src/project/document-ocr.ts |
| PDF 结构闭包/有界栅格与 DOCX 嵌图出现位置 | .skill/engine/src/adapters/document-raster-source.ts、document-raster-worker.ts、document-raster-pdf.ts、document-raster-docx.ts |
| 文档 OCR 串行编排与固定原件像素重放 | .skill/engine/src/adapters/inspection-document-ocr.ts、application/catalog.ts |
| WAV ASR 政策、采样/文本定位与固定依赖契约 | .skill/engine/src/project/asr.ts |
| WAV 有界结构/重采样、严格 JSON 与原生转写 | .skill/engine/src/adapters/asr-wav.ts、asr-json.ts、inspection-asr.ts |
| 批准稿、词与汉字对齐政策/定位图契约 | .skill/engine/src/project/alignment.ts |
| 完整 token JSON 与有界单调匹配 | .skill/engine/src/adapters/alignment-json.ts、alignment-map.ts |
| 对齐的原始波形核验、事务、复查与恢复 | .skill/engine/src/application/alignment.ts |
| 素材目录修订、复查与恢复 | .skill/engine/src/application/catalog.ts |
| UTF-8 提取与受限媒体探测 | .skill/engine/src/adapters/inspection.ts |
| 接收、展开、素材目录、对齐、视频与 Production 的独立目录租约 | .skill/engine/src/adapters/project-lease.ts |
| 视频准备/发布/回执与整数 PTS 定位图契约 | .skill/engine/src/project/video-preparation.ts |
| 视频受限原件、规范帧与代理适配 | .skill/engine/src/adapters/video-prepare.ts、video-frames.ts |
| 视频事务、复查、发布准入与恢复 | .skill/engine/src/application/video.ts、video-publication.ts |
| 镜头素材需求、选择、消费与覆盖契约 | .skill/engine/src/project/asset-plan.ts、ports/assets.ts |
| 素材绑定/快照/缺口与实际消费复查 | .skill/engine/src/application/asset-plan.ts、adapters/asset-port.ts、asset-usage.ts |
| Production 权威数据与模型提案契约 | .skill/engine/src/project/production.ts |
| Production 授权、审批、状态、失效与可读视图 | .skill/engine/src/project/production-policy.ts、production-view.ts |
| Production 租约、版本提交与恢复 | .skill/engine/src/application/production.ts、cli/production.ts |
| 导演契约与编译 | .skill/engine/src/project/director.ts |
| 绘制编排与主体组件 | .skill/engine/src/pipeline/spec-renderer.ts、drawing/ |
| 音频构建、混音与实测 | .skill/engine/src/audio/ |
| 编码与探测 | .skill/engine/src/ffmpeg/ |
| 工具状态与能力事实 | .skill/engine/src/project/tool-registry.ts |
| 进程隔离与运行时校验 | .skill/engine/workspace.mjs |
| 初始化、组件复制与统一调用 | .skill/scripts/video.mjs |
| 核心校验、备份与版本清单 | .skill/scripts/core.mjs |
| 实际成片与审片身份核验 | .skill/engine/src/project/artifact.ts |
| 结构化审片、署名与本地交付契约 | .skill/engine/src/project/delivery.ts |
| 审片覆盖、当前对象、权利与审批门禁 | .skill/engine/src/project/review-validation.ts |
| 当前成片、生产与声音来源复查 | .skill/engine/src/application/delivery-context.ts |
| 本地交付事务、清单与复查 | .skill/engine/src/application/delivery.ts、cli/delivery.ts |
| 组件可选项与依赖 | .skill/assets/components.json |
| 本片入口及审片模板 | .skill/assets/project/ |
| 回归测试 | .skill/engine/test/ |
| 字体、依赖和配音辅助脚本 | .skill/engine/assets/、node_modules/、scripts/ |

引擎只保留原始 TS，可由当前 Node 直接执行。依赖按包名保留一个版本。组件在初始化时从唯一源码复制并重写本片引用；运行时和规范副本属于影片初始化快照。备份是恢复用途的快照。日常维护编辑上表的权威文件。

```bash
node .skill/scripts/video.mjs backup
# 修改明确要求的通用能力，运行对应回归检查
node .skill/scripts/check.mjs --engine
node .skill/scripts/seal.mjs
node .skill/scripts/check.mjs --native
```

通用音频改动同时验证完整容器结构、原件解码样本数、原率 PCM 和唯一 canonical 的字节重放。显式 0.5 inspection 与 0.2 alignment 分别测试 ASR 关闭/启用、旧政策继承、截断成功退出反例、外部引用、协调外层哈希修改、累计配额、中断恢复及移根；真实宿主门禁通过固定原生工具产生独立已知样本输入并运行统一入口。

文档 OCR 改动采用显式 0.6 inspection，保持默认 0.4 和历史采用身份。必需校验 PDF 的经典结构、页树、解压/资源/画布配额与完整像素 oracle，DOCX 全包 CRC、正文 drawing occurrence/关系/部件身份，以及每单位栅格/TSV/text/map 与选择映射/原始命令记录的闭合关联。代表性宿主门禁从独立已知原件逐字节重建像素，覆盖双语/无文本、局部失败、协调摘要替换、累计配额、三种中断、恢复和移根；历史原生文本与单图/语音组分别沿自己的政策复查。选择覆盖、识别准确度与 DOCX 显示布局各自保存事实。

备份内容为完整 .skill/，每次统一入口执行前创建新快照，成功后删除超过两份的旧快照。备份失败时保留已有快照并停止调用。快照在 .skill-backups/，其文件名记录时间和核心哈希；恢复时先备份当前核心，再将所选快照解压到空的临时目录并核验，替换 .skill/ 后执行检查。影片运行时继续保持原版本。

修改标准须评估不同模型、题材和输入类型的共同需求；示例和参考资料作为验证输入。机制测试验证备份上限、输入隔离、核心固定、组件独立和真实音视频；旧的文档文字匹配检查随重复文档移除。

外部研究与主提示词按差异吸收，记录“来源与观察范围 → 可复核问题或设计假设 → 权威文件中的改动 → 验证”。具体维护过程按下述内容边界存入本地记录；通用检查的临时夹具放.research/out/并在结束后清理。附件可读取范围、原片实际观看范围和成片归因各自标明；资料未覆盖的部分保留pending。用户指定仅更新核心时，影片文件与固定运行时保持原状。

## 从项目复盘进化

用户明确要求学习项目时，在指定范围读取NOTES.md、prompt-history.jsonl、审片记录、相关源码与成片证据。把用户问题、可复核原因、已经验证的修正和待验证建议对应起来。单片偏好与建议时长留在本片；共性流程进入对应规范，可定位的工具限制进入权威源码。模型能力归因需要同条件对照证据。

新增能力以补充方式接入，保留仍适用的分类、入口与方法。合并、替换或移除既有内容时，明确调整依据并核对原有适用范围与调用。

完成备份、适用回归、seal及隔离检查后，在本片NOTES.md追加“skill 复盘与学习”段落：学习状态learned、日期、核心packageId、证据链接、已吸收改进和成片待办。evidence/skill-learning.json保存同一状态、来源路径与SHA-256、改进对应文件及验证结果；NOTES.md的来源哈希取学习段落之前的正文，避免自引用。

新片的学习状态从pending开始。后续复盘核对记录中的来源哈希；新增反馈、代码或审片证据变化时，追加pending记录并学习新增差异。learned表示已吸收该轮缺点与改进依据；成片修订、视觉验收和试听各自保留实际状态。

宿主条件当前为 macOS ARM64、Node 24、FFmpeg/ffprobe；在线配音需要 Python/edge-tts。模型接口与题材选择由 agent 负责，具体宿主适配通过独立维护提供。

## 内容边界与研究收敛

每项经验沿“现象 → 原因 → 修正 → 验证 → 归宿”回流。现象带实际观察范围与可定位条件；原因区分已复现行为和待验证假设；修正对应最小权威改动；验证分别记录工程、画面与试听；归宿写明进入哪份通用方法、规范、组件或本地待办。复用能力先查现有契约，方法卡链接统一的时序和验收规则，重复规则合并回原主题。单次版本、性能实测、夹具哈希和运行结论保存在本地维护记录，通用层保留计算方法、适用条件与反例。收敛完成后核对按需入口、独立初始化和生成区缺失时的核心测试。

| 内容 | 保存位置 |
|---|---|
| 通用协作、授权与执行入口 | 根 AGENTS.md |
| 可迁移理念、研究假设、适用条件与验证方法 | .research/，按能力主题组织 |
| 公开研究来源、作者、链接与致谢 | 根 README.md，集中归因 |
| 可执行流程、契约、组件与虚构测试夹具 | .skill/ 的唯一权威文件 |
| 具体项目名、用户原文、素材、代码、版本身份、复盘结论与待办 | projects/<slug>/，维护证据放 evidence/maintenance/ |
| 跨项目或独立核心维护的过程记录、原始研究笔记与迁移清单 | 本地 projects/.maintenance/，作为归档使用 |

维护时先查 .research/README.md 的方法索引，再在授权范围读取具体证据。提炼采用“问题 → 原理 → 适用条件 → 方法 → 验证”的结构；公开来源与归因集中在根 README.md；方法保留适用边界，将案例细节抽象为角色、对象、变量与状态。代码示例和夹具使用虚构名称、数据与路径。工程回归通过与影片观感验证各自需要对应证据。

共享前检查项目身份、个人路径、用户原文、素材与成片哈希、执行日期、运行次数、单片结论和未决项，将这些过程信息归回本地记录。公开作者、链接和出版信息在根 README.md 用于归因；通用契约、依赖名称及核心版本清单用于复现。通用层的说明应能独立于某次制作理解和执行。

汇总旧记录前检查调用与独有证据，先迁移再更新引用；同义规则合并到唯一主题，过期结论由有依据的新结论替换。项目历史按版本哈希保存在项目证据中，维护过程保留改动与验证的对应关系。核心恢复使用 .skill-backups/ 的两份成功快照。通用夹具与临时检查结果在记录完成后清理；实际素材、下载、帧与试听记录始终留在所属项目。

文档原生解析维护保持固定发行依赖、封闭 worker/policy/map 契约与单位覆盖语义。修改共享契约时先确定历史 adopted policy 的版本映射，再核对旧 catalog 继承、来源修订、定位图绑定及独立运行时。候选冻结后独立审查，工程回归与真实离线文档宿主检查绑定同一核心身份；实际内存观察、未测 IO 与条件跳过分别记录在本地维护证据。

OCR 维护保持固定语言发行、原生动态闭包与逻辑别名身份、1:1 白底 PPM、封闭 TSV/map/词区域观察契约。0.1/0.2 的政策采用与历史证据按原版本复查；历史 0.3 采用使用冻结默认值，新政策采用 0.4 的 ASR disabled 默认值。模型二进制随核心封装与项目快照保存，共享源码按根 README 的发行、大小和摘要恢复。候选冻结后的回归、实际离线双语/空图、坏输入与恢复检查绑定同一核心身份。

ASR 维护固定 WAV 范围、完整原率 PCM 与 16k 单声道采样事实、原始 JSON 重放、段级估计观察、离线模型/程序闭包和本批资源上限。依赖获取与本地构建依据已确认施工卡，实际调用与补丁身份进入本地证据；历史调用路径作为数据按原 inspection 核验，逻辑依赖路径随运行时移动解析。真实双语、空输出、取消、额度、恢复、历史运行时与空生成区验证绑定同一封存核心。

Office 维护采用显式 0.7 inspection 与文档 0.2，核验历史政策路由、整包 CRC、已解释关系、宏/DTD/路径限制、独立已知正文/notes/cell/table 文本与 UTF-8 定位。覆盖与遗漏、缓存公式、版面及全包外部引用观察各自保存事实。

视频与素材消费维护核验完整原件结构/帧/PTS、明确区间与有理帧映射、固定工具闭包、规范 RGBA/完整代理重放、成功 receipt 发布准入与三种中断落点恢复。标准 start/import/catalog/prepareDrawing/render/disclosure/artifact 链路采用独立已知像素与连续转场编码 oracle；回执绑定准确来源、选用文件、定位图和本次输入快照。部分覆盖、未观测动态 IO、闭合零消费与权利/语义/构图/连续性各自验证，失败准备和绘制保留上一有效 current。

Production 维护核验四种输入、固定 requested、稳定来源引用、作用域继承与当前内容审批、视图编辑和版本 CAS。成功状态由固定必需检查及有效输出计算；准备后、发布后、成功回执后分别测试中断，独立恢复核对来源、回执和 current。失效按实际消费依赖验证完整重建及未消费输入保留。候选冻结后集中完成一次全量引擎检查，真实统一入口和空生成区验证绑定同一核心；历史固定运行时与发布边界分别核对。
