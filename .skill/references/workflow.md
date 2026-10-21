# 制作、媒体与交付工作流

## 创作问答

先读[创作主线](motion.md#创作主线)。从当前对话提取主题、受众、目标、事实、时长、平台、语言、参考及约束，分清用户原话、模型推断与重要缺口。已有选择和明确委托持续沿用；可逆细节按项目惯例决定并记录。型号、性能、历史、科学因果通过可靠资料核对，附件按其来源身份提供候选方法。

方向待定时提出 2–3 个有实质差异的方案，比较核心证明、主体、叙事、色彩材料、运镜、节奏、声音和可实现性。用 2–4 句说明推荐的观看效果；首轮通常问 1–3 个影响范围、正确性或交付的问题，每题提供推荐项及具体取舍，支持自由回答。用户已有选择或明确“按推荐执行”时落实；必要答案待定期间可核对输入与工具，依赖步骤等待答复。

主题按[账号默认与每片风格选择](style-and-identity.md#账号默认与每片风格选择)取得本片选择或明确委托，再初始化。每片询问是否采用头像与「澄记 / 用计算机思维想现实」片尾；原文已明确时直接记录。采用时以「我是澄记，用计算机思维想现实。」收尾，前一句承接内容，片尾卡与实测口播同步；不采用时结束于正片结论。答复进入原文记录，NOTES 写明采用状态；恢复本片沿用该答复。

NOTES 保存解析依据、推荐与备选、默认值、最终选择和参考用途。brief.acceptance 写可观看验证的开头兴趣、事实结构、核心证明、焦点接力、节奏变化与字幕读时；events.md 连接事件、包装、声音和时间码。按[导演计划](direction.md)完成全片动态粗剪与正式素材重点样片，再按[质量规范](layout-and-quality.md)审查当前编码。工具限制影响已选观感时先试样并说明具体影响。

| 输入类型 | 独有核对项 |
|---|---|
| 教学解释 | 受众知识、学习目标、科学事实与简化范围 |
| 产品与仓库 | 实际代码/产品证据、可见操作、性能条件与版本 |
| 已有视频 | 原件探测、音轨/画幅/帧率、授权范围与保持项 |
| 复用已有方法 | 独立复制所需文件、来源贡献与本片改写 |
| 生成视频 | 提供方能力、调用/费用/人工轮次与真实素材消费 |
| 三维画面 | 固定时间求值、工具登记、代表性试渲染与最终编码 |

## 入口、文件与固定版本

macOS ARM64 使用根入口；通用命令使用 exec。入口校验并备份核心，`.skill-backups/` 常规保留最近两份成功快照。已有影片先 backup，再读本片 AGENTS、brand、prompt-history、NOTES、events/review 与 guide，按固定运行时恢复。Linux 使用[手建入口](#linux-手建入口)。

```bash
node .skill/scripts/video.mjs start <slug> --idea "用户原文" --theme <minimal|kinetic>
node .skill/scripts/video.mjs backup
node .skill/scripts/video.mjs <slug> capabilities --schema
node .skill/scripts/video.mjs <slug> exec <命令及参数>
```

| 本片路径 | 权威内容 |
|---|---|
| project.json / brief.json / director.json | 入口、交付声明与导演计划 |
| brand.json / workspace.json / .engine/ | 固定主题、配置摘要、独立运行时与依赖 |
| prompt-history.jsonl / NOTES.md | 沟通原文；推断、设计、来源与学习状态 |
| inputs/original / imports / import.json | 独立原件、固定接收清单、提交索引 |
| inputs/unpacked / unpacks / unpack.json | 一层 ZIP 展开、父身份与提交索引 |
| assets/catalogs / catalog.json | 素材版本、测量/观察/权利与当前索引 |
| assets/asset-plan.json / derived/ | 镜头选用及固定图像、视频、声音、对齐证据 |
| src/ / guide/ | 本片源码和组件副本；七篇制作规范快照 |
| evidence/ / runs/ | 事件、审片、参考；尝试、输入快照、回执、消费和租约 |
| out/renders/ / out/.tmp/ | 每次独立编码；本片临时文件 |

路径相对本片，slug 与目录一致，drawing 使用 src 内同步模块。输入、代码、组件与输出均为普通独立文件。生成候选、下载、模型/纹理、音频、截图和工具日志全部存本片；工具临时目录设为 out/.tmp，固定宿主输出立即迁入本片并登记。easing/random 默认复制，camera 同时复制 easing。

start 固定本片 brand.theme/defaultTheme/changes 与 workspace.brand.sha256，运行时读本片快照。账号默认仅按用户要求改变；已有影片保持原运行时与配置。项目进程及后代写入限定本片，.engine、brand、共享核心、备份和其他影片由沙箱保护；宿主文件工具遵守任务范围及其实际权限。

### 生成区的外部依赖约束

projects/ 含 .maintenance 是可删除生成区。区外代码、配置、资源、文档和测试保持自包含，禁止依赖其中具体文件及其软/硬链接。制作按显式 slug 读取本次输入；复盘按授权读取指定证据。核心测试自行生成虚构夹具，projects 缺失时校验、契约查询和初始化仍可运行。

### 沟通原文

prompt-history.jsonl 每行 `{timestamp,kind,text}`，timestamp 为 UTC ISO 入库时间，kind 为 prompt/question/answer，text 保留原话、换行和链接。start 保存首次 prompt，随后按沟通顺序补齐初始化前问答；后续修改逐条追加。可核实的原发言时间另记 NOTES，模型假设同样进入 NOTES。

```bash
node .skill/scripts/video.mjs <slug> prompt --kind prompt --text "用户修改原文"
node .skill/scripts/video.mjs <slug> prompt --kind question --text "问题原文"
node .skill/scripts/video.mjs <slug> prompt --kind answer --text "答复原文"
```

首次 --idea-file 可读用户指定文件；初始化后的 --file 使用本片相对路径，中转文件入库后清理。早期运行时可由宿主按同格式追加。run 保存渲染时的原文摘要与条数，后续沟通保持追加事实。

## 原件入库与 ZIP 展开

```bash
node .skill/scripts/video.mjs <slug> import --source "/path/to/selected input"
node .skill/scripts/video.mjs <slug> import --verify <importId>
node .skill/scripts/video.mjs <slug> unpack --import <importId> --path <archive-relative-path>
node .skill/scripts/video.mjs <slug> unpack --verify <unpackId>
```

import 接收用户指定普通文件/目录的独立副本，保留结构与空目录。根入口的相对来源按调用 cwd，本片入口按本片目录解析。ImportManifest 固定来源路径、长度、SHA-256 与批次身份，后续消费本片副本。`import --schema manifest`、`unpack --schema manifest` 查询契约。

| 政策文件 | 默认准入 |
|---|---|
| inputs/import-policy.json | 单文件 1 GiB，总 4 GiB，5000 文件，深度 16 |
| inputs/unpack-policy.json | ZIP/单文件各 1 GiB，总 4 GiB，条目/生成节点各 5000，深度 16，压缩比 200:1，元数据 16 MiB，全程 5 分钟 |

每次保存原字节、采用政策、摘要、计数和 receipt；流式核对实际字节，通过后原子发布索引。路径准入覆盖真实祖先、软/硬链接、特殊文件、越界、规范化/大小写/前缀碰撞、源变化及资源超限。实际来源授权与宿主读取权限各自满足；系统临时路径使用物理路径。失败保留原件、旧索引、回执及 out/.tmp 的本次现场；硬终止后以已验证索引恢复成功或 interrupted。

ZIP 使用已入库父副本，保存父清单/原件身份、解析器版本、原始名称、NFC 路径、逐成员 CRC32/长度/哈希。支持单卷 ZIP/ZIP64、Stored/Deflate、普通/空文件与目录、UTF-8/CP437/有效 Unicode 扩展；嵌套包作为普通字节保留。加密、分卷、其他压缩、链接及不明类型形成失败回执。中央目录/局部头/描述符、成员范围和单卷身份共同核验，元数据先准入再读取，输出先计额再写入；零压缩仅容纳零输出。隐式父目录计入节点，显式同名目录合并。输出权限按项目策略创建。

入库与展开分别持有租约并恢复各自回执；固定来源和已提交清单在离线最小环境中只读。复查包含全部成员、父来源、政策和清单外对象。中断计数保留最后持久化观察；manifest 保存制作时资源快照，receipt 继续记录后续复查与耗时。

## 素材目录、观察与权利

```bash
node .skill/scripts/video.mjs <slug> catalog --import <importId>
node .skill/scripts/video.mjs <slug> catalog --unpack <unpackId> --path <条目路径>
node .skill/scripts/video.mjs <slug> catalog --observation inputs/observation.json
node .skill/scripts/video.mjs <slug> catalog --rights inputs/rights.json
node .skill/scripts/video.mjs <slug> catalog --verify <catalogId>
```

使用 `catalog --schema policy|observation|rights|ocr-map` 读取当前契约。相同固定来源复用素材与版本；新入库来源配合 `--path ... --asset <assetId>` 建立新版本。每次修订保存全部版本、技术结果、观察、权利，assets/catalog.json 原子选择当前。内容版本沿原 inspection 政策、工具和派生证据复查，旧修订保留。

签名路由支持 UTF-8 MD/TXT、PNG/JPEG、WAV/MP3/FLAC/M4A、MP4/MOV/WebM；WebM 核对 EBML DocType。ZIP 登记显式展开待办。PDF/Office 原件支持入库与身份校验，解析状态为 unsupported；需内容时由授权流程准备图片或 UTF-8 文本。历史政策 0.1–0.7 的冻结字段用于摘要与版本继承，纯文档解析已移除。

文本保留 BOM/行尾和原 UTF-8 字节；图像记录尺寸及预览映射，自动旋转关闭；视频抽样记录流索引、timeBase、整数 PTS、请求/实际时间，时长未知时只取已知位置；音频证据保留原率单声道 PCM 与实测样本数。完整、局部、抽样、unknown 各自登记。

inspect-policy 控制数量、源/文本/目录/派生/PCM 字节、流数、像素、预览、工具日志、样本数及工具/全批时限。原字节和 adopted 快照进入 runs。工具使用格式/协议白名单、最小环境、离线沙箱和本片临时目录；FFmpeg 单次分配与像素预算分别准入。sourceReadBytes 统计受限 Node 描述符与签名窗口；工具内部 IO 和全进程 RSS 保留实际测量范围。

观察必须来自实际阅读/观看/试听的固定证据，记录版本/原件哈希、方法、定位、覆盖、判断、依据、置信度、局限和引用。文本定位 UTF-8 半开字节/行，图像定位证据像素，视频附实际 PTS，音频定位原率半开样本；抽样帧保持 sample。技术、语义、构图、连续性、权利各自保持状态。

权利 unknown 保持未知；user-declared 绑定 prompt/answer 并冻结原文快照；documented 绑定许可证据路径/哈希/原文片段。用途、限制、署名、适用音视频流与第三方权利分别记录；同一记录 ID 的 revision 递增。观察和权利原始 JSON 留在运行快照。

verify 核对索引、清单、父来源/字节、原政策和派生证据，再验证观察/权利定位。单项受限解析失败可保存状态；来源变化、权威损坏、全批配额、取消或发布故障保留旧索引。独立租约和回执支持中断恢复，已提交证据只读，新修订验证后发布。

## 单图 OCR

PNG 接受至多 8 位灰度/RGB/palette、tRNS/alpha 和 Adam7，拒绝 APNG、16 位及坏 chunk/CRC；JPEG 接受单个 8 位 SOF0/SOF2、1/3 组件，拒绝 CMYK/YCCK、其他 SOF、MPF/MPO 与拼接多图。范围/局部配额为 skipped，工具/身份/超时/TSV 故障为 failed；有效预览保留并标 partial。ocr.enabled=false 保存 disabled。

固定单帧 RGBA 保持源尺寸、奇数边长与编码方向，EXIF 1–8 同样处理。白底合成为 floor((c×alpha+255×(255−alpha)+127)/255)，输出 P6 RGB8，源与栅格坐标 1:1。Tesseract 固定 chi_sim+eng+~chi_sim_vert、OEM1、PSM3、DPI300、单线程，封装模型及工具物理闭包/动态别名由运行时锁核验。

保存 PPM、完整 TSV、规范 text、ocr-map。合法非空 level5 词按返回顺序排列，同 line 插 ASCII 空格，跨 line 插 LF，末尾保持末字节；区域记录层级、行序、整数框、原分值和 UTF-8 半开区间，−1 分值转 null。低分词保留；合法空 TSV 为 no-text/零 text/空 regions。map 绑定源、政策、四证据及引擎模型身份。

observation0.3 使用 ocr locator、text/map/raster ID、regionId、字节范围及 region-ocr-text；full 为整词，partial/sample 保持词内合法 UTF-8 边界，观察置信度 0–1。verify 重解析 TSV 并核对规范文本、区域、PPM header/长度和全部身份。普通 image 观察仍定位预览。

默认限额：源32 MiB，20图/批，1600万像素，边8192，PPM48000128 B，TSV8 MiB/10万行，2万词，text2 MiB，map4 MiB，4096结构项，单词4096 B、单行16384 B，串行1。政策可收紧，通用较小限额继续生效，批次先计数再同源去重。来源/累计配额/取消/发布故障保留旧 index；重新识别已有源须重新 import 并建立新内容版本。

## 音频输入、ASR 与批准稿对齐

默认 inspection0.4，asr.enabled=false；显式选择 zh/en 启用 ASR。原0.1 ASR 接受 RIFF PCM16、单/双声道8–48 kHz、0.2–120秒、64 MiB，去重后每批4个新 WAV；完整原率单声道 PCM 检查后生成唯一16 kHz单声道 canonical。raw JSON/text/segment map/canonical 一起发布，verify 重放 JSON。10ms 网格换算整数样本，文本按 UTF-8 字节定位；segment-asr-text 时间为 estimated/unknown，confidence=null，full 指选定段的完整文本。原 audio 观察沿原率 PCM 记录实听样本。

显式完整 INSPECT_POLICY_05 启用常见容器：WAV 完整 RIFF PCM16；FLAC PCM16/正 STREAMINFO 样本数/逐帧 CRC；MP3 固定 MPEG LayerIII 版本/采样率/声道、普通 ID3v2.3/2.4、可选完整 ID3v1、首帧 Xing/Info；M4A 单 ftyp/moov/mdat、单 AAC-LC、完整采样表/自包含引用、空或一个 rate1 编辑。外部引用、多轨、片段、加密、截断和超限保存失败/跳过事实。

0.5 固定唯一 probe、原率单声道 PCM、16k canonical WAV、audio-input-map。完整编码帧/采样表为解码域，原率样本数须匹配结构；delay/padding/edit 单独记录，presentationMapping=unknown。默认每批4源、64 MiB/源、单/双声道8–48k、0.2–120秒，32768结构项、12000包、PCM11520000 B、WAV3840044 B、map4 MiB、单工具30秒，串行。verify 重读原件、四证据、包边界、物理工具闭包及原 ToolRun/cwd，重新解码逐字节核对 PCM/WAV；重放临时文件退出清理。

ASR0.2 复用上述 canonical，追加 raw/text/map，观察0.5保持估计状态；ASR 关闭时四证据仍可用。新 catalog/receipt/index 依当前政策和历史最高版本写入，旧0.1–0.4和已提交0.5按原政策继承。转写完整性、语音存在、准确度与试听分别验收。依赖使用 engine-relative 身份，运行前后及提交前检查；native 在私有空 cwd 读取唯一 canonical，输出有界 JSON，失败保留基础结果与已消费计数。

```bash
node .skill/scripts/video.mjs <slug> align --schema script
node .skill/scripts/video.mjs <slug> align --catalog <id> --asset <id> --version <id> --script inputs/approved.json
node .skill/scripts/video.mjs <slug> align --verify <alignmentId>
node .skill/scripts/video.mjs <slug> align --recover
```

alignment0.1 接受16k单声道 PCM16、3200–1920000样本、64 MiB，逐字节核对 RIFF data/完整 audio-pcm/canonical payload。显式 ALIGNMENT_POLICY_02 使用已完成0.5通用音频证据，ASR 可关闭；四证据完整重放后提交同一 canonical。script/map保持0.1，清单回执按采用版本，索引保存历史最高版本。

批准稿包含 version/kind/language/lineId/text/approval。scope=word-alignment，user/delegated、decisionId、sourceRef路径/bytes/SHA和subjectSha256绑定授权；subject 按 UTF-8 JSON.stringify({version,kind,language,lineId,text}) 固定次序计算。来源来自 inputs/assets/production/prompt-history。原稿、批准来源、canonical、完整 token JSON、recognized text、map、manifest固定保存，独立租约及耐久回执/政策/ToolRun支持原子索引与恢复，工作稿修改保留旧快照。

对齐完整分区 UTF-8 原稿；ASCII词含内部直/弯撇号按小写精确匹配，汉字按 scalar，标点/空白/其他字符为 nonlexical/unknown。全部最优有界 LCS 路径使用同一唯一识别单位才给 estimated 时间；歧义/缺失/无效时间为 unknown/null。同词多 token 取包络，同 token 多汉字共用范围并注明限制；confidence=null，listening=unverified。完整提交、原稿覆盖、获时词数与听音分别记录。

默认文字32 KiB、来源1 MiB、两侧各2048词/字、8192token、单token16 KiB、raw/map各4 MiB、识别text1 MiB、矩阵4194304格、元数据/派生各16 MiB、有界读取256 MiB、诊断1 MiB、单工具120秒/事务180秒。矩阵先准入，stdout是独立raw预算，stderr计诊断；sourceReadBytes按受控回调，工具内部IO/RSS和跨宿主稳定性按实测登记。`align --schema policy` 查询完整契约。

## 视频准备与实际消费

```bash
node .skill/scripts/video.mjs <slug> video --schema request
node .skill/scripts/video.mjs <slug> video --request inputs/video-request.json
node .skill/scripts/video.mjs <slug> video --verify assets/derived/video/<uuid>/map.json
node .skill/scripts/video.mjs <slug> video --recover
node .skill/scripts/video.mjs <slug> assets --schema plan
node .skill/scripts/video.mjs <slug> assets --plan assets/asset-plan.json
```

请求绑定 catalog/manifest/asset/version/原件哈希、streamIndex、原 timeBase、整数 PTS 半开区间和 fps。支持自包含 MP4/MOV、单H.264/yuv420p/SDR、零旋转及可选AAC；完整 atom/sample/chunk/PTS/mdat/data-reference 先检查再解码。工具身份沿 workspace.audioInputRuntimeIdentity → asrRuntimeIdentity({toolsOnly:true}) → asr-dependencies.lock 的 FFmpeg/ffprobe 闭包核验。目录探测、识别与正式选段分别采用政策。

历史0.1解码完整受限源帧，保存整数PTS和独立RGBA哈希；按区间起点有理时间前帧保持，未知末帧时长为null，区间上界按已知呈现域准入。输出 map/frames.rgba/proxy.mp4/publication.json；verify 重建RGBA、静音代理并完整解码逐字节比较。冻结限额：源64 MiB/600帧/8294400像素/10秒，代理边512/600帧，RGBA256 MiB、代理32 MiB、probe/map各8 MiB、结构50000、单工具30秒/准备120秒。

0.2 输出宽高同为null则保留源像素，也可同宽高比设交付尺寸；mute缺省false。固定块核验源身份，驻留容器元数据，选段解码所需前置保持帧及连续帧，RGBA逐帧落盘。map记录全源帧数/呈现域、选用帧/CFR映射、交付/预览尺寸、政策及真实调用；AssetPort按单帧读取核对哈希，rough用缩小proxy，final用交付canonical。

保留音轨时 source-audio.wav 为48k双声道PCM16，零点对应 sourceRange.startPts，样本数按区间有理长度取整，保存源音轨timeBase/startPts/durationPts。明确静音和无轨分别为muted/absent；同一clip placement驱动画面与原声截取/移动。尚未接入原声时间线的普通画面入口报告pending，明确mute=true可走画面入口。

生产默认源/RGBA各8 GiB、proxy/原声各1 GiB、4000万源像素、预览边512、metadata/map各32 MiB、probe16 MiB、结构200万、驻留帧/磁盘余量各256 MiB、单工具300秒/准备900秒。`--limits inputs/video-resource-policy.json`显式采用政策；时长/帧数由资源预算准入，RIFF32原声按容量分段。不足时记录所需量/预算/磁盘与原因，缩短选段、分段或据实调整资源，保留原件/旧成果；RSS与工具内部IO单独记实测。

独立video租约在out/.tmp准备；publication绑定准确成功receipt字节和map/request/policy，成功回执为提交点。recover核验退出owner、目录/map后清理该次遗留输出并记interrupted。render冻结publication和成功回执，失败准备/消费保留旧current。

AssetNeed记录镜头用途、动作/视角/身份、尺寸/时长/权利与替代；AssetUse以稳定useId绑定need/shot/role和准确来源版本、源区间、归一裁框、contain/cover与mute。新plan0.2默认保原声，历史0.1继续明确静音。0.2照片使用源像素预算，OCR预算独立；照片编码字节与解码像素共用256 MiB驻留预算，超额按交付尺寸准备派生或分镜准备。

prepareDrawing/AssetPort完成受控读取，drawScene同步绘制；消费回执记录选用文件、map、帧/PTS、操作及输入快照。闭合入口可声明complete，动态IO保留partial/unknownRemainder。`assets`对账来源、派生、技术/权利/语义/构图/连续性缺口；最终可见内容与选段工程覆盖分别验收。

## 素材选择与生成视频

复杂实物/环境/材质评估生图，品牌/文字/数据/技术关系使用官方原件或精确代码。主体先依据资料验收，教学简化/比喻标明范围；图片运动需裁切余量/分层，换角度和环绕采用已验证多视图或三维。使用工具前核对当前接口、能力与已有费用/访问授权；adopted只表示工作流接入。生成结果和全部候选立即迁入assets/generated，参考在assets/reference，提示/工具/状态/路径/SHA进evidence/assets.json。

brief.assets登记实际来源与哈希；生图时tools.allowed加入imagegen、pureCode/zeroExternalAssets=false。工具生成、素材冻结、逐帧渲染各自记录；固定图片重现与重新生成能力分别陈述。外部素材登记许可、署名和实际用途；网络优先核验公有领域/CC0，品牌按角色专用约定查官方授权。去水印限自有或明确许可并保留权利信息。

引用资料逐镜记录“来源身份→镜号→源区间/区域→首次信息→再次使用的新分析或必要持续用途”。官方B-roll先扫干净原片，新镜优先不同源区间，图解/标签按信息叠加，回放须对应可见分析。素材缺口从未用区间、同主题合法来源、静帧或原创解释补足。实际平台规则/账户类别/AI声明在发布前核对官方现行来源和日期，项目偏好、许可和平台规则各记来源。

生成片段承担角色动作，平涂灰/白底、设备屏幕空白、no text/no logos；文字/UI/标注由代码绘制，逐镜标生成层/代码层。调用前确认参考可读路径；Grok Bot GenerateVideo需自己的素材目录，其他工具按实际接口。`exec node .engine/scripts/key-footage.ts <clip> <outDir>`支持`--preset white`或`--key #RRGGBB`，生成透明帧和meta；边框连通/封闭色区/收缩羽化去溢色，首中尾在暗亮背景验边缘。

openKeyedClip(dir,slot)速率0.75–1.5×，长片按上限截断，短片慢放后pingpong；往复限验证过的可逆周期动作，受力/口型/装配/流体采用足够正向素材或调整镜长。高输出帧率预乘混合相邻帧；drawCharacterLayer连相机缩放限制screenScale≤1，大主体需高源分辨率。fadeBottom可融合半身，轮廓光alpha≤0.15；最大推镜和连续窗口复核。

## Production 权威与恢复

`production --schema init|proposal|bundle|timeline`输出契约。init --request固定四种输入：folder-vlog的image/video，copy-video的copy，title-video的title，video-script的video/script。原要求、prompt摘要、输入身份、硬指标、原声与审批任务进入requested；模型可逆默认值和依据进入effective/decisions，后续要求先记原文再修订effective。

production/manifest标权威模式，state原子指向不可变revisions/<id>/bundle与成功回执；requirements/script/shots/timeline/decisions/失效同包，plan.md与决策JSONL为可重建视图。稳定script/line/shot/event ID、sourceRefs/lineRefs、素材版本和sourceHash闭合；硬时长/画幅/fps/最低尺寸遵守记录，preview/delivery分开，原声默认preserve，mute绑定用户来源和作用域。

决策记录decisionId/actor/sourcePrompt/rawText/scope/subjectHash/supersedes。用户授权来自保存的prompt/answer原文；作用域分别核对action/target/assetIds/provider/maxCost，本地plan/project委托覆盖本地规划，外部调用/收费/发布/访问沿明确授权。approve绑定准确任务和当前内容摘要，变化后重算适用性；新决策追加，撤销/替代引用旧ID，问题只影响对应任务。

apply --proposal携带expectedRevision/expectedSourceHash/rawText，在租约内CAS；修改可读视图时expectedViewHash绑定当前字节，视图头仍核验revision/包摘要。冲突保留旧state。invalidate使用expected-revision/source-hash/key/reason，key支持requested/effective/input:/line:/shot:，按实际消费者传播；完整重建清标，部分重建仍stale，未消费对象保持有效。

next按固定必需检查、有效输出、来源、硬指标、授权/审批和失效计算complete/ready/pending/stale/waiting_user。空/遗漏/重复/未知检查拒绝。apply先prepared→版本目录→不可变成功receipt→state；resume在租约内核对已停止owner和来源，缺成功receipt为interrupted，完整成功记录收敛一次提交。计划阶段完成范围为requirements/script/shots，时间线/编码/审片/交付各自验收。

timeline使用整数帧/48k样本，sourceHash消费effective/script/shots。take固定文件身份、实测样本与词/拍点依据，placements排固定声音，clip的start/end/sourceStartFrame同步驱动画面与原声。gain/mute逐原声/旁白/音乐/SFX设置，静音决策action=mute,target=timeline。

```bash
node .skill/scripts/video.mjs <slug> production next
node .skill/scripts/video.mjs <slug> production apply --proposal inputs/timeline-proposal.json
node .skill/scripts/video.mjs <slug> production compile --profile rough
node .skill/scripts/video.mjs <slug> render --profile rough --json
node .skill/scripts/video.mjs <slug> production compile --profile final
node .skill/scripts/video.mjs <slug> render --profile final --json
node .skill/scripts/video.mjs <slug> production resume
```

compile保存完整冲突、锚点/量化误差、字幕/读时，硬冲突阻断投影；通过后派生spec/asset-plan/production-spec。guard核对权威版本、运行时和派生身份。硬锚需observed词时或observed/authored拍点，estimated/unknown作为软建议；event与同镜图元ID绑定准备/可见/峰/完成/阅读关键帧，已有通道冲突明确阻断。清单共读从末项完成算。rough/final使用同一固定声音/样本排布，分别消费proxy/canonical。production-render保存原件/原声剪接/轨道/字幕/事件/编码帧数/声音检查；完整创作审片需实际全片声画。

## 配音、音乐与声音锁

env --json核对宿主/字体/音频工具。默认Edge→授权assets/audio/voice.wav→mock工程占位；正式旁白验收真实TTS或录音。Edge需edge-tts≥7.3.1，缺失在env写warning，helper --probe退出3，其他制作可继续。受管Python可建立`python3 -m venv --copies "$HOME/.local/share/js-build-motion/edge-tts"`，激活后`python3 -m pip install --upgrade 'edge-tts>=7.3.1'`；Linux缺venv按宿主管理安装python3-venv，制作沿同解释器PATH。离线用`audio/render --tts-provider file --no-network`，mock须明确工程用途。

用户明确声明豆包后显式`--tts-provider doubao`，已有授权沿用；仅提供Key或查目录仍沿默认。本地个人“我002”授权以根AGENTS优先。voices给公版ID/语言/模型/接口，抽象female_calm/female_lively/male_calm/male_lively按目录映射；需要Python/websockets≥14。凭据只从DOUBAO_API_KEY环境读取，项目/日志只记可用状态。个人复刻先核真实speaker ID、资源、账户和传输接口，目录可见、合成成功、完整解码、主观试听分别记录；403仅说明该请求组合，按官方接口核对已授权的适用路径。

audio生成narration-timing，逐句检查起止、完整性、空档/尾留；再qa读取匹配当前spec的实测，超1秒空档和低0.8秒尾留作为复核提示，结合信息与读时判断。未知时序为NARRATION_TIMING_PENDING。逐句voice/rate/start，rate整数百分比缺省+8%，SFX绝对秒；words.json保存实际音色/资源/接口/语速、服务词时与去重sentences。换文本/音色/模型/语速重新测量、排字幕/镜长/事件/片尾、锁声音和编码。

音乐先测拍点/瞬态并试听强拍相位，记录音轨哈希/BPM/原点/重音；60/BPM秒与fps×60/BPM帧逐拍从原点乘法换算。beatGrid与snapCutsToBeats默认maxShift0.12，later保护阅读下限，超范围kept；addCutAccents叠柔和鼓/气声/拨弦与短暂压低铺底。讲解优先语义和阅读，SFX对应预备/接触/瞬态/尾音，刻意偏移记用途并听当前编码。

`audio lock`保存assets/derived/audio/<hash>/audio-lock.json，固定master/分轨/句尾/词时与原来源。file模式适用一条预制旁白，完整解码获样本/时长，词时未知；多句采用逐句真实TTS。视觉改片用`render --audio-lock <相对路径>`复用同PCM master及字幕时序，AAC每次编码。旁白、音色、速率、起点、片长、混音或源字节变化需重锁；译文/样式/画面可沿用。

## 编码、后处理与身份

常用顺序：direct compile → brief validate → qa/project audit → audio/audio lock → storyboard --per-shot/frame --at → render → artifact --out evidence/artifact.json → disclosure。字幕排程与读时按[captions](captions.md)，SRT/VTT/画面共用时间线。

render建立attemptId，runs保存冻结输入/执行/receipt，out/renders保存独立MP4/字幕/音频；冻结spec/brief/代码/已知媒体，提交前复查源与快照。动态IO覆盖仍partial，assets树保守前后哈希；绘制通过声明本片相对路径消费。编码、完整解码、旁白信号、输入检查成功后原子更新根run，便捷out/<slug>.mp4按run恢复；失败保留旧成功，同片并发由锁拒绝。--out/--srt/--vtt只选本片out便捷副本，--no-run-log保留本次局部记录并保持根run。

artifact核验实际编码哈希/体积、run/spec/brief、绘制源码、固定运行时、attempt/输入快照/已知媒体；成功建立身份快照，失败保留旧快照。换编码前把旧artifact/review/run/检查保存evidence/versions/<旧SHA>，当前观察设pending。审片从run指定编码提帧/窗口并绑定同SHA，交付前`artifact --review evidence/artifact.json`；失配先恢复真实来源/编码记录再审查。run和DISCLOSURE由命令生成，试听/视觉缺口保留pending。

brief.assets[].provenance.tools记录素材来源工具；brief.tools.external包含id/label/kind/network/byteReproducible并加入allowed，forbidden仍生效，执行支持据实核对。来源用途为声明，本次调用按run观测。外部混音/ASS烧录/转码完成后用`postprocess --schema request`准备本片请求，`postprocess --request evidence/postprocess-request.json`登记，`postprocess --verify`复查。最终文件哈希/流实测、用途/字幕/词时声明、听音/像素观察分别记录。

disclosure读取后期记录，§1指最终视频并标原中间渲染，§4/§5列来源/步骤；可用--postprocess指定记录。artifact仍验证原渲染件，后期记录绑定最终交付。归档缺原件时可显式sourceVerification=records-only并以evidence路径/SHA绑定已有记录；现存来源继续核对，缺失列unavailable，原runId/artifactId/spec/brief/输入/消费链仍验证，缺失源哈希标声明。默认complete要求完整来源；恢复/移除源后重新登记范围。

外部封装日志缺失时保留产物/证据，核对流与音源后通过本片exec重新封装并保存真实调用；待核事实保持pending。早期影片按固定capabilities/guide执行，明确采用的新方法写本片src/evidence，核心升级单独维护。结构化review/credits/deliver及全片观察按[质量与交付](layout-and-quality.md)执行。

## 口播、发布与锁定

抖音口播默认短句、常用中国单位与准确换算，技术比喻1–2个并联系具体事；真实经历/数字/引语须有依据。按具体场景开头→机制→代价→办法→真实做法收尾，题材另有结构时记依据。避免空泛模板词与对照口号；可用humanizer-zh/dbs-ai-check时自查并记结果。片尾沿本片答复。标题直接说明主题，默认陈述句，用户指定优先；简介1–2句收益加3–5标签。

以下为本项目措辞/画面偏好，实际平台规则另核来源：投资/股票/交易/点位、站外网址/搜索注册/加群私信、薅羊毛/绕限制、第三方付费推荐/比价/支付渠道列为避用项；绝对化“最/第一/100%/唯一”等逐项复查，明确引语或带“之一”的时间表达按上下文处理，屏幕标题保守采用事实描述。平台机制使用记录/推荐等中性词。画面核对第三方水印、其他平台UI、侵权、二维码、联系方式、个人信息和生成乱码；与讲解对象相关的官方标识/界面按根AGENTS本地角色授权与许可执行。站内引导仅点名产品/栏目；生成图/视频按实际平台要求声明AI。

发布前逐项核对口播、字幕、大字、标题、简介和代表帧，抖音/小红书分别登记结果。独立封面由宿主读取assets/douyin-cover规范，复制选用素材入本片；封面模板/版式/输出严格限独立封面。稿件与分镜确认后锁定，用户主动指定的修改按其范围执行；审片时间戳/引号/叠化沿既有镜头改代码。Grok团队只开一轮必须改并复核，建议入下一片待办；本地按用户范围与质量规范闭环。确认封面沿用，用户明确换标题/主体再重做。发布由用户执行，既有明确审批仍适用。

## Linux 手建入口

适用Node24、FFmpeg/ffprobe、Linux Skia与实际字体齐备的团队宿主，用于文字稿/代码画面/本片已保存素材。系统隔离由宿主管理，记录host-managed-unverified；bwrap配置由宿主验证。macOS的发行宿主匹配、自动备份、verifyRuntime发行校验、sandbox-exec、native/standalone宿主门禁由本节手动流程替代。OCR/ASR、受限入库/视频准备、Production和结构化交付留待Linux适配；创作/来源/权利/原文/用户发布审批和真实音视频验收继续执行。

初始化前在同终端切Node24并核对`node --version`，后续沿用。根仓库执行：

```bash
export JBM_FILM_SLUG=example-film
export JBM_FILM_THEME=kinetic
export JBM_IDEA_FILE=/path/to/original-prompt.txt
node .skill/scripts/start-linux.mjs &&
npm install --prefix "projects/$JBM_FILM_SLUG/.engine" --omit=dev --bin-links=false &&
cd "projects/$JBM_FILM_SLUG" &&
export TMPDIR="$PWD/out/.tmp/"
```

脚本在写入前检查Node24、slug、theme和原文，创建独立引擎源码、七篇guide、easing/random组件、品牌快照、manual-0.1工作区和3秒无声占位，依赖采用来源manifest版本。Linux字体及许可按根README恢复到.engine/assets/fonts，尤其LXGWWenKai；安装完成保留本片package-lock并登记实际运行时：

```bash
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { digest, fileHashes } from './.engine/workspace.mjs';
const w = JSON.parse(readFileSync('workspace.json', 'utf8')), files = fileHashes('.engine');
w.engineSha256 = digest(JSON.stringify(files));
writeFileSync('evidence/runtime-files.json', JSON.stringify(files, null, 2) + '\n');
writeFileSync('workspace.json', JSON.stringify(w, null, 2) + '\n');
JS
```

brand.theme为已选主题，defaultTheme为当时账号推荐，changes记录初始化；选择依据另保存原文。每次恢复/执行/交付前核验，变化先明确迁移范围并留旧证据：

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertIndependentTree, digest, fileHashes } from './.engine/workspace.mjs';
const w = JSON.parse(readFileSync('workspace.json', 'utf8'));
assert.equal(w.mode, 'manual-linux'); assertIndependentTree('.');
assert.equal(digest(JSON.stringify(fileHashes('.engine'))), w.engineSha256);
assert.equal(digest(readFileSync('brand.json')), w.brand.sha256);
JS
```

修改前等待本片命令结束，在项目根归档完整项目到独立备份目录：

```bash
(
set -eu
test -f workspace.json
test -f project.json
JBM_PROJECT_DIR="$(pwd -P)"
JBM_PROJECT_NAME="$(basename "$JBM_PROJECT_DIR")"
JBM_BACKUP_ROOT="$(dirname "$JBM_PROJECT_DIR")/.backups/$JBM_PROJECT_NAME"
mkdir -p "$JBM_BACKUP_ROOT"
JBM_SNAPSHOT_DIR="$(mktemp -d "$JBM_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
tar -czf "$JBM_SNAPSHOT_DIR/project.tar.gz" -C "$(dirname "$JBM_PROJECT_DIR")" "$JBM_PROJECT_NAME"
tar -tzf "$JBM_SNAPSHOT_DIR/project.tar.gz" > /dev/null
printf '%s\n' "$JBM_SNAPSHOT_DIR/project.tar.gz"
)
```

恢复解压到空目录再核验。执行前缀为`node .engine/src/cli/index.ts <command> "$PWD"`，prompt追加原文，env --out-dir out --json、validate、brief validate、project audit、frame --at 1逐项运行；初始占位以render --no-audio --no-network试片。普通render需配置旁白/BGM/SFX，有意无声继续--no-audio。更新spec/brief/源码后跑qa、render、artifact --out evidence/artifact.json、disclosure，输出与日志都留本片，NOTES记录Asia/Shanghai渲染时间。辅助脚本为node .engine/scripts/<脚本>，自定义validateSpec显式传入loadBrand(本片brand路径)。
