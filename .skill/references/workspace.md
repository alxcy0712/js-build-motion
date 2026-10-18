# 项目布局与隔离

macOS 封存制作入口为node .skill/scripts/video.mjs；每次调用验证并备份核心，.skill-backups/保留最近两份成功快照。新片按[创作问答](intake.md)取得本片主题选择，再用 `start --theme` 创建projects/<slug>/；剩余重要选择完成后进入制作，后续命令指定已有影片。Linux 团队按根 AGENTS.md 的手建流程保存独立运行时、brand.json、manual-0.1 工作区及沟通原文，并使用本片引擎 CLI；该流程的校验范围与平台适用边界以对应条款为准。

## 生成区的外部依赖约束

projects/及其中的.maintenance/记录均属于可随时删除的生成区。禁止区外代码或文件将其中的具体文件作为模块导入、必需的文件输入、配置或资源路径、符号链接或硬链接目标、文档链接依赖。通用代码、方法、模板与测试夹具在对应权威位置独立保存；提炼后的能力与验证继续保持自包含。

制作入口按显式指定的slug创建或操作本片，复盘按明确授权读取指定证据，这些访问属于本次操作的输入。核心校验、测试和新片初始化须支持projects/缺失或清空；测试自行生成虚构夹具，仓库运行独立于已有影片与维护记录。

维护时运行node .skill/scripts/check.mjs --standalone：在独立空目录中仅复制完整.skill/，禁止引擎、初始化入口及其工作进程读取原工作区projects/，依次验证全量引擎测试、新片初始化和填写契约查询。进程退出测试通过系统ps查询本次受控子进程的状态。目录在检查前保持projects/缺失；首次初始化自行建立生成区。文案、标题、素材目录与视频加稿件使用各自输入契约，共用创作、素材、时间线与交付流程；题材和工具组合由当前任务决定。虚构输入与临时运行时在验证结束后清理，保留检查结果与采用的核心身份。

```text
projects/<slug>/
  project.json          manifest：entry、brief、outDir、drawing、可选director
  prompt-history.jsonl  用户原始prompt、后续要求与问答
  inputs/              本片原件、导入政策与接收身份
    import-policy.json 本片导入限额配置
    original/<importId>/  每批独立原件副本
    imports/<importId>/manifest.json  固定接收清单
    import.json        已提交批次索引与当前 importId
    unpack-policy.json 本片展开限额配置
    unpacked/<unpackId>/  独立的一层展开结果
    unpacks/<unpackId>/manifest.json  固定展开清单与父原件身份
    unpack.json        已提交展开版本索引与当前 unpackId
  director.json         导演计划
  brief.json            交付、输入、工具、声明与验收
  brand.json            本片主题快照（theme/defaultTheme/changes，记录显式参数或默认继承）
  NOTES.md              设计、事实、参考用途与skill学习状态
  src/                  本片代码与组件副本
  assets/               制作素材与授权输入
    asset-plan.json     镜头素材需求与固定版本选择
    derived/audio/      有哈希的定稿声音包
    derived/video/      成功回执绑定的定位图、交付 RGBA、预览代理与选段原声
  evidence/             events.md事件计划、artifact.json成片身份、review.md审片与参考记录
  runs/                 每次制作的输入或政策快照、执行记录、receipt、asset-usage 与写锁
  out/                  成片与中间产物
    renders/            按 attemptId 保存的独立渲染产物
  guide/                初始化时的规范快照
  .engine/              固定运行时与依赖
  workspace.json        核心版本、隔离与组件配置
  video.mjs / exec.mjs   本片命令入口
  AGENTS.md             本片指引
```

manifest中的路径相对本片，slug与目录名一致；drawing使用src/内的同步模块。输入、源码与输出使用普通独立文件。所需组件从核心唯一源码复制到本片，easing/random默认复制，camera依赖easing。

start 把账号默认风格（`.skill/brand.json`）与本片选择写入本片根目录的 `brand.json` 快照，同时在 `workspace.json.brand` 固定生效风格与快照哈希；校验与渲染读本片快照，运行时核对快照未被改动，项目进程的沙箱保护其写访问。账号默认只在用户要求时修改，供后续新项目继承；已有影片继续使用各自初始化时的运行时与配置。

## 影片制作文件边界

影片制作生成的文件放在对应的projects/<slug>/：图片及所有候选版本、参考下载、三维模型与纹理放assets/；代码与依赖副本放src/；分镜、截图、审片与工具记录放evidence/；成片、音频、帧序列和临时文件放out/，影片制作工具的临时目录使用本片out/.tmp/。生成前指定对应影片项目内的路径，收到固定宿主位置的工具结果后按[素材选择](assets.md)立即迁入本片，再登记和引用。

新片原文用start的--idea直接传入；--idea-file可读取用户已提供的输入文件。初始化后的prompt中转文件放在本片，--file使用本片相对路径，原文入库后清理。共享核心的备份和检查按[核心维护](maintenance.md)使用既有位置。

## 沟通原文

prompt-history.jsonl是沟通记录的唯一保存位置。每行含timestamp（UTC ISO记录时间）、kind（prompt/question/answer）和text原文。主题确定后，start保存首次制作prompt；随即按对话发生顺序追加初始化前的补充、问题和答案，后续沟通继续逐条追加，保留措辞、换行与链接。初始化前的原文从当前对话读取；记录时间由命令生成，若需要原始发言时间，在NOTES.md注明可核实的对话时间。模型假设和设计决定写入NOTES.md。

