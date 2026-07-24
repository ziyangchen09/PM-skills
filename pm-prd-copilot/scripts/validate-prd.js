#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertId, readMarkdown } = require('./build-prd-context');

const REQUIREMENT_ID = /^REQ-\d{8}-[a-z0-9][a-z0-9-]{0,80}$/;
const GATES = new Set(['READY', 'CONDITIONAL']);
const REQUIRED_SECTIONS = [
  '需求背景',
  '目标与非目标',
  '需求范围',
  '用户故事与验收',
  '需求详情',
  '依赖、风险与发布',
  '待确认项',
  '需求缺口',
  '评审预判',
  '评审结论与签署',
  '来源',
];
const PLACEHOLDER = /^(?:|[-—]|tbd|todo|n\/a|待补充|已确认\/假设\/待确认)$/i;
const URL = /^https?:\/\//i;

function usage() {
  return [
    'Usage:',
    '  node validate-prd.js --prd <prd.md> --handoff <handoff.md>',
    '  node validate-prd.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new Error('Unexpected argument: ' + item);
    const key = item.slice(2);
    if (key === 'self-test') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    args[key] = value;
    i += 1;
  }
  return args;
}

function scanHeadings(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const kind = marker[1][0];
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      return;
    }
    if (fence) return;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ index, level: match[1].length, title: match[2].trim() });
  });
  return { lines, headings };
}

function headingCount(body, level, title) {
  return scanHeadings(body).headings.filter((heading) => (
    heading.level === level && heading.title === title
  )).length;
}

function section(body, level, title) {
  const { lines, headings } = scanHeadings(body);
  const startHeading = headings.find((heading) => heading.level === level && heading.title === title);
  const start = startHeading ? startHeading.index : -1;
  if (start < 0) return null;
  let end = lines.length;
  const nextHeading = headings.find((heading) => heading.index > start && heading.level <= level);
  if (nextHeading) {
    end = nextHeading.index;
  }
  return lines.slice(start + 1, end).join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/)
    .map((value) => value.replace(/\\\|/g, '|').trim());
}

function markdownTable(body, level, title) {
  const content = section(body, level, title);
  if (content === null) return null;
  const lines = content.split('\n');
  const start = lines.findIndex((line, index) => {
    if (!line.trim().startsWith('|') || index + 1 >= lines.length) return false;
    const separators = cells(lines[index + 1]);
    return separators.length > 0 && separators.every((value) => /^:?-{3,}:?$/.test(value));
  });
  if (start < 0) return null;
  const headers = cells(lines[start]);
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const values = cells(line);
    if (values.length === headers.length && values.some(Boolean)) {
      rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
    }
  }
  return rows;
}

function tableHeaders(body, level, title) {
  const content = section(body, level, title);
  if (content === null) return null;
  const lines = content.split('\n');
  const start = lines.findIndex((line, index) => {
    if (!line.trim().startsWith('|') || index + 1 >= lines.length) return false;
    const separators = cells(lines[index + 1]);
    return separators.length > 0 && separators.every((value) => /^:?-{3,}:?$/.test(value));
  });
  return start < 0 ? null : cells(lines[start]);
}

function missing(value) {
  const text = String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .trim()
    .replace(/[。.!！?？:：；;…]+$/g, '')
    .trim();
  return PLACEHOLDER.test(text)
    || /^(?:tbd|todo|n\/a|na|待补充)(?:$|[：:\s-])/i.test(text)
    || text.includes('具体内容');
}

function requireRows(rows, columns, label, errors) {
  if (!rows || rows.length === 0) {
    errors.push(label + '：至少需要一条有效记录');
    return [];
  }
  rows.forEach((row, index) => {
    for (const column of columns) {
      if (missing(row[column])) errors.push(label + `：第 ${index + 1} 行缺少 ${column}`);
    }
  });
  return rows;
}

function meaningfulSection(body, title) {
  const content = section(body, 1, title);
  if (content === null) return false;
  const lines = content.split('\n');
  return lines.some((line, index) => {
    const value = line.trim();
    if (!value || value.startsWith('#') || value.startsWith('>')) return false;
    if (!value.startsWith('|')) return !missing(value);
    const values = cells(value);
    if (values.every((item) => /^:?-{3,}:?$/.test(item))) return false;
    const next = lines[index + 1] && cells(lines[index + 1]);
    if (next && next.length === values.length && next.every((item) => /^:?-{3,}:?$/.test(item))) return false;
    return values.some((item) => !missing(item));
  });
}

