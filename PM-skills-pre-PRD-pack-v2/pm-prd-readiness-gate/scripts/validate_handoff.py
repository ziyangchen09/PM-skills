#!/usr/bin/env python3
"""Validate pre-PRD stage metadata before handoff."""

from __future__ import annotations

import argparse
import json
import re
import tempfile
from datetime import datetime
from pathlib import Path


STAGES = {
    "intake.md": "intake",
    "evidence.md": "evidence",
    "problem.md": "problem",
    "solutions.md": "solution",
    "readiness.md": "readiness",
    "handoff.md": "handoff",
}
ARTIFACT_STATUS = {"draft", "confirmed", "superseded"}
PROBLEM_CONFIDENCE = {
    "validated",
    "plausible",
    "misframed",
    "not-supported",
    "conflicted",
}
DECISION_STATUS = {"proposal", "pending", "confirmed"}
UPSTREAM_STATUS = {"verified", "missing"}
EVIDENCE_CONCLUSION = {"strengthened", "unchanged", "weakened", "conflicted", "insufficient"}
EVIDENCE_NEXT_ROUTE = {"pm-problem-framing", "pm-demand-intake", "pause"}
GATE_RESULT = {"READY", "CONDITIONAL", "NOT_READY"}
REVIEW_MODE = {"standard", "reverse", "lightweight", "high-risk"}
SOURCE_TYPE = {
    "spoken",
    "feedback",
    "meeting-notes",
    "local-notes",
    "prd",
    "data",
    "research",
    "mixed",
    "derived",
    "handoff",
}
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SAFE_REQUIREMENT_ID = re.compile(r"^REQ-\d{8}-[a-z0-9][a-z0-9-]{0,80}$")
PLACEHOLDERS = {"", "-", "—", "待确认", "待定", "未定", "未知", "tbd", "todo", "n/a", "na"}
STATE_FIELDS = (
    "confirmed_by",
    "confirmed_at",
    "confirmation_source",
    "superseded_at",
    "superseded_reason",
)
REQUIRED_HEADINGS = {
    "intake": (
        "# 需求受理卡",
        "## 1. 原始输入",
        "## 2. 来源",
        "## 3. 初步识别",
        "## 4. 当前证据",
        "## 5. 历史关联",
        "## 6. 信息缺口",
        "## 7. 分诊结论",
    ),
    "evidence": (
        "# 证据研究简报",
        "## 1. 待验证判断",
        "## 2. 最小研究计划",
        "## 3. 证据索引",
        "## 4. 数据口径",
        "## 5. 反例与冲突",
        "## 6. 证据结论",
        "## 7. 下一步",
    ),
    "problem": (
        "# 问题定义简报",
        "## 1. 问题可信度结论",
        "## 2. 原始诉求与方案剥离",
        "## 3. 用户与场景",
        "## 4. 用户任务与当前流程",
        "## 5. 主问题",
        "## 6. 症状、原因和影响",
        "## 7. 证据与反例",
        "## 8. 目标状态与成功信号",
        "## 9. 约束与非目标",
        "## 10. 关键假设",
        "## 11. 待验证问题",
        "## 12. 进入方案设计的条件",
    ),
    "solution": (
        "# 方案设计简报",
        "## 1. 方案设计前提",
        "## 2. 候选方案",
        "## 3. 方案比较",
        "## 4. 推荐结论",
        "## 5. 最小可验证闭环",
        "## 6. 本期范围",
        "## 7. 风险与依赖",
        "## 8. 进入准入检查的条件",
    ),
    "readiness": (
        "# PRD 准入报告",
        "## 1. 准入结论",
        "## 2. 检查结果",
        "## 3. P0 阻塞",
        "## 4. P1 条件项",
        "## 5. P2：可在 PRD 内补充",
    ),
    "handoff": (
        "# PRD 交接包",
        "## 1. 已确认事实",
        "## 2. 已确认决策",
        "## 3. 问题与目标",
        "## 4. 推荐方案",
        "## 5. 本期范围",
        "## 6. 业务规则与约束",
        "## 7. 风险与降级",
        "## 8. 明确假设",
        "## 9. 待确认项",
    ),
}


def scalar(value: str):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("列表必须使用 JSON 格式") from exc
        if not isinstance(parsed, list):
            raise ValueError("列表格式无效")
        return parsed
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    try:
        return int(value)
    except ValueError:
        return value


def document(path: Path) -> tuple[dict[str, object], str]:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("缺少 YAML frontmatter")
    try:
        end = next(i for i, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration as exc:
        raise ValueError("YAML frontmatter 未闭合") from exc

    result: dict[str, object] = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[0].isspace():
            raise ValueError("不支持缩进或嵌套字段；列表请使用 JSON 行内格式")
        if ":" not in line:
            raise ValueError(f"无法解析字段：{line}")
        key, value = line.split(":", 1)
        key = key.strip()
        if key in result:
            raise ValueError(f"字段重复：{key}")
        result[key] = scalar(value)
    return result, "\n".join(lines[end + 1 :])


def frontmatter(path: Path) -> dict[str, object]:
    return document(path)[0]


def markdown_table(body: str, heading: str) -> list[dict[str, str]] | None:
    lines = body.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == heading)
    except StopIteration:
        return None

    table_lines: list[str] = []
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped.startswith("## "):
            break
        if stripped.startswith("|") and stripped.endswith("|"):
            table_lines.append(stripped)
        elif table_lines:
            break
    if len(table_lines) < 2:
        return None

    def cells(line: str) -> list[str]:
        return [cell.strip() for cell in line[1:-1].split("|")]

    headers = cells(table_lines[0])
    separators = cells(table_lines[1])
    if (
        not headers
        or len(headers) != len(set(headers))
        or len(separators) != len(headers)
        or not all("-" in item and item.replace("-", "").replace(":", "") == "" for item in separators)
    ):
        return None

    rows: list[dict[str, str]] = []
    for line in table_lines[2:]:
        values = cells(line)
        if len(values) != len(headers):
            continue
        if any(values):
            rows.append(dict(zip(headers, values)))
    return rows


def meaningful(value: object) -> bool:
    if not isinstance(value, str):
        return False
    cleaned = re.sub(r"[*_`>#]", "", value).strip()
    if cleaned.lower() in PLACEHOLDERS:
        return False
    if cleaned in {
        "READY / CONDITIONAL / NOT_READY",
        "validated / plausible / misframed / not-supported / conflicted",
        "proposal / pending / confirmed",
    }:
        return False
    return bool(re.search(r"[\w\u4e00-\u9fff]", cleaned)) and "……" not in cleaned


def markdown_section(body: str, heading: str) -> str | None:
    lines = body.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == heading)
    except StopIteration:
        return None
    level = len(heading) - len(heading.lstrip("#"))
    end = len(lines)
    for index in range(start + 1, len(lines)):
        stripped = lines[index].lstrip()
        if not stripped.startswith("#"):
            continue
        next_level = len(stripped) - len(stripped.lstrip("#"))
        if next_level <= level and stripped[next_level:next_level + 1] == " ":
            end = index
            break
    return "\n".join(lines[start + 1 : end])


def markdown_field(body: str, heading: str, label: str) -> str | None:
    section = markdown_section(body, heading)
    if section is None:
        return None
    pattern = re.compile(rf"^\s*-\s*{re.escape(label)}[：:]\s*(.*)$")
    for line in section.splitlines():
        match = pattern.match(line)
        if match:
            return match.group(1).strip()
    return None


def require_fields(
    body: str,
    filename: str,
    heading: str,
    labels: tuple[str, ...],
    errors: list[str],
) -> dict[str, str]:
    values: dict[str, str] = {}
    for label in labels:
        value = markdown_field(body, heading, label)
        if value is None:
            errors.append(f"{filename}: {heading} 缺少字段 {label}")
        elif not meaningful(value):
            errors.append(f"{filename}: {heading} 的 {label} 不能为空或保留模板占位")
        else:
            values[label] = value
    return values


def require_list(body: str, filename: str, heading: str, errors: list[str]) -> list[str]:
    section = markdown_section(body, heading)
    if section is None:
        errors.append(f"{filename}: 缺少 {heading}")
        return []
    items = [
        line.lstrip()[2:].strip()
        for line in section.splitlines()
        if line.lstrip().startswith("- ") and meaningful(line.lstrip()[2:])
    ]
    if not items:
        errors.append(f"{filename}: {heading} 至少需要一条有效内容")
    return items


