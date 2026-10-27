# 归档规范

## 目录

```text
pm-knowledge/
├── .sync/feishu/<scope-id>/manifests/
├── products/<product-id>/product.md
└── projects/<project-id>/
    ├── project.md
    ├── decisions.md
    ├── prds/
    ├── feedback/
    └── changes/
```

使用稳定的英文小写连字符 ID。`project.md` 的 `product_id` 将项目关联到产品；不要重复保存产品背景。

## PRD 文件名

```text
prds/YYYY-MM-DD-<feature-slug>-r<source-revision>-s<source-token-hash>-h<archive-hash>.md
prds/YYYY-MM-DD-<feature-slug>-h<archive-hash>-s<source-hash>.md
```

飞书来源使用 revision；本地来源使用正文与来源路径哈希。旧版本保持不可变。

## PRD frontmatter

```yaml
---
title: "布局（多窗视图）"
product_id: "product-id"
project_id: "project-id"
status: "draft"
version: "V1.0"
source_type: "feishu-wiki"
source_url: "https://example.feishu.cn/wiki/token"
source_token: "document-token"
source_wiki_token: "wiki-token"
source_space_id: "wiki-space-id"
source_revision: 662
source_path: "产品需求 / 影像阅片 / 布局"
content_hash: "sha256"
content_signature: "sha256-of-blocks-and-cover"
archive_hash: "sha256-of-text-hash-and-content-signature"
content_fidelity: "plain-text"
missing_content: []
rich_content_features: []
archived_at: "2026-07-15T00:00:00+08:00"
tags: ["layout", "viewer"]
related_prds: []
---
```

仅保存非空、可验证字段。不得保存凭据或访问令牌。

`content_fidelity` 取值：

- `plain-text`：飞书块列表未发现无法由纯文本保留的富内容；排版、链接目标和文字样式仍可能简化。
- `rich-export`：Markdown 用于检索，同时保存飞书官方导出的同版本 DOCX；归档记录相对路径、字节数和 SHA-256，复用前必须重新校验文件。
- `plain-text-incomplete`：用户明确接受降级后保存；`missing_content` 列出图片、表格、附件、评论、封面、内联对象等未保留内容及数量。
- `source-complete`：本地 UTF-8 Markdown/TXT 正文已完整复制，Markdown 未引用未随档复制的本地图片或附件。
- `source-incomplete`：用户明确接受降级后保存；本地 Markdown 的图片或附件只保留引用，`missing_content` 列出未复制资源。

## 飞书归档

凭据优先读取环境变量 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；也可用 `--config <config.json>` 或 `FEISHU_CONFIG` 指向包含 `app_id`、`app_secret` 的 JSON。不得把凭据写入归档。

应用需开通“查看新版文档”和“查看知识库”API 权限，并获得目标文档或知识库节点的实际阅读权限。脚本对临时网络错误、限流和 5xx 最多尝试 3 次，每次请求 15 秒超时。

```powershell
node scripts/archive-feishu-prd.js --url <feishu-url> --root <pm-knowledge>
```

脚本会在读取正文、全部文档块和官方 DOCX 导出前后核对 `revision_id`；文档正在编辑、缺少 revision 或前后版本不一致时停止或重试。发现富内容时自动创建导出任务并下载 DOCX，校验 ZIP/DOCX 文件头、字节数和 SHA-256 后，与 Markdown 放在同一归档目录。归档记录 `rich_content_path`、`rich_content_sha256`、`rich_content_size` 和 `rich_content_features`；任何文件缺失、被替换或校验不一致都停止复用。应用身份一次性开通 `docs:document:export`（或 `drive:export:readonly`）和 `drive:file:download`。只有用户明确接受文本降级时才加 `--allow-incomplete`。

### Wiki 目录增量同步

在产品登记中显式配置允许同步的 Wiki 根 URL：

```yaml
feishu_sync_roots: ["https://example.feishu.cn/wiki/root-token"]
```

在每个项目登记中显式配置该项目负责的结构子树：

```yaml
feishu_sync_subtrees: ["project-subtree-node-token"]
```

