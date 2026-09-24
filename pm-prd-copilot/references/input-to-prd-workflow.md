# 正式流程：零散输入转 PRD

本文件仅用于用户要求正式准入/交付、从交接包生成，或明确请求未通过前置分析的探索稿。日常写稿、功能概述和局部增量按 `SKILL.md` 的“日常撰写与增量修改”及 [prd-writing-style.md](prd-writing-style.md) 执行，不因缺少阶段产物停止写稿，也不调用本文件的上下文脚本。

本流程的上下文包和完整模板有正式结构要求；日常稿无需生成它们。进入本流程后，精简风格不能替代门禁、来源核验或确认记录。

## 输入契约

- 保留口述转写、会议记录或用户反馈的原文和来源类型。
- 先明确 `product_id` 与 `project_id`；归属不唯一时只询问这一个问题。
- 输入可以不完整。除项目归属外，不要因缺少细节停止前置分析；未通过 Readiness Gate 时不得生成正式 PRD。
- 原始输入依次交给 `pm-demand-intake`、`pm-problem-framing`、`pm-solution-designer` 和 `pm-prd-readiness-gate`。本 Skill 只消费最终交接包，不重复完成前置阶段职责。

## 背景检索

已有 `readiness.md` 时，先运行 `pm-prd-readiness-gate` 的确定性校验器。只有 READY 或 CONDITIONAL 且校验通过，才能运行：

```text
node scripts/build-prd-context.js --root <pm-knowledge> --product <product-id> --project <project-id> --requirement <requirement-id> --output <context-file>
```

该模式按 `readiness.md → handoff.md → problem.md → solutions.md` 读取本轮前置分析。NOT_READY、ID 不一致或校验失败时不得生成正式 PRD。

只有用户明确要求查看“前置分析未通过”的探索稿时，才将原始输入保存为 UTF-8 文本文件并运行：

```text
node scripts/build-prd-context.js --root <pm-knowledge> --product <product-id> --project <project-id> --input <input-file> --exploratory --source-type <spoken|feedback|meeting-notes|local-notes> --output <context-file>
```

脚本只做可解释的词面检索，返回产品/项目上下文、已确认决策及带来源摘录的相关资料。该模式不判断需求真假、不自动采纳历史规则，也不具备正式 PRD 准入资格。`handoff.md` 禁止通过 `--input` 读取，必须改用 `--requirement` 触发校验。

指定 `--output` 时只创建新上下文文件；目标已存在即停止，不覆盖既有上下文、输入或任何已校验阶段产物。

## 生成顺序

1. 从上下文包提取四类信息：事实、假设、冲突、待确认。
   交接包模式下，`handoff.md` 是本轮主输入；历史资料只能补充背景和约束。
2. 用 `assets/prd-template.md` 生成正式流程的 PRD 草稿，并按写作参考精简正文；范围表只写概述，细节放到需求详情，来源和评审依据通过引用关联。不得用历史内容静默补齐本轮未确认规则。
   探索模式必须在标题和状态中标记“前置分析未通过”，并把 `readiness` 写为 `NOT_EVALUATED`。
3. 按不同的角色、目标或触发场景生成最少数量的用户故事，并为核心故事生成可测试的场景覆盖矩阵。
4. 每条关键历史约束在“来源”中记录本地路径；如有飞书链接，同时保留原始链接。
5. 用 `references/prd-quality-checklist.md` 检查草稿，再输出需求缺口和评审预判。
6. 将交接包路径写入 `source_analysis` 和“来源”表，然后运行：

```text
node scripts/validate-prd.js --prd <prd.md> --handoff <requirement-directory>/handoff.md
```

生成 PRD 时把当前交接包的 `updated_at` 写入 `handoff_updated_at`，并把完整文件 SHA-256 写入 `handoff_sha256`。校验器要求 `source_analysis` 与“来源”表真实指向同一个本地 `handoff.md`，指纹与时间完全一致，并重新执行前置门禁；handoff 更新后旧 PRD 自动失效。正式 PRD 的用户故事和验收场景必须已确认，P1 只能保留在受控待确认表中。必填章节不得重复，受控章节不得用第二张表隐藏问题，核心章节不得保留 `待补充`、`TODO` 或 `TBD` 占位。

校验通过后使用 create-only 保存命令：

```text
node scripts/save-prd.js --input <draft.md> --handoff <requirement-directory>/handoff.md --root <pm-knowledge>
```

目标版本文件已存在时停止；必须提升 `version` 并重新生成、校验，不能覆盖旧 PRD。

校验失败时保持草稿状态并修正错误；只有校验通过的 READY 或 CONDITIONAL 文件才能作为正式 PRD 交付。

## 输出契约

- 所有待确认内容使用低亮度红色 `#A65A5A`：`<span style="color:#A65A5A">待确认：具体内容</span>`。表格中只包裹待确认单元格内容，不整行染色；同一条内容不要重复着色。渲染器不支持 HTML 时，必须保留“待确认”文本作为降级提示。
- `PRD 草稿`：事实与建议方案分开；用户故事含角色、触发场景、目标、价值、依据和确认状态。
- `PRD frontmatter`：交接包模式必须填写 `requirement_id`、`readiness` 和 `source_analysis`。
- `CONDITIONAL P1`：沿用交接包中的 P1-ID，并原样保留等级、影响、负责人和最晚确认节点；不得改成普通 TBD 或只保留数量。
- `正式 PRD 校验`：不得包含开放 P0；用户故事和验收场景必须可测试，且 CONDITIONAL 的全部 P1 必须与 `handoff.md` 逐字段一致。
- `场景覆盖矩阵`：使用 `AC-ID | 关联故事 | 类型 | Given | When | Then | 状态`；至少覆盖正常路径，只添加适用的边界、失败和权限场景。
- `需求缺口`：使用 `REV-ID | ID | 问题 | 等级 | 依据 | 影响 | 建议 | 需谁确认`；等级仅用 P0/P1/P2。
- `研发评审预判`：使用 `REV-ID | 问题 | 等级 | 关联缺口/依据 | 不确认的影响 | 建议回答 | 确认人`，聚焦状态、数据、接口、权限、兼容、性能、迁移、回滚和可测试性。
- `UI 评审预判`：使用同一表格，聚焦入口、布局、文案、交互反馈、空/错/loading/无权限状态、极端数据和响应式边界。
- `评审结论与签署`：必须覆盖上述每一个 `REV-ID`；`resolved/accepted-risk` 需要最终决策、存在且带定位的本地确认来源、确认人和带时区确认时间。
- 每个问题都要引用触发它的原文或明确指出缺失字段；删除无法改变决策或减少返工的问题。
