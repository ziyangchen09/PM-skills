---
name: pm-prototype-studio
description: 基于已确认 PRD 生成可运行、可版本化的 Vue 3 交互原型，支持沿用样式、局部视觉升级和全新视觉探索，按需结合 UI UX Pro Max、Frontend Design 与 Impeccable，并检查实际渲染。适用于产品验证和研发/UI 沟通；不用于生产前端交付、Figma 回写、后端、鉴权或真实数据接入。
---

# PM Prototype Studio

## 职责边界

本 Skill 只负责产品验证级 Vue 原型。默认复用已有页面结构、设计变量和组件规则，不重新发明整套视觉语言；生产代码拆分、接口联调、权限安全和正式切图不属于本阶段。

默认产物：

```text
pm-knowledge/projects/<project-id>/prototypes/<requirement-id>/vNNN/
```

开始前完整阅读 `references/prototype-contract.md`。涉及视觉方案、样式修改或样式验收时，再读 `references/visual-design.md`。

## 准入输入

至少具备：

- 已确认 PRD 或通过门禁的 `handoff.md`；
- 目标项目、需求 ID 和要验证的主场景；
- 沿用样式或局部视觉升级时，提供已通过 `$pm-ui-context-builder` 校验的 `design/context.md`；全新视觉探索可使用明确的设计简报和已有参考。

有历史页面而缺少设计上下文时，先调用 `$pm-ui-context-builder`；不要根据单张截图臆造全局规范。全新项目没有历史样式时，记录该事实，按探索模式提出方案，不编造历史规范或伪造上下文校验通过。

## 设计模式

| 模式 | 初始化参数 | 适用情况 | 样式边界 |
| --- | --- | --- | --- |
| 沿用样式 | `preserve`（默认） | 功能迭代、交互修复、未明确要求改版 | 保留既有视觉，只修改任务所需区域 |
| 局部视觉升级 | `refine` | 指定表格、面板、弹窗或页面精修 | 优化指定范围，不替换产品整体视觉语言 |
| 全新视觉探索 | `explore` | 新产品，或用户明确要求新风格/整体改版 | 先用代表页面比较方向，再按选定方向展开 |

用户已给出具体设计或选定方案时直接实现，不重复选型。通用“做个原型”不等于授权整体改版。

## 工作流

1. 确认 `project_id`、`requirement_id`、输入 PRD、设计模式和适用的设计依据；实际查看所有本轮参考截图、页面和关键 Vue 文件。
2. 初始化下一版本。首次复制 Vue starter；已有版本时自动复制上一版的源码，但不复制依赖和构建产物：

```powershell
node scripts/init-vue-prototype.js --root <pm-knowledge> `
  --project <project-id> --requirement <requirement-id> --design-mode preserve
```

3. 把 PRD 的主场景、关键状态、异常反馈和验收结果映射到原型；优先修改 `src/App.vue` 与 `src/styles.css`，只有确有复用价值时才拆组件。
4. 按设计模式执行 `references/visual-design.md`：先复用有效的设计规范；需要时调用可用的设计技能。探索稿和待确认值保存在本版 `visual-spec.md`，不覆盖项目已确认规范。
5. 实现一条可从入口走到结果的主流程。按钮、表单、切换、校验、弹窗或状态反馈不能只是静态装饰。
6. 填写根目录 `prototype.md`：输入依据、设计模式、规范来源、本版范围、交互清单、未实现项和验证结果。
7. 安装依赖并验证预览与构建：

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build
```

8. 在实际浏览器走完主流程，按视觉设计参考检查目标尺寸和关键状态，保存截图与操作结果；构建通过不代表视觉或交互验收通过。

## 提示词微调规则

- 用户点名局部范围时，只修改该范围及其直接依赖；导航、布局、配色或其他流程默认保持不变。
- 每轮修改前运行初始化脚本创建下一版本，不覆盖旧版本，也不直接改已确认版本。
- 把“保留什么、改什么、验收条件”追加到新版本 `prototype.md` 的“局部微调记录”。
- 如果反馈会改变 PRD 规则、数据结构或跨系统流程，先提示影响并回到 `$pm-prd-copilot` 处理需求变更，不在原型里静默决定。

## 完成标准

- Vue 3/Vite 项目可启动，主流程可交互，关键状态与 PRD 一致；
- 页面可追溯到 PRD、设计上下文和参考页面，未确认内容明确标记；
- 用户未点名的区域与上一版保持一致；
- `prototype.md` 已记录范围、差异、未实现项、构建结果及实际截图/交互检查；工具不可用时明确列出未验证项，不勾选通过；
- 输出被明确称为“交互原型”，不宣称可直接上线。
