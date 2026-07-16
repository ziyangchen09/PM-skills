# PM Skills

面向产品经理的 Codex Skills。目前包含 `pm-prd-copilot`：用于归档、生成、审查 PRD，并分析需求变更影响。

## 功能

- 将飞书文档或本地资料归档为可检索的 PRD
- 根据口述、会议记录或用户反馈生成 PRD 草稿
- 检查需求缺口，预判研发与 UI 评审问题
- 对比 PRD 版本并输出变更影响矩阵
- 按产品和项目维护独立的 `pm-knowledge` 资料库

## 安装

克隆仓库：

```powershell
git clone https://github.com/ziyangchen09/PM-skills.git
```

将 `pm-prd-copilot` 复制到 Codex 用户技能目录：

```powershell
Copy-Item -Recurse PM-skills\pm-prd-copilot $HOME\.codex\skills\
```

重启 Codex 后即可使用。

## 使用示例

在 Codex 中直接描述任务，例如：

```text
用 pm-prd-copilot 把这份会议记录整理成 PRD。
用 pm-prd-copilot 审查这个 PRD，列出阻塞项和高风险项。
对比这个需求的新旧版本，分析研发、UI、数据和测试影响。
```

首次使用时，Skill 会在当前工作区查找 `pm-knowledge`；不存在时会按需创建最小目录。业务资料与密钥不应提交到本仓库。

## 目录

```text
pm-prd-copilot/
├── SKILL.md
├── agents/
├── assets/
├── references/
└── scripts/
```

详细规则见 [`pm-prd-copilot/SKILL.md`](pm-prd-copilot/SKILL.md)。
