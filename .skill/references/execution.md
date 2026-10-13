# 音视频与验收

从根目录使用node .skill/scripts/video.mjs <slug> <command>。按当前项目入口准备spec，常用命令：

```text
env --json
voices
direct compile
brief validate
qa
project audit
audio
audio lock
storyboard --per-shot
frame --at <秒>
render
artifact --out evidence/artifact.json
disclosure
```

env核对宿主、字体和音频工具。旁白使用真实TTS或授权的本片音频。audio生成narration-timing.json，核对逐句完整性、起止、句间空档和尾留；据实测调整文案与镜长，再生成对应规格的音频。关键词时间可驱动画面事件。

audio之后再次运行qa，读取匹配当前规格的实测时间，报告发声占比、逐段空档、平均/最长空档与首尾停留。超过1秒的句间空档和不足0.8秒的尾留提供复核提示，按本片的信息变化、揭幕和阅读用途判定，并在brief.acceptance设定适用目标。时序缺口保留NARRATION_TIMING_PENDING；修改规格后重新audio以更新缓存。

原生VideoSpec可逐句设置audio.narration[].voice与rate（整数百分比，省略为+8%），start决定绝对起点；audio.sfx按绝对秒排程。Edge的voice-*.words.json记录服务音色与实际语速参数。句间空档和句内语速分别核对，语速变化后重新测量关键词与句尾，并更新对应画面。

配音默认选择edge-tts，voice使用female_calm、female_lively、male_calm或male_lively。用户明确声明使用豆包语音后，audio或render显式传入--tts-provider doubao；声明与后续变更保存在本片prompt-history.jsonl，并在其授权范围内沿用。voices提供豆包公版音色的名称、ID、语种、模型资源与接口；启用doubao provider后，导演计划的voice或audio.narration[].voice可使用目录ID，自动匹配资源与流式接口，四个抽象音色映射到对应的默认豆包音色。运行条件为Python/websockets>=14与环境变量DOUBAO_API_KEY。voice-*.words.json保存实际音色ID、模型资源、接口、语速和服务返回的词级时间；服务提供时间戳的范围以对应音色与语种为准。音色调用权限由账户开通的服务决定。

音乐驱动的段落先建立拍点网格，讲解段落以实测语义词和阅读时间组织事件；两者共用本片时间轴。每拍秒数为60/BPM、帧数为fps×60/BPM：120 BPM在30fps为15帧，在60fps为30帧。非整数拍点从时间原点逐拍换算并取整，在events.md记录fps、BPM、原点及触发时间，避免逐次累计取整误差。

已有音乐先测拍点与瞬态并试听核对强拍相位，记录音频哈希、beat times、重音和偏移；每四拍取一点仅在拍号及首拍相位成立时表示小节重拍。程序音乐使用生成时的同一节拍原点。SFX 对齐动作接触或结果；旁白重点、阅读与音乐重音发生冲突时，以该段内容优先级调整。

BGM承托情绪与段落，SFX按点击、接触、冲击或完成事件排程。预备、瞬态、尾音分别对照画面；刻意的听觉提前或延后登记具体偏移与用途，并以编码主片中的实际听感复核。音色、受力、距离和安静停留共同决定声画关系，动作落定与文字阅读保留所需时间。

声音排布与试听完成后，使用 `node .skill/scripts/video.mjs <slug> audio lock` 保存定稿声音包，返回本片相对路径 `assets/derived/audio/<hash>/audio-lock.json`。命令固定 master、分轨、实测句尾和已有词级时间，并登记文件哈希与原制作来源。本片预制 `assets/audio/voice.wav` 可用 `audio lock --tts-provider file --no-network`；采样率、样本数和时长来自原文件完整解码，词级时间保持未知。当前正式制作的 file 模式适用于一条预制旁白，多句脚本采用逐句真实 TTS。

纯视觉改片使用 `node .skill/scripts/video.mjs <slug> render --audio-lock <返回的相对路径>`，沿用相同 master、分轨和实测字幕时间。复用时登记锁包和音轨来源，本次工具事实记录实际编码与文件校验。旁白文本、音色、语速、起点、片长或混音排布发生变化，以及锁包、媒体或源素材被替换时，命令要求重新定稿；画面、译文和字幕样式调整可沿用声音。当前复用保证 PCM master 身份，AAC 封装由每次渲染执行。

