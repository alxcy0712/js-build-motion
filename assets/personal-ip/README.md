# 个人形象 IP

透明人物资产，可纳入 Git 并供影片按内容需要复用。人物沿用蓬松黑发、圆润暖肤脸型、深棕大眼睛和头大肩窄的卡通比例，人物自身右胸固定白色手写 `Alxcy` 签名（正面画面左侧）。基础造型为黑色连帽衫、米白抽绳；10 套衣柜造型沿用相同身份特征。以 [identity.json](identity.json) 固定身份。

| 素材 | 路径 | 规格 |
|---|---|---|
| 三视图 | `views/front.png`、`side.png`、`back.png` | 384 × 768，透明 PNG |
| 10 套衣柜全身造型 | `wardrobe/<id>/front.webp`，索引见 `wardrobe.json` | 各为 512 × 1024，正面全身透明 WebP |
| 10 套三向上半身服装图层 | `wardrobe/<id>/upper-body.webp` | 各为 1536 × 512，正面、左 45°、右 45° 三格；肩颈与服装透明图层 |
| 扶正大头照 | `portrait.png` | 512 × 512，透明 PNG |
| 18 种表情 × 3 个朝向 | `expressions/`、`expressions/left45/`、`expressions/right45/`，索引见 `expressions.json` | 共 54 张 256 × 256 透明 PNG |
| 左右 45° 透视基准 | `rig/left45-base.png`、`rig/right45-base.png` | 512 × 512，独立生成的透明肖像 |
| 左右 45° 完整表情图集 | `rig/left45-expressions.png`、`rig/right45-expressions.png` | 各为 768 × 1536，3 列 × 6 行，每格 256 × 256 |
| 独立头部、肩颈 | `rig/head.png`、`rig/body.png` | 512 × 512，透明 PNG |
| 各表情眉毛、脸颊 | `rig/brows.png`、`rig/cheeks.png` | 各含 12 套，双倍纹理分辨率 |
| 各表情眼睛 | `rig/eyes.png` | 12 套眼睛与逐级眼皮，保持固定注视方向 |
| 各表情静止嘴型 | `rig/rest-mouths.png` | 12 套，双倍纹理分辨率 |
| 独立讲话口型 | `rig/mouths.png` | 6 套固定尺寸，双倍纹理分辨率 |
| 闭眼兼容图层 | `rig/blink.png` | 256 × 256 |
| 待机与说话循环 | `animations/idle.png`、`speaking.png` | 256 × 256，6 秒，24 fps，透明 APNG |
| 较小的动画版本 | `animations/idle.webp`、`speaking.webp` | 相同的透明循环 |
| 可控动画与绑定 | `puppet.mjs`、`rig.json` | Canvas 2D，18 种正面表情与衣柜可驱动，左右 45° 可切换静态表情 |
| 表情合成入口 | `build-expressions.mjs` | 使用共享基准与图层生成全部表情 |
| 交互预览 | `preview.html`、`preview.mjs` | 表情、朝向、说话、歪头、深浅背景、本地音频、衣柜与 PNG 下载 |

正常说话使用扶正的正面头部，眼睛保持水平，嘴部居中。头部、眉毛、眼睛、脸颊与嘴巴共享同一坐标变换；`headTilt` 可以连续变化，肩颈底层补齐头部转动后显露的位置。肩部有轻微呼吸，眼皮按完整生成姿态逐级闭合。开心、大笑、闭眼放松保留闭眼表情；眨单眼时，睁开的眼睛仍可眨眼。

下巴与下颌线保存在共用头部图层。口型补底止于下巴上方，脸颊图层分别覆盖两侧腮红；切换表情、张嘴与歪头时沿用完整的原始下颌轮廓。

18 种表情包含平静微笑、开心、大笑、思考、专注、惊讶、疑惑、担心、害羞、坚定、眨单眼、闭眼放松、生气、难过、落泪、怀疑、释然、兴奋。疑惑在头部右上方显示紫色漫画“？”，惊讶显示金色漫画“！”；倾斜曲线、暖色细描边与短笔触保留缩略图辨识度。生气增加红色情绪符号，兴奋增加金色星芒。落泪采用闭眼哭泣、张开的哭喊嘴型与从下眼睑连续流向下颌的浅蓝泪痕，正面动画中的细小高光沿泪痕向下移动，泪水跟随头部转动。正面新增表情通过 `rig.json` 的 `expressionLayers` 组合原有 12 套图层，怀疑与难过使用相应的眼皮姿态。