function tableCount(body, level, title) {
  const content = section(body, level, title);
  if (content === null) return 0;
  const lines = content.split('\n');
  let count = 0;
  let fence = null;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const marker = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const kind = marker[1][0];
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      continue;
    }
    if (fence || !lines[index].trim().startsWith('|')) continue;
    const separators = cells(lines[index + 1]);
    if (separators.length > 0 && separators.every((item) => /^:?-{3,}:?$/.test(item))) count += 1;
  }
  return count;
}

function unresolvedCoreLines(body, title) {
  const content = section(body, 1, title) || '';
  return content.split('\n').filter((line) => {
    const text = line
      .replace(/<[^>]+>/g, '')
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
      .trim();
    return missing(text)
      || /^(?:待补充|待确认)(?:[：:].*)?[。.!！?？；;…]*$/i.test(text)
      || /已确认\s*\/\s*假设\s*\/\s*待确认/.test(text);
  });
}

function pendingText(value) {
  return String(value || '')
    .replace(/<span\b[^>]*>/gi, '')
    .replace(/<\/span>/gi, '')
    .trim()
    .replace(/^待确认[：:]\s*/, '')
    .trim();
}

function sourcePathPart(value) {
  const text = String(value || '').trim().replace(/^`|`$/g, '');
  if (!text || URL.test(text)) return text;
  const marker = text.indexOf('#');
  return (marker >= 0 ? text.slice(0, marker) : text).trim();
}

function knowledgeRootFromHandoff(handoffFile) {
  let cursor = path.dirname(path.resolve(handoffFile));
  while (path.dirname(cursor) !== cursor) {
    if (path.basename(cursor).toLowerCase() === 'projects') return path.dirname(cursor);
    cursor = path.dirname(cursor);
  }
  return null;
}

function sourceCandidates(value, prdFile, handoffFile) {
  const source = sourcePathPart(value);
  if (!source || URL.test(source)) return [];
  if (path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) return [];
  const candidates = [
    path.resolve(path.dirname(handoffFile), source),
    path.resolve(path.dirname(prdFile), source),
    path.resolve(process.cwd(), source),
  ];
  const knowledgeRoot = knowledgeRootFromHandoff(handoffFile);
  if (knowledgeRoot) candidates.unshift(path.resolve(knowledgeRoot, source));
  return [...new Set(candidates)];
}

function resolveExistingSource(value, prdFile, handoffFile) {
  const knowledgeRoot = knowledgeRootFromHandoff(handoffFile);
  const realKnowledgeRoot = knowledgeRoot && fs.existsSync(knowledgeRoot)
    ? fs.realpathSync.native(knowledgeRoot)
    : null;
  for (const candidate of sourceCandidates(value, prdFile, handoffFile)) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (fs.lstatSync(candidate).isSymbolicLink()) continue;
    const realCandidate = fs.realpathSync.native(candidate);
    if (realKnowledgeRoot) {
      const relative = path.relative(realKnowledgeRoot, realCandidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    }
    return realCandidate;
  }
  return null;
}

function sameExistingFile(left, right) {
  if (!left || !right || !fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftReal = fs.realpathSync.native(left);
  const rightReal = fs.realpathSync.native(right);
  if (process.platform === 'win32') return leftReal.toLowerCase() === rightReal.toLowerCase();
  return leftReal === rightReal;
}

function validateSourceReferences(values, label, prdFile, handoffFile, errors) {
  let includesHandoff = false;
  for (const value of values) {
    const source = sourcePathPart(value);
    if (!source || URL.test(source)) continue;
    const resolved = resolveExistingSource(value, prdFile, handoffFile);
    if (!resolved) {
      errors.push(label + ' 本地来源不存在：' + source);
      continue;
    }
    if (sameExistingFile(resolved, handoffFile)) includesHandoff = true;
  }
  return includesHandoff;
}

function validIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function sourceLocator(value) {
  const text = String(value || '').trim();
  const marker = text.indexOf('#');
  return marker >= 0 ? text.slice(marker + 1).trim() : '';
}

function locatorExists(file, locator) {
  let decoded = locator;
  try {
    decoded = decodeURIComponent(locator);
  } catch {
    decoded = locator;
  }
  const expected = decoded.trim().toLowerCase();
  if (!expected) return false;
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').some((line) => {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading && heading[1].trim().toLowerCase() === expected) return true;
    if (!line.trim().startsWith('|')) return false;
    return cells(line).some((value) => value.toLowerCase() === expected);
  });
}

