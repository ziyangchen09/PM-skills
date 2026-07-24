# PM Skills

最后更新：2026-07-22

一套面向产品经理的 Codex Skills：按产品和项目沉淀背景资料，将口述、会议记录和用户反馈推进为经过门禁校验的 PRD，并支持证据补证、用户故事、评审闭环、需求变更影响分析、飞书 Wiki 增量同步、历史页面设计上下文沉淀和 Vue 交互原型生成。

## 一句话开始

在 Codex 中直接说：

```text
把下面这段口述需求从受理一路推进到可写 PRD，并保存每个阶段产物：……
```

默认链路：

```text
零散输入
→ pm-demand-intake
├─ 证据足够 → pm-problem-framing
└─ 需要补证 → pm-evidence-research → pm-problem-framing
→ pm-solution-designer
→ pm-prd-readiness-gate
→ pm-prd-copilot
```

需要继续做页面方案时，接入独立设计分支：

```text
已确认 PRD + 历史页面/现有前端
→ pm-ui-context-builder
→ pm-prototype-studio
→ 提示词局部微调并确认原型版本
```

## 已具备的能力

| Skill | 单一职责 | 主要产物 |
|---|---|---|
| `pm-demand-intake` | 保留原始输入、识别需求性质、分诊 | `intake.md` |
| `pm-evidence-research` | 设计最小补证并整理证据、反例和适用范围 | `evidence.md` |
| `pm-problem-framing` | 明确用户、场景、问题、证据和目标状态 | `problem.md` |
| `pm-solution-designer` | 比较方案、记录决策状态、收口最小闭环 | `solutions.md` |
| `pm-prd-readiness-gate` | 对抗式检查并输出 READY、CONDITIONAL 或 NOT_READY | `readiness.md`、`handoff.md` |
| `pm-prd-copilot` | 生成/审查/归档 PRD，维护状态索引并分析变更影响 | PRD、评审记录、影响报告 |
| `pm-ui-context-builder` | 从历史页面、截图或现有前端提取可追溯的设计上下文 | `design/context.md` |
| `pm-prototype-studio` | 基于已确认 PRD 和设计上下文生成、版本化并局部微调 Vue 原型 | `prototypes/<requirement-id>/vNNN/` |

关键保障：

- 阶段产物使用 `draft → confirmed → superseded`，确认人、确认时间和直接确认来源必须可追溯。
- READY/CONDITIONAL 不只看字段数量，还检查章节、关键表格、来源文件、确认记录、决策证据和上游是否过期。
- 正式 PRD 必须再次通过校验：真实引用同一个 `handoff.md`、无开放 P0、无重复章节或隐藏表格、无占位内容，用户故事和验收场景已确认。
- CONDITIONAL 的 P1-ID、问题、影响、负责人和期限必须从交接包原样保留。
- 需求缺口、研发/UI 问题与评审结论使用同一个稳定 `REV-ID` 逐条闭环；`resolved/accepted-risk` 必须引用存在且带定位的本地直接确认记录。
- PRD、影响报告和历史阶段产物均只创建新文件，不覆盖旧版本。
- 飞书归档会核对稳定 revision；发现图片、附件、表格、评论、封面或内联对象时，自动保存官方 DOCX 富内容快照，并校验文件格式、大小和 SHA-256。
- 飞书 Wiki 可从已登记根目录递归扫描全部层级；未变化文档不重复保存，正文或富内容变化时创建新版本，改名/移动不复制内容，远端删除不删除本地历史。
- 本地 Markdown/TXT 可归档；Markdown 引用未随档复制的图片或附件时默认停止。
- 状态脚本可显示 Owner、当前阶段、Gate、P0/P1 数量、阻塞项、下一 Skill、PRD 草稿/完成状态，并刷新项目需求索引。
- 设计上下文会分开记录可追溯事实、推断和待确认项，并校验来源文件、`SRC-ID` 引用和真实表格记录；只有标题的空壳档案不能通过。
- Vue 原型默认沿用已有页面与组件规则，只修改提示词点名的范围；每轮经独立暂存后发布新版本，不覆盖已确认版本，开发预览默认仅本机可访问。
- 当前原型能力面向产品验证和研发沟通，不等同于生产前端交付，也不包含 Figma 自动回写、后端、鉴权或真实数据接入。

## 常用指令

端到端推进：

```text
把这条医生反馈从需求受理一路推进到可写 PRD；证据不足时先做最小补证，不要跳过门禁。
```

只执行一个阶段：

