---
name: pm-prd-copilot
description: 按产品和项目递归增量同步飞书 Wiki PRD 目录，归档、检索并复用 PRD；将口述、反馈和会议记录先路由到 PRD 前置分析链，再基于 pm-prd-readiness-gate 校验通过的交接包生成 PRD、用户故事、需求缺口和研发/UI 评审问题，并分析需求变更影响。用于同步或归档 PRD、把零散输入推进为 PRD、审查需求、准备评审、场景化需求或评估变更影响时。
---

# PM PRD Copilot

将方法保存在 Skill 中，将持续增长的业务资料保存在独立的 `pm-knowledge` 目录中。不得把 App Secret、访问令牌或整套业务文档写入 Skill。

## 选择工作流

- 同步已登记的飞书 Wiki PRD 目录或归档单个飞书/本地 PRD：执行“归档”。
- 将口述、会议记录或反馈推进为 PRD：先执行前置分析链，再执行“生成”。
- 已有 `readiness.md` 或 `handoff.md`：执行“从交接包生成”。
- 查找缺口并准备评审：执行“审查”。
- 将需求改动与旧版本对比：执行“变更影响”。
- 查询一个需求当前阶段或生成项目需求索引：执行“状态”。

开始前读取 [archive-schema.md](references/archive-schema.md)。生成 PRD 时读取 [input-to-prd-workflow.md](references/input-to-prd-workflow.md) 和 [prd-quality-checklist.md](references/prd-quality-checklist.md)；审查时读取质量清单；需求变更时读取 [change-impact-rules.md](references/change-impact-rules.md)。

## 定位上下文

1. 在当前工作区查找 `pm-knowledge`；不存在时按归档规范创建最小目录。
2. 从用户输入、来源文档元数据和现有 `product.md`、`project.md` 识别 `product_id` 与 `project_id`。
3. 无法唯一判断项目时，只询问一个必要问题，不猜测归属。
4. 归档、审查和变更分析使用 `rg` 搜索标题、标签、功能名、相关 PRD 和决策；生成 PRD 时优先运行 [build-prd-context.js](scripts/build-prd-context.js)。先读取产品与项目上下文，再读取最相关的历史 PRD；不要默认加载整个资料库。
5. 引用历史信息时标出本地来源路径；区分事实、推断和待确认项。
6. 需要判断下一步时运行 [requirement-status.js](scripts/requirement-status.js)；它只读取现有阶段产物，不建立第二套状态库。

## 归档

1. 单个飞书链接运行 [archive-feishu-prd.js](scripts/archive-feishu-prd.js)。已登记 Wiki PRD 根目录运行 [sync-feishu-wiki.js](scripts/sync-feishu-wiki.js)；它递归遍历全部层级，并仅把明确映射到项目的 `docx` 归档。脚本在正文与块列表读取前后核对 revision，保留原始 URL、文档 token、内容完整度、富内容签名和归档时间，不修改飞书原文。
2. 脚本返回 `classification_required` 时，根据来源路径和候选项只询问一个归属问题，再用 `--product` 与 `--project` 重试。首次确认后把飞书空间或节点 token 写入对应上下文，供后续自动识别。
3. 本地 Markdown/TXT 运行 [archive-local-prd.js](scripts/archive-local-prd.js)，明确传入已登记且归属一致的产品和项目；其他格式先用对应格式工具转换。Markdown 含本地图片或附件引用时默认停止，只有用户明确接受资源未随档复制后才使用 `--allow-incomplete`。口述或反馈保留来源类型与日期；不得把推断写成原始事实。
4. 飞书以 `source_token + revision + archive_hash`，本地以来源路径、正文和完整度信息去重。正文或富内容签名变化时创建新版本，不覆盖旧版本。
5. 按 [archive-schema.md](references/archive-schema.md) 写入 Markdown frontmatter 和正文。
6. 飞书文档含图片、附件、表格、评论、封面、链接语义、嵌入内容或未知块时，自动通过官方导出接口保存同版本 DOCX 富内容快照；只有 revision 稳定、DOCX 格式有效且大小与 SHA-256 校验通过后，才标记为 `rich-export`。导出失败时停止，不得自动降级；仅在用户明确接受纯文本缺失后才使用 `--allow-incomplete`。

### Wiki 目录增量同步

