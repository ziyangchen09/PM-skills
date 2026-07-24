# 与 pm-prd-copilot 的集成建议

`pm-prd-copilot` 已接入飞书 Wiki 目录增量同步、单文档归档、生成、审查、状态和变更影响工作流，并支持“从 PRD 交接包生成”。本文件保留边界和读取顺序说明。

## 建议修改 1：description

在原 description 中补充：

```text
也可读取 pm-prd-readiness-gate 生成的 PRD 交接包，在保留事实、假设、决策和待确认边界的前提下生成 PRD。
```

## 建议修改 2：选择工作流

增加：

```markdown
- 已有 PRD 准入报告或交接包：执行“从交接包生成”。
```

## 建议修改 3：生成 PRD 前置判断

在“生成 PRD”开头增加：

```markdown
0. 如果存在同一产品、项目和 `requirement_id` 的 `readiness.md`：
   - `READY`：校验通过后读取同目录 `handoff.md` 生成 PRD。
   - `CONDITIONAL`：校验通过后读取 `handoff.md`，并把每个 P1 的 ID、等级、影响、负责人和最晚确认节点原样保留为待确认或风险，不得静默补齐或只保留数量。
   - `NOT_READY`：不得读取或生成 `handoff.md`；默认不生成正式 PRD。用户明确要求时可以生成探索性草稿，但必须在标题和状态中标记“前置分析未通过”。
   - ID 不一致或校验失败：按 `NOT_READY` 处理，不自动跨项目查找同名需求。
```

## 建议修改 4：上下文读取顺序

生成 PRD 时建议按以下顺序：

```text
product.md
→ project.md
→ decisions.md
→ requirements/<requirement-id>/readiness.md
→ handoff.md
→ evidence.md（仅研究分支）
→ problem.md
→ solutions.md
→ 相关历史 PRD
→ 原始输入
```

`readiness.md` 负责提供门禁结论，`handoff.md` 负责提供已通过校验的 PRD 输入；历史 PRD 只能补充背景和约束，不能覆盖本轮明确决策。

## 建议修改 5：PRD frontmatter

可选增加：

```yaml
requirement_id: "REQ-YYYYMMDD-feature-slug"
readiness: "READY|CONDITIONAL|NOT_READY"
source_analysis:
  - "requirements/<requirement-id>/handoff.md"
  - "requirements/<requirement-id>/problem.md"
  - "requirements/<requirement-id>/solutions.md"
  - "requirements/<requirement-id>/readiness.md"
```

## 建议路由

```text
用户说“把这个需求整理一下”
→ pm-demand-intake

用户说“帮我分析为什么要做”
→ pm-problem-framing

用户说“证据不足，先验证需求是否真实”
→ pm-evidence-research

用户说“有哪些方案”
→ pm-solution-designer

用户说“可以开始写 PRD 了吗”
→ pm-prd-readiness-gate

用户说“基于已确认方案写 PRD”
→ pm-prd-copilot
```

## 重要边界

- `pm-prd-copilot` 不应重新发明已经在交接包中确认的需求背景。
- 历史资料与本轮交接包冲突时，应暴露冲突，不自动选历史结论。
- CONDITIONAL 中的待确认项必须进入 PRD 的待确认或风险章节。
- NOT_READY 默认不能伪装成正式可研发 PRD。
- 正式 PRD 必须运行 `validate-prd.js`，真实引用同一个本地 `handoff.md`，且再次通过 readiness 校验。
- 阶段产物只有具备确认人、确认时间和直接确认来源时才能作为 `confirmed` 消费；上游更新会使下游交接失效。