```text
用 pm-demand-intake 判断这条反馈属于什么需求，给出唯一下一步。
用 pm-evidence-research 为这个需求设计最小补证计划，并整理已有访谈和数据。
用 pm-problem-framing 把已确认受理卡和证据整理成问题定义，不要给功能方案。
用 pm-solution-designer 比较不同成本的方案并推荐最小闭环。
用 pm-prd-readiness-gate 对抗式检查这个需求能不能开始写 PRD。
```

处理 PRD：

```text
用 pm-prd-copilot 从这个已校验 handoff 生成正式 PRD。
用 pm-prd-copilot 审查这个 PRD，列出 P0、P1、研发/UI 问题并记录评审结论。
用 pm-prd-copilot 对比新旧版本，分析研发、UI、数据、测试和文档影响。
```

生成和微调 Vue 原型：

```text
用 pm-ui-context-builder 分析这些历史页面和现有 Vue 页面，为 ct-system 建立设计上下文；事实和推断分开记录。
用 pm-prototype-studio 基于这个已确认 PRD 和 ct-system 的设计上下文生成 Vue 交互原型，只实现主业务流程。
在上一版原型上只调整结节表单的必填反馈和错误定位，其他区域保持不变，并保存为下一版本。
```

归档：

```text
用 pm-prd-copilot 增量同步医疗项目的飞书 Wiki PRD 目录。
用 pm-prd-copilot 把这个飞书 PRD 归档到对应产品和项目。
用 pm-prd-copilot 把这个本地 Markdown PRD 归档到 ai-mdt / ct-system。
用 pm-prd-copilot 把这个本地 Markdown PRD 归档到 ai-mdt / mdt-system。
```

## PRD 准入规则

- `READY`：完整前置产物已确认、语义与结构校验通过、P0/P1 均为 0，问题已验证，方案已确认。
- `CONDITIONAL`：P0 为 0，允许存在已登记负责人和期限的 P1；生成草稿时必须逐值保留全部 P1。
- `NOT_READY`：存在 P0、核心产物缺失、确认不可追溯、来源无效、上游过期或结构/语义失败；默认不生成正式 PRD。
- 只有用户明确要求时才生成探索稿；必须标记“前置分析未通过”，`readiness` 为 `NOT_EVALUATED`。

## 保存与确认

业务资料保存在工作区的 `pm-knowledge`，不写入 Skill：

```text
pm-knowledge/
├── .sync/feishu/<scope-id>/manifests/  # Wiki 同步的只增代际清单
├── products/<product-id>/product.md
└── projects/<project-id>/
    ├── project.md
    ├── decisions.md
    ├── requirements/<requirement-id>/
    │   ├── source.md
    │   ├── confirmations.md
    │   ├── intake.md
    │   ├── evidence.md          # 仅研究分支需要
    │   ├── problem.md
    │   ├── solutions.md
    │   ├── readiness.md
    │   ├── handoff.md
    │   └── history/
    ├── design/
    │   └── context.md
    ├── prototypes/<requirement-id>/
    │   └── vNNN/
    ├── prds/
    ├── feedback/
    └── changes/
```

需求 ID 使用 `REQ-YYYYMMDD-<feature-slug>`。每个阶段必须沿用同一个产品责任人 `owner`。新产物先保存为 `draft`；当前用户或指定责任人确认全文后，在 `confirmations.md` 追加稳定 `CONF-ID`，再填写 `confirmed_by`、`confirmed_at` 和 `confirmation_source: confirmations.md#CONF-ID`。

不要把密钥、访问令牌或未脱敏的敏感资料提交到仓库。

## 脚本命令

检查一个需求或输出项目状态：

```powershell
node .\pm-prd-copilot\scripts\requirement-status.js `
  --root .\pm-knowledge --project <project-id> --requirement <requirement-id>

node .\pm-prd-copilot\scripts\requirement-status.js `
  --root .\pm-knowledge --project <project-id> --refresh
```

校验正式 PRD：

```powershell
node .\pm-prd-copilot\scripts\validate-prd.js `
  --prd <prd.md> --handoff <requirement-directory>\handoff.md

node .\pm-prd-copilot\scripts\save-prd.js `
  --input <validated-draft.md> --handoff <requirement-directory>\handoff.md `
  --root .\pm-knowledge
```

`--refresh` 只更新派生的 `projects/<project-id>/requirements/index.md`；其他 `--output` 仍为只创建新文件。`save-prd.js` 会重新校验并按版本只创建新 PRD，目标已存在时必须提升版本，不能覆盖。

校验页面设计上下文并初始化 Vue 原型：

```powershell
node .\pm-ui-context-builder\scripts\validate-design-context.js `
  --file .\pm-knowledge\projects\<project-id>\design\context.md `
  --root .\pm-knowledge