function validateDecisionSource(value, prdFile, handoffFile, issueId, errors) {
  const locator = sourceLocator(value);
  if (!locator || URL.test(String(value || '').trim())) {
    errors.push(issueId + '：决策来源必须是带定位的本地文件');
    return;
  }
  const resolved = resolveExistingSource(value, prdFile, handoffFile);
  if (!resolved) {
    errors.push(issueId + '：决策来源文件不存在');
    return;
  }
  if (!locatorExists(resolved, locator)) errors.push(issueId + '：决策来源定位不存在');
}

function collectReviewSources(body, errors) {
  const specs = [
    [1, '需求缺口', ['REV-ID', 'ID', '问题', '等级', '依据', '影响', '建议', '需谁确认']],
    [2, '研发可能提问', ['REV-ID', '问题', '等级', '关联缺口/依据', '不确认的影响', '建议回答', '确认人']],
    [2, 'UI 可能提问', ['REV-ID', '问题', '等级', '关联缺口/依据', '不确认的影响', '建议回答', '确认人']],
  ];
  const sources = new Map();
  for (const [level, title, requiredColumns] of specs) {
    const headers = tableHeaders(body, level, title) || [];
    for (const column of requiredColumns) {
      if (!headers.includes(column)) errors.push(title + ' 表格缺少 ' + column + ' 列');
    }
    for (const [index, row] of (markdownTable(body, level, title) || []).entries()) {
      for (const column of requiredColumns) {
        if (missing(row[column])) errors.push(`${title}：第 ${index + 1} 行缺少 ${column}`);
      }
      const id = row['REV-ID'];
      if (!/^REV-\d+$/.test(id || '')) {
        errors.push(title + ' 的 REV-ID 必须使用 REV-<number>：' + (id || '空'));
        continue;
      }
      if (sources.has(id)) errors.push('REV-ID 重复：' + id);
      sources.set(id, title);
    }
  }
  return sources;
}

function readinessValidatorCandidates() {
  const workspaceRoot = path.resolve(__dirname, '..', '..');
  return [
    path.join(workspaceRoot, 'pm-prd-readiness-gate', 'scripts', 'validate_handoff.py'),
    path.join(workspaceRoot, 'PM-skills-pre-PRD-pack-v2', 'pm-prd-readiness-gate', 'scripts', 'validate_handoff.py'),
  ];
}

function validateHandoffWithGate(handoffFile) {
  const validator = readinessValidatorCandidates().find((candidate) => fs.existsSync(candidate));
  if (!validator) return ['未找到 pm-prd-readiness-gate 校验器，不能把 PRD 视为正式版本'];
  const commands = [...new Set([process.env.PYTHON, 'python', 'py'].filter(Boolean))];
  for (const command of commands) {
    const result = childProcess.spawnSync(command, [validator, path.dirname(handoffFile)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.status === 0) return [];
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return ['handoff 未通过 pm-prd-readiness-gate：' + (output || `退出码 ${result.status}`)];
  }
  return ['未找到可运行的 Python，无法复核 handoff 门禁'];
}

function p1Rows(rows) {
  return (rows || []).filter((row) => row['等级'] === 'P1' || /^P1-\d+$/.test(row.ID || ''));
}

function findOpenP0(body) {
  const locations = [
    [1, '待确认项'],
    [1, '需求缺口'],
    [2, '研发可能提问'],
    [2, 'UI 可能提问'],
  ];
  const located = locations.flatMap(([level, title]) => (markdownTable(body, level, title) || [])
    .filter((row) => row['等级'] === 'P0' || /^P0-\d+$/.test(row.ID || ''))
    .map((row) => `${title}:${row.ID || 'P0'}`));
  const global = [];
  let fence = null;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const kind = marker[1][0];
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      continue;
    }
    if (fence || !line.trim().startsWith('|')) continue;
    const values = cells(line);
    const id = values.find((value) => /^P0-\d+$/.test(value));
    if (id || values.includes('P0')) global.push('全局:' + (id || 'P0'));
  }
  return [...new Set([...located, ...global])];
}