```bash
node .skill/scripts/video.mjs start <slug> --idea "用户原文" --theme <minimal|kinetic>
node .skill/scripts/video.mjs <slug> prompt --kind prompt --text "用户本轮原文"
node .skill/scripts/video.mjs <slug> prompt --kind question --text "模型问题原文"
node .skill/scripts/video.mjs <slug> prompt --kind answer --text "用户答复原文"
```

多行或特殊字符可安全传入--idea和--text；文件读取与中转遵守上面的生成文件边界。assets/保存制作素材，沟通原文统一进入prompt-history。已有记录保持追加；早期运行时可通过宿主文件工具按同格式保存。

## 原件入库

用户选定一个普通文件或目录后，通过本片固定运行时复制原件并保存接收身份：

```bash
node .skill/scripts/video.mjs <slug> import --source "/path/to/selected input"
node .skill/scripts/video.mjs <slug> import --verify <importId>
node .skill/scripts/video.mjs <slug> import --schema manifest
```

根入口的相对来源路径按调用时的工作目录解析；本片 video.mjs 的相对来源路径按本片目录解析。源文件保持原位置和内容。目录保留相对结构及空目录，单文件保留文件名，每次成功导入保存一个新批次。ImportManifest 是接收身份权威，后续素材目录通过 importId 和清单条目引用原件。后续消费使用本片副本，清单中的源路径用于来源证据。

首次导入生成本片 inputs/import-policy.json，默认上限为单文件 1 GiB、总计 4 GiB、5000 个文件、目录深度 16。调整本片配置后发起新导入；每次执行将配置原字节快照 import-policy.source.json、解析快照 import-policy.json、实际采用值、摘要及计数保存到 runs/<attemptId>/，结果回执为其中的 receipt.json。配置解析失败时保留可读取的原字节与失败原因。流式复制核对实际字节和 SHA-256，完整校验后原子更新 inputs/import.json。旧批次继续保留；失败或中断留下回执、已接收条目和原因，临时副本保存在 out/.tmp/import-<attemptId>/。

来源与目标使用真实路径和普通独立文件；软链接、硬链接、特殊文件、规范化后的名称碰撞、超限和可检测的源变化会拒绝本批。源路径祖先中的软链接也适用这一规则，系统临时目录可使用 /private/tmp 等物理路径。导入命令在独立的离线沙箱中读取本片与本次选定来源，继续保护共享核心和其他影片。用户对来源的授权及系统的实际读取权限分别满足；命令参数只指定来源范围。硬终止后的 running/prepared 回执保留现场，下一次导入根据已提交索引恢复为成功或中断。

本入口提供原件字节入库。ZIP 在此作为一个普通文件接收；一层展开通过下述独立命令执行。文档语义、媒体测量、许可判断与素材消费对账按各自用例继续接入。已有影片沿用初始化时的运行时；导入和展开命令以本片版本能力为准。

## 已入库 ZIP 显式展开

先完成原件入库，再用 importId 和父清单内的相对路径选择本片副本：

```bash
node .skill/scripts/video.mjs <slug> unpack --import <importId> --path <archive-relative-path>
node .skill/scripts/video.mjs <slug> unpack --verify <unpackId>
node .skill/scripts/video.mjs <slug> unpack --schema manifest
```

每次展开生成独立 unpackId 和 unpack-attempt 身份。清单保存父 importId、父清单 SHA-256、ZIP 路径、原件字节数及 SHA-256、解析器版本、原始名称字节和解码路径、采用的 NFC 路径、逐文件长度、CRC32 和 SHA-256。嵌套压缩包作为普通字节文件保留。普通单卷 ZIP/ZIP64、Stored/Deflate、普通文件、空文件和目录、UTF-8、CP437 与有效的 Unicode 路径扩展构成本入口范围。加密包、分卷、其他压缩方法、声明的链接、特殊或类型不明对象形成失败回执。

首次展开生成 inputs/unpack-policy.json。默认限额为原 ZIP 和单个展开文件各 1 GiB、总展开量 4 GiB、归档条目与生成节点各 5000、目录深度 16、单文件和批次展开/压缩字节比 200:1、元数据 16 MiB、规划到提交前检查共 5 分钟。文件深度使用父目录深度，目录深度使用自身深度；生成节点包含隐式父目录，显式目录与同名隐式父目录合为一个节点。零压缩字节容许零展开字节。元数据预算在读取可变名称、注释、扩展字段之前准入，并计入 ZIP64 扩展区。高重复内容可按本片需求调整压缩比；原字节配置、采用配置和各自 SHA-256 保存到 runs/<attemptId>/unpack-policy.{source,adopted}.json。

路径检查覆盖原始和采用名称、越界、不安全路径段、盘符、反斜杠、控制字符、重复声明、规范化、大小写和文件目录前缀冲突。中央目录、局部头、数据描述符、单卷身份、数值范围与成员范围共同核验；保留结构连续的普通归档，其他结构形成回执。归档权限和身份只用于类型检查，输出使用本片创建策略。隐藏成员和空目录同样登记。