def require_table(
    body: str,
    filename: str,
    heading: str,
    columns: tuple[str, ...],
    errors: list[str],
    minimum_rows: int = 1,
) -> list[dict[str, str]]:
    rows = markdown_table(body, heading)
    if rows is None:
        errors.append(f"{filename}: 缺少或无法解析 {heading} 表格")
        return []
    if len(rows) < minimum_rows:
        errors.append(f"{filename}: {heading} 至少需要 {minimum_rows} 行有效内容")
    for index, row in enumerate(rows, 1):
        for column in columns:
            if column not in row:
                errors.append(f"{filename}: {heading} 缺少列 {column}")
                continue
            if not meaningful(row[column]):
                errors.append(f"{filename}: {heading} 第 {index} 行缺少 {column}")
    return rows


def validate_issue_rows(
    rows: list[dict[str, str]] | None,
    filename: str,
    heading: str,
    id_prefix: str,
    required_columns: tuple[str, ...],
    errors: list[str],
) -> list[str]:
    if rows is None:
        errors.append(f"{filename}: 缺少或无法解析 {heading} 表格")
        return []

    ids: list[str] = []
    for index, row in enumerate(rows, 1):
        issue_id = row.get("ID", "").strip()
        suffix = issue_id.removeprefix(id_prefix)
        if not issue_id.startswith(id_prefix) or not suffix.isdigit():
            errors.append(f"{filename}: {heading} 第 {index} 行 ID 必须使用 {id_prefix}<number>")
        elif issue_id in ids:
            errors.append(f"{filename}: {heading} ID 重复：{issue_id}")
        else:
            ids.append(issue_id)
        for column in required_columns:
            value = row.get(column, "").strip()
            if value.lower() in PLACEHOLDERS:
                errors.append(f"{filename}: {issue_id or f'第 {index} 行'} 缺少 {column}")
    return ids


def nonnegative_int(meta: dict[str, object], key: str, errors: list[str], file: str) -> int:
    value = meta.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        errors.append(f"{file}: {key} 必须是非负整数")
        return -1
    return value


def parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def valid_timestamp(value: object) -> bool:
    return parse_timestamp(value) is not None


def source_file(
    reference: object,
    requirement_dir: Path,
    filename: str,
    field: str,
    errors: list[str],
    require_locator: bool = False,
) -> Path | None:
    if not isinstance(reference, str) or not reference.strip():
        errors.append(f"{filename}: {field} 必须是非空本地路径")
        return None
    raw = reference.strip()
    path_text, separator, locator = raw.partition("#")
    if require_locator and (not separator or not meaningful(locator)):
        errors.append(f"{filename}: {field} 必须使用 path#定位")
    if "://" in path_text or not path_text:
        errors.append(f"{filename}: {field} 必须是需求目录内的本地路径")
        return None
    relative = Path(path_text)
    if relative.is_absolute() or ".." in relative.parts:
        errors.append(f"{filename}: {field} 不得使用绝对路径或 ..")
        return None
    candidate = requirement_dir / relative
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(requirement_dir)
    except (OSError, RuntimeError, ValueError):
        errors.append(f"{filename}: {field} 指向不存在或目录外文件：{path_text}")
        return None
    current = candidate
    while current != requirement_dir:
        if current.is_symlink():
            errors.append(f"{filename}: {field} 拒绝符号链接：{path_text}")
            return None
        current = current.parent
    if not resolved.is_file():
        errors.append(f"{filename}: {field} 必须指向普通文件：{path_text}")
        return None
    if require_locator and locator:
        try:
            source_text = resolved.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError):
            errors.append(f"{filename}: {field} 的来源文件无法读取：{path_text}")
        else:
            line_locator = re.fullmatch(r"L(\d+)(?:-L(\d+))?", locator.strip(), re.IGNORECASE)
            if line_locator:
                start = int(line_locator.group(1))
                end = int(line_locator.group(2) or start)
                if start < 1 or end < start or end > len(source_text.splitlines()):
                    errors.append(f"{filename}: {field} 的行号定位无效：{locator}")
            else:
                marker = locator.strip().replace("-", " ").lower()
                if marker and marker not in source_text.lower() and locator.strip().lower() not in source_text.lower():
                    errors.append(f"{filename}: {field} 的定位在来源文件中不存在：{locator}")
    return resolved


def require_prose(body: str, filename: str, heading: str, errors: list[str]) -> str:
    section = markdown_section(body, heading)
    if section is None:
        errors.append(f"{filename}: 缺少 {heading}")
        return ""
    prose = " ".join(line.strip() for line in section.splitlines() if line.strip())
    if not meaningful(prose):
        errors.append(f"{filename}: {heading} 缺少实质内容")
        return ""
    return prose


