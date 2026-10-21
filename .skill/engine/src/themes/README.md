# 风格层（themes）

风格 token 提供色彩、字体、节奏与转场的预设。叙事、主体、构图和镜头编排由本片计划及绘制实现；共用判断以制作规范中的创作主线为准。

```
themes/
  ids.ts          风格 ID 与默认值（minimal）
  brand.ts        账号默认、本片主题快照与旧版配置读取
  types.ts        ThemeTokens 契约
  shared.ts       主题内嵌字体文件名、固定中文字体栈、抖音/小红书安全区
  styles/*.ts     每个风格一份 token
  registry.ts     getTheme(id) / listThemes() / orientationOf()
  validate.ts     token 校验（色值、对比度、字号递减、禁止线性缓动、文字过冲上限、安全区）
  motion.ts       cubicBezier、弹簧过冲/收敛解析
  fonts.ts        主题内嵌字体注册、通用候选查找、回退检测与实际绘制字族观测
  text-reveal.ts  统一文字进退场组件 revealState / drawRevealText
```

## 选用
spec 里写 `"style": { "theme": "minimal" }`，或简写 `"style": "minimal"`（repair 自动展开）。省略 theme 时沿用本片 brand.json 的生效主题；新片账号默认为 `minimal`，初始化时可显式选择 `kinetic`。选择依据与变更流程见制作规范中的“账号默认与每片风格选择”。
`theme_stage` 使用主题样式；`motion_stage` 保留 palette 与原创 elements。主题为 `minimal`、`kinetic`。

## 规则
- 文字一律走 `drawRevealText`：opacity 用 bezier，位移/缩放用闭式弹簧，二者解耦；纯 seek(t)。
- `textReveal.allowOvershoot=false` 的风格，弹簧进度被钳制在 [0,1]，校验器也要求解析过冲 < 0.1%。
- 禁止线性缓动；不动画 letter-spacing；中文 tracking 恒为 0。
- 新增风格：写 `styles/<id>.ts` → 加入 `ids.ts` 与 `registry.ts` → `node --test test/themes.test.ts` → 在 `references/style-and-identity.md` 补一段。
