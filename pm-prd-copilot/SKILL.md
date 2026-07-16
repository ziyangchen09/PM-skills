---
name: pm-prd-copilot
description: 按产品和项目归档、检索并复用 PRD；读取飞书 Wiki/云文档或本地口述与用户反馈，生成 PRD，检查需求漏洞，生成用户故事，预判研发与 UI 评审问题，并分析需求变更影响。用于用户要求归档或同步 PRD、把零散输入整理成 PRD、审查需求、准备评审、场景化需求或评估变更影响时。
---

# PM PRD Copilot

将方法保存在 Skill 中，将持续增长的业务资料保存在独立的 `pm-knowledge` 目录中。不得把 App Secret、访问令牌或整套业务文档写入 Skill。

## 选择工作流

- 归档飞书或本地 PRD：执行“归档”。
- 将口述、会议记录或反馈整理成 PRD：执行“生成”。
- 查找缺口并准备评审：执行“审查”。
- 将需求改动与旧版本对比：执行“变更影响”。

开始前读取 [archive-schema.md](references/archive-schema.md)。生成 PRD 时读取 [input-to-prd-workflow.md](references/input-to-prd-workflow.md) 和 [prd-quality-checklist.md](references/prd-quality-checklist.md)；审查时读取质量清单；需求变更时读取 [change-impact-rules.md](references/change-impact-rules.md)。

## 定位上下文

1. 在当前工作区查找 `pm-knowledge`；不存在时按归档规范创建最小目录。
2. 从用户输入、来源文档元数据和现有 `product.md`、`project.md` 识别 `product_id` 与 `project_id`。
3. 无法唯一判断项目时，只询问一个必要问题，不猜测归属。
4. 归档、审查和变更分析使用 `rg` 搜索标题、标签、功能名、相关 PRD 和决策；生成 PRD 时优先运行 [build-prd-context.js](scripts/build-prd-context.js)。先读取产品与项目上下文，再读取最相关的历史 PRD；不要默认加载整个资料库。
5. 引用历史信息时标出本地来源路径；区分事实、推断和待确认项。

## 归档

1. 飞书链接优先运行 [archive-feishu-prd.js](scripts/archive-feishu-prd.js)。Wiki 目录先加 `--list-children` 列出直接子节点；遇到 `has_child` 时按需继续列出下一级，只归档目标 `docx`。脚本匹配已有产品与项目、去重并写入本地；保留原始 URL、文档 token、revision 和归档时间，不修改飞书原文。
2. 脚本返回 `classification_required` 时，根据来源路径和候选项只询问一个归属问题，再用 `--product` 与 `--project` 重试。首次确认后把飞书空间或节点 token 写入对应上下文，供后续自动识别。
3. 本地文档、口述或反馈保留来源类型与日期；不得把推断写成原始事实。
4. 同一 `source_token + source_revision` 或同一来源下正文哈希相同，不重复归档。内容变化时创建新版本，不覆盖旧版本。
5. 按 [archive-schema.md](references/archive-schema.md) 写入 Markdown frontmatter 和正文。
6. 图片或附件只在理解需求需要时下载；保留来源关系。

## 生成 PRD

1. 原样保存用户口述转写、会议记录或反馈，记录来源类型；不得先行改写或总结后再检索。
2. 按 [input-to-prd-workflow.md](references/input-to-prd-workflow.md) 运行 [build-prd-context.js](scripts/build-prd-context.js)，生成带来源摘录的上下文包。
3. 复制 [prd-template.md](assets/prd-template.md) 作为输出结构。先列事实、假设、冲突和待确认项，再写建议方案；不得自行补造业务规则。
4. 按不同的角色、目标或触发场景生成最少数量的用户故事；为每个核心故事生成正常场景，并只补充适用的边界、失败和权限场景。未确认规则保留“待确认”。
5. 按质量清单检查草稿；输出“需求缺口”和“评审预判”。每个问题包含依据、影响、建议回答和确认人，不要混入已确认需求。
6. 默认生成本地草稿并保留原始输入来源；不得覆盖已归档版本，也不得自动回写飞书。

## 审查 PRD

1. 按 [prd-quality-checklist.md](references/prd-quality-checklist.md) 检查目标、范围、流程、状态、权限、数据、依赖、验收和上线风险。
2. 将问题分为 `P0 阻塞`、`P1 高风险`、`P2 优化`。
3. 先用历史资料回答已有结论；仅将冲突或仍未解决的决策分别转成研发和 UI 可能提出的问题。
4. 每个问题说明触发依据、不确认的影响、建议回答和确认人。只保留能改变决策或降低返工的问题。

## 变更影响

1. 找到同一需求的上一个归档版本；无法唯一判断时先列候选，不得自行选择。
2. 按 [change-impact-rules.md](references/change-impact-rules.md) 运行 [analyze-prd-change.js](scripts/analyze-prd-change.js)，生成章节差异和相关文档候选。
3. 逐个 `CHG-ID` 检查 PRD、流程、UI、接口、数据、权限、埋点、测试、迁移回滚和发布说明。关键词命中只算候选，不算确定影响。
4. 输出影响矩阵及具体文档更新建议；只有直接依赖证据才标记“确定”，其余标记“待核实”。
5. 默认将影响报告保存到项目 `changes/` 并保留旧版本；只有用户明确要求时才改写关联文档或回写飞书。

## 完成标准

- 已明确产品、项目、来源和版本。
- 所有引用均可追溯到本地路径或飞书链接。
- 已分离事实、假设、待确认项和建议。
- 新 PRD 含用户故事、验收标准和评审问题。
- 变更分析列出受影响文档及更新建议。