def validate_semantics(
    stage: str,
    meta: dict[str, object],
    body: str,
    requirement_dir: Path,
    documents: dict[str, dict[str, object]],
    errors: list[str],
) -> None:
    filename = next(name for name, expected in STAGES.items() if expected == stage)
    lines = {line.strip() for line in body.splitlines()}
    for heading in REQUIRED_HEADINGS[stage]:
        if heading not in lines:
            errors.append(f"{filename}: 缺少章节 {heading}")

    if stage == "intake":
        raw_input = require_prose(body, filename, "## 1. 原始输入", errors)
        if "保留必要原意和来源" in raw_input:
            errors.append("intake.md: 原始输入仍是模板说明")
        require_fields(body, filename, "## 2. 来源", ("来源类型", "时间", "来源路径或链接"), errors)
        require_fields(
            body,
            filename,
            "## 3. 初步识别",
            ("主要需求性质", "表面诉求", "目标候选", "目标用户候选", "场景候选", "潜在问题"),
            errors,
        )
        route = require_fields(
            body,
            filename,
            "## 7. 分诊结论",
            ("推荐下一步主路径", "理由"),
            errors,
        ).get("推荐下一步主路径")
        if route and route != meta.get("route"):
            errors.append("intake.md: 正文推荐下一步与 frontmatter route 不一致")
        return

    if stage == "evidence":
        require_table(
            body,
            filename,
            "## 1. 待验证判断",
            ("ID", "判断", "会改变什么", "支持标准", "反驳标准"),
            errors,
        )
        evidence_rows = require_table(
            body,
            filename,
            "## 3. 证据索引",
            ("证据 ID", "来源及定位", "时间", "样本/范围", "支持或反驳", "独立来源组", "局限"),
            errors,
        )
        for index, row in enumerate(evidence_rows, 1):
            source_file(row.get("来源及定位"), requirement_dir, filename, f"证据索引第 {index} 行来源", errors, True)
            if meaningful(row.get("时间")) and not valid_timestamp(row.get("时间")):
                errors.append(f"evidence.md: 证据索引第 {index} 行时间必须是带时区的 ISO-8601 时间")
        conclusion = require_fields(
            body,
            filename,
            "## 6. 证据结论",
            ("结论（与 frontmatter 一致）", "适用用户与场景", "不适用范围"),
            errors,
        ).get("结论（与 frontmatter 一致）")
        if conclusion and conclusion != meta.get("evidence_conclusion"):
            errors.append("evidence.md: 正文证据结论与 frontmatter 不一致")
        next_route = require_fields(
            body,
            filename,
            "## 7. 下一步",
            ("路由（与 frontmatter 一致）", "理由", "重新评估条件"),
            errors,
        ).get("路由（与 frontmatter 一致）")
        if next_route and next_route != meta.get("next_route"):
            errors.append("evidence.md: 正文下一路由与 frontmatter 不一致")
        return

    if stage == "problem":
        confidence = require_fields(
            body,
            filename,
            "## 1. 问题可信度结论",
            ("结论（与 frontmatter 一致）", "理由", "当前最薄弱的假设"),
            errors,
        ).get("结论（与 frontmatter 一致）")
        if confidence and confidence != meta.get("problem_confidence"):
            errors.append("problem.md: 正文问题可信度与 frontmatter 不一致")
        require_fields(body, filename, "## 3. 用户与场景", ("目标用户", "触发场景", "前置条件"), errors)
        flow_rows = require_table(
            body,
            filename,
            "## 4. 用户任务与当前流程",
            ("步骤", "用户目标", "当前操作", "障碍或风险", "绕行方式", "来源"),
            errors,
        )
        for index, row in enumerate(flow_rows, 1):
            source_file(row.get("来源"), requirement_dir, filename, f"当前流程第 {index} 行来源", errors, True)
        require_prose(body, filename, "### 问题陈述", errors)
        require_table(
            body,
            filename,
            "## 7. 证据与反例",
            ("判断", "支持证据", "反例或冲突", "证据强度", "结论"),
            errors,
        )
        require_fields(
            body,
            filename,
            "## 8. 目标状态与成功信号",
            ("目标状态", "可观察成功信号"),
            errors,
        )
        require_fields(body, filename, "## 9. 约束与非目标", ("非目标",), errors)
        return

    if stage == "solution":
        require_fields(
            body,
            filename,
            "## 1. 方案设计前提",
            ("主问题", "目标用户", "目标状态", "必须解决的能力", "非目标", "当前证据强度"),
            errors,
        )
        for option in ("### 方案 A：", "### 方案 B："):
            require_fields(
                body,
                filename,
                option,
                ("核心机制", "覆盖的问题", "本期范围", "非范围", "主要风险", "验证方法"),
                errors,
            )
        require_table(body, filename, "## 3. 方案比较", ("维度", "方案 A", "方案 B"), errors)
        decision = require_fields(
            body,
            filename,
            "## 4. 推荐结论",
            (
                "推荐方案",
                "推荐理由",
                "不选择其他方案的理由",
                "结论依赖的假设",
                "改选条件",
                "决策状态（与 frontmatter 一致）",
            ),
            errors,
        )
        decision_status = decision.get("决策状态（与 frontmatter 一致）")
        if decision_status and decision_status != meta.get("decision_status"):
            errors.append("solutions.md: 正文决策状态与 frontmatter 不一致")
        if meta.get("decision_status") == "confirmed":
            confirmation = require_fields(
                body,
                filename,
                "## 4. 推荐结论",
                ("决策人", "确认时间", "决策来源"),
                errors,
            )
            if "确认时间" in confirmation and not valid_timestamp(confirmation["确认时间"]):
                errors.append("solutions.md: 决策确认时间必须是带时区的 ISO-8601 时间")
            if "决策来源" in confirmation:
                source_file(
                    confirmation["决策来源"],
                    requirement_dir,
                    filename,
                    "决策来源",
                    errors,
                    True,
                )
        require_fields(
            body,
            filename,
            "## 5. 最小可验证闭环",
            (
                "目标用户",
                "触发条件",
                "核心任务",
                "必要输入",
                "系统处理",
                "用户确认或控制点",
                "输出结果",
                "失败与恢复",
                "验证指标",
                "成功标准",
                "停止或回退标准",
            ),
            errors,
        )
        require_list(body, filename, "### 必须实现", errors)
        require_list(body, filename, "### 暂不实现", errors)
        require_table(
            body,
            filename,
            "## 7. 风险与依赖",
            ("风险或依赖", "类型", "影响", "验证或缓解", "降级", "责任人"),
            errors,
        )
        return

    if stage == "readiness":
        conclusion = require_fields(
            body,
            filename,
            "## 1. 准入结论",
            ("结论（与 frontmatter `gate_result` 一致）", "核心理由", "当前最大返工风险", "建议下一步"),
            errors,
        ).get("结论（与 frontmatter `gate_result` 一致）")
        if conclusion and conclusion != meta.get("gate_result"):
            errors.append("readiness.md: 正文准入结论与 frontmatter 不一致")
        require_table(
            body,
            filename,
            "## 2. 检查结果",
            ("维度", "状态", "依据", "问题等级", "处理建议"),
            errors,
            9,
        )
        return

    facts = require_table(
        body,
        filename,
        "## 1. 已确认事实",
        ("事实", "来源路径", "定位或短摘录"),
        errors,
    )
    for index, row in enumerate(facts, 1):
        source_file(row.get("来源路径"), requirement_dir, filename, f"已确认事实第 {index} 行来源", errors)
    decisions = markdown_table(body, "## 2. 已确认决策")
    if decisions is None:
        errors.append("handoff.md: 缺少或无法解析已确认决策表格")
        decisions = []
    if documents.get("solution", {}).get("decision_status") == "confirmed" and not decisions:
        errors.append("handoff.md: 已确认方案必须包含至少一条已确认决策")
    for index, row in enumerate(decisions, 1):
        for column in ("决策", "确认人", "确认时间", "直接确认来源"):
            if not meaningful(row.get(column)):
                errors.append(f"handoff.md: 已确认决策第 {index} 行缺少 {column}")
        if meaningful(row.get("确认时间")) and not valid_timestamp(row.get("确认时间")):
            errors.append(f"handoff.md: 已确认决策第 {index} 行确认时间无效")
        if meaningful(row.get("直接确认来源")):
            source_file(
                row.get("直接确认来源"),
                requirement_dir,
                filename,
                f"已确认决策第 {index} 行直接确认来源",
                errors,
                True,
            )
    require_fields(
        body,
        filename,
        "## 3. 问题与目标",
        ("目标用户", "场景", "用户任务", "当前障碍", "影响", "目标状态", "非目标"),
        errors,
    )
    recommendation = require_fields(
        body,
        filename,
        "## 4. 推荐方案",
        ("核心机制", "用户流程变化", "决策状态", "未选择方案及原因"),
        errors,
    )
    solution_status = documents.get("solution", {}).get("decision_status")
    if recommendation.get("决策状态") and recommendation["决策状态"] != solution_status:
        errors.append("handoff.md: 决策状态与 solutions.md 不一致")
    require_list(body, filename, "### 必须实现", errors)
    require_list(body, filename, "### 暂不实现", errors)
    require_fields(
        body,
        filename,
        "## 6. 业务规则与约束",
        ("核心对象", "状态与转换", "权限", "数据", "外部依赖", "性能或设备边界", "合规与安全"),
        errors,
    )
    require_table(
        body,
        filename,
        "## 7. 风险与降级",
        ("风险", "触发条件", "缓解", "降级", "恢复"),
        errors,
    )