逐条解析与受控流式写入独立累计实际压缩输入、展开输出和生成节点；plannedNodes 保存规划节点，expandedNodes 保存实际创建节点。输出字节在写入前检查限额。全部内容、父原件和目录复查通过后原子更新 inputs/unpack.json。失败保留原件、旧索引、回执与本次现场 out/.tmp/unpack-<attemptId>/；已移动但索引提交前失败的版本继续作为未发布现场保存。锁位于 runs/unpack.lock/，接收与展开各自恢复自己的回执。强制终止后的下一次展开复测现存输出字节与节点，压缩和元数据计数保留最后一次已保存观察；已提交索引决定恢复为成功。receipt.json 记录完整执行耗时，manifest 记录制作清单时的资源快照。

统一入口及后代进程使用离线、最小环境的本片沙箱，原 ZIP、接收清单和接收索引保持只读。展开结果复查核对固定清单、政策快照、父原件和全部成员，发现缺失、改动、链接或清单外对象即失败。

## 版本与执行

NOTES.md中的skill学习状态按[核心维护](maintenance.md)记录。learned标记包含证据、已吸收改进与对应核心版本；制作与试听的验收状态继续写入evidence/review.md。

统一入口将命令交给本片video.mjs/exec.mjs。系统沙箱覆盖其进程及后代，写入限定本片，.engine/只读；核心、备份和其他影片保持内容隔离。宿主编辑器与文件工具使用宿主权限，并按任务边界访问。

manifest校验核心，workspace.json固定本片初始化版本与隔离配置。已有影片继续使用原运行时，新片使用升级后的核心。run.json记录运行时、源码及prompt-history的哈希和条目数；渲染期间源码保持稳定。后续追加沟通记录保留渲染时的历史快照。

