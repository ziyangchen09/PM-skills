# 产品原型样式能力升级

日期：2026-10-27。用户确认执行的范围：接入 UI UX Pro Max、更新 Frontend Design、补充 Impeccable，并完善原型设计模式、设计规范和截图验收。未修改已有业务原型或医学规则。

## 更新内容

- `pm-prototype-studio` 增加 preserve / refine / explore 三种模式，默认仍然沿用样式；局部精修不扩大到整体改版，新项目允许从设计简报开始探索，不伪造历史上下文。
- 初始化器新增 `--design-mode`，默认 preserve，拒绝未知值，写入版本清单。原有版本隔离、源文件复制、符号链接检查和路径约束保留。
- 新视觉提案保存在本版 `visual-spec.md`；项目复用规则经确认后才进入 `design/style-guide.md`，必要时保存页面覆盖项。
- 增加设计技能选择、中文和密集表格适配、深色阅片区、风险颜色语义、焦点/可访问名称及实际截图验收要求。
- `pm-ui-context-builder` 继续只记录可追溯事实和推断；明确生成提案不属于已有事实。

## 外部技能来源与审查

| 技能 | 来源/版本 | 本次处理 |
| --- | --- | --- |
| UI UX Pro Max | 现有用户技能目录 `$HOME/.agents/skills/ui-ux-pro-max-0.1.0` | 接入实际 search.py 路径与 Vue 检索，不重复安装 |
| Frontend Design | anthropics/skills，提交 `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | 使用官方 SKILL.md 和 LICENSE.txt，更新现有同名能力，不新增重复入口 |
| Impeccable | pbakaus/impeccable，提交 `d34c87e1a00989ae8dbdd7f6b30b70f23319e860`，上游技能 4.8.0 | 安装本地 `4.8.0-pm-docs.1` 文档适配版，明确不是官方完整 CLI |

固定来源与文件 SHA256 见 `design-skills/sources.json`。Frontend Design 的官方文本保持原样；Impeccable 的入口和精修参考经过中文改写和裁剪，修改声明及采用的上游文件见 `design-skills/impeccable/UPSTREAM.md`，保留 Apache-2.0 许可证。

审查对象为最终安装候选的全部 6 个文件：Frontend Design 2 个、Impeccable 4 个。均为明文指令、来源说明或许可证；不包含执行程序、混淆代码、依赖安装器、密钥读取或外部上传。精修通过宿主已获授权的文件/浏览器/构建能力执行，属于中等权限范围的文件操作，修改须保持在用户指定范围。未执行或安装上游完整包中的自动下载引擎、实时浏览器脚本、hooks 或代理配置；不声称这些功能已经审查通过。

## 安装位置与本地备份

以下路径以本次 Windows 用户安装为例，`$HOME` 表示用户主目录；备份和验证产物只保存在本地，不随 GitHub 仓库发布。

- PM 原型技能：`$HOME/.codex/skills/pm-prototype-studio/`。
- PM 设计上下文：`$HOME/.codex/skills/pm-ui-context-builder/`。
- Frontend Design：更新 `$HOME/.agents/skills/frontend-design-3-0.1.0/`；保留现有目录入口，内容来自官方提交，目录旧版本后缀不代表更新后版本。
- Impeccable 文档适配版：`$HOME/.codex/skills/impeccable/`。
- 修改前的项目源码和 README：`outputs/skills-style-upgrade-20261027/before/`。
- 实际安装目标、备份路径和文件校验结果：`outputs/skills-style-upgrade-20261027/installation.json`；备份只在替换现有技能时创建。

现有根 `install.ps1` 仍维护原来的 PM 技能包，包含本次新增的原型参考文件；`design-skills` 中两个独立技能不被该安装器自动覆盖。后续更新应先审查新版本并备份目标，再同步完整技能目录，不对本地适配版运行上游自更新器。

## 已执行验证

- 四个技能源码的 `quick_validate.py` 校验通过。
- 原型初始化器自测通过：默认/局部升级/探索模式、非法模式拒绝、版本递增、旧源码保留、依赖跳过、路径和符号链接保护。
- 设计上下文校验器自测通过。
- 现有根安装器在项目内隔离目录安装全部 8 个 PM 技能成功，门禁和配套脚本自测通过；该检查没有覆盖用户全局的其他技能。
- UI UX Pro Max 实际生成设计规范建议成功，Vue 栈检索返回 3 条结果；输出保存在 `outputs/skills-style-upgrade-20261027/work/checks/`。
- 全局安装后四个技能再次通过格式校验，PM 原型初始化器和上下文校验器在已安装路径下自测通过；全部安装文件的 SHA256 与源码一致。
- Git 差异空白检查通过。保留本轮开始前已有的 README、.gitignore、其他文档及未跟踪文件修改。

本轮验证针对技能配置、脚本和安装文件；没有生成业务页面，也没有执行一次完整的新页面视觉设计任务，不能据此宣称实际页面视觉效果已经验收。后续生成原型时按新增规则记录截图和操作证据。

## 使用示例

```text
用 pm-prototype-studio 局部升级这个表格的层级、行高和选中态，其余区域保持不变。
用 pm-prototype-studio 为这个新模块探索视觉方向，先比较代表页面，再展开选定方案。
用 impeccable polish 精修这个原型，只调整排版和间距，保留配色和业务交互。
```