正面沿用同一头型、发型、身体位置和胸口标识。`left45` 朝画面左侧转 45°，`right45` 朝画面右侧转 45°；两组以独立透视基准整体重绘表情，眉眼、嘴型、泪水与面部明暗连续融合，远近眼睛依照各自朝向绘制。完整肖像保存在图集中，`rig.json` 的 `angledExpressions` 固定图集与单元规格，单元顺序沿用 `expressionIds`；胸口签名沿用人物自身右胸的位置。左右 45° 提供静态 PNG；正面提供说话、眨眼和歪头动画。预渲染 APNG/WebP 使用平静表情。

## 个人衣柜

[查看全身造型总览](wardrobe/overview.webp)与[三向上半身总览](wardrobe/upper-body-overview.webp)。

[wardrobe.json](wardrobe.json) 登记 10 套新增服装，基础黑色连帽衫由 `defaultOutfit` 引用。每套包含完整服装、鞋子与配饰，沿用自身右胸的白色签名。全身图保存在 `front.webp`；三向上半身服装保存在 `upper-body.webp`，三格依次为正面、朝画面左侧 45°、朝画面右侧 45°。图像由内置 imagegen 基于原有身份素材衍生，完整提示词见 [prompts.json](wardrobe/prompts.json)：全身使用 `sharedPrompt` 加对应 `outfitDesign`，上半身使用 `upperBody.sharedPrompt` 加对应 `outfitDesign`；`revisions` 记录后续修订。

颈肩比例以基础黑色连帽衫为基准：颈部连续露出，领口、围巾、领巾与耳机留在下巴下方，肩线自然放松，正面身体中轴扶正。服装源图通过等比缩放与平移对齐共享头部；三向取样区保留完整的颈肩比例。`reconstruction` 保存本轮重构依据，`history` 保存上一版提示词与被替换素材的哈希。

| id | 风格 | 服装与鞋子 | 配饰 |
|---|---|---|---|
| `business` | 商务正装 | 藏蓝西装、白衬衫、酒红领带、西裤、棕色牛津鞋 | 银色腕表 |
| `academy` | 学院针织 | 墨绿菱格背心、米白衬衫、条纹领带、卡其裤、乐福鞋 | 棕色肩背书包 |
| `street` | 街头棒球 | 酒红棒球夹克、米白 T 恤、水洗黑牛仔裤、奶白高帮鞋 | 细银项链 |
| `outdoor` | 山系户外 | 橄榄绿户外夹克、沙色工装裤、登山靴 | 小型登山背包、橙色领巾 |
| `sport` | 活力运动 | 钴蓝运动外套、浅灰 T 恤、深灰束脚裤、蓝白跑鞋 | 橙色运动手表 |
| `summer` | 夏日亚麻 | 深青亚麻短袖衬衫、米白内搭、沙色短裤、棕色凉鞋 | 米白帆布托特包 |
| `winter` | 冬日围巾 | 深蓝灰羊毛大衣、浅灰针织衫、深色长裤、棕色短靴 | 酒红围巾、棕色手套 |
| `neo-chinese` | 新中式 | 墨青立领盘扣外套、米白内搭、黑色长裤、黑色布鞋 | 小玉佩 |
| `workwear` | 复古工装 | 靛蓝牛仔夹克、条纹 T 恤、烟草棕长裤、工装靴 | 颈挂式耳机、棕色皮带 |
| `techwear` | 未来科技 | 石墨灰机能外套、黑色工装裤、黑银高帮鞋 | 青色肩夹通讯器、银色腕环 |

衣柜共用原有头部、眉眼、口型与左右 45° 表情图集，实时合成 10 套服装 × 3 个朝向 × 18 种表情。正面保留说话、眨眼、歪头和呼吸；左右 45° 提供静态表情。`drawWardrobePortrait` 负责三向绘制，`drawPersonalIP` 保留基础连帽衫调用。预编码 APNG/WebP 循环使用基础连帽衫；衣柜动画通过实时绘制生成。

`rig.json` 的 `wardrobeJaws` 保存三向下颌轮廓，左右 45° 按 `expressionIds` 分别登记。换装时沿轮廓裁切共用头像，并恢复暖色细描边，清理下巴外侧的深色残片；正面轮廓随头部姿态一起变换。基础黑色连帽衫沿用原有完整肖像。

三向服装颈部向头像内重叠 6 个逻辑像素，保持画面下沿固定，让颈部连续覆盖下颌的抗锯齿边缘与正面轻微歪头后的衔接区域。