此类分阶段制作保存实际渲染和封装记录，使用本片运行时的 buildFacts / buildMeasured / buildRunLog 生成 run.json，登记音轨来源、哈希、素材消耗与实际字幕数；最终输出哈希和源码哈希必须对应成片，再生成 disclosure。所有制作步骤继续通过统一入口，原脚本、镜长、声音和编码参数的保持情况写入本片证据。

字幕排时序与长旁白内部的镜头推进按[短字幕与语义分镜](captions-and-shots.md)，首次显现、强调峰值、动作完成和完整清单读时按其中的[中文语义事件排程](captions-and-shots.md#中文语义事件排程)。qa 的 captionReadability 给出分句后的条数、最长文本、最短停留与估算条数；按提示复核短词闪现、双语对应和词级匹配。画面、SRT、VTT 沿用同一条目时间线。

## 成片身份与证据绑定

项目 render 创建唯一 attemptId，在 `runs/<attemptId>/` 保存输入快照、执行记录与 receipt，在 `out/renders/<attemptId>/` 保存该次 MP4、字幕和生成音频。渲染执行已冻结的 spec、brief、源码和已知媒体；提交前核对原输入与快照。当前快照覆盖标为 `partial`：动态绘制代码的所有文件访问尚未逐调用登记，整个 assets 树采用保守前后哈希核对。新增画法继续通过声明的本片素材及相对路径读取。

编码、完整解码、旁白信号与输入校验成功后，原子更新本片 `run.json`，其 outputPath 指向该次独立成片；默认 `out/<slug>.mp4` 与字幕继续作为便捷副本。失败 receipt 保留原因，上次成功的 run 与成片继续可用，同片并发 render 由写锁拒绝。`--out`、`--srt`、`--vtt` 可指定本片 out 内的便捷副本，历史 renders 与临时区保留给引擎。`--no-run-log` 保存本次局部执行记录和产物，当前根 run 保持原值。

进程在多个便捷副本更新中途退出时，根 run 继续指向已提交成片，下次 render 确认原进程结束后恢复副本。读取和审片始终沿用根 run 指定的成片。

最终封装后运行`node .skill/scripts/video.mjs <slug> artifact --out evidence/artifact.json`。命令读取实际成片，核对run.json的文件哈希、体积、当前spec/brief和已记录绘制入口与源码，并核对已知固定运行时；新运行同时核对 attemptId、输入快照和已知媒体。成功后保存身份快照，失败保留已有快照。每次新渲染使用新的 attemptId，审片按该次身份重新绑定。快照用于审片绑定，其检查范围为文件与记录一致性。视觉、事实、动态与试听结果按[成片质量](quality.md)分别登记。

已有审片版本时，先将上一份身份快照、review.md、run.json及对应检查保留到本片evidence/versions/<旧视频SHA-256>/，再建立新快照并将当前观察标为pending。

从这份编码文件提取审片帧与动作段，检查报告注明同一视频哈希，review.md引用身份快照并填写实际范围。交付前运行`node .skill/scripts/video.mjs <slug> artifact --review evidence/artifact.json`，确认正在交付的文件与审片绑定相符。失配时保留历史run与证据，定位最后一次渲染或封装过程，重新生成真实记录及对应检查，再开始当前版本审片。

封装日志缺失时，保留现有产物与证据，核实视频流和来源音轨后通过本片exec重新封装，保存真实调用、来源哈希及当次实测。来源或制作事实尚未核实的部分保留pending，交付声明限定到可核查过程。

早期影片沿用固定运行时与guide快照；命令和字段以本片capabilities及guide核对。按本轮用户要求采用的通用方法落实到本片src和evidence；需要核验旧片时，通过本片exec完成同等的实际文件核对，并记录当时具备的来源信息。升级规则的效果用采用新核心的影片验证。

按[两级动态预演](direction.md)制作完整粗剪与重点样片，用当前编码检查[观看效果](quality.md)。qa 警告结合实际画面与配音复核；结构检查和创作判断分别记录。运动模糊按快动作需求评估，采用子帧采样时声明快门区间并检查文字清晰度与渲染成本。

ffprobe与完整解码核验编码，encoded-voice-presence.json核验编码后旁白信号。run.json与DISCLOSURE.md由render/disclosure生成。evidence/review.md保存真实检查范围、问题、修正、复核与brief.acceptance结果；观看或试听缺口保留pending。适用验收通过后标记complete，用户明确要求的审批保持有效。
