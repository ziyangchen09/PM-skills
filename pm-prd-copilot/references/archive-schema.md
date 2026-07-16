# 归档规范

## 目录

```text
pm-knowledge/
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
prds/YYYY-MM-DD-<feature-slug>-r<source-revision>.md
```

来源没有 revision 时使用 `v<version>`。旧版本保持不可变。

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
archived_at: "2026-07-15T00:00:00+08:00"
tags: ["layout", "viewer"]
related_prds: []
---
```

仅保存非空、可验证字段。不得保存凭据或访问令牌。

## 上下文文件

`product.md` 保存长期稳定的产品定位、目标用户、术语、核心能力和全局约束。使用 `aliases`、`keywords`、`feishu_space_ids` 和 `feishu_node_tokens` 帮助自动识别产品。`project.md` 保存项目目标、范围、角色、系统边界和依赖，使用 `aliases`、`keywords` 和 `feishu_node_tokens` 帮助自动识别项目。`decisions.md` 按日期记录已确认决策及来源。

## 去重和版本

- 相同 `source_token` 与 `source_revision`：视为已归档。
- 相同 `source_token`、不同 revision、正文哈希相同：视为无内容变更，不创建新文件。
- 相同 `source_token`、不同 revision、正文哈希不同：创建新文件。
- 不同来源但正文疑似相同：保留两份来源，只标记关联，不自动删除。
- 需求变更不得改写旧文件。
