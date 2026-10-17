# 风格层（themes）

引擎只负责“按时间求值并绘制”，所有审美决定集中在风格 token 里。原创体系，外部项目仅作思路参考，不复制代码或配方。

```
themes/
  ids.ts          风格 ID 与默认值（minimal）
  types.ts        ThemeTokens 契约
  shared.ts       共用字体候选文件名（含 macOS 自带的同类字体）、中文字体栈、抖音/小红书安全区
  styles/*.ts     每个风格一份 token
  registry.ts     getTheme(id) / listThemes() / orientationOf()
  validate.ts     token 校验（色值、对比度、字号递减、禁止线性缓动、文字过冲上限、安全区）
  motion.ts       cubicBezier、弹簧过冲/收敛解析
  fonts.ts        字体注册（按文件名查找：engine/assets/fonts → $JBM_FONT_DIRS → 当前平台系统字体目录）+ 回退检测，严格模式缺字即失败
  text-reveal.ts  统一文字进退场组件 revealState / drawRevealText
```

## 选用
spec 里写 `"style": { "theme": "minimal" }`，或简写 `"style": "minimal"`（repair 自动展开）。不写时默认 `minimal`。
原有 `preset/palette/paper/line` 保持不变，继续驱动旧环境（rain_window / motion_stage）的水彩场景绘制；风格层只作用于 `theme_stage` 镜头。可选风格只有 `minimal` 与 `kinetic`。

## 规则
- 文字一律走 `drawRevealText`：opacity 用 bezier，位移/缩放用闭式弹簧，二者解耦；纯 seek(t)。
- `textReveal.allowOvershoot=false` 的风格，弹簧进度被钳制在 [0,1]，校验器也要求解析过冲 < 0.1%。
- 禁止线性缓动；不动画 letter-spacing；中文 tracking 恒为 0。
- 新增风格：写 `styles/<id>.ts` → 加入 `ids.ts` 与 `registry.ts` → `node --test test/themes.test.ts` → 在 `references/styles.md` 补一段。
