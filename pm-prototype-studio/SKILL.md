---
name: pm-prototype-studio
description: 基于已确认 PRD、项目设计上下文和历史 Vue 页面，生成可运行、可版本化并可通过提示词局部微调的 Vue 3 交互原型。适用于产品经理需要快速验证新功能页面、演示主业务流程或向研发和 UI 说明交互方案的场景；不用于生产前端交付、Figma 回写、后端、鉴权或真实数据接入。
---

# PM Prototype Studio

## 职责边界

本 Skill 只负责产品验证级 Vue 原型。默认复用已有页面结构、设计变量和组件规则，不重新发明整套视觉语言；生产代码拆分、接口联调、权限安全和正式切图不属于本阶段。

默认产物：

```text
pm-knowledge/projects/<project-id>/prototypes/<requirement-id>/vNNN/
```

开始前完整阅读 `references/prototype-contract.md`。

## 准入输入

至少具备：

- 已确认 PRD 或通过门禁的 `handoff.md`；
- 目标项目、需求 ID 和要验证的主场景；
- 已通过 `$pm-ui-context-builder` 校验的 `design/context.md`。

如缺少设计上下文，先调用 `$pm-ui-context-builder`，不要根据单张截图臆造全局规范。若用户明确要求全新视觉探索，可以先提出方向，但仍须把选定方向和既有规则的偏离写入原型说明。

## 工作流

1. 确认 `project_id`、`requirement_id`、输入 PRD 和设计上下文；实际查看所有参考截图、页面和关键 Vue 文件。
2. 初始化下一版本。首次复制 Vue starter；已有版本时自动复制上一版的源码，但不复制依赖和构建产物：

```powershell
node scripts/init-vue-prototype.js --root <pm-knowledge> `
  --project <project-id> --requirement <requirement-id>
```

3. 把 PRD 的主场景、关键状态、异常反馈和验收结果映射到原型；优先修改 `src/App.vue` 与 `src/styles.css`，只有确有复用价值时才拆组件。
4. 用 `design/context.md` 中有来源的变量和组件规则还原历史风格；待确认内容使用显式占位或说明，不伪装成已确定方案。
5. 实现一条可从入口走到结果的主流程。按钮、表单、切换、校验、弹窗或状态反馈不能只是静态装饰。
6. 填写根目录 `prototype.md`：输入依据、本版范围、交互清单、未实现项和验证结果。
7. 安装依赖并验证预览与构建：

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build
```

## 提示词微调规则

- 用户点名局部范围时，只修改该范围及其直接依赖；导航、布局、配色或其他流程默认保持不变。
- 每轮修改前运行初始化脚本创建下一版本，不覆盖旧版本，也不直接改已确认版本。
- 把“保留什么、改什么、验收条件”追加到新版本 `prototype.md` 的“局部微调记录”。
- 如果反馈会改变 PRD 规则、数据结构或跨系统流程，先提示影响并回到 `$pm-prd-copilot` 处理需求变更，不在原型里静默决定。

## 完成标准

- Vue 3/Vite 项目可启动，主流程可交互，关键状态与 PRD 一致；
- 页面可追溯到 PRD、设计上下文和参考页面，未确认内容明确标记；
- 用户未点名的区域与上一版保持一致；
- `prototype.md` 已记录范围、差异、未实现项和构建结果；
- 输出被明确称为“交互原型”，不宣称可直接上线。