def validate(requirement_dir: Path) -> list[str]:
    if requirement_dir.is_symlink():
        return [f"拒绝符号链接需求目录：{requirement_dir}"]
    requirement_dir = requirement_dir.resolve()
    errors: list[str] = []
    documents: dict[str, dict[str, object]] = {}
    bodies: dict[str, str] = {}

    if not requirement_dir.is_dir():
        return [f"目录不存在：{requirement_dir}"]

    for filename, expected_stage in STAGES.items():
        path = requirement_dir / filename
        if not path.exists():
            continue
        if path.is_symlink() or path.resolve().parent != requirement_dir:
            errors.append(f"{filename}: 拒绝目录外或符号链接产物")
            continue
        try:
            meta, body = document(path)
        except (OSError, UnicodeError, ValueError) as exc:
            errors.append(f"{filename}: {exc}")
            continue
        documents[expected_stage] = meta
        bodies[expected_stage] = body

        common = (
            "contract_version",
            "requirement_id",
            "product_id",
            "project_id",
            "owner",
            "stage",
            "artifact_status",
            "source_type",
            "source_paths",
            "created_at",
            "updated_at",
        )
        for key in common:
            if key not in meta or meta[key] == "" or (isinstance(meta[key], str) and not meta[key].strip()):
                errors.append(f"{filename}: 缺少 {key}")
        for key in STATE_FIELDS:
            if key not in meta:
                errors.append(f"{filename}: 缺少 {key}")
            elif not isinstance(meta[key], str):
                errors.append(f"{filename}: {key} 必须是字符串")
        if meta.get("contract_version") != 1:
            errors.append(f"{filename}: contract_version 必须为 1")
        if meta.get("stage") != expected_stage:
            errors.append(f"{filename}: stage 应为 {expected_stage}")
        if meta.get("artifact_status") not in ARTIFACT_STATUS:
            errors.append(f"{filename}: artifact_status 无效")
        for key in ("requirement_id", "product_id", "project_id", "owner", "source_type", "created_at", "updated_at"):
            if key in meta and not isinstance(meta[key], str):
                errors.append(f"{filename}: {key} 必须是字符串")
        if meta.get("source_type") not in SOURCE_TYPE:
            errors.append(f"{filename}: source_type 无效")
        for key in ("created_at", "updated_at"):
            if not valid_timestamp(meta.get(key)):
                errors.append(f"{filename}: {key} 必须是带时区的 ISO-8601 时间")
        created_at = parse_timestamp(meta.get("created_at"))
        updated_at = parse_timestamp(meta.get("updated_at"))
        if created_at and updated_at and created_at > updated_at:
            errors.append(f"{filename}: created_at 不得晚于 updated_at")
        source_paths = meta.get("source_paths")
        if not isinstance(source_paths, list) or not source_paths or not all(isinstance(item, str) and item.strip() for item in source_paths):
            errors.append(f"{filename}: source_paths 必须是非空字符串列表")
        else:
            for index, reference in enumerate(source_paths, 1):
                source_file(reference, requirement_dir, filename, f"source_paths[{index}]", errors)

        status = meta.get("artifact_status")
        if status == "draft":
            if any(meta.get(key) for key in ("confirmed_by", "confirmed_at", "confirmation_source", "superseded_at", "superseded_reason")):
                errors.append(f"{filename}: draft 不得携带确认或废止元数据")
        elif status in {"confirmed", "superseded"}:
            for key in ("confirmed_by", "confirmed_at", "confirmation_source"):
                if not meaningful(meta.get(key)):
                    errors.append(f"{filename}: {status} 缺少 {key}")
            confirmed_at = parse_timestamp(meta.get("confirmed_at"))
            if meta.get("confirmed_at") and confirmed_at is None:
                errors.append(f"{filename}: confirmed_at 必须是带时区的 ISO-8601 时间")
            if confirmed_at and updated_at and confirmed_at < updated_at:
                errors.append(f"{filename}: confirmed_at 不得早于 updated_at；修改后必须重新确认")
            if meaningful(meta.get("confirmation_source")):
                source_file(
                    meta.get("confirmation_source"),
                    requirement_dir,
                    filename,
                    "confirmation_source",
                    errors,
                    True,
                )
                source_bases = {
                    item.partition("#")[0] for item in source_paths
                } if isinstance(source_paths, list) else set()
                if str(meta.get("confirmation_source")).partition("#")[0] not in source_bases:
                    errors.append(f"{filename}: confirmation_source 必须登记在 source_paths")
            if status == "confirmed" and (meta.get("superseded_at") or meta.get("superseded_reason")):
                errors.append(f"{filename}: confirmed 不得携带 superseded 元数据")
            if status == "superseded":
                if not valid_timestamp(meta.get("superseded_at")):
                    errors.append(f"{filename}: superseded_at 必须是带时区的 ISO-8601 时间")
                if not meaningful(meta.get("superseded_reason")):
                    errors.append(f"{filename}: superseded 缺少 superseded_reason")
                superseded_at = parse_timestamp(meta.get("superseded_at"))
                if superseded_at and confirmed_at and superseded_at < confirmed_at:
                    errors.append(f"{filename}: superseded_at 不得早于 confirmed_at")

    readiness = documents.get("readiness")
    if readiness is None:
        errors.append("缺少 readiness.md")
        return errors

    identity = tuple(readiness.get(key) for key in ("product_id", "project_id", "requirement_id"))
    owner = readiness.get("owner")
    for stage, meta in documents.items():
        current = tuple(meta.get(key) for key in ("product_id", "project_id", "requirement_id"))
        if current != identity:
            errors.append(f"{stage}: product_id/project_id/requirement_id 与 readiness 不一致")
        if meta.get("owner") != owner:
            errors.append(f"{stage}: owner 与 readiness 不一致")

    product_id, project_id, requirement_id = identity
    if not isinstance(requirement_id, str) or not SAFE_REQUIREMENT_ID.fullmatch(requirement_id):
        errors.append("readiness.md: requirement_id 必须使用 REQ-YYYYMMDD-feature-slug")
    if not isinstance(product_id, str) or not SAFE_ID.fullmatch(product_id):
        errors.append("readiness.md: product_id 格式无效")
    if not isinstance(project_id, str) or not SAFE_ID.fullmatch(project_id):
        errors.append("readiness.md: project_id 格式无效")
    if requirement_dir.name != requirement_id:
        errors.append("目录名必须与 requirement_id 一致")
    if (
        requirement_dir.parent.name != "requirements"
        or requirement_dir.parent.parent.name != project_id
        or requirement_dir.parent.parent.parent.name != "projects"
    ):
        errors.append("目录必须位于 projects/<project_id>/requirements/<requirement_id>/")

    intake = documents.get("intake")
    if intake is not None and (not isinstance(intake.get("route"), str) or not intake.get("route", "").strip()):
        errors.append("intake.md: 缺少 route")

    problem = documents.get("problem")
    evidence = documents.get("evidence")
    if evidence is not None:
        if evidence.get("upstream_status") not in UPSTREAM_STATUS:
            errors.append("evidence.md: upstream_status 无效")
        if evidence.get("evidence_conclusion") not in EVIDENCE_CONCLUSION:
            errors.append("evidence.md: evidence_conclusion 无效")
        if evidence.get("next_route") not in EVIDENCE_NEXT_ROUTE:
            errors.append("evidence.md: next_route 无效")
    if problem is not None:
        if problem.get("upstream_status") not in UPSTREAM_STATUS:
            errors.append("problem.md: upstream_status 无效")
        if problem.get("problem_confidence") not in PROBLEM_CONFIDENCE:
            errors.append("problem.md: problem_confidence 无效")

    solution = documents.get("solution")
    if solution is not None:
        if solution.get("upstream_status") not in UPSTREAM_STATUS:
            errors.append("solutions.md: upstream_status 无效")
        if solution.get("decision_status") not in DECISION_STATUS:
            errors.append("solutions.md: decision_status 无效")

    gate_result = readiness.get("gate_result")
    if gate_result not in GATE_RESULT:
        errors.append("readiness.md: gate_result 无效")
    if readiness.get("review_mode") not in REVIEW_MODE:
        errors.append("readiness.md: review_mode 无效")
    if not isinstance(readiness.get("p1_tracking_complete"), bool):
        errors.append("readiness.md: p1_tracking_complete 必须是布尔值")
    p0_count = nonnegative_int(readiness, "p0_count", errors, "readiness.md")
    p1_count = nonnegative_int(readiness, "p1_count", errors, "readiness.md")
    p1_complete = readiness.get("p1_tracking_complete") is True
    handoff = documents.get("handoff")

    for stage, meta in documents.items():
        validate_semantics(stage, meta, bodies.get(stage, ""), requirement_dir, documents, errors)

    readiness_updated = parse_timestamp(readiness.get("updated_at"))
    if readiness_updated:
        for stage in ("intake", "evidence", "problem", "solution"):
            upstream_updated = parse_timestamp(documents.get(stage, {}).get("updated_at"))
            if upstream_updated and upstream_updated > readiness_updated:
                errors.append(f"readiness.md: 已过期，{stage} 的 updated_at 更新")
    if handoff is not None:
        handoff_updated = parse_timestamp(handoff.get("updated_at"))
        if handoff_updated:
            for stage in ("intake", "evidence", "problem", "solution", "readiness"):
                upstream_updated = parse_timestamp(documents.get(stage, {}).get("updated_at"))
                if upstream_updated and upstream_updated > handoff_updated:
                    errors.append(f"handoff.md: 已过期，{stage} 的 updated_at 更新")

    p0_rows = markdown_table(bodies.get("readiness", ""), "## 3. P0 阻塞")
    p1_rows = markdown_table(bodies.get("readiness", ""), "## 4. P1 条件项")
    p0_ids = validate_issue_rows(
        p0_rows,
        "readiness.md",
        "P0 阻塞",
        "P0-",
        ("阻塞项", "依据", "不确认的影响", "最短补齐方式", "建议负责人"),
        errors,
    )
    p1_ids = validate_issue_rows(
        p1_rows,
        "readiness.md",
        "P1 条件项",
        "P1-",
        ("条件项", "影响范围", "最晚处理阶段或时间", "处理方式", "负责人"),
        errors,
    )
    if p0_count >= 0 and len(p0_ids) != p0_count:
        errors.append(f"readiness.md: p0_count={p0_count} 与 P0 表格有效行数 {len(p0_ids)} 不一致")
    if p1_count >= 0 and len(p1_ids) != p1_count:
        errors.append(f"readiness.md: p1_count={p1_count} 与 P1 表格有效行数 {len(p1_ids)} 不一致")

    handoff_p1_ids: list[str] = []
    handoff_p1_rows: list[dict[str, str]] = []
    if handoff is not None:
        pending_rows = markdown_table(bodies.get("handoff", ""), "## 9. 待确认项")
        if pending_rows is None:
            errors.append("handoff.md: 缺少或无法解析待确认项表格")
        else:
            if any(row.get("等级", "").strip() == "P0" or row.get("ID", "").strip().startswith("P0-") for row in pending_rows):
                errors.append("handoff.md: READY 或 CONDITIONAL 不得包含 P0")
            handoff_p1_rows = [
                row for row in pending_rows
                if row.get("等级", "").strip() == "P1" or row.get("ID", "").strip().startswith("P1-")
            ]
            handoff_p1_ids = validate_issue_rows(
                handoff_p1_rows,
                "handoff.md",
                "P1 待确认项",
                "P1-",
                ("问题", "等级", "影响", "负责人", "最晚确认阶段或时间"),
                errors,
            )
            for row in handoff_p1_rows:
                if row.get("等级", "").strip() != "P1":
                    errors.append(f"handoff.md: {row.get('ID', 'P1')} 的等级必须为 P1")

    if handoff is not None and handoff.get("gate_result") != gate_result:
        errors.append("handoff.md: gate_result 与 readiness 不一致")

    research_route = bool(intake and intake.get("route") == "pm-evidence-research")
    research_complete = bool(
        evidence
        and evidence.get("artifact_status") == "confirmed"
        and evidence.get("upstream_status") == "verified"
        and evidence.get("next_route") == "pm-problem-framing"
    )

    if gate_result == "READY":
        required_stages = ["intake", "problem", "solution", "handoff"] + (["evidence"] if research_route else [])
        for stage in required_stages:
            if stage not in documents:
                errors.append(f"READY: 缺少 {stage} 产物")
        if p0_count != 0:
            errors.append("READY: p0_count 必须为 0")
        if p1_count != 0:
            errors.append("READY: p1_count 必须为 0")
        if handoff_p1_ids:
            errors.append("READY: handoff 不得包含 P1")
        if intake and intake.get("route") not in {"pm-problem-framing", "pm-evidence-research"}:
            errors.append("READY: intake route 必须进入问题定义或证据补证")
        if research_route and not research_complete:
            errors.append("READY: 证据补证必须已确认并路由到 pm-problem-framing")
        if problem and (problem.get("problem_confidence") != "validated" or problem.get("upstream_status") != "verified"):
            errors.append("READY: 问题必须已验证且上游已核验")
        if solution and (solution.get("decision_status") != "confirmed" or solution.get("upstream_status") != "verified"):
            errors.append("READY: 方案必须已确认且上游已核验")
        for stage in ("intake", "evidence", "problem", "solution", "readiness", "handoff"):
            if stage in documents and documents[stage].get("artifact_status") != "confirmed":
                errors.append(f"READY: {stage} 的 artifact_status 必须为 confirmed")
    elif gate_result == "CONDITIONAL":
        required_stages = ["intake", "problem", "solution", "handoff"] + (["evidence"] if research_route else [])
        for stage in required_stages:
            if stage not in documents:
                errors.append(f"CONDITIONAL: 缺少 {stage} 产物")
        if p0_count != 0 or p1_count <= 0 or not p1_complete:
            errors.append("CONDITIONAL: 要求 P0=0、P1>0 且 P1 责任与期限登记完整")
        if p1_count >= 0 and len(handoff_p1_ids) != p1_count:
            errors.append(f"CONDITIONAL: handoff P1 数量 {len(handoff_p1_ids)} 必须等于 p1_count={p1_count}")
        if set(handoff_p1_ids) != set(p1_ids):
            errors.append("CONDITIONAL: readiness 与 handoff 的 P1-ID 必须完全一致")
        readiness_by_id = {row.get("ID", "").strip(): row for row in p1_rows or []}
        handoff_by_id = {row.get("ID", "").strip(): row for row in handoff_p1_rows}
        field_pairs = (
            ("条件项", "问题"),
            ("影响范围", "影响"),
            ("负责人", "负责人"),
            ("最晚处理阶段或时间", "最晚确认阶段或时间"),
        )
        for issue_id in set(readiness_by_id) & set(handoff_by_id):
            for readiness_field, handoff_field in field_pairs:
                if readiness_by_id[issue_id].get(readiness_field, "").strip() != handoff_by_id[issue_id].get(handoff_field, "").strip():
                    errors.append(
                        f"CONDITIONAL: {issue_id} 的 {readiness_field}/{handoff_field} 在 readiness 与 handoff 中不一致"
                    )
        if intake and intake.get("route") not in {"pm-problem-framing", "pm-evidence-research"}:
            errors.append("CONDITIONAL: intake route 必须进入问题定义或证据补证")
        if research_route and not research_complete:
            errors.append("CONDITIONAL: 证据补证必须已确认并路由到 pm-problem-framing")
        if problem and problem.get("upstream_status") != "verified":
            errors.append("CONDITIONAL: problem 上游必须已核验")
        if problem and problem.get("problem_confidence") not in {"validated", "plausible"}:
            errors.append("CONDITIONAL: problem_confidence 只能是 validated 或 plausible")
        if solution and solution.get("upstream_status") != "verified":
            errors.append("CONDITIONAL: solution 上游必须已核验")
        if solution and solution.get("decision_status") not in {"pending", "confirmed"}:
            errors.append("CONDITIONAL: decision_status 只能是 pending 或 confirmed")
        for stage in ("intake", "evidence", "problem", "solution", "readiness", "handoff"):
            if stage in documents and documents[stage].get("artifact_status") != "confirmed":
                errors.append(f"CONDITIONAL: {stage} 的 artifact_status 必须为 confirmed")
    elif gate_result == "NOT_READY":
        if p0_count <= 0:
            errors.append("NOT_READY: 至少需要一个 P0")
        if handoff is not None:
            errors.append("NOT_READY: 不得生成 handoff.md")

    return errors


