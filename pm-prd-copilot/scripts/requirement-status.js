#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readMarkdown } = require('./build-prd-context');
const { markdownTable, validatePrd } = require('./validate-prd');

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_REQUIREMENT_ID = /^REQ-\d{8}-[a-z0-9][a-z0-9-]{0,80}$/;
const INDEX_MARKER = '<!-- pm-prd-copilot:requirements-index:v1 -->';

function usage() {
  return [
    'Usage:',
    '  node requirement-status.js --root <pm-knowledge> --project <project-id>',
    '    [--requirement <requirement-id>] [--output <requirements-index.md>]',
    '    [--refresh]  # refreshes only projects/<project>/requirements/index.md',
    '  node requirement-status.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new Error('Unexpected argument: ' + item);
    const key = item.slice(2);
    if (key === 'self-test' || key === 'refresh') {
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

function assertId(value, pattern, label) {
  if (!value || !pattern.test(value)) throw new Error('Invalid ' + label + ': ' + value);
}

function artifact(requirementRoot, filename) {
  const file = path.join(requirementRoot, filename);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(filename + ' cannot be a symbolic link');
  const realRoot = fs.realpathSync(requirementRoot);
  const realFile = fs.realpathSync(file);
  const left = process.platform === 'win32' ? path.dirname(realFile).toLowerCase() : path.dirname(realFile);
  const right = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  if (left !== right) throw new Error(filename + ' resolves outside requirement directory');
  const parsed = readMarkdown(file);
  return { file, meta: parsed.frontmatter, body: parsed.body };
}

function validTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
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
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return text.split('\n').some((line) => {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading && heading[1].trim().toLowerCase() === expected) return true;
    if (!line.trim().startsWith('|')) return false;
    return line.trim().replace(/^\||\|$/g, '').split('|')
      .some((cellValue) => cellValue.trim().toLowerCase() === expected);
  });
}

function bodyError(item) {
  const stage = item.meta.stage;
  const required = {
    intake: ['# 需求受理卡', '## 1. 原始输入', '## 7. 分诊结论'],
    evidence: ['# 证据研究简报', '## 1. 待验证判断', '## 3. 证据索引', '## 6. 证据结论', '## 7. 下一步'],
    problem: ['# 问题定义简报', '### 问题陈述', '## 8. 目标状态与成功信号'],
    solution: ['# 方案设计简报', '## 4. 推荐结论', '## 5. 最小可验证闭环'],
    readiness: ['# PRD 准入报告', '## 1. 准入结论', '## 3. P0 阻塞', '## 4. P1 条件项'],
    handoff: ['# PRD 交接包', '## 9. 待确认项'],
  };
  const lines = new Set(item.body.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()));
  for (const heading of required[stage] || []) {
    if (!lines.has(heading)) return path.basename(item.file) + ' missing required content: ' + heading;
  }
  if (stage === 'intake') {
    const match = item.body.match(/^\s*-\s*推荐下一步主路径[：:]\s*(.+?)\s*$/m);
    if (!match || match[1].trim() !== item.meta.route) return 'intake.md body route does not match frontmatter';
  }
  if (stage === 'evidence') {
    const conclusion = item.body.match(/^\s*-\s*结论（与 frontmatter 一致）[：:]\s*(.+?)\s*$/m);
    const nextRoute = item.body.match(/^\s*-\s*路由（与 frontmatter 一致）[：:]\s*(.+?)\s*$/m);
    if (!conclusion || conclusion[1].trim() !== item.meta.evidence_conclusion) {
      return 'evidence.md body conclusion does not match frontmatter';
    }
    if (!nextRoute || nextRoute[1].trim() !== item.meta.next_route) {
      return 'evidence.md body route does not match frontmatter';
    }
  }
  return '';
}

