# js-build-motion

独立视频工作区：minimal/kinetic固定个人识别，Skia Canvas绘制，支持字幕/IP/片尾、生成视频层、素材导入/ZIP/目录、视频选段/原声、配音/混音/对齐、Production与审片交付。角色与授权见[AGENTS](AGENTS.md)，制作入口见[SKILL](.skill/SKILL.md)。现有影片保留固定运行时；PDF/Office仅入库核身份，内容解析已移除。

## 安装与运行

封存宿主为macOS ARM64、Node24、FFmpeg/ffprobe；Git克隆后按下文恢复字体、OCR/ASR固定依赖，再执行检查/seal。直接依赖由`.skill/engine/package-lock.json`固定：

```bash
npm ci --prefix .skill/engine --omit=dev
node .skill/scripts/check.mjs --engine
node .skill/scripts/check.mjs --docs
node .skill/scripts/seal.mjs
node .skill/scripts/check.mjs --native
```

Skia安装提示须以实际模块加载/出帧验证。Linux按[手建入口](.skill/references/workflow.md#linux-手建入口)装本机依赖并登记摘要，宿主隔离自行验证，原生受限媒体/Production入口待Linux适配。

用户确认主题及逐片片尾选择后制作：

```bash
node .skill/scripts/video.mjs start my-film --idea "制作30秒讲解" --theme minimal
node .skill/scripts/video.mjs my-film capabilities --schema
node .skill/scripts/video.mjs my-film import --source /path/to/input
node .skill/scripts/video.mjs my-film catalog --import <importId>
node .skill/scripts/video.mjs my-film direct compile
node .skill/scripts/video.mjs my-film render
node .skill/scripts/video.mjs my-film artifact --out evidence/artifact.json
node .skill/scripts/video.mjs my-film disclosure
```

[工作流](.skill/references/workflow.md)详述入库/媒体0.1与0.2/ASR/对齐/Production/后期，[质量](.skill/references/layout-and-quality.md)详述review/credits/deliver。视频准备支持自包含H.264/yuv420p/SDR MP4/MOV、零旋转与可选AAC；原声消费用Production，普通画面入口明确静音。对齐时间estimated/unknown，试听单独验收。

Edge需Python/edge-tts≥7.3.1；豆包明确启用--tts-provider doubao，需websockets≥14和DOUBAO_API_KEY环境变量，个人音色按AGENTS授权。离线file用授权voice.wav，mock限预览；audio lock固定PCM，render --audio-lock复用。CJK固定Noto Sans CJK SC，facts.fonts/fontUsage记录文件与实际字族。

.skill为核心，assets为授权IP/独立封面，projects为本片输入/代码/证据/成片，当前编码看run.json；.research/out为检查临时区，.pi为本机记录。新片复制七篇guide和固定运行时。按[维护](.skill/references/maintenance.md)备份→检查→seal，常规备份保留两份；--standalone验证空生成区/移根/初始化，检查模式分开运行。

共享见[REVIEW](REVIEW.md)，启用git config core.hooksPath .githooks；共享前node .githooks/check-publish.mjs --worktree，提交后--history HEAD。项目/依赖副本/备份/敏感配置保持本地。

## 字体与原生依赖恢复

中文字体感谢LXGW/FONTWORKS和Noto；西文字体感谢Rasmus Andersson、Inter Tight及Geist维护者。

字体放`.skill/engine/assets/fonts/`，Linux本片放`.engine/assets/fonts/`。下列原件字节与SHA须一致，OFL文本随源码；完整封存/备份/新片包含二进制，Git克隆需恢复：

| 文件与固定来源 | 字节数 | SHA-256 | 许可 |
|---|---|---|---|
| [NotoSansCJKsc-VF.otf](https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/Variable/OTF/NotoSansCJKsc-VF.otf)，Sans 2.004 | 30737452 | `2745e9681cb9d8a5c8901b62c9e1bd98c9c774365fc3b84dd467621013b51cd3` | [OFL-NotoSansCJK.txt](.skill/engine/assets/fonts/OFL-NotoSansCJK.txt) |
| [Inter-Variable.ttf](https://raw.githubusercontent.com/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/inter/Inter%5Bopsz,wght%5D.ttf) | 876576 | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` | [OFL-Inter.txt](.skill/engine/assets/fonts/OFL-Inter.txt) |
| [InterTight-Variable.ttf](https://raw.githubusercontent.com/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/intertight/InterTight%5Bwght%5D.ttf) | 581588 | `b81b73dcb64df3c230cabade7df6c5773bf863233f24c9ee51087519f1f88b6f` | [OFL-InterTight.txt](.skill/engine/assets/fonts/OFL-InterTight.txt) |
| [GeistMono-Variable.ttf](https://raw.githubusercontent.com/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/geistmono/GeistMono%5Bwght%5D.ttf) | 171948 | `d00e590b8eb3a59acc329b2d044fd143ae935090b7da33199ebee27cc7de8196` | [OFL-GeistMono.txt](.skill/engine/assets/fonts/OFL-GeistMono.txt) |
| [LXGWWenKai-Regular.ttf](https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf)，1.522（原有绘图字体） | 25575676 | `39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009` | [OFL.txt](.skill/engine/assets/fonts/OFL.txt)，来自[固定上游许可](https://github.com/lxgw/LxgwWenKai/blob/7ebd0771fda4285299670f83c398f32f32c7bef8/OFL.txt) |

OCR采用Tesseract5.5.0及Leptonica，模型固定tessdata_fast4.1.0/65727574dfcd264acbb0c3e07860e4e9e9b22185。恢复eng/chi_sim到assets/ocr/tessdata，字节、SHA、Git blob、原生闭包/动态别名见[OCR锁](.skill/engine/ocr-dependencies.lock.json)，许可在assets/ocr/LICENSE。语言chi_sim+eng+~chi_sim_vert，模型随运行时封装。

ASR用whisper.cpp d1be6fde11ac6e0407606b4e42fe72d34add8037和multilingual base修订5359861c739e955e79d9a303bcbc70fb988958b1。[模型](https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin)存assets/asr/models/ggml-base.bin，147951465 B，SHA256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`。固定源码应用[stdout补丁](.skill/engine/assets/asr/stdout-stream.patch)（patch -p1），CMake Release构建whisper-cli，BUILD_SHARED_LIBS、GGML_BACKEND_DL、GGML_METAL、GGML_ACCELERATE、GGML_BLAS、GGML_OPENMP、GGML_NATIVE、WHISPER_COREML、WHISPER_COMMON_FFMPEG、GGML_STATIC均OFF，目标whisper-cli -j4。程序放assets/asr/bin，完整身份及FFmpeg/ffprobe闭包见[ASR锁](.skill/engine/asr-dependencies.lock.json)，许可在assets/asr/licenses。恢复后核闭包/离线验证/seal，已有片保持旧版本。

## 来源与致谢

感谢以下作者和维护者。方法独立整理到motion/direction/drawing及风格规范；作品归原作者，实际素材使用另核许可。上游页面保留完整制作名单，观察、作者陈述、推断和实测分别记录。

- 0xMovez：[动效流程](https://x.com/0xMovez/status/2104216919033192746)。
- Pluvio9yte：[动作/受力](https://x.com/Pluvio9yte/status/2105533742907605209?s=20)。
- OpenDesign：[Motion 发布片](https://x.com/OpenDesignHQ/status/2111023212129829086)、[界面演示](https://x.com/OpenDesignHQ/status/2111029430080725196)。
- Josef Albers、Josef and Anni Albers Foundation：[Interaction of Color](https://www.albersfoundation.org/alberses/teaching/interaction-of-color)。
- BUCK、Blue Studio / 项目团队：[Comfy Brand Refresh](https://www.buck.co/work/comfy-brand-refresh)、[IBM Sustainability](https://www.buck.co/work/ibm-sustainability)。
- Tyler Hobbs：[How to Hack a Painting](https://www.tylerxhobbs.com/words/how-to-hack-a-painting)、[水彩方法](https://www.tylerxhobbs.com/words/a-guide-to-simulating-watercolor-paint-with-generative-art)。
- Grant Sanderson / 3Blue1Brown：[Fourier Transforms](https://www.3blue1brown.com/lessons/fourier-transforms/)。
- Ordinary Folk / School of Motion / Jorge R. Canedo E.：[Manifesto](https://www.ordinaryfolk.co/project/school-of-motion-manifesto)。
- Oscar Hudson / Apple / TBWA / Pulse / Framestore：[Bounce](https://www.oneclub.org/awards/adcawards/-award/35329/bounce/)。
- 花叔 Huashu / alchaincyf：[huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion)。
- Pentagram / Domenic Lippa：[London Design Festival 2025](https://www.pentagram.com/work/london-design-festival-2025)。
- A1 Gallery / 原作者：[Typographic Portfolio](https://www.a1.gallery/websites/typographic-portfolio)。
- 静静的自媒体运营：[安全框预览](https://www.douyin.com/video/7609205181926457786)。
- opusvideo / Awesome Claude Video及原作者：[awesome-claude-video](https://github.com/opusvideo/awesome-claude-video)。
- athemeroy / Awesome Claude 5.5 Videos：[awesome-claude-5-5-videos](https://github.com/athemeroy/awesome-claude-5-5-videos)、[研究方法](https://github.com/athemeroy/awesome-claude-5-5-videos/blob/main/docs/methodology.zh-CN.md)、[提示词矩阵](https://github.com/athemeroy/awesome-claude-5-5-videos/blob/main/docs/prompt-matrix.zh-CN.md)。
- Prompt Motion / @p4nthera_：[案例库](https://prompt-motion.com/)、[展演模板](https://prompt-motion.com/templates/showreel)。
- zero / @twoclipping：[UI形变](https://prompt-motion.com/twoclipping-5cba86)。
- Stephan Livera / @stephanlivera：[展演](https://prompt-motion.com/stephanlivera-df17a2)。
- @LinearUncle：[导数讲解](https://prompt-motion.com/linearuncle-5d2bae)。
- ultima / @ultimaxbt：[橙点系统](https://prompt-motion.com/ultimaxbt-bbebf5)。
- testarossa / @rossaxbt：[UI循环](https://prompt-motion.com/rossaxbt-94583b)。
- Parker Rex / @ParkerRex：[令牌桶](https://prompt-motion.com/parkerrex-1a54fe)。
- Prompt Motion 编辑者：[讲解提示词分析](https://prompt-motion.com/blog/ai-explainer-video-prompts)、[产品片提示词分析](https://prompt-motion.com/blog/ai-launch-video-prompts)、[效果约束分析](https://prompt-motion.com/blog/make-ai-motion-graphics-look-less-ai)。
- Dawn Delbanco、The Metropolitan Museum of Art：[Chinese Handscrolls](https://www.metmuseum.org/essays/chinese-handscrolls)。
- Charles and Ray Eames、Eames Office：[Powers of Ten](https://www.eamesoffice.com/the-work/powers-of-ten/)。
- Design Council：[The Double Diamond](https://www.designcouncil.org.uk/resources/the-double-diamond/)。
- Pixar、Khan Academy：[Pixar in a Box](https://www.pixar.com/pixar-in-a-box)。
- David Thorburn、MIT OpenCourseWare：[The Film Experience](https://ocw.mit.edu/courses/21l-011-the-film-experience-fall-2013/)。

Tak（[@cherry_mx_reds](https://x.com/cherry_mx_reds)）的Art History Speedrun为花叔项目的上游起点，见[原项目致谢](https://github.com/alchaincyf/huashu-art-motion#致谢)。其绘制、动画语法、拆解/渲染/QA文档在该仓库，项目采用材料、语义同步和连续帧诊断机制。

- Adobe 教程团队：[Tracking Shots](https://www.adobe.com/creativecloud/video/production/cinematography/camera-shots-and-angles/tracking-shot.html)。
- Apple Motion 文档：[相机行为](https://support.apple.com/guide/motion/add-camera-behaviors-motn17c69ccb/mac)、[相机控制](https://support.apple.com/guide/motion/camera-controls-motn17c68cdf/mac)。
- three.js与文档：[相机](https://threejs.org/manual/pages/cameras.html)、[实用技巧](https://threejs.org/manual/pages/tips.html)。
- YouTube 帮助文档：[观众留存分析](https://support.google.com/youtube/answer/9314415?hl=en)。
- W3C WAI：[文字对比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[闪烁阈值](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)。
- Christian Swinehart / samizdatco 与 skia-canvas：[skia-canvas](https://github.com/samizdatco/skia-canvas)、[官方安装文档](https://skia-canvas.org/getting-started)。
- Evgeny Poberezkin 与 Ajv：[Ajv](https://github.com/ajv-validator/ajv)。
- Node.js 与 FFmpeg：[Node.js](https://nodejs.org/)、[FFmpeg](https://ffmpeg.org/)。
- rany2 与 edge-tts：[edge-tts](https://github.com/rany2/edge-tts)、[7.3.0](https://github.com/rany2/edge-tts/releases/tag/7.3.0)、[7.3.1](https://github.com/rany2/edge-tts/releases/tag/7.3.1)。
- 火山引擎豆包语音文档：[公版音色列表](https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh)、[双向WS](https://docs.volcengine.com/docs/DoubaoVoice/WebSocketBidirectionalStreaming-V3?lang=zh)、[单向HTTP](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)。
- websockets：[websockets](https://websockets.readthedocs.io/)。
- Python 文档：[venv 官方说明](https://docs.python.org/3/library/venv.html)。
- LXGW（霞鹜）、FONTWORKS 与字体：[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)。
- Noto 与字体：[Noto Sans CJK](https://github.com/notofonts/noto-cjk/tree/Sans2.004)。
- Josh Wolfe / yauzl（MIT）：ZIP解析及PKWARE结构依据；[yauzl](https://github.com/thejoshwolfe/yauzl)、[PKWARE ZIP 格式规范](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)。
- FFmpeg文档：probe、时间戳、协议和格式准入；[FFprobe](https://ffmpeg.org/ffprobe.html)、[FFmpeg](https://ffmpeg.org/ffmpeg.html)、[协议文档](https://ffmpeg.org/ffmpeg-protocols.html)、[格式文档](https://ffmpeg.org/ffmpeg-formats.html)。
- [Tesseract5.5.0](https://github.com/tesseract-ocr/tesseract/tree/5.5.0)（Apache-2.0）/ [Leptonica](https://github.com/DanBloomberg/leptonica)：OCR；[TSV文档](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)、[初始化](https://github.com/tesseract-ocr/tesseract/blob/5.5.0/src/ccmain/tessedit.cpp)、[W3C PNG](https://www.w3.org/TR/png-3/)、[方向控制](https://ffmpeg.org/ffmpeg.html#Video-Options)。
- Tesseract：tessdata_fast（Apache-2.0）；[tessdata_fast 4.1.0](https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0)。
- Apple XNU：进程组信号与后代清理；[Apple 公开 XNU 的信号实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)。
- whisper.cpp/OpenAI Whisper（MIT）：离线识别和模型；[whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037)、[OpenAI Whisper](https://github.com/openai/whisper)。
- David Reid / miniaudio、Sean Barrett / stb（MIT或公有领域）：原生解码；[miniaudio](https://github.com/mackron/miniaudio)、[stb_vorbis](https://github.com/nothings/stb)。
- whisper.cpp：完整token JSON及实验性时间；[token JSON](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/examples/cli/cli.cpp)。
- FFmpeg7.1与IETF RFC9639：MP3/FLAC结构和样本依据；[FFmpeg demuxer 文档](https://ffmpeg.org/ffmpeg-formats.html)、[MP3源码](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavformat/mp3dec.c)、[RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html)。

恢复模型下载：[eng](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/eng.traineddata)、[chi_sim](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/chi_sim.traineddata)。