def sample_body(stage: str, meta: dict[str, object]) -> str:
    if stage == "intake":
        return "\n".join([
            "# 需求受理卡",
            "",
            "## 1. 原始输入",
            "",
            "医生反馈历史记录定位耗时，希望减少重复查找。",
            "",
            "## 2. 来源",
            "",
            "- 提出人：医生 A",
            "- 来源类型：用户访谈",
            "- 是否转述：否",
            "- 时间：2026-07-16T00:00:00+08:00",
            "- 来源路径或链接：source.md#用户反馈",
            "",
            "## 3. 初步识别",
            "",
            "- 主要需求性质：用户问题",
            "- 次要需求性质：体验优化",
            "- 表面诉求：快速定位历史记录",
            "- 目标候选：减少查找耗时",
            "- 目标用户候选：接诊医生",
            "- 场景候选：复诊查看历史记录",
            "- 潜在问题：历史记录难以定位",
            "- 输入中已指定的方案：增加检索入口",
            "- 已知约束：必须保留权限校验",
            "",
            "## 4. 当前证据",
            "",
            "| 证据 | 原始来源 ID 或路径 | 支持或反驳什么 | 强度 | 备注 |",
            "|---|---|---|---|---|",
            "| 用户访谈 | source.md#用户反馈 | 支持查找困难 | E2 | 已核对原话 |",
            "",
            "- 综合证据等级：E2",
            "- 说明：单一明确场景，需继续核验影响范围。",
            "",
            "## 5. 历史关联",
            "",
            "- 重复需求：无（已检索当前项目）",
            "- 相关功能：历史记录列表",
            "- 相关缺陷：无（行为符合现有规则）",
            "- 相关决策：保留权限校验",
            "- 冲突：无（已核对现有决策）",
            "- 依赖：历史记录接口",
            "",
            "## 6. 信息缺口",
            "",
            "| 缺失信息 | 为什么重要 | 是否阻塞下一步 | 建议获取方式 |",
            "|---|---|---|---|",
            "| 影响频率 | 判断优先级 | 否 | 查询日志 |",
            "",
            "## 7. 分诊结论",
            "",
            f"- 推荐下一步主路径：{meta.get('route', 'pm-problem-framing')}",
            "- 理由：用户、场景与障碍已可描述，适合继续定义问题。",
            "- 当前不建议做的事情：直接确定页面方案",
            "- 重新评估条件：发现现有能力已完整覆盖",
        ])
    if stage == "evidence":
        return "\n".join([
            "# 证据研究简报",
            "",
            "## 1. 待验证判断",
            "",
            "| ID | 判断 | 会改变什么 | 支持标准 | 反驳标准 |",
            "|---|---|---|---|---|",
            "| Q-01 | 医生定位历史记录存在稳定障碍 | 是否继续问题定义 | 多个独立任务证据 | 观察中可快速完成 |",
            "",
            "## 2. 最小研究计划",
            "",
            "| 研究问题 | 用户/数据范围 | 方法 | 记录内容 | 停止标准 | 负责人 | 最晚节点 |",
            "|---|---|---|---|---|---|---|",
            "| 定位障碍发生在哪一步 | 接诊医生 | 任务观察 | 步骤与耗时 | 能判断主要障碍 | 产品负责人 | 2026-07-20T00:00:00+08:00 |",
            "",
            "## 3. 证据索引",
            "",
            "| 证据 ID | 来源及定位 | 时间 | 样本/范围 | 支持或反驳 | 独立来源组 | 局限 |",
            "|---|---|---|---|---|---|---|",
            "| E-01 | source.md#用户反馈 | 2026-07-16T00:00:00+08:00 | 接诊医生 | 支持定位困难 | interview-01 | 单一科室 |",
            "",
            "## 4. 数据口径",
            "",
            "- 指标与分母：不适用（本轮为定性补证）",
            "- 数据源：source.md",
            "- 时间窗口：2026-07-16",
            "- 过滤条件：接诊医生",
            "- 缺失/异常/重复处理：同源转述去重",
            "- 分层：科室",
            "- 已知偏差：单一科室",
            "- 可复算来源：source.md#用户反馈",
            "",
            "## 5. 反例与冲突",
            "",
            "| 反例或冲突 | 来源 | 影响的判断 | 适用范围 | 处理结论 |",
            "|---|---|---|---|---|",
            "| 熟练用户可记录日期 | source.md#用户反馈 | 障碍强度 | 熟练用户 | 不推翻主要障碍 |",
            "",
            "## 6. 证据结论",
            "",
            f"- 结论（与 frontmatter 一致）：{meta.get('evidence_conclusion', 'strengthened')}",
            "- 得到加强的判断：历史记录定位存在可观察障碍",
            "- 被削弱或推翻的判断：问题覆盖全部科室尚未证实",
            "- 仍不足的判断：影响规模",
            "- 适用用户与场景：接诊医生复诊场景",
            "- 不适用范围：未观察的科室",
            "",
            "## 7. 下一步",
            "",
            f"- 路由（与 frontmatter 一致）：{meta.get('next_route', 'pm-problem-framing')}",
            "- 理由：证据足以形成条件性问题定义",
            "- 重新评估条件：出现相反任务观察",
        ])
    if stage == "problem":
        return "\n".join([
            "# 问题定义简报",
            "",
            "## 1. 问题可信度结论",
            "",
            f"- 结论（与 frontmatter 一致）：{meta.get('problem_confidence', 'validated')}",
            "- 理由：访谈和任务观察均显示定位历史记录耗时。",
            "- 当前最薄弱的假设：问题是否覆盖全部科室。",
            "",
            "## 2. 原始诉求与方案剥离",
            "",
            "- 原始诉求：增加历史记录检索入口",
            "- 输入中指定的方案：新增入口",
            "- 方案试图解决的问题候选：历史记录定位困难",
            "",
            "## 3. 用户与场景",
            "",
            "- 目标用户：接诊医生",
            "- 直接受影响者：接诊医生",
            "- 间接受影响者：患者",
            "- 决策者：产品负责人",
            "- 触发场景：复诊时查看历史记录",
            "- 前置条件：医生已登录且拥有患者权限",
            "",
            "## 4. 用户任务与当前流程",
            "",
            "| 步骤 | 用户目标 | 当前操作 | 所需信息 | 障碍或风险 | 绕行方式 | 来源 |",
            "|---|---|---|---|---|---|---|",
            "| 1 | 找到历史记录 | 逐页浏览列表 | 患者与日期 | 列表较长且缺少定位线索 | 记录日期后重试 | source.md#用户反馈 |",
            "",
            "## 5. 主问题",
            "",
            "### 问题陈述",
            "",
            "> 接诊医生在复诊查看历史记录时，因列表缺少定位线索而反复翻页，增加查找耗时；目标是更快定位，本期不改动记录内容。",
            "",
            "### 子问题",
            "",
            "| 子问题 | 用户 | 场景 | 是否可独立解决 | 证据 |",
            "|---|---|---|---|---|",
            "| 定位线索不足 | 接诊医生 | 复诊 | 是 | source.md#用户反馈 |",
            "",
            "## 6. 症状、原因和影响",
            "",
            "| 类型 | 内容 | 证据 | 可信度 |",
            "|---|---|---|---|",
            "| 症状 | 反复翻页 | source.md#用户反馈 | 高 |",
            "| 原因假设 | 缺少有效定位线索 | 任务观察 | 中 |",
            "| 影响 | 查找耗时增加 | 用户访谈 | 中 |",
            "",
            "## 7. 证据与反例",
            "",
            "| 判断 | 支持证据 | 反例或冲突 | 证据强度 | 结论 |",
            "|---|---|---|---|---|",
            "| 定位困难存在 | 访谈与任务观察 | 未发现（已检查另一名用户） | E3 | 支持 |",
            "",
            "## 8. 目标状态与成功信号",
            "",
            "- 目标状态：医生可根据已知线索快速定位历史记录",
            "- 可观察成功信号：完成定位所需步骤和时间下降",
            "- 已有基线：当前需要逐页浏览",
            "- 尚缺数据：不同科室的频率",
            "",
            "## 9. 约束与非目标",
            "",
            "- 业务约束：不得改变原始记录",
            "- 技术约束：复用现有接口",
            "- 合规或安全约束：继续执行患者权限校验",
            "- 时间约束：本迭代完成验证",
            "- 非目标：不修改历史记录内容",
            "",
            "## 10. 关键假设",
            "",
            "| 假设 | 类型 | 当前证据 | 风险 | 验证方式 | 成功标准 |",
            "|---|---|---|---|---|---|",
            "| 日期是有效线索 | 用户行为 | 访谈 | 中 | 原型测试 | 用户可完成定位 |",
            "",
            "## 11. 待验证问题",
            "",
            "| 问题 | 等级 | 会改变什么 | 建议验证方式 | 建议确认人 |",
            "|---|---|---|---|---|",
            "| 科室覆盖范围 | P1 | 局部筛选项 | 数据分析 | 产品负责人 |",
            "",
            "## 12. 进入方案设计的条件",
            "",
            "- 已满足：主问题和目标用户明确",
            "- 可条件带入：科室覆盖范围",
            "- 当前阻塞：无（已完成核心问题核验）",
        ])
    if stage == "solution":
        decision_status = str(meta.get("decision_status", "confirmed"))
        return "\n".join([
            "# 方案设计简报",
            "",
            "## 1. 方案设计前提",
            "",
            "- 主问题：历史记录定位困难",
            "- 目标用户：接诊医生",
            "- 目标状态：按已知线索快速定位",
            "- 必须解决的能力：缩小候选记录范围",
            "- 已确认约束：保留患者权限校验",
            "- 非目标：不编辑历史记录内容",
            "- 当前证据强度：E3",
            "- 仍依赖的关键假设：日期是常用定位线索",
            "",
            "## 2. 候选方案",
            "",
            "### 方案 A：",
            "",
            "- 核心机制：增加日期筛选",
            "- 用户流程变化：先选择日期范围再浏览结果",
            "- 覆盖的问题：减少无关记录",
            "- 本期范围：日期范围筛选",
            "- 非范围：全文检索",
            "- 前置依赖：现有列表接口支持日期参数",
            "- 主要风险：用户不记得准确日期",
            "- 失败或降级方式：保留原列表浏览",
            "- 验证方法：可用性测试",
            "",
            "### 方案 B：",
            "",
            "- 核心机制：增加最近记录快捷入口",
            "- 用户流程变化：从快捷入口进入最近记录",
            "- 覆盖的问题：减少近期记录查找步骤",
            "- 本期范围：最近三次记录",
            "- 非范围：任意日期检索",
            "- 前置依赖：现有列表排序稳定",
            "- 主要风险：无法覆盖较早记录",
            "- 失败或降级方式：返回完整列表",
            "- 验证方法：任务完成率测试",
            "",
            "## 3. 方案比较",
            "",
            "| 维度 | 方案 A | 方案 B |",
            "|---|---|---|",
            "| 问题覆盖度 | 覆盖任意日期 | 仅覆盖近期 |",
            "",
            "## 4. 推荐结论",
            "",
            "- 推荐方案：方案 A",
            "- 推荐理由：覆盖主问题且复用现有接口",
            "- 不选择其他方案的理由：方案 B 无法覆盖较早记录",
            "- 结论依赖的假设：日期是常用定位线索",
            "- 改选条件：原型测试显示用户无法使用日期定位",
            f"- 决策状态（与 frontmatter 一致）：{decision_status}",
            "- 决策人：产品负责人",
            "- 确认时间：2026-07-16T00:00:00+08:00",
            "- 决策来源：source.md#确认记录",
            "",
            "## 5. 最小可验证闭环",
            "",
            "- 目标用户：接诊医生",
            "- 触发条件：复诊查看历史记录",
            "- 核心任务：定位目标记录",
            "- 必要输入：日期范围",
            "- 系统处理：按日期过滤有权限的记录",
            "- 用户确认或控制点：用户提交筛选条件",
            "- 输出结果：匹配记录列表",
            "- 结果如何被使用：打开目标记录",
            "- 失败与恢复：清除筛选返回完整列表",
            "- 验证指标：任务完成率和完成时间",
            "- 成功标准：测试用户均能完成定位且步骤减少",
            "- 停止或回退标准：任务完成率低于现有流程",
            "",
            "## 6. 本期范围",
            "",
            "### 必须实现",
            "",
            "- 日期范围筛选并保留权限校验",
            "",
            "### 验证性实现",
            "",
            "- 记录筛选使用次数",
            "",
            "### 体验增强",
            "",
            "- 常用日期快捷选择",
            "",
            "### 暂不实现",
            "",
            "- 全文检索",
            "",
            "## 7. 风险与依赖",
            "",
            "| 风险或依赖 | 类型 | 概率 | 影响 | 验证或缓解 | 降级 | 责任人 |",
            "|---|---|---|---|---|---|---|",
            "| 接口不支持日期参数 | 技术依赖 | 低 | 影响筛选实现 | 开发前验证接口 | 保留原列表 | 技术负责人 |",
            "",
            "## 8. 进入准入检查的条件",
            "",
            "- 已满足：方案和最小闭环已明确",
            "- 可条件带入：科室覆盖范围",
            "- 当前阻塞：无（核心依赖已确认）",
        ])
    if stage == "readiness":
        p0_total = meta.get("p0_count") if type(meta.get("p0_count")) is int else 0
        p1_total = meta.get("p1_count") if type(meta.get("p1_count")) is int else 0
        p0_rows = [
            f"| P0-{index:02d} | 阻塞项 {index} | source.md | 可能推翻范围 | 补齐证据 | 产品负责人 |"
            for index in range(1, max(0, p0_total) + 1)
        ]
        p1_rows = [
            f"| P1-{index:02d} | 条件项 {index} | 局部规则 | PRD 评审前 | 明确规则 | 产品负责人 |"
            for index in range(1, max(0, p1_total) + 1)
        ]
        return "\n".join([
            "# PRD 准入报告",
            "",
            "## 1. 准入结论",
            "",
            f"- 结论（与 frontmatter `gate_result` 一致）：{meta.get('gate_result', 'READY')}",
            "- 核心理由：问题、方案、范围和验收方向均已明确。",
            "- 当前最大返工风险：无（已核对核心假设与依赖）",
            "- 建议下一步：生成并校验 PRD",
            "",
            "## 2. 检查结果",
            "",
            "| 维度 | 状态 | 依据 | 问题等级 | 处理建议 |",
            "|---|---|---|---|---|",
            "| 问题与价值 | 已满足 | problem.md | 无 | 进入 PRD |",
            "| 方案与范围 | 已满足 | solutions.md | 无 | 进入 PRD |",
            "| 用户流程 | 已满足 | solutions.md | 无 | 细化验收 |",
            "| 业务对象和规则 | 已满足 | handoff 草稿 | 无 | 细化规则 |",
            "| 权限、责任和审计 | 已满足 | problem.md | 无 | 保留权限校验 |",
            "| 技术、数据与依赖 | 已满足 | solutions.md | 无 | 开发前复核 |",
            "| AI 与自动化 | 不适用 | 本需求不含 AI | 无 | 无需处理 |",
            "| 验收与上线 | 已满足 | solutions.md | 无 | 编写验收场景 |",
            "| 文档完整性 | 已满足 | 阶段产物 | 无 | 运行校验器 |",
            "",
            "## 3. P0 阻塞",
            "",
            "| ID | 阻塞项 | 依据 | 不确认的影响 | 最短补齐方式 | 建议负责人 |",
            "|---|---|---|---|---|---|",
            *p0_rows,
            "",
            "## 4. P1 条件项",
            "",
            "| ID | 条件项 | 影响范围 | 最晚处理阶段或时间 | 处理方式 | 负责人 |",
            "|---|---|---|---|---|---|",
            *p1_rows,
            "",
            "## 5. P2：可在 PRD 内补充",
            "",
            "| 项目 | 建议写入章节 | 备注 |",
            "|---|---|---|",
        ])
    if stage == "handoff":
        p1_rows = []
        if meta.get("gate_result") == "CONDITIONAL":
            p1_rows.append("| P1-01 | 条件项 1 | P1 | 局部规则 | 产品负责人 | PRD 评审前 |")
        return "\n".join([
            "# PRD 交接包",
            "",
            "## 1. 已确认事实",
            "",
            "| 事实 | 来源路径 | 定位或短摘录 |",
            "|---|---|---|",
            "| 医生需要在复诊时查找历史记录 | source.md | 用户反馈章节 |",
            "",
            "## 2. 已确认决策",
            "",
            "| 决策 | 确认人 | 确认时间 | 直接确认来源 |",
            "|---|---|---|---|",
            "| 使用日期筛选方案 | 产品负责人 | 2026-07-16T00:00:00+08:00 | source.md#确认记录 |",
            "",
            "## 3. 问题与目标",
            "",
            "- 目标用户：接诊医生",
            "- 场景：复诊查看历史记录",
            "- 用户任务：定位目标记录",
            "- 当前障碍：列表缺少定位线索",
            "- 影响：查找步骤和耗时增加",
            "- 目标状态：按日期快速定位记录",
            "- 非目标：不修改记录内容",
            "",
            "## 4. 推荐方案",
            "",
            "- 核心机制：按日期范围过滤有权限的记录",
            "- 用户流程变化：先选择日期再浏览结果",
            "- 决策状态：confirmed",
            "- 未选择方案及原因：最近记录入口覆盖不足",
            "",
            "## 5. 本期范围",
            "",
            "### 必须实现",
            "",
            "- 日期范围筛选并保留权限校验",
            "",
            "### 验证性实现",
            "",
            "- 记录筛选使用次数",
            "",
            "### 暂不实现",
            "",
            "- 全文检索",
            "",
            "## 6. 业务规则与约束",
            "",
            "- 核心对象：历史记录",
            "- 状态与转换：筛选仅改变列表视图，不改变记录状态",
            "- 权限：沿用患者记录查看权限",
            "- 数据：使用记录日期和患者标识",
            "- 外部依赖：历史记录列表接口",
            "- 性能或设备边界：普通门诊工作站两秒内返回",
            "- 合规与安全：不得扩大记录可见范围",
            "",
            "## 7. 风险与降级",
            "",
            "| 风险 | 触发条件 | 缓解 | 降级 | 恢复 |",
            "|---|---|---|---|---|",
            "| 日期参数不可用 | 接口不支持过滤 | 开发前验证 | 返回完整列表 | 清除筛选条件 |",
            "",
            "## 8. 明确假设",
            "",
            "| 假设 | 当前证据 | 风险 | 验证方式 |",
            "|---|---|---|---|",
            "| 日期是常用线索 | 用户访谈 | 中 | 原型测试 |",
            "",
            "## 9. 待确认项",
            "",
            "| ID | 问题 | 等级 | 影响 | 负责人 | 最晚确认阶段或时间 |",
            "|---|---|---|---|---|---|",
            *p1_rows,
        ])
    return ""