function confirmationError(item, requirementRoot) {
  const meta = item.meta;
  if (meta.artifact_status !== 'confirmed') return path.basename(item.file) + ' is not confirmed';
  for (const key of ['confirmed_by', 'confirmed_at', 'confirmation_source']) {
    if (typeof meta[key] !== 'string' || !meta[key].trim()) return path.basename(item.file) + ' missing ' + key;
  }
  if (!validTimestamp(meta.confirmed_at)) return path.basename(item.file) + ' has invalid confirmed_at';
  if (!validTimestamp(meta.updated_at)) return path.basename(item.file) + ' has invalid updated_at';
  if (Date.parse(meta.confirmed_at) < Date.parse(meta.updated_at)) {
    return path.basename(item.file) + ' changed after confirmation';
  }
  if (meta.superseded_at || meta.superseded_reason) return path.basename(item.file) + ' has invalid superseded metadata';
  if (!Array.isArray(meta.source_paths) || !meta.source_paths.includes(meta.confirmation_source.split('#')[0])) {
    return path.basename(item.file) + ' confirmation_source is not in source_paths';
  }
  const marker = meta.confirmation_source.indexOf('#');
  if (marker <= 0 || !meta.confirmation_source.slice(marker + 1).trim()) {
    return path.basename(item.file) + ' confirmation_source needs a locator';
  }
  const relative = meta.confirmation_source.slice(0, marker);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    return path.basename(item.file) + ' confirmation_source is outside requirement scope';
  }
  const target = path.resolve(requirementRoot, relative);
  const rel = path.relative(requirementRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return path.basename(item.file) + ' confirmation_source does not exist';
  }
  if (fs.lstatSync(target).isSymbolicLink()) return path.basename(item.file) + ' confirmation_source cannot be a symlink';
  const realRoot = fs.realpathSync(requirementRoot);
  const realTarget = fs.realpathSync(target);
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    return path.basename(item.file) + ' confirmation_source resolves outside requirement scope';
  }
  if (!locatorExists(realTarget, meta.confirmation_source.slice(marker + 1))) {
    return path.basename(item.file) + ' confirmation_source locator does not exist';
  }
  const contentError = bodyError(item);
  if (contentError) return contentError;
  return '';
}

function updatedAt(item) {
  const value = item && item.meta.updated_at;
  return validTimestamp(value) ? Date.parse(value) : Number.NaN;
}

function isStale(item, upstreams) {
  const current = updatedAt(item);
  return Number.isNaN(current) || upstreams.some((upstream) => {
    const time = updatedAt(upstream);
    return !Number.isNaN(time) && time > current;
  });
}

