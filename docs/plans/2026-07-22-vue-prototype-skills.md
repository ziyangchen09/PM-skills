# Vue Prototype Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增两个职责单一、可独立验证的产品经理 Skill：沉淀历史页面设计上下文，并基于 PRD 与该上下文生成可通过提示词局部微调的 Vue 3 交互原型。

**Architecture:** `pm-ui-context-builder` 只负责形成可追溯的项目级设计上下文；`pm-prototype-studio` 只消费 PRD、设计上下文与明确反馈，创建版本化 Vue 原型。两者复用现有 `pm-knowledge/projects/<project-id>/` 存档结构，并通过现有根安装器统一安装。

**Tech Stack:** Markdown Skill 协议、Node.js 标准库、Vue 3、Vite、PowerShell 安装器。

---

### Task 1: 初始化两个 Skill 骨架

**Files:**
- Create: `pm-ui-context-builder/`
- Create: `pm-prototype-studio/`

1. 使用系统 `skill-creator/scripts/init_skill.py` 分别初始化目录、资源目录与 `agents/openai.yaml`。
2. 检查生成目录，不创建 Skill 内部 README。

### Task 2: 实现页面设计上下文 Skill

**Files:**
- Modify: `pm-ui-context-builder/SKILL.md`
- Create: `pm-ui-context-builder/references/design-context-schema.md`
- Create: `pm-ui-context-builder/assets/design-context-template.md`
- Create: `pm-ui-context-builder/scripts/validate-design-context.js`

1. 定义输入、事实/推断边界、项目级存档路径与输出契约。
2. 提供紧凑模板，覆盖页面基线、设计变量、可复用组件、禁止臆造和待确认项。
3. 实现安全路径与必需字段校验，并提供 `--self-test`。

### Task 3: 实现 Vue 原型 Skill

**Files:**
- Modify: `pm-prototype-studio/SKILL.md`
- Create: `pm-prototype-studio/references/prototype-contract.md`
- Create: `pm-prototype-studio/assets/prototype-manifest-template.md`
- Create: `pm-prototype-studio/assets/vue-starter/`
- Create: `pm-prototype-studio/scripts/init-vue-prototype.js`

1. 定义默认沿用历史页面、主流程可交互、局部微调和版本化规则。
2. 提供最小 Vue 3/Vite 起步模板，不引入后端、鉴权或生产交付承诺。
3. 实现安全、只创建不覆盖的原型初始化脚本，并提供 `--self-test`。

### Task 4: 接入统一安装与使用说明

**Files:**
- Modify: `install.ps1`
- Modify: `PM-skills-pre-PRD-pack-v2/install.ps1`
- Modify: `README.md`
- Modify: `PM-skills-pre-PRD-pack-v2/README.md`

1. 将两个来源加入现有暂存、校验、备份、安装和回滚链路。
2. 在安装前显式运行新增脚本自测。
3. 更新能力总览、设计分支、常用指令、知识目录和安装数量。

### Task 5: 验证与安装

1. 运行两个新增脚本的 `--self-test`。
2. 对两个 Skill 运行 `quick_validate.py`。
3. 对两级 PowerShell 安装器执行解析检查。
4. 使用隔离 `TargetRoot` 安装全部 8 个 Skill，并从安装副本复测。
5. 验证通过后，将两个新增 Skill 同步到本机已安装 Skill 目录。