function compareP1(prdRows, handoffRows, errors) {
  const prd = new Map();
  const handoff = new Map();
  for (const row of prdRows) {
    if (!/^P1-\d+$/.test(row.ID || '')) errors.push('PRD P1-ID 必须使用 P1-<number>：' + (row.ID || '空'));
    if (prd.has(row.ID)) errors.push('PRD P1-ID 重复：' + row.ID);
    prd.set(row.ID, row);
  }
  for (const row of handoffRows) {
    if (!/^P1-\d+$/.test(row.ID || '')) errors.push('handoff P1-ID 必须使用 P1-<number>：' + (row.ID || '空'));
    if (handoff.has(row.ID)) errors.push('handoff P1-ID 重复：' + row.ID);
    handoff.set(row.ID, row);
  }
  if ([...prd.keys()].sort().join('|') !== [...handoff.keys()].sort().join('|')) {
    errors.push('PRD 与 handoff 的 P1-ID 必须完全一致');
  }
  const fields = [
    ['待确认项', '问题', pendingText],
    ['等级', '等级', (value) => String(value || '').trim()],
    ['影响', '影响', (value) => String(value || '').trim()],
    ['建议确认人', '负责人', (value) => String(value || '').trim()],
    ['决策条件/时间点', '最晚确认阶段或时间', (value) => String(value || '').trim()],
  ];
  for (const id of prd.keys()) {
    if (!handoff.has(id)) continue;
    for (const [prdField, handoffField, normalize] of fields) {
      if (normalize(prd.get(id)[prdField]) !== normalize(handoff.get(id)[handoffField])) {
        errors.push(`${id}：${prdField} 未原样保留 handoff 的 ${handoffField}`);
      }
    }
  }
}