声音锁、渲染 attempt、当前 run 与便捷输出副本按[音视频与验收](execution.md#成片身份与证据绑定)使用；具体命令以本片固定运行时为准。

evidence/events.md连接导演承诺、素材、动作、声音和主片时间码；evidence/artifact.json绑定实际编码与运行记录。按[音视频流程](execution.md)生成和复核身份快照，按[成片质量](quality.md)填写视听范围。每轮检查报告保存自己的输入身份，历史证据继续标明适用版本。

## 素材目录与可定位记录

已提交原件和展开成员通过 `catalog --import <importId>` 或 `catalog --unpack <unpackId>` 登记；`--path <条目路径>` 选择一个普通文件。每次登记生成独立目录修订；相同固定来源复用素材 ID 与内容版本。替换来源使用新入库/展开身份，通过 `--path <条目> --asset <assetId>` 建立新内容版本。`assets/catalog.json` 指向当前修订与素材版本；`assets/catalogs/<catalogId>/manifest.json` 保存该修订的全部素材版本、技术结果、观察与权利，旧修订和派生证据保留。每个内容版本引用最初探测目录、运行身份与政策快照哈希；后续批次调整准入限额时，既有版本按原探测政策复查。

首批适配 UTF-8 MD/TXT、PNG/JPEG、WAV/MP3/FLAC/M4A、MP4/MOV/WebM。格式路由使用字节签名和固定 demuxer。ZIP 登记显式展开待办；PDF 原生文本与 DOCX 正文使用下述文档契约。PNG/JPEG OCR 使用下述单图契约；转写、词级对齐、其他 Office 格式与连续视频代理按后续契约扩展。文本证据保留 BOM、行尾与原始 UTF-8 字节。图像预览记录实际像素尺寸、源尺寸及缩放映射，自动旋转关闭。视频帧记录流索引、原时间基准、整数 PTS、请求时间和实际时间；已知流时长取起点、中点与接近终点的有限目标，缺失时长只取已知位置。音频保存首音轨原采样率的单声道 s16le PCM 证据和实际样本数；完整、局部与抽样覆盖单独登记，容器时长保留原字段。

`inputs/inspect-policy.json` 控制文件数、源/文本/目录字节、媒体流数、像素、工具日志、派生输出、PCM 输出、视频样本数、预览边长与逐工具/全批时间。`catalog --schema policy` 查询默认值与闭合契约。原始和采用政策保存在 `runs/<attemptId>/inspect-policy.{source,adopted}.json`。回执的 sourceReadBytes 统计受限 Node 描述符读取与签名窗口，工具内部和复制适配器的读取量保留未测口径。回执登记可观测读取/输出数量、固定 argv、工具版本、退出码与失败原因；目录元数据在逐项累积时执行准入，超限失败回执保留测量计数并注明省略的逐项细节。媒体工具使用格式/协议白名单、本片临时目录、最小环境和离线沙箱，FFmpeg 单次分配上限与预览像素准入分别记录；全进程内存仍受宿主条件约束。

模型实际读取、观看或试听固定证据后，通过 `catalog --observation <本片JSON>` 写入可定位观察。`catalog --schema observation` 查询必填字段：素材 ID、内容版本、字节哈希、方法、定位、覆盖、判断、依据、置信度、局限与证据引用。文本使用 UTF-8 字节半开区间和行号；图片/视频定位到证据像素区域；视频附实际 PTS；音频使用原采样率样本半开区间。抽样帧观察保留 sample 覆盖，程序校验结构、引用和范围，实际内容判断由观察依据支持。技术、语义匹配、构图适配、连续性和权利范围保留各自状态。

`catalog --rights <本片JSON>` 增补权利记录，`catalog --schema rights` 查询结构。unknown 保留未知状态；user-declared 引用本片 prompt/answer 原文，程序冻结实际 prompt-history 快照；documented 绑定已登记许可证据的路径、哈希和原文片段。每条记录包含用途、限制、署名、视频/音频流适用范围和第三方权利状态；同一记录 ID 按 revision 递增，素材版本与记录修订各自固定。观察/权利提交的原始 JSON 保存在本次运行快照。

`catalog --verify <catalogId>` 复查提交索引、清单哈希、固定父来源及实际字节、政策快照、派生证据和目录中的观察/权利定位。受限解析失败作为单项状态提交；来源身份变化、权威记录损坏、全批输出限额、取消或发布故障保留旧索引。目录使用独立租约和回执；下一次调用依据已验证提交索引恢复成功，未提交且已停止的运行恢复 interrupted。中断回执中的读取与工具计数保留最后一次持久化观察。WebM 使用 EBML DocType 准入。大量固定证据的沙箱规则通过本片临时配置文件传入，调用结束后清理。已提交证据在目录沙箱内只读；新修订验证后通过原子索引发布。

## 文档原生文本与定位图

新 catalog/index/receipt 与 inspect policy 写入封闭 0.3；历史 0.1、0.2 目录和政策、普通观察与权利记录按原契约读取和继承。原始政策字节和有效政策摘要各自保存；历史 0.2 adoption 保持其冻结文档默认值，新运行采用冻结的 0.3 文档与 OCR 默认值。已有影片继续使用初始化时的固定运行时。升级历史 unsupported 文档记录时，从原选外部来源重新 import，再通过 `catalog --import <新importId> --path <条目> --asset <旧assetId>` 建立修订。

PDF 按签名读取，原生文本顺序遵循 PDF.js 文本项输出，每页一个单位；扫描页与空页登记原生文本为空，视觉内容和阅读顺序保留覆盖局限。PK 签名和 `.docx` 名称共同触发普通 Word OPC 包校验，正文固定为 `word/document.xml`；解析主体段落和基础表格单元格，保留空段落和结构序号。DOCX 分页未知，未读 part、复杂修订、兼容分支、图像、文本框和未计算字段等进入遗漏清单。XML 接受 UTF-8 和 BOM UTF-16；预定义实体和合法数字引用正常解析，DTD/自定义实体、宏、异常路径或外部主关系触发拒绝。

成功或合法 partial 提取保存固定 UTF-8 text 和 `document-map` JSON 两份证据。`catalog --schema document-map` 查询 map 契约，map 绑定原件字节/hash、parser/version、有效政策 hash、文本 bytes/hash、单位顺序和 UTF-8 半开区间；PDF 定位为实际页码，DOCX 定位为 namespace 已识别的 part/结构路径。完整单位之间使用 LF，失败或 skipped 单位保留原因和空范围。

`catalog --schema observation` 同时提供历史观察和 `DocumentObservation@0.2`。文档观察指定 `locator.kind=document`、text/map evidence ID、unitId 与派生文本内的字节范围，以及 `coverageScope=unit-native-text`。full 表示一个实际完成单位的全部原生文本范围；整篇 partial 可包含完整单位。语义判断与权利声明各自显式提交。

`policy.document` 默认限额为源 32 MiB、每批文档 20、PDF 200 页、单位 20,000、文本 8 MiB、map 4 MiB、payload 32 MiB；DOCX 条目 2,000、声明展开总量 64 MiB、XML 单 part 8 MiB/实际总量 32 MiB、路径深度 16、XML 深度 64/节点 200,000、单项和总压缩比 200:1。数值可在闭合政策内收紧，上限允许等于；文本同时接受通用 maxTextBytes 的较小值。完整前缀可在页/单位/文本限额下形成 partial，map/包结构限额产生单项 failed。每批候选数、通用来源/累计派生配额和身份变化导致全批失败，旧有效索引保留。

每文档单独串行 Node worker，固定 executable/argv、最小环境、离线 catalog 沙箱和本片临时目录；stdout 为独立限额的完整 JSON payload，诊断经 stderr 计入工具配额。单工具时间接受 30 秒与通用政策的较小值，诊断接受 1 MiB 与通用政策的较小值。V8 old-space 最多 512 MiB，实际峰值 maxRSSKiB 保存到 map；全进程硬 RSS 与库内部 IO 各自保留未测口径。父进程验证完整协议与身份后发布 text/map；超时、退出、截断或协议错误登记单项 failed。

## 单图 OCR 与词区域

PNG/JPEG 按字节签名路由，在通用 probe/preview 后执行单图 OCR。静态 PNG 接受合法的至多 8 位灰度、RGB、palette、tRNS/alpha 和 Adam7；APNG、16 位和坏 chunk/CRC 拒绝 OCR。JPEG 接受单个 8 位 SOF0/SOF2、1 或 3 组件；CMYK/YCCK、其他 SOF、MPF/MPO 与拼接多图拒绝 OCR。格式范围或局部配额形成 skipped；native 工具/身份、超时或 TSV 协议故障形成 failed。有效预览保留，技术结果登记 partial；通用图像探测失败继续保留 failed。显式设置 policy.ocr.enabled=false 保存 disabled 事实与正常预览。

OCR 固定单帧 RGBA 解码，保持编码像素方向、源尺寸和奇数边长，EXIF 方向 1–8 均按该规则处理。每个通道使用整数白底合成 floor((channel×alpha + 255×(255−alpha) + 127)/255)，生成固定 P6 RGB8 栅格。源和 OCR 栅格坐标为 1:1；预览按自己的缩放映射定位。Tesseract 固定语言 chi_sim+eng+~chi_sim_vert、LSTM OEM 1、PSM 3、DPI 300、单线程和完整 TSV 输出，读取本片封装的语言文件；进程及后代沿用离线、最小环境和本片临时目录。

完整输出保存 ocr-raster (.ppm)、ocr-tsv (.txt)、规范 text (.txt) 和 ocr-map (.json) 四份证据。catalog --schema ocr-map 查询闭合契约。定位图绑定 source/policy/raster/TSV/text/engine/model 字节身份。合法非空 level=5 词按 TSV 返回次序保留；同一 line 之间插入一个 ASCII 空格，不同 line 之间插入 LF，末尾保持词的末字节。每个词区域保存层级、行序号、整数像素框、原始 0–100 引擎分值（固定 −1 sentinel 转 null）及 UTF-8 半开区间。低分词保留；合法无词 TSV 保存 no-text、零字节 text 与空 regions。

OcrObservation@0.3 使用 locator.kind=ocr、text/map/raster evidence ID、regionId 与 byteStart/byteEnd，coverageScope=region-ocr-text。full 覆盖该词全部文本；partial/sample 限定在同一词内并满足 UTF-8 边界。观察者 confidence 保持 0–1。OCR 文本观察由词区域契约验证，普通 image 观察继续定位预览。verify 重读固定四证据、验证 PPM header/长度并重新解析 TSV，比对规范文本、区域、源尺寸、政策、引擎与描述符。

policy.ocr 可收紧的默认上限：源 32 MiB、每批图片 20、源像素 16,000,000、边长 8,192、PPM 48,000,128 字节、TSV 8 MiB、数据行 100,000、词区域 20,000、文本 2 MiB、map 4 MiB、格式结构项 4,096、单词 4,096 字节、单行 16,384 字节，concurrency 固定 1。通用限额的较小值持续生效。批次计数先于同源去重；累计派生/目录/时间配额、来源变化、取消及发布故障保留旧 index。失败已接收的有界工具输出计入回执，完整四件套验证后进入固定证据。中断恢复沿用目录租约与提交索引契约，重新执行使用新 attempt。

封装模型和锁文件由 verifyRuntime 在入口执行前核验；宿主 native 可用性、物理文件与逻辑动态库别名由固定依赖锁复核。语言模型随 seal、备份与新片 .engine 快照保存；共享源码恢复依据根 README 的固定发行与 SHA-256。已有图像版本沿用原事实，需要 OCR 时从原外部来源重新 import，再用 --path 与 --asset 建立新版本。整个进程硬 RSS 和库内部 IO 继续保留未测口径。

## 有界 WAV ASR 与段级建议稿

catalog/policy 新写 0.4，读取 0.1/0.2/0.3/0.4。默认 asr.enabled=false；项目 inputs/inspect-policy.json 显式启用 asr 并选择 zh 或 en。首版接受 RIFF WAVE PCM16、单声道或双声道、8–48 kHz、0.2–120 秒与64 MiB，每批来源去重后最多4个新 WAV。原率单声道 PCM 完整检查后规范化为16 kHz单声道 WAV；原始 JSON、text、segment map 与 canonical WAV 一起发布，verify 重放原始 JSON。

ASR 时间按10 ms网格换算为整数样本，UTF-8原文按字节定位。observation 0.4 使用 kind=asr、segment-asr-text、estimated/unknown 与 null confidence；full 表示一个已选择段的完整文字。原0.1 audio观察继续引用原率PCM，登记实际听音样本。转写、源语音存在、内容准确度和听音各有独立证据。

程序与模型采用 engine-relative 逻辑身份，运行前后及提交前核验固定文件。程序使用已有stdout流输出有界JSON，cwd为全新私有空目录；native收到唯一canonical WAV的绝对路径。局部转写拒绝保留基础结果和已消费计数，基础supported变partial；累计quota、批量截止、身份变化及取消维持旧有效index。获取与恢复方法及公开归因见根README，运行时保留完整依赖与许可。

## 有界常见音频容器

`inputs/inspect-policy.json` 显式采用完整 `INSPECT_POLICY_05` 对象启用通用音频证据。`catalog --schema policy` 查询闭合结构；默认政策保持 0.4。0.5 对 WAV、MP3、FLAC 字节签名和 `.m4a` 输入执行有界容器检查，随后保存唯一一组 probe、原率单声道 audio-pcm、16 kHz单声道 audio-canonical 和 audio-input-map。每批来源去重后最多4个新音频，单源64 MiB，单/双声道8–48 kHz，完整解码帧域的时长等效0.2–120秒。

WAV 接受完整 RIFF PCM16；FLAC 接受 PCM16、正 STREAMINFO 样本数和有界元数据，检查逐帧头部 CRC、帧 CRC、序列和全部音频字节。MP3 接受固定 MPEG LayerIII 版本/采样率/声道、普通 ID3v2.3/2.4 和完整可选 ID3v1、首帧 Xing/Info；逐帧核对大小和完整尾部，登记元数据帧以及原始 delay/padding。M4A 接受单个 ftyp/moov/mdat、单音轨 AAC-LC、完整采样表、自包含数据引用和空或一个 rate=1 常规编辑；核对每个包恰好覆盖唯一 mdat，登记编辑事实。外部引用、多音轨、片段、加密、其他编码形态、截断和配额超限保留明确失败或跳过事实。

样本范围定义为 `complete-decoded-frames`。MP3 采用完整编码帧解码，M4A 采用完整采样表解码；delay/padding 与 edit 单独保存，`presentationMapping=unknown`。原率 PCM 的样本数必须等于结构事实，规范波形保存整数样本数、payload 字节数与 SHA-256。结构条目最多32768，包最多12000，原率单声道 PCM最多11520000 B，规范 WAV最多3840044 B，图最多4 MiB，单工具30秒，串行执行；本片政策可下调最大值。

`verify` 重读完整原件和固定四证据，复查政策、原件哈希、封闭结构、全部 probe 包边界、工具物理闭包与三个原始 ToolRun/cwd，再从原件重新解码和规范化，逐字节比对 PCM/WAV。临时重放归本片 `out/.tmp/`，退出时清理。ASR 关闭时这组证据照常可用；ASR 启用时 `.2` 转写复用同一规范 WAV，追加 raw JSON/text/map，`.5` ASR 观察维持 estimated/unknown 与 null confidence。通用音频覆盖、容器呈现时长、语音文本、识别准确度和听音状态各自登记。

新 catalog/receipt/index 按当前政策与历史最高版本写入 0.4 或 0.5，素材复查沿用原始 inspection 政策。历史 0.1–0.4 与 ASR map 0.1 保持原契约；已提交 0.5 证据在后续 0.4 政策运行中继续继承和复查。

## 扫描 PDF 与 DOCX 嵌图 OCR

`inputs/inspect-policy.json` 显式采用完整 `INSPECT_POLICY_06` 并设置 `documentOcr.enabled=true`。`pdfPages` 与 `docxImages` 分别为升序、唯一的 1 起始页码/图片出现序号；两组选择各自应用于本次选中的同类文档，使用 `catalog --import <importId> --path <条目>` 选择具体文件。默认政策为0.4，0.6文档OCR默认disabled；空选择保存skipped。0.6同原件的有效政策变化会建立同assetId的新assetVersion，各历史版本的政策、观察和权利继续保留。

PDF 接受1.0–1.7、无加密、单次修订的classic xref；逐对象核对offset/generation/stream Length、完整源extent、字典键、内部引用和页树归属。名称先解码 `#xx`。外部stream/file/action、XFA、object/xref stream、增量链、inline图像、JPX/JBIG2与结构降级形成明确失败。流接受raw、单层Flate与Image DCT，检查实际完整解压、图像字节/尺寸和累计像素；渲染警告和解码错误形成失败。选页采用固定CropBox、固有Rotate、UserUnit、72/150/300 DPI与 `ceil(viewport)` 尺寸，白底P6/RGB8、annotations关闭；定位保存viewBox、scale和六项坐标变换。其scope为`selected-pdf-page-pixels`。

DOCX 接受普通Word Transitional OPC，完整准入并解压全部ZIP entry核对CRC。主正文段落/基础表格中的DrawingML inline/anchor按出现顺序分配序号，通过mainPart、structurePath、relationshipsPart、relationshipId、embeddedPart及其字节/SHA/CRC绑定PNG/JPEG。相同part的多次出现各有独立定位。main图像关系为规范Internal且目标/内容类型/签名闭合；外部/linked/歧义关系、越界或别名target、宏和异常包结构形成失败。栅格沿用单图静态PNG/JPEG、编码方向和整数白底规则。scope为`selected-docx-embedded-source-pixels`；页眉页脚等其他part内容与Word分页、crop/rotate/scale/叠层显示保持未知。

每个完成或no-text单位保存`document-ocr-raster`、`document-ocr-tsv`、`document-ocr-text`、`document-ocr-map`四项。独立`document-ocr-selection-map`绑定固定容器、原始政策/运行时、明确选择、总单位数、完成单位、失败原因及nativeStatus；原生text/document-map两项按nativeStatus复查。每个已选单位引用`runs/<attempt>/`中的封闭命令记录及其bytes/SHA，记录原始request、有限worker结果、worker/decode/OCR ToolRun和cwd。失败单位保留实测总数和原始命令事实；disabled与空选择保存descriptor并保持附加证据为空。

`catalog --schema document-ocr-map` 与 `document-ocr-selection-map` 查询封闭结构。观察0.6使用kind=document-ocr、unitId/regionId、text/map/selection-map/raster IDs及UTF-8半开区间，coverageScope=region-ocr-text；full指该词的完整OCR文本字节。识别分数、观察者confidence、选择范围和整个文档视觉内容各自记录。固定语言/OEM/PSM/TSV协议沿用单图OCR。

`verify` 从固定容器重新提取/渲染所选单位，核对完整locator和每个P6字节，再重放TSV/text/regions；原始命令按inspection origin的政策、来源和私有路径约定验证。历史cwd/argv作为原始数据保存，迁根重放解析当前路径。运行时绑定相对有序的独立源码/依赖/资源文件与实际Node物理文件，生成区与无关模型/测试排除；OCR工具及语言文件独立核验。重放临时文件归本片out/.tmp并在退出后清理。

单源32MiB、每源/每批各4单位、单单位1600万像素/边长8192/PPM48000128B、每批3200万像素；嵌图每项8MiB/每批16MiB。PDF最多200页/20000对象/200000结构token/深度64/解压流64MiB；DOCX图片出现最多20000，ZIP/XML限额沿document政策。canvas live最多3200万像素、累计分配6400万像素，固定运行时资源读取16MiB；单worker Node old-space512MiB/30秒/JSON payload64MiB，串行运行；map各4MiB，TSV/text/词数等按嵌套documentOcr.ocr限额。单单位准入/识别失败可形成partial选择映射；来源/运行时变化、取消、累计单位/像素/嵌图/通用派生配额及发布故障导致全批回滚并保留旧索引。渲染运行时身份固定本片独立代码、依赖和资源，以及Node初始加载的非System物理执行文件与动态库；System库作为宿主条件登记。硬RSS、库内部IO、跨宿主像素稳定性和识别准确度保留实测范围。

新catalog/receipt/index保留已提交最高版本0.6；后续0.4/0.5政策可继续继承0.6记录，逐素材复查其原始政策。历史0.1–0.5目录、原生文档、单图OCR、ASR和音频证据继续使用各自冻结契约。

## PPTX 与 XLSX 原生文本

`inputs/inspect-policy.json` 显式采用完整 `INSPECT_POLICY_07` 时，PPTX/XLSX 路由进入文档 worker；默认 0.4 和历史 0.1–0.6 保留其采用身份与 ZIP 路由。`catalog --schema policy` 查询 office 与 document 的有限资源上限，既有 OCR/ASR/音频/文档 OCR 字段继续使用原语义。目录、索引和回执继承最高已提交版本，逐素材复查最初政策。

Office 文档 request/result/map 使用 0.2。PPTX 按 presentation 关系顺序提取 slide 段落、基础表格与 notes 的正文占位符；XLSX 按 workbook 顺序提取 shared/inline/rich 字符串、单元格值、缓存公式结果与基础表格元数据。缓存公式的计算正确性与版面重建各自保留待核验。定位图绑定 part、namespace 结构路径、幻灯片序号或 sheet/cell/range 与固定 UTF-8 半开区间。

worker 对完整 ZIP 包做 CRC 和有限解压，按已解释的 XML/关系部件提取内容，拒绝宏、DTD、路径逃逸与已解释关系中的外部目标。其余部件和关系保存 omitted/partial；全包外部引用审计保留 unknown。原件与历史目录保持固定；text/map/source 任意字节变化均在 verify 中拒绝。

## 有界视频准备

```bash
node .skill/scripts/video.mjs <slug> video --schema request
node .skill/scripts/video.mjs <slug> video --request inputs/video-request.json
node .skill/scripts/video.mjs <slug> video --verify assets/derived/video/<uuid>/map.json
node .skill/scripts/video.mjs <slug> video --recover
```

请求绑定已提交目录的准确 catalog/manifest/asset/version/原件哈希，选择一个 streamIndex 和整数 PTS 半开区间，并声明原 timeBase 与目标 fps。接受自包含普通 MP4/MOV、单路 H.264/yuv420p/SDR、零旋转和可选 AAC 原声。完整 atom/sample/chunk/PTS/mdat 与 data reference 检查在实际解码前准入，固定 FFmpeg/ffprobe 使用封装的物理闭包与离线环境。目录探测、识别证据和正式选段分别采用自己的资源政策。

历史 0.1 全原件帧受限解码并保存整数 PTS/独立 RGBA 哈希；规范帧按原区间起点的有理时间使用前帧保持，末帧未知时长继续为 null，区间上界沿已知呈现域准入。输出为 `assets/derived/video/<uuid>/{map.json,frames.rgba,proxy.mp4,publication.json}`。map 保存来源、政策、依赖、全部源帧与选用帧映射、实际四种命令；复查重建 RGBA 与静音代理、完整解码代理，逐字节比对固定数据。

`video --schema limits` 查询契约。历史 0.1 冻结默认源64 MiB、600帧、8294400像素、10秒，代理最长边512、600帧、RGBA256 MiB、代理32 MiB、probe/map各8 MiB、结构项50000、单工具30秒、总准备120秒，已有成果继续按该政策复查。

生产请求采用 0.2，`output.width/height` 同为 null 时保留原件像素，也可明确选择同宽高比的交付尺寸；`mute` 缺省为 false。原件以固定块核验身份，仅加载容器元数据；实际解码覆盖选段所需的前置保持帧与连续源帧，规范 RGBA 逐帧落盘。AssetPort 按单帧读取并核对独立哈希，预览代理另行等比缩小；正式绘制使用交付 RGBA 的尺寸和像素。map 保存完整来源帧数/可接受呈现域、所选源帧、CFR 映射、预览尺寸、实际工具调用及采用政策。

0.2 在原件存在音轨且选择保留时保存 `source-audio.wav`：48 kHz、双声道 PCM16，样本零点对应同一视频 sourceRange.startPts；源音轨 timeBase/startPts/durationPts 保留在 map，样本数按该半开区间有理长度取整。明确静音与原件无音轨分别记录 muted/absent。剪切、拼接和移动使用同一个 clip placement 驱动画面与原声，原声、旁白、音乐、音效分别混音；当前画面入口对尚未接入原声时间线的选用报告 pending，明确 `mute=true` 可使用画面入口。

生产政策默认源/RGBA各8 GiB、代理/原声各1 GiB、40000000源像素、512预览边长、metadata/map各32 MiB、probe16 MiB、结构项2000000、驻留帧256 MiB、可用磁盘余量256 MiB、单工具300秒和总准备900秒。采用政策通过 `video --request ... --limits inputs/video-resource-policy.json` 或复查时同一参数明确调整；时长和帧数由选段输出/资源预算准入，短片、低分辨率及小文件属于测试夹具预算。预算不足记录所需数量、实际预算/磁盘和具体原因，采用缩短选段、分段处理或有依据的资源调整；RIFF32 原声选段沿容器容量分段。原件与上一成功成果持续保留；完整进程 RSS 和工具内部 IO 按实际测量口径记录。

输出在本次 `out/.tmp/` 准备，独立 video 租约串行发布；publication 绑定准确成功 receipt 字节和 map/request/政策版本身份，成功回执作为提交点。0.2 失败回执同时保留采用资源政策与原因。recover 核对已退出 owner、该次目录与 map 后清理其遗留输出，保存 interrupted 状态。

制作计划选择 map 的准确路径/字节/hash及相同源区间，render 将 publication 和成功回执一并冻结。消费文件/帧身份在 [AssetPlan 与 AssetPort](assets.md#镜头需求版本选择与实际消费) 中对账；被选区间的工程覆盖、最终可见内容、语义适配与权利审批各自保留事实。字节、结构、时间与累计保留像素预算为准入限制，总进程 RSS 与工具内部 IO 保存实际观察范围。

## 有界词与汉字对齐

`align --catalog <catalogId> --asset <assetId> --version <assetVersion> --script <本片JSON>` 选择一个已提交的素材内容版本。独立 alignment 0.1 接受 RIFF PCM16、16 kHz单声道、3200–1920000样本与64 MiB。准入逐字节核对原件 RIFF data、该素材的完整 audio-pcm 和 canonical WAV payload。目录版本沿用自身政策，已有运行时继续固定。

`inputs/alignment-policy.json` 显式采用完整 `ALIGNMENT_POLICY_02` 对象时，对齐消费已完成的通用音频证据。目录的 ASR 可以保持关闭。0.2 原件身份包含容器事实、PCM、canonical 与 audio-input-map 身份；目录完整重放后再核对四证据和原件，将该唯一 canonical 波形提交供应方，提交前复查输入身份。词/汉字定位图和批准稿仍使用0.1；alignment清单/回执采用自身政策版本，索引保留已发布最高版本。默认0.1继续采用原始16 kHz单声道RIFF oracle。

`align --schema script` 提供闭合批准稿结构：version/kind/language/lineId/text 与 approval。approval 记录 scope=word-alignment、user/delegated、decisionId、sourceRef 的本片路径/字节数/SHA-256，以及 subjectSha256。subject 摘要采用 UTF-8 JSON.stringify({version,kind,language,lineId,text}) 的固定字段次序。输入来自 inputs、assets、production 或 prompt-history.jsonl；alignment 索引和自身输出归入保留路径。声明、准确身份和用户授权依据在本片原文中核对，程序验证声明的字节绑定。

原始批准稿、批准来源、canonical WAV、原始完整 token JSON、recognized text、map 和 manifest 保存到 `assets/derived/alignment/<alignmentId>/`。`assets/alignment.json` 原子发布新版本；`runs/<attemptId>/` 保存耐久回执、原始/采用政策和原始 ToolRun/cwd。`align --verify <alignmentId>` 复查固定来源、运行时与七件文件，重新解析 raw JSON 并逐字段重放 map。工作稿后续修改保留已提交快照和旧定位图。`align --recover` 按有效索引恢复已停止的 running/prepared 回执；相邻运行与历史输出受独立租约和只读边界约束。

原稿以 UTF-8 字节半开区间完整分区。ASCII 词和内部直/弯撇号按小写精确匹配，汉字按 Unicode scalar 逐字匹配；标点、空白和其他字符保留 nonlexical/unknown。有界 LCS 的全部最优路径都必须使用同一唯一识别单位，才能写 estimated 时间；歧义、缺失和无效 token 时间保存 unknown/null。多 token 的同一词采用供应方范围包络；同 token 的多个汉字共享范围并登记局限。完整音频提交、完整原稿分区、获得时间的词数和听音状态各自记录，confidence 始终为 null，listening 始终为 unverified。

`inputs/alignment-policy.json` 可下调默认限额，`align --schema policy` 查询闭合契约。默认批准文字32 KiB、批准来源1 MiB、两侧各2048词/汉字、8192原始token、单token文本16 KiB、raw/map各4 MiB、识别文本1 MiB、矩阵4194304格、元数据与派生各16 MiB、有界来源/证据读取256 MiB、工具诊断1 MiB、单工具120秒、全事务180秒，串行执行。矩阵在分配前准入，工具 stdout 作为独立限额 raw payload，stderr 计入诊断。sourceReadBytes 统计 readFixed 及目录回调消费的原件、政策和证据；固定运行时校验与工具内部 IO 各自保留独立口径。派生计数覆盖六件 payload，清单/政策/索引按元数据限额准入；清单保留准备时计数，回执继续累计后续核验与提交的观察。硬 RSS 与跨宿主字节稳定性保留实测范围。真实宿主门禁覆盖中英、原始波形oracle、歧义/空稿、配额、中断恢复、移根和进程后代隔离；听音与识别准确度需本片另行审查。
