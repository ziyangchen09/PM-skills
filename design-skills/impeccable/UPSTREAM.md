# 来源与适配范围

- 上游：https://github.com/pbakaus/impeccable
- 固定提交：`d34c87e1a00989ae8dbdd7f6b30b70f23319e860`
- 上游技能版本：4.8.0；本地版本：4.8.0-pm-docs.1。
- 许可证：Apache-2.0，完整文本保留于 LICENSE。
- 修改日期：2026-10-27。
- 参考内容：`.agents/skills/impeccable/SKILL.md`、`reference/polish.md`、`reference/typeset.md`、`reference/layout.md`、`reference/quieter.md`。
- 本地改写：中文入口与精修参考；增加只读评审入口，将相关检查收敛到已有 PRD、设计上下文和原型验证记录。
- 裁剪：不分发引擎、launchers、实时浏览器脚本、自动 hooks、检测器、原生平台流程、代理配置或存储工具；无需 Node 包、API key、外部上传或自动下载。
- 运行范围：通过宿主已有文件、浏览器和构建工具，在用户授权页面范围内评审或精修。本适配版不包含上游完整 CLI 功能，不能报告其检测结果。

需要上游完整引擎或实时模式时，应另行审查其官方发行包；不要对本适配版运行官方自更新器或静默替换它。