function validatePrd(prdFile, handoffFile, options = {}) {
  const errors = [];
  for (const [label, file] of [['PRD', prdFile], ['handoff', handoffFile]]) {
    if (!fs.existsSync(file)) errors.push(label + ' 文件不存在：' + file);
  }
  if (errors.length) return errors;

  const prd = readMarkdown(prdFile);
  const handoff = readMarkdown(handoffFile);
  if (path.basename(handoffFile).toLowerCase() !== 'handoff.md') {
    errors.push('handoff 文件名必须为 handoff.md');
  }
  if (options.checkHandoffGate) errors.push(...validateHandoffWithGate(handoffFile));
  const requiredMeta = [
    'title', 'product_id', 'project_id', 'requirement_id', 'readiness', 'status', 'version',
    'handoff_updated_at', 'handoff_sha256', 'source_analysis',
  ];
  for (const key of requiredMeta) {
    const value = prd.frontmatter[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      errors.push('PRD frontmatter 缺少 ' + key);
    }
  }
  for (const key of ['product_id', 'project_id']) {
    try {
      assertId(prd.frontmatter[key], key);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!REQUIREMENT_ID.test(prd.frontmatter.requirement_id || '')) {
    errors.push('requirement_id 必须使用 REQ-YYYYMMDD-feature-slug');
  }
  if (!GATES.has(prd.frontmatter.readiness)) errors.push('PRD readiness 只能是 READY 或 CONDITIONAL');
  if (handoff.frontmatter.stage !== 'handoff') errors.push('交接文件的 stage 必须为 handoff');
  if (handoff.frontmatter.artifact_status !== 'confirmed') errors.push('handoff 必须是 confirmed');
  if (!GATES.has(handoff.frontmatter.gate_result)) errors.push('handoff gate_result 只能是 READY 或 CONDITIONAL');

  for (const key of ['product_id', 'project_id', 'requirement_id']) {
    if (prd.frontmatter[key] !== handoff.frontmatter[key]) errors.push(`PRD ${key} 与 handoff 不一致`);
  }
  if (prd.frontmatter.readiness !== handoff.frontmatter.gate_result) {
    errors.push('PRD readiness 与 handoff gate_result 不一致');
  }
  if (!/^V\d+(?:\.\d+)*$/i.test(prd.frontmatter.version || '')) {
    errors.push('PRD version 必须使用 V<number>[.<number>...]');
  }
  if (!validIsoTimestamp(prd.frontmatter.handoff_updated_at)) {
    errors.push('handoff_updated_at 必须是带时区的 ISO-8601 时间');
  }
  if (prd.frontmatter.handoff_updated_at !== handoff.frontmatter.updated_at) {
    errors.push('PRD handoff_updated_at 与当前 handoff.md 不一致');
  }
  const handoffHash = crypto.createHash('sha256').update(fs.readFileSync(handoffFile)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(prd.frontmatter.handoff_sha256 || '')) {
    errors.push('handoff_sha256 必须是 64 位小写 SHA-256');
  } else if (prd.frontmatter.handoff_sha256 !== handoffHash) {
    errors.push('PRD handoff_sha256 与当前 handoff.md 不一致');
  }

  const sources = prd.frontmatter.source_analysis;
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((value) => typeof value === 'string' && value.trim())) {
    errors.push('source_analysis 必须是非空字符串列表');
  } else if (!validateSourceReferences(sources, 'source_analysis', prdFile, handoffFile, errors)) {
    errors.push('source_analysis 必须包含与 --handoff 相同的本地文件');
  }

  for (const title of REQUIRED_SECTIONS) {
    const count = headingCount(prd.body, 1, title);
    if (count === 0) errors.push('缺少必填章节：' + title);
    if (count > 1) errors.push('必填章节不得重复：' + title);
  }
  for (const [level, title] of [
    [2, '用户故事'],
    [2, '场景覆盖矩阵'],
    [2, '研发可能提问'],
    [2, 'UI 可能提问'],
  ]) {
    if (headingCount(prd.body, level, title) > 1) errors.push('章节不得重复：' + title);
  }
  for (const [level, title] of [
    [1, '需求范围'],
    [2, '用户故事'],
    [2, '场景覆盖矩阵'],
    [1, '待确认项'],
    [1, '需求缺口'],
    [2, '研发可能提问'],
    [2, 'UI 可能提问'],
    [1, '评审结论与签署'],
    [1, '来源'],
  ]) {
    if (tableCount(prd.body, level, title) > 1) errors.push('受控章节只能包含一张表格：' + title);
  }
  for (const title of ['需求背景', '目标与非目标', '需求详情', '依赖、风险与发布']) {
    if (!meaningfulSection(prd.body, title)) errors.push('必填章节没有有效内容：' + title);
    if (unresolvedCoreLines(prd.body, title).length) errors.push('正式需求章节不得保留待补充/待确认占位：' + title);
  }

  requireRows(
    markdownTable(prd.body, 1, '需求范围'),
    ['功能', '概述', '优先级'],
    '需求范围',
    errors,
  );

  const stories = requireRows(
    markdownTable(prd.body, 2, '用户故事'),
    ['ID', '角色', '触发场景', '目标', '用户价值', '依据', '状态'],
    '用户故事',
    errors,
  );
  const storyIds = new Set();
  for (const story of stories) {
    if (!/^US-\d+$/.test(story.ID || '')) errors.push('用户故事 ID 必须使用 US-<number>：' + (story.ID || '空'));
    if (storyIds.has(story.ID)) errors.push('用户故事 ID 重复：' + story.ID);
    if (story['状态'] !== '已确认') errors.push((story.ID || '用户故事') + ' 状态必须为已确认；不确定项应进入 P1');
    storyIds.add(story.ID);
  }

  const scenarios = requireRows(
    markdownTable(prd.body, 2, '场景覆盖矩阵'),
    ['AC-ID', '关联故事', '类型', '前置条件（Given）', '用户动作（When）', '可观察结果（Then）', '状态'],
    '场景覆盖矩阵',
    errors,
  );
  const scenarioIds = new Set();
  for (const scenario of scenarios) {
    if (!/^AC-\d+$/.test(scenario['AC-ID'] || '')) errors.push('验收场景 ID 必须使用 AC-<number>：' + (scenario['AC-ID'] || '空'));
    if (scenarioIds.has(scenario['AC-ID'])) errors.push('验收场景 ID 重复：' + scenario['AC-ID']);
    if (scenario['状态'] !== '已确认') errors.push((scenario['AC-ID'] || '验收场景') + ' 状态必须为已确认；不确定项应进入 P1');
    scenarioIds.add(scenario['AC-ID']);
    if (!storyIds.has(scenario['关联故事'])) errors.push('验收场景引用了不存在的故事：' + scenario['关联故事']);
  }
  for (const storyId of storyIds) {
    if (!scenarios.some((row) => row['关联故事'] === storyId && row['类型'] === '正常')) {
      errors.push(storyId + ' 缺少正常验收场景');
    }
  }

  const sourceRows = requireRows(
    markdownTable(prd.body, 1, '来源'),
    ['ID', '类型', '本地路径/原始链接', '用途'],
    '来源',
    errors,
  );
  if (!validateSourceReferences(
    sourceRows.map((row) => row['本地路径/原始链接']),
    '来源表',
    prdFile,
    handoffFile,
    errors,
  )) {
    errors.push('来源表必须包含与 --handoff 相同的本地文件');
  }

  const reviewSources = collectReviewSources(prd.body, errors);
  const reviewRows = markdownTable(prd.body, 1, '评审结论与签署');
  if (reviewRows === null) {
    errors.push('评审结论与签署必须包含标准表格');
  } else {
    const reviewIds = new Set();
    reviewRows.forEach((row, index) => {
      const id = row['Issue ID'];
      const status = row['状态'];
      if (!/^REV-\d+$/.test(id || '')) errors.push(`评审结论第 ${index + 1} 行 Issue ID 必须使用 REV-<number>`);
      if (reviewIds.has(id)) errors.push('评审 Issue ID 重复：' + id);
      reviewIds.add(id);
      if (!reviewSources.has(id)) errors.push((id || '评审结论') + '：没有对应的来源问题');
      if (reviewSources.has(id) && !String(row['来源'] || '').includes(reviewSources.get(id))) {
        errors.push(id + '：来源必须指向 ' + reviewSources.get(id));
      }
      if (!['open', 'resolved', 'accepted-risk'].includes(status)) {
        errors.push((id || `评审结论第 ${index + 1} 行`) + ' 状态无效');
      }
      if (status === 'resolved' || status === 'accepted-risk') {
        for (const column of ['最终答案/决策', '决策来源', '确认人', '确认时间']) {
          if (missing(row[column])) errors.push(`${id || '评审结论'}：${status} 时必须填写 ${column}`);
        }
        if (row['确认时间'] && !validIsoTimestamp(row['确认时间'])) {
          errors.push(`${id || '评审结论'}：确认时间必须是带时区的 ISO-8601 时间`);
        }
        if (!missing(row['决策来源'])) validateDecisionSource(row['决策来源'], prdFile, handoffFile, id || '评审结论', errors);
      }
    });
    for (const [id, source] of reviewSources) {
      if (!reviewIds.has(id)) errors.push(`${id}：${source} 中的问题尚未进入评审结论与签署`);
    }
  }

  for (const item of findOpenP0(prd.body)) errors.push('正式 PRD 不得保留开放 P0：' + item);

  const prdPending = p1Rows(markdownTable(prd.body, 1, '待确认项'));
  const handoffPending = p1Rows(markdownTable(handoff.body, 2, '9. 待确认项'));
  if (prd.frontmatter.readiness === 'READY' && prdPending.length) {
    errors.push('READY PRD 不得包含 P1 待确认项');
  }
  if (prd.frontmatter.readiness === 'READY' && handoffPending.length) {
    errors.push('READY handoff 不得包含 P1 待确认项');
  }
  if (prd.frontmatter.readiness === 'CONDITIONAL') {
    requireRows(
      prdPending,
      ['ID', '待确认项', '等级', '影响', '触发依据', '建议确认人', '决策条件/时间点'],
      'CONDITIONAL P1',
      errors,
    );
    compareP1(prdPending, handoffPending, errors);
  }
  return errors;
}