1. 只有产品 `product.md` 的 `feishu_sync_roots` 明确登记的根 URL 才能同步；使用项目 `project.md` 的 `feishu_sync_subtrees` 把子树映射到唯一项目。不得用标题猜归属，也不得把仅用于检索提示的 `feishu_node_tokens` 当作批量同步授权。
2. 运行：

```text
node scripts/sync-feishu-wiki.js --product <product-id> --root <pm-knowledge>
```

需要先核对时加 `--dry-run`；预演不得创建归档或同步清单。
3. 每轮完整读取已映射文档的正文和块签名。内容未变时复用本地归档；正文或富内容签名变化时只创建新版本。不要仅凭 revision 跳过读取。
4. 根页和项目子树入口只有在读取后确认正文为空且无富内容时才能标记为结构节点；有内容的项目入口按普通 PRD 处理，未映射根页有内容时返回 `partial`，不得静默跳过。
5. 同步清单按代际只创建在 `.sync/feishu/<scope-id>/manifests/`；清单是可重建的派生状态，不替代归档事实。运行锁存在时停止，不并发写同一同步根。
6. 根目录或分页失败时不提交新清单。单文档失败、未映射子树或完整度阻塞时继续其他节点并返回 `partial`；不得自动放宽 `--allow-incomplete`。
7. 节点移动或改名只更新清单；内容未变时不复制 PRD。节点第一次未出现标为 `suspected_removed`，连续第二次才标为 `removed_from_scope`；任何情况都不删除本地历史归档。

## 生成 PRD

0. 正式 PRD 不得绕过前置分析链：
   - 只有口述、会议记录或反馈时，原样保存输入，先进入 `pm-demand-intake`；证据不足时按受理结论进入 `pm-evidence-research`，随后再进入 `pm-problem-framing`、`pm-solution-designer` 和 `pm-prd-readiness-gate`。本 Skill 不重复生成这些前置阶段的结论。
   - 已存在同一产品、项目和 `requirement_id` 的前置产物时，先运行 `pm-prd-readiness-gate/scripts/validate_handoff.py <requirement-directory>`；校验失败时按 NOT_READY 处理。
   - READY：以 `handoff.md` 为本轮主输入生成正式 PRD。
   - CONDITIONAL：以 `handoff.md` 生成草稿，并把全部 P1 原样保留到待确认项或风险章节。
   - NOT_READY：不得读取或生成 `handoff.md`，默认只输出阻塞项和最短补齐路径。用户明确要求时可生成探索性草稿，但标题和状态必须标记“前置分析未通过”。
   - 运行 [build-prd-context.js](scripts/build-prd-context.js) 时使用 `--requirement <requirement-id>`；ID 不一致或找不到校验器时停止，不跨项目搜索同名需求。
   - 只有用户明确要求跳过前置分析查看探索稿时，才可使用 `--input <file> --exploratory`；该产物不得标记为正式 PRD，`readiness` 必须为 `NOT_EVALUATED`。
1. 原样保存用户口述转写、会议记录或反馈，记录来源类型；不得先行改写或总结后再检索。
2. 按 [input-to-prd-workflow.md](references/input-to-prd-workflow.md) 运行 [build-prd-context.js](scripts/build-prd-context.js)，生成带来源摘录的上下文包。
3. 复制 [prd-template.md](assets/prd-template.md) 作为输出结构。先列事实、假设、冲突和待确认项，再写建议方案；不得自行补造业务规则。
4. 按不同的角色、目标或触发场景生成最少数量的用户故事；为每个核心故事生成正常场景，并只补充适用的边界、失败和权限场景。草稿中的未确认规则进入 P1，并用 `<span style="color:#A65A5A">待确认：具体内容</span>` 标记；正式校验前，用户故事和验收场景状态必须为“已确认”，不能把“待确认”混入正式规则。
5. 按质量清单检查草稿；输出“需求缺口”和“评审预判”。每个问题分配唯一 `REV-ID`，包含依据、影响、建议回答和确认人，并在“评审结论与签署”使用同一 ID 闭环；不要混入已确认需求。
6. 生成草稿时记录当前 `handoff_updated_at` 和完整文件的 `handoff_sha256`。运行 [validate-prd.js](scripts/validate-prd.js) 对照真实 `handoff.md` 检查正式 PRD；校验器会重新运行前置门禁、核对 handoff 指纹与本地来源，并拒绝重复章节/第二张受控表、开放 P0 和占位内容。失败时保持草稿并修正，不得交付为正式 PRD。
7. 默认先生成工作草稿并保留原始输入来源。正式保存必须运行 [save-prd.js](scripts/save-prd.js)，它会先校验再按版本创建新文件；目标已存在时停止，不得覆盖已归档版本，也不得自动回写飞书。
8. 交接包中的本轮已确认事实和决策优先于历史资料；发现冲突时暴露冲突，不静默选择历史结论。
9. 新 PRD 使用 `projects/<project-id>/prds/YYYY-MM-DD-<requirement-slug>-v<version>.md`。保存命令：