node .\pm-prototype-studio\scripts\init-vue-prototype.js `
  --root .\pm-knowledge --project <project-id> `
  --requirement <requirement-id>
```

原型默认创建在 `projects/<project-id>/prototypes/<requirement-id>/vNNN/`；已存在的版本不会被覆盖。进入原型目录后安装依赖并启动预览，即可继续用自然语言指定局部调整。

归档飞书或本地 PRD：

```powershell
node .\pm-prd-copilot\scripts\sync-feishu-wiki.js `
  --product ai-mdt --root .\pm-knowledge

node .\pm-prd-copilot\scripts\archive-feishu-prd.js `
  --url <feishu-url> --root .\pm-knowledge

node .\pm-prd-copilot\scripts\archive-local-prd.js `
  --file <prd.md|prd.txt> --product <product-id> --project <project-id> `
  --root .\pm-knowledge
```

首次同步前可加 `--dry-run` 只做预演。产品的 `product.md` 必须用 `feishu_sync_roots` 登记允许同步的 Wiki 根，项目的 `project.md` 必须用 `feishu_sync_subtrees` 登记项目子树；脚本不会按标题猜项目。同步结果为 `partial` 时，查看输出中的 `blocked` 和 `unmapped`，补齐映射或明确处理富内容后再运行。

完整富内容归档需要应用身份一次性开通 `docs:document:export`（或 `drive:export:readonly`）和 `drive:file:download`。Markdown 继续用于检索，旁路 `.source.docx` 是富内容权威快照；文件缺失或校验不一致时停止复用。

`--allow-incomplete` 只作为显式降级开关：仅当用户明确接受本轮相关文档缺失富内容时使用，归档会记录缺失项，不能把降级副本称为完整归档。

当前已把医疗项目 PRD 总目录 `3.3 PRD合集` 登记为 `ai-mdt` 的同步根，并完成两条项目映射：`CT系统` → `ct-system`，`MDT系统` → `mdt-system`。两个项目独立归档、保持关联，避免 PRD 背景互相污染。`数据治理平台` 尚未建立独立项目上下文，因此会显示为 `unmapped`，不会误归到 CT 或 MDT。当前本地自动归档只支持 UTF-8 Markdown/TXT；Word、PDF 仍需先用对应文档工具转换。

### Wiki 增量同步如何工作

- 每轮会递归发现全部层级，并重新核对已映射文档的正文和富内容签名；这是为了不漏掉同 revision 的图片、附件或评论变化。
- Wiki 根页和项目子树入口也会先读取；只有正文为空且无富内容时才当作纯目录，避免漏掉“既是目录又有 PRD 正文”的节点。
- 未变化文档复用已有归档；新增或实际变化才创建新文件。旧格式归档缺少富内容签名和文件完整性校验，因此会安全新建一次当前格式基线，之后才进入增量复用。
- 复用前会核对产品/项目归属、正文、revision、内容完整度、缺失项、富内容签名和归档文件指纹；富内容归档还会核对 DOCX 的路径、大小和 SHA-256，任何文件被改动时停止。
- 同步清单只创建新代际，保存在 `.sync/feishu/`；同一根有运行锁，避免两个任务同时写。
- 根目录或分页失败时不提交新清单。单文档失败会继续处理其他文档，并把整轮标为 `partial`。
- 节点第一次消失只标记“疑似移出”，连续第二次完整扫描仍未出现才标记“已移出范围”；本地 PRD 永远不会自动删除。

## 安装与更新

在仓库根目录运行一个命令，安装或更新全部 8 个 Skills：

```powershell
.\install.ps1 -Force
```

安装器会先校验所有 Skill、运行全部脚本自测，再暂存、备份并替换；任一必需文件或测试失败都不会开始安装。旧版本保存在 `$HOME\.codex\skills\.pm-pre-prd-backup-*`。完成后重启 Codex。

只安装 5 个 PRD 前置 Skills 时，可运行：

```powershell
.\PM-skills-pre-PRD-pack-v2\install.ps1 -Force
```

## README 维护约定

- 每次修改 Skill 行为、脚本、模板、交接协议或安装方式，都必须同步检查并更新本 README。
- 前置链专属变化同时更新 `PM-skills-pre-PRD-pack-v2/README.md`。
- 不在各 Skill 目录重复创建 README；根 README 是用户使用说明的唯一入口。