function sampleHandoff(gate) {
  const pending = gate === 'CONDITIONAL'
    ? '| P1-01 | 确认极端布局 | P1 | UI 范围 | 产品负责人 | PRD 评审前 |'
    : '';
  return `---
product_id: "ct"
project_id: "viewer"
requirement_id: "REQ-20260720-layout"
stage: "handoff"
artifact_status: "confirmed"
gate_result: "${gate}"
updated_at: "2026-07-20T00:00:00+08:00"
---
# PRD 交接包
## 9. 待确认项
| ID | 问题 | 等级 | 影响 | 负责人 | 最晚确认阶段或时间 |
|---|---|---|---|---|---|
${pending}
`;
}

function samplePrd(gate, handoffContent = sampleHandoff(gate)) {
  const pending = gate === 'CONDITIONAL'
    ? '| P1-01 | <span style="color:#A65A5A">待确认：确认极端布局</span> | P1 | UI 范围 | handoff.md | 产品负责人 | PRD 评审前 |'
    : '';
  return `---
title: "布局需求"
product_id: "ct"
project_id: "viewer"
requirement_id: "REQ-20260720-layout"
readiness: "${gate}"
status: "draft"
version: "V0.1"
handoff_updated_at: "2026-07-20T00:00:00+08:00"
handoff_sha256: "${crypto.createHash('sha256').update(handoffContent, 'utf8').digest('hex')}"
source_analysis: ["projects/viewer/requirements/REQ-20260720-layout/handoff.md"]
---
# 需求背景
## 用户与场景
医生需要比较多张影像。
# 目标与非目标
## 目标
支持多图比较。
# 需求范围
| 功能 | 概述 | 优先级 |
|---|---|---|
| 多图布局 | 展示多张影像 | P1 |
# 用户故事与验收
## 用户故事
| ID | 角色 | 触发场景 | 目标 | 用户价值 | 依据 | 状态 |
|---|---|---|---|---|---|---|
| US-01 | 医生 | 查看片子 | 同屏比较 | 提高效率 | handoff.md | 已确认 |
## 场景覆盖矩阵
| AC-ID | 关联故事 | 类型 | 前置条件（Given） | 用户动作（When） | 可观察结果（Then） | 状态 |
|---|---|---|---|---|---|---|
| AC-01 | US-01 | 正常 | 已打开检查 | 切换布局 | 显示多张影像 | 已确认 |
# 需求详情
## 主流程
选择布局后展示影像。
# 依赖、风险与发布
依赖现有阅片组件。
# 待确认项
| ID | 待确认项 | 等级 | 影响 | 触发依据 | 建议确认人 | 决策条件/时间点 |
|---|---|---|---|---|---|---|
${pending}
# 需求缺口
| REV-ID | ID | 问题 | 等级 | 依据 | 影响 | 建议 | 需谁确认 |
|---|---|---|---|---|---|---|---|
# 评审预判
## 研发可能提问
| REV-ID | 问题 | 等级 | 关联缺口/依据 | 不确认的影响 | 建议回答 | 确认人 |
|---|---|---|---|---|---|---|
## UI 可能提问
| REV-ID | 问题 | 等级 | 关联缺口/依据 | 不确认的影响 | 建议回答 | 确认人 |
|---|---|---|---|---|---|---|
# 评审结论与签署
| Issue ID | 来源 | 状态 | 最终答案/决策 | 决策来源 | 确认人 | 确认时间 |
|---|---|---|---|---|---|---|
# 来源
| ID | 类型 | 本地路径/原始链接 | 用途 |
|---|---|---|---|
| SRC-01 | handoff | projects/viewer/requirements/REQ-20260720-layout/handoff.md | 本轮输入 |
`;
}

function runSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-prd-validate-'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const makeCase = (name, gate) => {
    const knowledgeRoot = path.join(root, name, 'knowledge');
    const requirementDir = path.join(
      knowledgeRoot,
      'projects',
      'viewer',
      'requirements',
      'REQ-20260720-layout',
    );
    const handoffContent = sampleHandoff(gate);
    const handoff = write(path.join(requirementDir, 'handoff.md'), handoffContent);
    write(
      path.join(requirementDir, 'confirmations.md'),
      '# 阶段确认记录\n\n| ID | 确认内容 |\n|---|---|\n| CONF-01 | 确认评审结论 |\n',
    );
    const prd = write(
      path.join(knowledgeRoot, 'projects', 'viewer', 'prds', gate.toLowerCase() + '.md'),
      samplePrd(gate, handoffContent),
    );
    return { knowledgeRoot, handoff, prd };
  };
  try {
    const ready = makeCase('ready', 'READY');
    const readyHandoff = ready.handoff;
    const readyPrd = ready.prd;
    assert.deepStrictEqual(validatePrd(readyPrd, readyHandoff), []);

    const conditional = makeCase('conditional', 'CONDITIONAL');
    const conditionalHandoff = conditional.handoff;
    const conditionalPrd = conditional.prd;
    assert.deepStrictEqual(validatePrd(conditionalPrd, conditionalHandoff), []);

    const changedHandoff = makeCase('changed-handoff', 'READY');
    fs.appendFileSync(changedHandoff.handoff, '\n更新后的规则。\n', 'utf8');
    assert(validatePrd(changedHandoff.prd, changedHandoff.handoff).some((error) => error.includes('handoff_sha256')));

    const missingMeta = write(path.join(path.dirname(readyPrd), 'missing-meta.md'), samplePrd('READY').replace(/^source_analysis:.*\n/m, ''));
    assert(validatePrd(missingMeta, readyHandoff).some((error) => error.includes('source_analysis')));

    const missingStories = write(path.join(path.dirname(readyPrd), 'missing-stories.md'), samplePrd('READY').replace('| US-01 | 医生 | 查看片子 | 同屏比较 | 提高效率 | handoff.md | 已确认 |', ''));
    assert(validatePrd(missingStories, readyHandoff).some((error) => error.includes('用户故事')));

    const droppedP1 = write(path.join(path.dirname(conditionalPrd), 'dropped-p1.md'), samplePrd('CONDITIONAL').replace(
      '| P1-01 | <span style="color:#A65A5A">待确认：确认极端布局</span> | P1 | UI 范围 | handoff.md | 产品负责人 | PRD 评审前 |',
      '',
    ));
    assert(validatePrd(droppedP1, conditionalHandoff).some((error) => error.includes('P1-ID')));

    const openP0 = write(path.join(path.dirname(readyPrd), 'open-p0.md'), samplePrd('READY').replace(
      '|---|---|---|---|---|---|---|---|\n# 评审预判',
      '|---|---|---|---|---|---|---|---|\n| REV-01 | P0-01 | 权限未定 | P0 | 无 | 无法开发 | 补齐 | 产品 |\n# 评审预判',
    ));
    assert(validatePrd(openP0, readyHandoff).some((error) => error.includes('开放 P0')));

    const fakeSource = write(path.join(path.dirname(readyPrd), 'fake-source.md'), samplePrd('READY')
      .replaceAll('projects/viewer/requirements/REQ-20260720-layout/handoff.md', 'missing/handoff.md'));
    assert(validatePrd(fakeSource, readyHandoff).some((error) => error.includes('本地来源不存在')));

    const placeholders = write(path.join(path.dirname(readyPrd), 'placeholders.md'), samplePrd('READY')
      .replace('医生需要比较多张影像。', '待补充。')
      .replaceAll('| 已确认 |', '| 待确认 |'));
    const placeholderErrors = validatePrd(placeholders, readyHandoff);
    assert(placeholderErrors.some((error) => error.includes('没有有效内容')));
    assert(placeholderErrors.some((error) => error.includes('状态必须为已确认')));

    const englishPlaceholder = write(path.join(path.dirname(readyPrd), 'english-placeholder.md'), samplePrd('READY')
      .replace('医生需要比较多张影像。', 'TODO: fill before release'));
    assert(validatePrd(englishPlaceholder, readyHandoff).some((error) => error.includes('有效内容')));

    const secondTableP0 = write(path.join(path.dirname(readyPrd), 'second-table-p0.md'), samplePrd('READY')
      .replace(
        '# 需求缺口',
        '| ID | 待确认项 | 等级 | 影响 | 触发依据 | 建议确认人 | 决策条件/时间点 |\n'
          + '|---|---|---|---|---|---|---|\n| P0-98 | 隐藏问题 | P0 | 阻塞 | 审查 | 产品 | 开发前 |\n# 需求缺口',
      ));
    const secondTableErrors = validatePrd(secondTableP0, readyHandoff);
    assert(secondTableErrors.some((error) => error.includes('一张表格')));
    assert(secondTableErrors.some((error) => error.includes('开放 P0')));

    const reviewSourcePrd = samplePrd('READY').replace(
      '|---|---|---|---|---|---|---|\n## UI 可能提问',
      '|---|---|---|---|---|---|---|\n| REV-01 | 权限边界是什么 | P1 | handoff.md | 可能返工 | 沿用现有权限 | 产品负责人 |\n## UI 可能提问',
    );
    const missingReviewClosure = write(path.join(path.dirname(readyPrd), 'missing-review-closure.md'), reviewSourcePrd);
    assert(validatePrd(missingReviewClosure, readyHandoff).some((error) => error.includes('尚未进入评审结论')));

    const fakeReviewSource = write(path.join(path.dirname(readyPrd), 'fake-review-source.md'), reviewSourcePrd.replace(
      '|---|---|---|---|---|---|---|\n# 来源',
      '|---|---|---|---|---|---|---|\n| REV-01 | 研发可能提问 | resolved | 沿用现有权限 | 已确认 | 产品负责人 | 2026-07-20T00:00:00+08:00 |\n# 来源',
    ));
    assert(validatePrd(fakeReviewSource, readyHandoff).some((error) => error.includes('决策来源必须')));

    const validReviewSource = write(path.join(path.dirname(readyPrd), 'valid-review-source.md'), reviewSourcePrd.replace(
      '|---|---|---|---|---|---|---|\n# 来源',
      '|---|---|---|---|---|---|---|\n| REV-01 | 研发可能提问 | resolved | 沿用现有权限 | projects/viewer/requirements/REQ-20260720-layout/confirmations.md#CONF-01 | 产品负责人 | 2026-07-20T00:00:00+08:00 |\n# 来源',
    ));
    assert.deepStrictEqual(validatePrd(validReviewSource, readyHandoff), []);

    const duplicateHeading = write(path.join(path.dirname(readyPrd), 'duplicate-heading.md'), samplePrd('READY')
      + '\n# 待确认项\n| ID | 待确认项 | 等级 | 影响 | 触发依据 | 建议确认人 | 决策条件/时间点 |\n'
      + '|---|---|---|---|---|---|---|\n| P0-99 | 隐藏问题 | P0 | 阻塞 | 审查 | 产品 | 开发前 |\n');
    assert(validatePrd(duplicateHeading, readyHandoff).some((error) => error.includes('不得重复')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Self-test passed\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return runSelfTest();
  if (!args.prd || !args.handoff) throw new Error('Missing --prd or --handoff\n\n' + usage());
  const errors = validatePrd(path.resolve(args.prd), path.resolve(args.handoff), { checkHandoffGate: true });
  if (errors.length) {
    process.stderr.write(JSON.stringify({ status: 'invalid', errors }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ status: 'ok', prd: path.resolve(args.prd) }, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write('Error: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { markdownTable, validatePrd };