```text
node scripts/save-prd.js --input <draft.md> --handoff <requirement-directory>/handoff.md --root <pm-knowledge>
```

文件已存在时应提升 `version` 后重新生成和校验，不能只更换时间戳伪装成新版本。

## 审查 PRD

1. 按 [prd-quality-checklist.md](references/prd-quality-checklist.md) 检查目标、范围、流程、状态、权限、数据、依赖、验收和上线风险。
2. 将问题分为 `P0 阻塞`、`P1 高风险`、`P2 优化`。
3. 先用历史资料回答已有结论；仅将冲突或仍未解决的决策分别转成研发和 UI 可能提出的问题。
4. 每个问题说明触发依据、不确认的影响、建议回答和确认人。只保留能改变决策或降低返工的问题。
5. 使用来源问题的同一个稳定 `REV-ID` 写入“评审结论与签署”，不得遗漏或另起无法映射的 ID。只有当前用户或可追溯决策人确认后才能标为 `resolved` 或 `accepted-risk`；决策来源必须是存在且带定位的本地直接确认记录，确认时间使用带时区 ISO-8601。

## 状态

1. 单需求运行：

```text
node scripts/requirement-status.js --root <pm-knowledge> --project <project-id> --requirement <requirement-id>
```

2. 项目级运行时省略 `--requirement`，输出所有需求的当前阶段、Gate、阻塞项和下一 Skill。
3. 状态会检查确认人、确认时间、确认来源、上游过期、交接门禁、正式 PRD 校验和未闭环评审项；可识别 `handoff`、`prd` 与 `complete`。索引只是派生视图，不得反向覆盖阶段产物。

## 变更影响

1. 找到同一 `requirement_id` 的上一个归档版本；旧、新版本号必须可比较且新版严格更高。无法唯一判断、跨需求或倒序时停止，不得自行选择。
2. 按 [change-impact-rules.md](references/change-impact-rules.md) 运行 [analyze-prd-change.js](scripts/analyze-prd-change.js)，生成章节差异和相关文档候选。
3. 逐个 `CHG-ID` 检查 PRD、流程、UI、接口、数据、权限、埋点、测试、迁移回滚和发布说明。关键词命中只算候选，不算确定影响。
4. 输出影响矩阵及具体文档更新建议；只有直接依赖证据才标记“确定”，其余标记“待核实”。
5. 将影响报告按 `changes/YYYYMMDD-HHmmss-<requirement-id>-impact.md` 保存；输出路径已存在时停止并改用新时间戳，不覆盖旧报告。只有用户明确要求时才改写关联文档或回写飞书。

## 完成标准

- 已明确产品、项目、来源和版本。
- 所有引用均可追溯到本地路径或飞书链接。
- 已分离事实、假设、待确认项和建议。
- 新 PRD 含用户故事、验收标准和评审问题。
- 从交接包生成时，PRD 已记录 `requirement_id`、准入结论和阶段来源。
- 从 CONDITIONAL 交接包生成时，P1 的 ID、等级、影响、负责人和期限均已原样保留。
- 正式 PRD 已通过 `validate-prd.js`，且不含开放 P0。
- 正式 PRD 已通过 `save-prd.js` 以 create-only 方式进入项目 `prds/`，不会覆盖旧版本。
- 未通过前置分析的探索稿已明确标记，不会与正式 PRD 混淆。
- 变更分析列出受影响文档及更新建议。
- Wiki 目录同步只处理显式登记的根和项目子树；未映射、阻塞和不支持节点已在本轮结果中暴露。