`feishu_sync_roots` 是批量读取授权边界，`feishu_sync_subtrees` 是项目归属边界；不得用标题推断或用 `feishu_node_tokens` 替代。同步项目：

```powershell
node scripts/sync-feishu-wiki.js --product <product-id> --root <pm-knowledge>
```

加 `--dry-run` 时完整扫描和校验，但不创建归档、锁或清单。每轮会重新读取已映射 `docx` 的正文和规范化块签名，以捕获同 revision 的富内容变化；“增量”只表示未变化内容不写新文件，新增或实际变化才以 create-only 方式创建新版本。

缺少 `archive_hash`、`content_signature` 或文件完整性指纹的旧归档不能直接充当可信同步基线。首次迁移会保留旧文件并只创建一次当前格式快照；后续运行再按完整指纹复用，不修改旧文件。

复用当前格式归档前必须核对产品/项目、来源文档、revision、正文、`content_hash`、`content_signature`、`archive_hash`、`content_fidelity`、`missing_content` 和清单中的文件指纹；`rich-export` 还必须核对 DOCX 路径、字节数和 SHA-256。任何关键字段、正文或富内容文件不一致都按完整性失败处理，不得更新清单来接受被改动的文件。

同步状态按代际保存在 `.sync/feishu/<scope-id>/manifests/`，同一根使用独占锁。清单分开记录 Wiki `node_token`、真实文档 `obj_token`、当前路径、最新内容观察和不可变归档路径。它是可重建派生状态，不能替代归档文件或作为跳过内容核对的唯一依据。

- 根节点、分页、循环或目录完整性失败：本轮不提交清单，也不推进移除状态。
- 单文档失败、富内容阻塞或子树未映射：继续其他节点，本轮返回 `partial`。
- 不支持的非 `docx` 节点记录为跳过，但仍递归检查其子节点。
- 改名或移动只更新当前路径，内容未变时不复制归档。
- 第一次完整扫描未出现标记 `suspected_removed`；连续第二次才标记 `removed_from_scope`。
- 永不因飞书删除、移动或权限变化而删除本地历史 PRD。
- `--allow-incomplete` 仍需用户明确接受整个本轮同步的纯文本降级，不能在无人确认时自动添加。

## 本地归档

```powershell
node scripts/archive-local-prd.js --file <prd.md|prd.txt> `
  --product <product-id> --project <project-id> --root <pm-knowledge>
```

产品和项目必须已分别登记在 `products/<product-id>/product.md`、`projects/<project-id>/project.md`，目录名、frontmatter ID 和 `project.md.product_id` 必须精确一致。仅支持有效 UTF-8 的 `.md` 和 `.txt`；Word、PDF、图片等格式明确拒绝，先使用对应格式工具转换后再归档。Markdown 引用了本地图片或附件时默认停止；只有用户明确接受资源未随档复制时才加 `--allow-incomplete`。脚本以来源路径、正文哈希和完整度信息去重，内容变化时创建新文件，使用 create-only 写入且不覆盖旧版本。

## 上下文文件

`product.md` 保存长期稳定的产品定位、目标用户、术语、核心能力和全局约束。使用 `aliases`、`keywords`、`feishu_space_ids` 和 `feishu_node_tokens` 帮助自动识别产品，并用 `feishu_sync_roots` 明确批量同步根。`project.md` 保存项目目标、范围、角色、系统边界和依赖，使用 `aliases`、`keywords` 和 `feishu_node_tokens` 帮助自动识别项目，并用 `feishu_sync_subtrees` 明确目录子树归属。`decisions.md` 按日期记录已确认决策及来源。

## 去重和版本

- 相同 `source_token`、`source_revision` 和 `archive_hash`：视为已归档。
- 相同 `source_token`、不同 revision、`archive_hash` 相同：视为无内容变更，不创建新文件。
- revision 相同但正文、评论、附件、图片或其他块签名不同：创建新文件，不用纯文本哈希吞掉富内容变化。
- 本地同一来源路径且正文和完整度信息相同：视为无内容变更，不创建新文件。
- 不同来源但正文疑似相同：保留两份来源，只标记关联，不自动删除。
- 需求变更不得改写旧文件。
