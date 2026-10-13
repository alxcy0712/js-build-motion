# 风格选择

| theme | 名称 | 关键 token | 适用 |
|---|---|---|---|
| `minimal`（默认） | 极简 | 底 #000、字 #F5F5F7、强调琥珀 #FFB340；Inter + 苹方/鸿蒙/思源黑；竖屏 hero 132；文字弹簧 k100 c25（零过冲）；进场 0.9s、最短停留 1.2s；推镜 1→1.03/5s；颗粒 3% | 观点金句、开场钩子、品牌片尾、人生思考 |
| `kinetic` | 炫酷 | 底 #05060A、电光青 #00E5FF + 洋红 #FF2BD6；Inter Tight 900；hero 168；k380 c28（过冲 ≤4%）；甩切 (.8,0,.1,1) + 8 采样运动模糊；128 BPM、停留 0.6s；辉光 0.6 | AI 新工具发布、效率对比、榜单、高能开场 |
| `terminal` | 科技UI/终端 | 底 #08090A、面板 #1A1B1E、发丝线 #26272B、靛紫 #7C83FF；Geist Mono + Inter；k300 c34（无过冲）；打字 35ms/字；放大进元素、扫描线转场 | AI 实操、Prompt/代码演示、工作流与“输入→处理→输出”图解 |
| `crayon` | 手绘蜡笔 | 米白纸 #F6F1E7、墨 #2B2622、橙 #E8603C/蓝/黄/绿；思源黑 900；逐字进场、k180 c18（过冲 ≤6%）；颗粒 8%/8fps 抖动；纸翻转场 | 个人 IP 出镜、生活类比故事、与蜡笔画 Skill 插画同框 |
| `storybook` | 水彩绘本 | 原 watercolor_storybook；思源宋；慢节奏 k90 c22；墨晕/模糊溶解 | 温情叙事、雨夜氛围、沿用旧项目 |

所有风格共用安全区：竖屏 上220 / 下520 / 左72 / 右168；横屏 上72 / 下96 / 左右120。

## 品牌锁
`.skill/brand.json` 的 `lockedTheme` 决定全部影片风格（默认 `minimal`）。单片 spec 写了不同的 `style.theme`：`enforcement: "override"` 时强制改回并给出 `BRAND_THEME_LOCKED` 警告，`"reject"` 时直接失败。换风格只能改 brand.json，并在 `changes` 末尾追加一条同名记录。

## 防死帧
- 每个风格的 `liveness` 规定持续微运动层（drift 指数推镜永不停、椭圆视差漂移、扫光、蜡笔沸腾；颗粒不算），校验器保证任意 ≤0.5s 窗口内有可见位移。镜头内调用 `microMotionAt(theme, t)` 取相机状态。
- 审片：`node .skill/engine/scripts/dead-frame-qa.ts <video.mp4> [--json]`，比较相隔 0.5s 的帧（灰度、块平均、扣除颗粒噪声底），报告无可见变化的区间；有死帧退出码 2。

## 个人 IP 使用规则
- IP 是小幅美术，**不当主视觉放大**。显示边长 ≤ 源尺寸 512px（rig 头/身部件），推荐 256–384；超过即 `IP_UPSCALE` 校验失败（按实际输出像素换算，4K 输出同样受限）。
- `scenes[].ip` 默认不出现。只在两种情况使用：
  - `role: "identity"`：身份声明或需要时，例如片尾小签名（默认 288px，底部居中）。
  - `role: "actor"`：讲解动画中的演员，例如骑车、操作电脑（默认 384px）。
- 写法：`"ip": { "role": "identity", "size": 288, "position": "bottom-center", "expression": "happy" }`；`position` 可选 `bottom-center | bottom-left | bottom-right | center | custom`（custom 需 `x`、`y`，0–1，y 为角色底边）。旧写法 `ip: true` 自动降级为 288px 身份署名并告警。
- 纯文字镜头不放 IP，标题居中；身份署名在底部时标题略上移。
