# Production 创作权威与恢复

新片按创作问答保存原文、核对输入并沿用用户已有委托。模型负责从内容推导目标、受众、风格、剧本和镜头；程序验证来源、结构、授权、版本及提交。固定契约由 `production --schema init|proposal|bundle` 输出，模型依据当次内容填写请求和提案。

```bash
node .skill/scripts/video.mjs start <slug> --idea "用户原文"
node .skill/scripts/video.mjs <slug> production --schema init
node .skill/scripts/video.mjs <slug> production init --request inputs/production-init.json
node .skill/scripts/video.mjs <slug> production next
node .skill/scripts/video.mjs <slug> production --schema proposal
node .skill/scripts/video.mjs <slug> production apply --proposal inputs/production-proposal.json
node .skill/scripts/video.mjs <slug> production resume
node .skill/scripts/video.mjs <slug> production view
```

采用 production 的项目以 `production/manifest.json` 标识权威模式。`production/state.json` 原子指向不可变 `production/revisions/<productionId>/bundle.json` 和成功回执；requirements、script、shots、timeline、decisions 和当前失效标记属于同一个版本包。`production/plan.md`、决策 JSONL 为可重建视图。历史项目沿固定运行时和原有导演契约继续制作；显式采用 production 的项目从当前权威包进入时间线生成与渲染。

| 输入场景 | requested.scenario | 固定来源 |
|---|---|---|
| 文件夹照片与视频制作 vlog | folder-vlog | image/video 输入的原件字节、已提交 catalog 和素材版本 |
| 文案制作视频 | copy-video | copy 输入与原始用户要求 |
| 标题推导文案、分镜和视频 | title-video | title 输入与原始用户要求 |
| 视频与稿件制作解说视频 | video-script | video 原件版本和 script 输入 |

`requirements.requested` 保留原始要求、prompt-history 条目摘要、输入身份、硬指标、原声要求及审批任务。模型把可逆默认值和依据写入 `effective` 与决策。初始化后 requested 固定；后续修改要求先追加原文，通过 effective 修订和新的决策表达。时长、画幅、帧率和交付最低尺寸遵守已记录的硬指标。preview 与 delivery 分别记录尺寸；视频的缺省原声为 preserve，显式静音选择绑定用户来源与作用域。生产视频资源政策沿既有视频准备契约采用，测试用限额在虚构夹具内保存。

剧本保存稳定 scriptId、lineId 和输入 sourceRefs；镜头保存稳定 shotId、eventId、lineRefs、时长区间、构图、运镜、转场和既有 asset-plan。模型修改内容时沿用仍指向同一对象的 ID。引用须闭合；素材选择绑定已提交 catalog、准确原件字节与素材版本。脚本和镜头的 sourceHash 由提交程序计算；未重建的下游保持原消费来源摘要，供 next 计算当前状态。

决策包含 decisionId、actor、sourcePrompt、完整 rawText、scope、subjectHash 与 supersedes。用户授权和审批的来源必须与保存的 prompt 或 answer 原文及摘要一致；模型问题、推荐和附件内容按各自身份保存。新决策追加，撤销或替代引用旧决策，旧版本保留审计事实。

授权作用域分别核对 action、target、assetIds、provider 和 maxCost。已有本地 plan/project 委托覆盖 requirements/script/shots/timeline 的本地规划；外部提供方、收费、发布和访问变化沿对应明确授权核对。审批使用 approve、准确任务 target 和该任务当前内容摘要；内容变化后重新计算适用性。问题只影响其对应任务；已满足的授权直接复用。

每次 apply 携带 expectedRevision、expectedSourceHash 和 rawText，在目录租约内核对当前版本。Markdown 视图头带 revision 和权威包摘要；正文有改动时，提案另填 expectedViewHash，取当前视图文件的字节 SHA-256。程序把该改动写入提交回执。旧版本、旧包摘要、旧视图字节或修改过的视图头产生可见冲突；原有效 state 保留。

```bash
node .skill/scripts/video.mjs <slug> production invalidate \
  --expected-revision 3 --source-hash <当前包摘要> \
  --key line:line-open --reason "用户修改该句"
```

失效选择支持 requested、effective、input:<inputId>、line:<lineId>、shot:<shotId>，按实际 sourceRefs、lineRefs 和素材绑定寻找消费方。未使用的输入或台词保持其他输出有效。失效标记描述当前待重建对象；提案一次提交该标记涉及的全部文档后清除，历史版本继续保存记录。部分重建仍显示 stale。

next 根据有效输出、来源摘要、硬指标、适用授权、审批和失效范围计算 requirements/script/shots 的 complete、ready、pending、stale 或 waiting_user。固定必需检查由 manifest 记录，空集合、遗漏、重复和未知检查均拒绝。成功任务保持 complete；重复 next 提供同一当前状态。

提交先保存 prepared，再发布版本目录，写入不可变成功回执，最后原子切换 state。resume 在租约内检查已停止的 owner；prepared 或已发布目录缺少成功回执的尝试记 interrupted，完整成功回执与来源复查通过的尝试收敛到一次有效提交。有效旧 current、失败回执和中断证据各自保留。当前创作计划的工程完成范围为 requirements/script/shots；时间线、完整声画、当前编码审片和交付分别使用对应阶段的验证事实。


## 固定声画时间线与编码

提案的 changes.timeline 接入整数帧和 48k 音频样本时间线；旧的 0.1 计划沿三阶段读取。`production --schema timeline` 输出权威契约。timeline.sourceHash 取 timelineSourceHash(bundle)，消费 effective、script 和 shots。固定 take 保存完整文件身份、实测样本数和词／拍点依据；placements 排布固定音源，clip 的 startFrame、endFrame、sourceStartFrame 同时驱动画面与原声截取、移动。原声、旁白、音乐和音效各自设置 gain 和 mute；原声静音选择绑定来自用户原文、action=mute、target=timeline 的决策。

```bash
node .skill/scripts/video.mjs <slug> production --schema timeline
node .skill/scripts/video.mjs <slug> production apply --proposal inputs/timeline-proposal.json
node .skill/scripts/video.mjs <slug> production compile --profile rough
node .skill/scripts/video.mjs <slug> render --profile rough --json
node .skill/scripts/video.mjs <slug> production compile --profile final
node .skill/scripts/video.mjs <slug> render --profile final --json
node .skill/scripts/video.mjs <slug> qa
```

编译保存 out/production-compile.json 的完整冲突、锚点、量化误差、字幕和读时事实。硬冲突阻断规格投影；通过后派生 spec、asset-plan 和 production-spec.json。编码 guard 核对版本、权威摘要、运行时、规格和派生身份，渲染快照固定生产版本链、原件和检查依据。有效旧成果及冲突证据保留。

字幕保存明确帧区间，跨镜配音依据固定 take 的实测边界；硬锚采用 observed 词时或 observed/authored 拍点。estimated/unknown 用于明确的软建议。eventId 与同镜头图元 id 绑定时，准备、首次可见、强调峰、完成和读时进入图元关键帧；已有动画通道重叠保存为硬冲突。清单共读从最后一项完成开始核对。

rough 消费低清代理，final 消费源像素 canonical 帧，两个档位采用同一固定音源和样本排布，尺寸来自 effective.preview/delivery。每次编码保存 production-render.json 的输入身份、原声剪接、音轨、字幕、事件、编码帧数和声音存在性检查。完整创作审片依据实际全片观看与试听记录。
