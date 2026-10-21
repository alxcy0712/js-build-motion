# 当前独立影片

恢复时读[创作主线](guide/motion.md#创作主线)、[个人识别](guide/style-and-identity.md)，核对brand、prompt-history、NOTES、evidence/events与review的已选项和待验收项。制作以本片guide及固定.engine为版本依据。

按[workflow](guide/workflow.md)补齐原文问答与重要选择，已有授权/委托沿用；[direction](guide/direction.md)编排全片动态粗剪和正式素材重点样片，[drawing](guide/drawing.md)实现，[captions](guide/captions.md)排时序，[layout-and-quality](guide/layout-and-quality.md)核当前编码。包装选用/变体/实现状态入events，实际观察与修正入review。

素材/参考/模型纹理在assets，代码/组件/依赖副本在src，截图/日志/分镜在evidence，成片及临时文件在out，工具TMPDIR为out/.tmp。固定宿主输出立即迁入本片；沟通原文只追加prompt-history，中转入库后清理。

从仓库根使用node .skill/scripts/video.mjs <slug> <command>，通用命令用exec；Linux手建项目用本AGENTS前置说明和workflow的Linux入口。系统沙箱覆盖制作进程及后代，宿主工具按任务范围和权限访问。.engine和brand保留初始化版本，本片src及组件可编辑；画面按seed/spec/frame求值。run和DISCLOSURE由引擎生成，检查缺口pending。

学习状态初始pending；明确授权核心复盘时由宿主读仓库maintenance规范，完成备份/检查/seal后记录learned、版本、证据与成片待办。已有授权与明确逐次审批要求保持有效。