全身采用 512 × 1024 透明 WebP，服装图层采用 512 像素单元的透明 WebP，头部与表情沿用共享源素材。下载时由预览页导出单张透明 PNG。衣柜保存每套全身图与三向服装图层，合成结果按使用需要导出；中间源图与检查截图在验收后清理。

```js
const wardrobe = await fetch('./assets/personal-ip/wardrobe.json').then(response => response.json());
const outfit = wardrobe.outfits.find(item => item.id === 'neo-chinese');
const image = new Image();
image.src = './assets/personal-ip/' + outfit.path;
await image.decode();
context.drawImage(image, 40, 60, 300, 600);
```

上半身使用原有八张正面绑定图片，再按需解码 `rig.angledExpressions.left45.path`、`right45.path` 到 `images.left45`、`images.right45`；将本套 `upperBody.path` 解码到 `images.outfit`，保留索引中的相对目录。

```js
import { drawWardrobePortrait } from './assets/personal-ip/puppet.mjs';

// images 已解码所需绑定图片、左右 45° 图集与本套 upperBody.path。
drawWardrobePortrait(context, images, rig, outfit, {
  view: 'left45', expression: 'focused', x: 40, y: 60, size: 320,
});
```

正面使用 `view: 'front'`，其余说话和头部姿态参数沿用下文；`outfit` 传入 `wardrobe.outfits` 中的一项，基础造型传入 `undefined`。复制所需 WebP、共享绑定与运行文件到影片，并按 `manifest.json` 登记来源与哈希。

本地预览在仓库根执行 `node assets/personal-ip/preview.mjs`，打开返回的网址。选装同步更新上半身动画与表情区，衣柜区支持全身与上半身构图、左右 45°、深浅与透明格背景，以及当前构图和上半身 PNG 导出。

运行 `node assets/personal-ip/verify-wardrobe.mjs` 校验 540 种组合、共享身份像素、54 个共用头像的下巴边缘、54 张基础连帽衫肖像、三向下巴下方的连续露颈区域、口型与歪头绑定，以及图集取样边界。头颈接缝另行检查 1260 个静态与讲话、呼吸、±5° 歪头状态的透明度。`upperBody.rects` 固定每格的有效服装区域，运行入口按该区域取样。

## 在影片中使用

复制所需 PNG、`rig.json` 与 `puppet.mjs` 到当前影片 `assets/personal-ip/`，登记来源与哈希。按 rig 中的相对路径解码 `base`、`body`、`mouths`、`eyes`、`blink`、`brows`、`cheeks`、`restMouths` 八张图片。

```js
import { drawPersonalIP, speechLevel } from './assets/personal-ip/puppet.mjs';

drawPersonalIP(context, images, rig, {
  time: frame / fps,
  x: 40, y: 80, size: 320,
  expression: 'focused',
  speaking: true,
  mouthOpen: speechLevel(audioSamples),
  headTilt: 0,
});
```

`expression` 使用 `expressions.json` 中的 id。`speaking: true` 开启讲话，`mouthOpen: 0` 表示闭口停顿，`mouthOpen: 1` 表示张开；省略 `mouthOpen` 时使用内置音节演示。`roundness: 1` 选择圆口型；`headTilt` 单位为度，已验证左右 5°；`blink: false` 固定眼皮，`motion: false` 固定呼吸。音量包络驱动开合和停顿，精确音素同步由影片提供时序。

静态表情的原 `path` 与 id 保持兼容；`views.front`、`views.left45`、`views.right45` 返回对应的 PNG 路径。例如疑惑的左 45° 使用 `expressions/left45/puzzled.png`。抖音封面编辑器从本索引动态读取全部表情与朝向；源素材、索引更新后刷新编辑页即可使用。

预览通过 HTTP 打开，切换待机、说话和音频时保留当前表情与姿态。本地音频保留在浏览器。APNG 使用 `.png` 扩展名，可循环播放；静态查看器显示首帧。预编码循环将小幅身体运动量化到 0.25 像素，交互绘制使用连续时间。

此目录是用户授权纳入版本库的个人 IP 源资产。角色使用遵循所有者授权，仓库其他代码的许可单独适用。文件大小与 SHA-256 见 `manifest.json`。

重新合成时在仓库根运行 `node assets/personal-ip/build-expressions.mjs`，使用核心已配置的 Skia Canvas。`manifest.json` 登记当前源素材与文件哈希；修改素材后同时更新个人 IP 清单，以及封面模板清单中的共享来源哈希。影片已复制并登记的素材按各片版本独立保存。