function findValidator(override) {
  const candidates = [
    override,
    process.env.PM_PRD_READINESS_VALIDATOR,
    path.resolve(__dirname, '..', '..', 'pm-prd-readiness-gate', 'scripts', 'validate_handoff.py'),
    path.resolve(__dirname, '..', '..', 'PM-skills-pre-PRD-pack-v2', 'pm-prd-readiness-gate', 'scripts', 'validate_handoff.py'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function validateHandoff(requirementRoot, validatorOverride) {
  const validator = findValidator(validatorOverride);
  if (!validator) return { ok: false, detail: 'Readiness validator not found' };
  const commands = [...new Set([process.env.PYTHON, 'python', 'py'].filter(Boolean))];
  for (const command of commands) {
    const result = childProcess.spawnSync(command, [validator, requirementRoot], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.error) return { ok: false, detail: result.error.message };
    if (result.status !== 0) {
      return { ok: false, detail: [result.stdout, result.stderr].filter(Boolean).join(' ').trim() };
    }
    return { ok: true, detail: '' };
  }
  return { ok: false, detail: 'Python runtime not found' };
}

function findLatestPrd(requirementRoot, requirementId) {
  const projectRoot = path.dirname(path.dirname(requirementRoot));
  const prdRoot = path.join(projectRoot, 'prds');
  if (!fs.existsSync(prdRoot)) return null;
  return fs.readdirSync(prdRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => {
      const file = path.join(prdRoot, entry.name);
      if (fs.lstatSync(file).isSymbolicLink()) return null;
      const parsed = readMarkdown(file);
      if (parsed.frontmatter.requirement_id !== requirementId) return null;
      const version = String(parsed.frontmatter.version || '').match(/^V(\d+(?:\.\d+)*)$/i);
      return {
        file,
        meta: parsed.frontmatter,
        body: parsed.body,
        version: version ? version[1].split('.').map(Number) : [],
        archivedAt: validTimestamp(parsed.frontmatter.archived_at)
          ? Date.parse(parsed.frontmatter.archived_at)
          : 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const length = Math.max(left.version.length, right.version.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (right.version[index] || 0) - (left.version[index] || 0);
        if (difference) return difference;
      }
      return right.archivedAt - left.archivedAt || right.file.localeCompare(left.file);
    })[0] || null;
}

function prdStatus(requirementRoot, handoff, gate) {
  const requirementId = path.basename(requirementRoot);
  const prd = findLatestPrd(requirementRoot, requirementId);
  if (!prd) return null;
  const errors = validatePrd(prd.file, handoff.file);
  if (errors.length) {
    return result(requirementId, 'prd', gate, 'pm-prd-copilot', 'PRD validation failed: ' + errors[0], prd.meta.archived_at || '');
  }
  const reviewRows = markdownTable(prd.body, 1, '评审结论与签署') || [];
  const openReviewCount = reviewRows.filter((row) => row['状态'] === 'open').length;
  const completed = ['approved', 'confirmed', 'released', 'completed'].includes(String(prd.meta.status || '').toLowerCase())
    && openReviewCount === 0;
  if (completed) return result(requirementId, 'complete', gate, 'complete', '', prd.meta.archived_at || '');
  const blocker = openReviewCount
    ? `Open review items: ${openReviewCount}`
    : 'PRD status is ' + String(prd.meta.status || 'draft');
  return result(requirementId, 'prd', gate, 'pm-prd-copilot', blocker, prd.meta.archived_at || '');
}

function evaluateStageStatus(requirementRoot, validatorOverride) {
  if (fs.lstatSync(requirementRoot).isSymbolicLink()) throw new Error('Requirement directory cannot be a symbolic link');
  const requirementId = path.basename(requirementRoot);
  assertId(requirementId, SAFE_REQUIREMENT_ID, 'requirement_id');
  const files = {
    intake: artifact(requirementRoot, 'intake.md'),
    evidence: artifact(requirementRoot, 'evidence.md'),
    problem: artifact(requirementRoot, 'problem.md'),
    solution: artifact(requirementRoot, 'solutions.md'),
    readiness: artifact(requirementRoot, 'readiness.md'),
    handoff: artifact(requirementRoot, 'handoff.md'),
  };
  const existing = Object.entries(files).filter(([, value]) => value);
  const projectId = path.basename(path.dirname(path.dirname(requirementRoot)));
  let productId = '';
  let owner = '';
  for (const [stage, value] of existing) {
    if (value.meta.requirement_id !== requirementId) {
      return result(requirementId, stage, 'invalid', stage, 'ID mismatch in ' + path.basename(value.file), value.meta.updated_at);
    }
    if (value.meta.project_id !== projectId) {
      return result(requirementId, stage, 'invalid', stage, 'project_id mismatch in ' + path.basename(value.file), value.meta.updated_at);
    }
    if (value.meta.stage !== stage) {
      return result(requirementId, stage, 'invalid', stage, 'stage mismatch in ' + path.basename(value.file), value.meta.updated_at);
    }
    if (!productId) productId = value.meta.product_id;
    if (!value.meta.product_id || value.meta.product_id !== productId) {
      return result(requirementId, stage, 'invalid', stage, 'product_id mismatch in ' + path.basename(value.file), value.meta.updated_at);
    }
    if (typeof value.meta.owner !== 'string' || !value.meta.owner.trim()) {
      return result(requirementId, stage, 'invalid', stage, 'owner missing in ' + path.basename(value.file), value.meta.updated_at);
    }
    if (!owner) owner = value.meta.owner;
    if (value.meta.owner !== owner) {
      return result(requirementId, stage, 'invalid', stage, 'owner mismatch in ' + path.basename(value.file), value.meta.updated_at);
    }
  }
  if (!files.intake) return result(requirementId, 'source', '', 'pm-demand-intake', 'Missing intake.md');
  let stateError = confirmationError(files.intake, requirementRoot);
  if (stateError) return result(requirementId, 'intake', '', 'pm-demand-intake', stateError, files.intake.meta.updated_at);

  if (files.intake.meta.route === 'pm-evidence-research') {
    if (!files.evidence) return result(requirementId, 'intake', '', 'pm-evidence-research', 'Missing evidence.md', files.intake.meta.updated_at);
    stateError = confirmationError(files.evidence, requirementRoot);
    if (stateError) return result(requirementId, 'evidence', '', 'pm-evidence-research', stateError, files.evidence.meta.updated_at);
    if (isStale(files.evidence, [files.intake])) {
      return result(requirementId, 'evidence', '', 'pm-evidence-research', 'evidence.md is stale', files.evidence.meta.updated_at);
    }
    if (files.evidence.meta.upstream_status !== 'verified') {
      return result(requirementId, 'evidence', '', 'pm-evidence-research', 'Evidence upstream is not verified', files.evidence.meta.updated_at);
    }
    if (!['strengthened', 'unchanged', 'weakened', 'conflicted', 'insufficient'].includes(files.evidence.meta.evidence_conclusion)) {
      return result(requirementId, 'evidence', '', 'pm-evidence-research', 'Invalid evidence conclusion', files.evidence.meta.updated_at);
    }
    if (files.evidence.meta.next_route === 'pm-demand-intake') {
      return result(requirementId, 'evidence', '', 'pm-demand-intake', 'Evidence requires intake scope correction', files.evidence.meta.updated_at);
    }
    if (files.evidence.meta.next_route === 'pause') {
      return result(requirementId, 'evidence', '', 'pause', 'Evidence route is paused', files.evidence.meta.updated_at);
    }
    if (files.evidence.meta.next_route !== 'pm-problem-framing') {
      return result(requirementId, 'evidence', '', 'pm-evidence-research', 'Invalid evidence next_route', files.evidence.meta.updated_at);
    }
  } else if (files.intake.meta.route !== 'pm-problem-framing') {
    const route = String(files.intake.meta.route || 'pm-demand-intake');
    return result(requirementId, 'intake', '', route, 'Intake routed outside the PRD chain', files.intake.meta.updated_at);
  }

  if (!files.problem) return result(requirementId, files.evidence ? 'evidence' : 'intake', '', 'pm-problem-framing', 'Missing problem.md');
  stateError = confirmationError(files.problem, requirementRoot);
  if (stateError) return result(requirementId, 'problem', '', 'pm-problem-framing', stateError, files.problem.meta.updated_at);
  const problemUpstreams = [files.intake];
  if (files.intake.meta.route === 'pm-evidence-research' && files.evidence) problemUpstreams.push(files.evidence);
  if (isStale(files.problem, problemUpstreams)) {
    return result(requirementId, 'problem', '', 'pm-problem-framing', 'problem.md is stale', files.problem.meta.updated_at);
  }
  if (files.problem.meta.upstream_status !== 'verified'
    || !['validated', 'plausible'].includes(files.problem.meta.problem_confidence)) {
    return result(requirementId, 'problem', '', 'pm-problem-framing', 'Problem is not ready for solution design', files.problem.meta.updated_at);
  }
  if (!files.solution) return result(requirementId, 'problem', '', 'pm-solution-designer', 'Missing solutions.md');
  stateError = confirmationError(files.solution, requirementRoot);
  if (stateError) return result(requirementId, 'solution', '', 'pm-solution-designer', stateError, files.solution.meta.updated_at);
  if (isStale(files.solution, [files.problem])) {
    return result(requirementId, 'solution', '', 'pm-solution-designer', 'solutions.md is stale', files.solution.meta.updated_at);
  }
  if (files.solution.meta.upstream_status !== 'verified'
    || !['pending', 'confirmed'].includes(files.solution.meta.decision_status)) {
    return result(requirementId, 'solution', '', 'pm-solution-designer', 'Solution decision is not ready for the PRD gate', files.solution.meta.updated_at);
  }
  if (!files.readiness) return result(requirementId, 'solution', '', 'pm-prd-readiness-gate', 'Missing readiness.md');

  stateError = confirmationError(files.readiness, requirementRoot);
  if (stateError) return result(requirementId, 'readiness', '', 'pm-prd-readiness-gate', stateError, files.readiness.meta.updated_at);
  const gate = String(files.readiness.meta.gate_result || '');
  if (gate === 'NOT_READY') {
    if (files.handoff) {
      return result(requirementId, 'readiness', gate, 'pm-prd-readiness-gate', 'NOT_READY must not contain handoff.md', files.readiness.meta.updated_at);
    }
    return result(requirementId, 'readiness', gate, 'pm-prd-readiness-gate', 'Resolve P0 blockers', files.readiness.meta.updated_at);
  }
  if (!['READY', 'CONDITIONAL'].includes(gate) || !files.handoff) {
    return result(requirementId, 'readiness', gate, 'pm-prd-readiness-gate', 'Missing or invalid handoff', files.readiness.meta.updated_at);
  }
  stateError = confirmationError(files.handoff, requirementRoot);
  if (stateError) return result(requirementId, 'handoff', gate, 'pm-prd-readiness-gate', stateError, files.handoff.meta.updated_at);
  const validation = validateHandoff(requirementRoot, validatorOverride);
  if (!validation.ok) {
    return result(requirementId, 'readiness', gate, 'pm-prd-readiness-gate', validation.detail || 'Handoff validation failed', files.readiness.meta.updated_at);
  }
  const currentPrd = prdStatus(requirementRoot, files.handoff, gate);
  if (currentPrd) return currentPrd;
  return result(requirementId, 'handoff', gate, 'pm-prd-copilot', gate === 'CONDITIONAL' ? 'Preserve all P1 items' : '', files.handoff.meta.updated_at);
}

function statusSummary(requirementRoot) {
  const files = ['intake.md', 'evidence.md', 'problem.md', 'solutions.md', 'readiness.md', 'handoff.md'];
  const metas = [];
  for (const filename of files) {
    const file = path.join(requirementRoot, filename);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
    try {
      metas.push(readMarkdown(file).frontmatter);
    } catch {
      // The evaluator reports malformed artifacts; summary fields remain blank.
    }
  }
  const readiness = metas.find((meta) => meta.stage === 'readiness') || {};
  const explicitOwner = metas.map((meta) => meta.owner).find((value) => typeof value === 'string' && value.trim());
  return {
    owner: String(explicitOwner || ''),
    p0: Number.isInteger(readiness.p0_count) && readiness.p0_count >= 0 ? readiness.p0_count : '',
    p1: Number.isInteger(readiness.p1_count) && readiness.p1_count >= 0 ? readiness.p1_count : '',
  };
}

function stageStatus(requirementRoot, validatorOverride) {
  return Object.assign(
    evaluateStageStatus(requirementRoot, validatorOverride),
    statusSummary(requirementRoot),
  );
}

function result(requirementId, stage, gate, next, blocker, updatedAt = '') {
  return { requirementId, stage, gate, next, blocker, updatedAt: String(updatedAt || '') };
}

function listRequirementRoots(root, projectId, requirementId) {
  assertId(projectId, SAFE_ID, 'project_id');
  const base = path.join(path.resolve(root), 'projects', projectId, 'requirements');
  if (requirementId) {
    assertId(requirementId, SAFE_REQUIREMENT_ID, 'requirement_id');
    return [path.join(base, requirementId)];
  }
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_REQUIREMENT_ID.test(entry.name))
    .map((entry) => path.join(base, entry.name))
    .sort();
}

function cell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function renderIndex(projectId, rows) {
  const lines = [
    INDEX_MARKER,
    '',
    '# 需求状态索引',
    '',
    '- 项目：`' + projectId + '`',
    '- 生成时间：`' + new Date().toISOString() + '`',
    '',
    '| Requirement | Owner | 当前阶段 | Gate | P0 | P1 | 下一步 | 阻塞/条件 | 更新时间 |',
    '|---|---|---|---|---:|---:|---|---|---|',
  ];
  for (const row of rows) {
    lines.push('| ' + [
      row.requirementId,
      row.owner,
      row.stage,
      row.gate,
      row.p0,
      row.p1,
      row.next,
      row.blocker,
      row.updatedAt,
    ].map(cell).join(' | ') + ' |');
  }
  if (!rows.length) lines.push('| - | - | - | - | - | - | pm-demand-intake | 尚无 requirement 目录 | - |');
  return lines.join('\n') + '\n';
}

function writeIndex(root, projectId, requestedOutput, markdown, refresh) {
  const canonical = path.resolve(root, 'projects', projectId, 'requirements', 'index.md');
  const output = requestedOutput ? path.resolve(requestedOutput) : canonical;
  if (refresh && output !== canonical) {
    throw new Error('--refresh may update only ' + canonical);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const exists = fs.existsSync(output);
  if (exists) {
    if (fs.lstatSync(output).isSymbolicLink() || !fs.statSync(output).isFile()) {
      throw new Error('Index output must be a regular file');
    }
    if (refresh && !fs.readFileSync(output, 'utf8').includes(INDEX_MARKER)) {
      throw new Error('Refusing to refresh a file not generated by requirement-status.js');
    }
  }
  if (!refresh) {
    fs.writeFileSync(output, markdown, { encoding: 'utf8', flag: 'wx' });
    return output;
  }
  const suffix = process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const temporary = path.join(path.dirname(output), '.' + path.basename(output) + '.' + suffix + '.tmp');
  const backup = path.join(path.dirname(output), '.' + path.basename(output) + '.' + suffix + '.bak');
  fs.writeFileSync(temporary, markdown, { encoding: 'utf8', flag: 'wx' });
  try {
    if (exists) fs.renameSync(output, backup);
    fs.renameSync(temporary, output);
    if (exists) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(output)) fs.renameSync(backup, output);
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return output;
}

function runSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-status-'));
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const sampleBody = (stage, fields) => {
    if (stage === 'intake') return `# 需求受理卡
## 1. 原始输入
用户需要完成任务。
## 7. 分诊结论
- 推荐下一步主路径：${fields.route}
- 理由：进入下一阶段。`;
    if (stage === 'evidence') return `# 证据研究简报
## 1. 待验证判断
判断可被验证。
## 3. 证据索引
来源为 source.md。
## 6. 证据结论
- 结论（与 frontmatter 一致）：${fields.evidence_conclusion}
## 7. 下一步
- 路由（与 frontmatter 一致）：${fields.next_route}`;
    if (stage === 'problem') return `# 问题定义简报
### 问题陈述
用户在任务中存在可验证障碍。
## 8. 目标状态与成功信号
用户可完成任务。`;
    if (stage === 'solution') return `# 方案设计简报
## 4. 推荐结论
推荐最小闭环。
## 5. 最小可验证闭环
完成核心任务。`;
    if (stage === 'readiness') return `# PRD 准入报告
## 1. 准入结论
${fields.gate_result}
## 3. P0 阻塞
| ID | 阻塞项 |
|---|---|
## 4. P1 条件项
| ID | 条件项 |
|---|---|`;
    if (stage === 'handoff') return `# PRD 交接包
## 9. 待确认项
| ID | 问题 | 等级 | 影响 | 负责人 | 最晚确认阶段或时间 |
|---|---|---|---|---|---|`;
    return '# ' + stage;
  };
  const meta = (requirementId, stage, fields = {}, timestamp = '2026-07-20T00:00:00+08:00') => ['---',
    'contract_version: 1',
    'requirement_id: "' + requirementId + '"',
    'product_id: "product"',
    'project_id: "project"',
    'owner: "产品负责人"',
    'stage: "' + stage + '"',
    'artifact_status: "confirmed"',
    'confirmed_by: "产品负责人"',
    'confirmed_at: "2026-07-20T00:00:00+08:00"',
    'confirmation_source: "source.md#CONF-01"',
    'superseded_at: ""',
    'superseded_reason: ""',
    'source_type: "local-notes"',
    'source_paths: ["source.md"]',
    'created_at: "2026-07-20T00:00:00+08:00"',
    'updated_at: "' + timestamp + '"',
    ...Object.entries(fields).map(([key, value]) => key + ': ' + JSON.stringify(value)),
    '---', '', sampleBody(stage, fields),
  ].join('\n');
  const setup = (requirementId) => {
    const base = 'projects/project/requirements/' + requirementId + '/';
    write(base + 'source.md', '# source\n\n## CONF-01\n产品负责人确认。\n');
    return { base, directory: path.join(root, base) };
  };
  const validator = write('validator.py', 'raise SystemExit(0)\n');
  try {
    const directId = 'REQ-20260720-direct';
    const direct = setup(directId);
    write(direct.base + 'intake.md', meta(directId, 'intake', { route: 'pm-problem-framing' }));
    let row = stageStatus(direct.directory);
    assert.strictEqual(row.next, 'pm-problem-framing');
    write(direct.base + 'intake.md', meta(directId, 'intake', { route: 'pm-problem-framing' })
      .replace('confirmation_source: "source.md#CONF-01"', 'confirmation_source: "source.md#MISSING"'));
    row = stageStatus(direct.directory);
    assert.strictEqual(row.next, 'pm-demand-intake');
    assert.match(row.blocker, /locator/);

    const requirementId = 'REQ-20260720-research';
    const research = setup(requirementId);
    write(research.base + 'intake.md', meta(requirementId, 'intake', { route: 'pm-evidence-research' }));
    row = stageStatus(research.directory);
    assert.strictEqual(row.next, 'pm-evidence-research');
    write(research.base + 'evidence.md', meta(requirementId, 'evidence', {
      upstream_status: 'verified',
      evidence_conclusion: 'strengthened',
      next_route: 'pm-problem-framing',
    }));
    row = stageStatus(research.directory);
    assert.strictEqual(row.next, 'pm-problem-framing');
    write(research.base + 'problem.md', meta(requirementId, 'problem', {
      upstream_status: 'verified',
      problem_confidence: 'validated',
    }, '2026-07-19T00:00:00+08:00').replace(
      'confirmed_at: "2026-07-20T00:00:00+08:00"',
      'confirmed_at: "2026-07-19T00:00:00+08:00"',
    ));
    row = stageStatus(research.directory);
    assert.strictEqual(row.next, 'pm-problem-framing');
    assert.match(row.blocker, /stale/);

    const inactiveEvidenceId = 'REQ-20260720-inactive-evidence';
    const inactiveEvidence = setup(inactiveEvidenceId);
    write(inactiveEvidence.base + 'intake.md', meta(inactiveEvidenceId, 'intake', { route: 'pm-problem-framing' }));
    write(inactiveEvidence.base + 'evidence.md', meta(inactiveEvidenceId, 'evidence', {
      upstream_status: 'verified', evidence_conclusion: 'strengthened', next_route: 'pm-problem-framing',
    }, '2026-07-21T00:00:00+08:00').replace(
      'confirmed_at: "2026-07-20T00:00:00+08:00"',
      'confirmed_at: "2026-07-21T00:00:00+08:00"',
    ));
    write(inactiveEvidence.base + 'problem.md', meta(inactiveEvidenceId, 'problem', {
      upstream_status: 'verified', problem_confidence: 'validated',
    }));
    row = stageStatus(inactiveEvidence.directory);
    assert.strictEqual(row.next, 'pm-solution-designer');
    assert.doesNotMatch(row.blocker, /stale/);

    const notReadyId = 'REQ-20260720-not-ready';
    const notReady = setup(notReadyId);
    write(notReady.base + 'intake.md', meta(notReadyId, 'intake', { route: 'pm-problem-framing' }));
    write(notReady.base + 'problem.md', meta(notReadyId, 'problem', {
      upstream_status: 'verified', problem_confidence: 'validated',
    }));
    write(notReady.base + 'solutions.md', meta(notReadyId, 'solution', {
      upstream_status: 'verified', decision_status: 'pending',
    }));
    write(notReady.base + 'readiness.md', meta(notReadyId, 'readiness', {
      gate_result: 'NOT_READY', review_mode: 'standard', p0_count: 1, p1_count: 0, p1_tracking_complete: true,
    }));
    write(notReady.base + 'handoff.md', meta(notReadyId, 'handoff', { gate_result: 'NOT_READY' }));
    row = stageStatus(notReady.directory);
    assert.match(row.blocker, /must not contain handoff/);

    const conditionalId = 'REQ-20260720-conditional';
    const conditional = setup(conditionalId);
    write(conditional.base + 'intake.md', meta(conditionalId, 'intake', { route: 'pm-problem-framing' }));
    write(conditional.base + 'problem.md', meta(conditionalId, 'problem', {
      upstream_status: 'verified', problem_confidence: 'plausible',
    }));
    write(conditional.base + 'solutions.md', meta(conditionalId, 'solution', {
      upstream_status: 'verified', decision_status: 'pending',
    }));
    write(conditional.base + 'readiness.md', meta(conditionalId, 'readiness', {
      gate_result: 'CONDITIONAL', review_mode: 'standard', p0_count: 0, p1_count: 1, p1_tracking_complete: true,
    }));
    write(conditional.base + 'handoff.md', meta(conditionalId, 'handoff', { gate_result: 'CONDITIONAL' }));
    row = stageStatus(conditional.directory, validator);
    assert.strictEqual(row.stage, 'handoff');
    assert.strictEqual(row.gate, 'CONDITIONAL');
    assert.strictEqual(row.owner, '产品负责人');
    assert.strictEqual(row.p0, 0);
    assert.strictEqual(row.p1, 1);
    assert.match(row.blocker, /P1/);

    const completeId = 'REQ-20260720-complete';
    const complete = setup(completeId);
    write(complete.base + 'intake.md', meta(completeId, 'intake', { route: 'pm-problem-framing' }));
    write(complete.base + 'problem.md', meta(completeId, 'problem', {
      upstream_status: 'verified', problem_confidence: 'validated',
    }));
    write(complete.base + 'solutions.md', meta(completeId, 'solution', {
      upstream_status: 'verified', decision_status: 'confirmed',
    }));
    write(complete.base + 'readiness.md', meta(completeId, 'readiness', {
      gate_result: 'READY', review_mode: 'standard', p0_count: 0, p1_count: 0, p1_tracking_complete: true,
    }));
    const completeHandoff = write(complete.base + 'handoff.md', meta(completeId, 'handoff', { gate_result: 'READY' }));
    const completeHandoffHash = crypto.createHash('sha256').update(fs.readFileSync(completeHandoff)).digest('hex');
    const handoffRelative = 'projects/project/requirements/' + completeId + '/handoff.md';
    const completePrd = write('projects/project/prds/complete.md', `---
title: "完成需求"
product_id: "product"
project_id: "project"
requirement_id: "${completeId}"
readiness: "READY"
status: "approved"
version: "V1.0"
handoff_updated_at: "2026-07-20T00:00:00+08:00"
handoff_sha256: "${completeHandoffHash}"
source_analysis: ["${handoffRelative}"]
archived_at: "2026-07-20T01:00:00+08:00"
---
# 需求背景
用户需要完成任务。
# 目标与非目标
目标是缩短操作时间；不改变权限模型。
# 需求范围
| 功能 | 概述 | 优先级 |
|---|---|---|
| 快速入口 | 提供任务入口 | P1 |
# 用户故事与验收
## 用户故事
| ID | 角色 | 触发场景 | 目标 | 用户价值 | 依据 | 状态 |
|---|---|---|---|---|---|---|
| US-01 | 医生 | 处理任务 | 快速完成 | 节省时间 | handoff.md | 已确认 |
## 场景覆盖矩阵
| AC-ID | 关联故事 | 类型 | 前置条件（Given） | 用户动作（When） | 可观察结果（Then） | 状态 |
|---|---|---|---|---|---|---|
| AC-01 | US-01 | 正常 | 已登录 | 点击入口 | 展示任务 | 已确认 |
# 需求详情
点击入口后展示任务内容。
# 依赖、风险与发布
复用现有权限与发布流程。
# 待确认项
| ID | 待确认项 | 等级 | 影响 | 触发依据 | 建议确认人 | 决策条件/时间点 |
|---|---|---|---|---|---|---|
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
| SRC-01 | handoff | ${handoffRelative} | 本轮输入 |
`);
    write('projects/project/prds/touched-old.md', fs.readFileSync(completePrd, 'utf8')
      .replace('status: "approved"', 'status: "draft"')
      .replace('version: "V1.0"', 'version: "V0.9"'));
    row = stageStatus(complete.directory, validator);
    assert.strictEqual(row.stage, 'complete');
    assert.strictEqual(row.next, 'complete');

    assert(renderIndex('project', [row]).includes(completeId));
    const output = path.join(root, 'index.md');
    fs.writeFileSync(output, 'existing', 'utf8');
    assert.throws(() => fs.writeFileSync(output, 'new', { encoding: 'utf8', flag: 'wx' }));
    const firstIndex = renderIndex('project', [row]);
    const canonicalIndex = writeIndex(root, 'project', null, firstIndex, true);
    assert.strictEqual(fs.readFileSync(canonicalIndex, 'utf8'), firstIndex);
    const secondIndex = renderIndex('project', []);
    writeIndex(root, 'project', canonicalIndex, secondIndex, true);
    assert.strictEqual(fs.readFileSync(canonicalIndex, 'utf8'), secondIndex);
    assert.throws(() => writeIndex(root, 'project', output, 'bad\n', true), /only/);
    fs.writeFileSync(canonicalIndex, 'user-authored\n', 'utf8');
    assert.throws(() => writeIndex(root, 'project', canonicalIndex, secondIndex, true), /not generated/);
    assert.strictEqual(fs.readFileSync(canonicalIndex, 'utf8'), 'user-authored\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Self-test passed\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return runSelfTest();
  for (const key of ['root', 'project']) {
    if (!args[key]) throw new Error('Missing --' + key + '\n\n' + usage());
  }
  const roots = listRequirementRoots(args.root, args.project, args.requirement);
  for (const requirementRoot of roots) {
    if (!fs.existsSync(requirementRoot)) throw new Error('Requirement directory not found: ' + requirementRoot);
  }
  const rows = roots.map((requirementRoot) => stageStatus(requirementRoot));
  const markdown = renderIndex(args.project, rows);
  if (args.output || args.refresh) {
    const output = writeIndex(args.root, args.project, args.output, markdown, Boolean(args.refresh));
    process.stdout.write(JSON.stringify({ status: 'ok', output, requirements: rows.length }, null, 2) + '\n');
    return;
  }
  process.stdout.write(markdown);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write('Error: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { renderIndex, stageStatus };