def sample(stage: str, body: str | None = None, **values: object) -> str:
    base: dict[str, object] = {
        "contract_version": 1,
        "requirement_id": "REQ-20260716-one",
        "product_id": "product",
        "project_id": "project",
        "owner": "产品负责人",
        "stage": stage,
        "artifact_status": "confirmed",
        "confirmed_by": "产品负责人",
        "confirmed_at": "2026-07-16T00:00:00+08:00",
        "confirmation_source": "source.md#确认记录",
        "superseded_at": "",
        "superseded_reason": "",
        "source_type": "local-notes",
        "source_paths": ["source.md"],
        "created_at": "2026-07-16T00:00:00+08:00",
        "updated_at": "2026-07-16T00:00:00+08:00",
    }
    base.update(values)
    lines = ["---"]
    for key, value in base.items():
        if isinstance(value, bool):
            rendered = str(value).lower()
        elif isinstance(value, int):
            rendered = str(value)
        elif isinstance(value, list):
            rendered = json.dumps(value, ensure_ascii=False)
        else:
            rendered = f'"{value}"'
        lines.append(f"{key}: {rendered}")
    if body is None:
        body = sample_body(stage, base)
    return "\n".join(lines + ["---", body])


def self_test() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        req = Path(tmp) / "pm-knowledge" / "projects" / "project" / "requirements" / "REQ-20260716-one"
        req.mkdir(parents=True)
        (req / "source.md").write_text(
            "# 用户反馈\n医生反馈历史记录定位耗时。\n\n# 确认记录\n产品负责人确认阶段产物及日期筛选方案。",
            encoding="utf-8",
        )
        (req / "intake.md").write_text(sample("intake", route="pm-problem-framing"), encoding="utf-8")
        (req / "problem.md").write_text(
            sample("problem", upstream_status="verified", problem_confidence="validated"), encoding="utf-8"
        )
        (req / "solutions.md").write_text(
            sample("solution", upstream_status="verified", decision_status="confirmed"), encoding="utf-8"
        )
        (req / "readiness.md").write_text(
            sample(
                "readiness",
                gate_result="READY",
                review_mode="standard",
                p0_count=0,
                p1_count=0,
                p1_tracking_complete=True,
            ),
            encoding="utf-8",
        )
        (req / "handoff.md").write_text(sample("handoff", gate_result="READY"), encoding="utf-8")
        assert validate(req) == [], validate(req)

        (req / "intake.md").write_text(sample("intake", route="pm-evidence-research"), encoding="utf-8")
        (req / "evidence.md").write_text(
            sample(
                "evidence",
                upstream_status="verified",
                evidence_conclusion="strengthened",
                next_route="pm-problem-framing",
            ),
            encoding="utf-8",
        )
        assert validate(req) == [], validate(req)
        (req / "evidence.md").unlink()
        assert any("READY: 缺少 evidence 产物" in error for error in validate(req))
        (req / "intake.md").write_text(sample("intake", route="pm-problem-framing"), encoding="utf-8")

        (req / "problem.md").write_text(
            sample("problem", body="", upstream_status="verified", problem_confidence="validated"),
            encoding="utf-8",
        )
        assert any("problem.md: 缺少章节" in error or "缺少实质内容" in error for error in validate(req))
        (req / "problem.md").write_text(
            sample("problem", upstream_status="verified", problem_confidence="validated"), encoding="utf-8"
        )

        (req / "solutions.md").write_text(
            sample("solution", body="", upstream_status="verified", decision_status="confirmed"),
            encoding="utf-8",
        )
        assert any("solutions.md: 缺少章节" in error for error in validate(req))
        (req / "solutions.md").write_text(
            sample("solution", upstream_status="verified", decision_status="confirmed"), encoding="utf-8"
        )

        (req / "handoff.md").write_text(sample("handoff", body="", gate_result="READY"), encoding="utf-8")
        assert any("handoff.md: 缺少章节" in error for error in validate(req))
        (req / "handoff.md").write_text(sample("handoff", gate_result="READY"), encoding="utf-8")

        (req / "intake.md").write_text(
            sample(
                "intake",
                route="pm-problem-framing",
                source_paths=["missing.md"],
                confirmation_source="missing.md#确认记录",
            ),
            encoding="utf-8",
        )
        assert any("指向不存在" in error and "missing.md" in error for error in validate(req))
        (req / "intake.md").write_text(sample("intake", route="pm-problem-framing"), encoding="utf-8")

        (req / "problem.md").write_text(
            sample(
                "problem",
                upstream_status="verified",
                problem_confidence="validated",
                confirmation_source="",
            ),
            encoding="utf-8",
        )
        assert any("confirmed 缺少 confirmation_source" in error for error in validate(req))
        (req / "problem.md").write_text(
            sample("problem", upstream_status="verified", problem_confidence="validated"), encoding="utf-8"
        )

        missing_decision_source = sample_body(
            "solution",
            {"decision_status": "confirmed"},
        ).replace("- 决策来源：source.md#确认记录", "- 决策来源：")
        (req / "solutions.md").write_text(
            sample(
                "solution",
                body=missing_decision_source,
                upstream_status="verified",
                decision_status="confirmed",
            ),
            encoding="utf-8",
        )
        assert any("推荐结论 的 决策来源" in error for error in validate(req))
        (req / "solutions.md").write_text(
            sample("solution", upstream_status="verified", decision_status="confirmed"), encoding="utf-8"
        )

        (req / "intake.md").write_text(
            sample(
                "intake",
                route="pm-problem-framing",
                updated_at="2026-07-17T00:00:00+08:00",
                confirmed_at="2026-07-17T00:00:00+08:00",
            ),
            encoding="utf-8",
        )
        stale_errors = validate(req)
        assert any("readiness.md: 已过期" in error for error in stale_errors)
        assert any("handoff.md: 已过期" in error for error in stale_errors)
        (req / "intake.md").write_text(sample("intake", route="pm-problem-framing"), encoding="utf-8")

        (req / "readiness.md").write_text(
            sample(
                "readiness",
                gate_result="READY",
                review_mode="standard",
                p0_count="0",
                p1_count=0,
                p1_tracking_complete="true",
            ),
            encoding="utf-8",
        )
        type_errors = validate(req)
        assert any("p0_count 必须" in error for error in type_errors)
        assert any("p1_tracking_complete 必须" in error for error in type_errors)

        (req / "readiness.md").write_text(
            sample(
                "readiness",
                gate_result="READY",
                review_mode="lightweight",
                p0_count=1,
                p1_count=0,
                p1_tracking_complete=True,
            ),
            encoding="utf-8",
        )
        assert any("p0_count" in error for error in validate(req))

        (req / "readiness.md").write_text(
            sample(
                "readiness",
                gate_result="CONDITIONAL",
                review_mode="reverse",
                p0_count=0,
                p1_count=1,
                p1_tracking_complete=False,
            ),
            encoding="utf-8",
        )
        (req / "handoff.md").write_text(sample("handoff", gate_result="CONDITIONAL"), encoding="utf-8")
        assert any("P1" in error for error in validate(req))

        conditional_meta = {
            "gate_result": "CONDITIONAL",
            "review_mode": "standard",
            "p0_count": 0,
            "p1_count": 1,
            "p1_tracking_complete": True,
        }
        missing_owner = sample_body("readiness", conditional_meta).replace(
            "| 明确规则 | 产品负责人 |", "| 明确规则 |  |"
        )
        (req / "readiness.md").write_text(
            sample("readiness", body=missing_owner, **conditional_meta), encoding="utf-8"
        )
        (req / "handoff.md").write_text(sample("handoff", gate_result="CONDITIONAL"), encoding="utf-8")
        assert any("缺少 负责人" in error for error in validate(req))

        (req / "readiness.md").write_text(sample("readiness", **conditional_meta), encoding="utf-8")
        missing_impact = sample_body("handoff", {"gate_result": "CONDITIONAL"}).replace(
            "| P1 | 局部规则 |", "| P1 |  |"
        )
        (req / "handoff.md").write_text(
            sample("handoff", body=missing_impact, gate_result="CONDITIONAL"), encoding="utf-8"
        )
        assert any("缺少 影响" in error for error in validate(req))

        changed_impact = sample_body("handoff", {"gate_result": "CONDITIONAL"}).replace(
            "| P1 | 局部规则 |", "| P1 | 数据范围 |"
        )
        (req / "handoff.md").write_text(
            sample("handoff", body=changed_impact, gate_result="CONDITIONAL"), encoding="utf-8"
        )
        assert any("影响范围/影响" in error and "不一致" in error for error in validate(req))

        (req / "handoff.md").write_text(
            sample("handoff", gate_result="CONDITIONAL", project_id="other-project"), encoding="utf-8"
        )
        assert any("不一致" in error for error in validate(req))

        (req / "readiness.md").write_text(
            sample(
                "readiness",
                gate_result="NOT_READY",
                review_mode="standard",
                p0_count=1,
                p1_count=0,
                p1_tracking_complete=False,
            ),
            encoding="utf-8",
        )
        assert any("不得生成 handoff.md" in error for error in validate(req))

        duplicate = req / "duplicate.md"
        duplicate.write_text("---\nstage: readiness\nstage: handoff\n---\n", encoding="utf-8")
        try:
            frontmatter(duplicate)
        except ValueError as exc:
            assert "字段重复" in str(exc)
        else:
            raise AssertionError("duplicate frontmatter key was accepted")

        req2 = req.parent / "REQ-20260716-two"
        req2.mkdir()
        (req2 / "readiness.md").write_text(
            sample(
                "readiness",
                requirement_id="REQ-20260716-two",
                gate_result="CONDITIONAL",
                review_mode="reverse",
                p0_count=0,
                p1_count=1,
                p1_tracking_complete=True,
            ),
            encoding="utf-8",
        )
        (req2 / "handoff.md").write_text(
            sample("handoff", requirement_id="REQ-20260716-two", gate_result="CONDITIONAL"), encoding="utf-8"
        )
        missing_errors = validate(req2)
        assert any("缺少 problem" in error for error in missing_errors)
        assert any("缺少 solution" in error for error in missing_errors)

        req3 = req.parent / "REQ-20260716-three"
        req3.mkdir()
        (req3 / "intake.md").write_text(
            sample("intake", requirement_id="REQ-20260716-three", route="pm-problem-framing"), encoding="utf-8"
        )
        (req3 / "problem.md").write_text(
            sample(
                "problem",
                requirement_id="REQ-20260716-three",
                upstream_status="verified",
                problem_confidence="misframed",
            ),
            encoding="utf-8",
        )
        (req3 / "solutions.md").write_text(
            sample(
                "solution",
                requirement_id="REQ-20260716-three",
                upstream_status="verified",
                decision_status="proposal",
            ),
            encoding="utf-8",
        )
        (req3 / "readiness.md").write_text(
            sample(
                "readiness",
                requirement_id="REQ-20260716-three",
                gate_result="CONDITIONAL",
                review_mode="standard",
                p0_count=0,
                p1_count=1,
                p1_tracking_complete=True,
            ),
            encoding="utf-8",
        )
        (req3 / "handoff.md").write_text(
            sample("handoff", requirement_id="REQ-20260716-three", gate_result="CONDITIONAL", source_type="handoff"),
            encoding="utf-8",
        )
        state_errors = validate(req3)
        assert any("problem_confidence" in error for error in state_errors)
        assert any("decision_status" in error for error in state_errors)
    print("self-test: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requirement_dir", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.requirement_dir is None:
        parser.error("请提供 requirement directory")
    errors = validate(args.requirement_dir)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("handoff validation: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
