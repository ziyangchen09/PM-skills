#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REQUIRED_FIELDS = ['project_id', 'product_id', 'updated_at', 'source_paths'];
const REQUIRED_SECTIONS = ['来源', '页面基线', '设计变量', '可复用组件', '禁止臆造', '待确认'];
const ARCHIVE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function usage() {
  return [
    'Usage:',
    '  node validate-design-context.js --file <context.md> --root <pm-knowledge>',
    '  node validate-design-context.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  const known = new Set(['file', 'root', 'self-test']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--') || !known.has(item.slice(2))) {
      throw new Error('Unexpected argument: ' + item);
    }
    const key = item.slice(2);
    if (key === 'self-test') {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    args[key] = value;
    index += 1;
  }
  return args;
}

function safeAbsolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')
    || value.split(/[\\/]/).includes('..') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return path.resolve(value);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..'
    && !path.isAbsolute(relative);
}

function rejectSymlinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed: ' + cursor);
    }
  }
}

function resolveSafeFile(fileValue, rootValue) {
  const root = safeAbsolute(rootValue, '--root');
  const file = safeAbsolute(fileValue, '--file');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('--root must be an existing directory');
  }
  if (!isInside(root, file)) throw new Error('--file must be inside --root');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error('--file must be an existing regular file');
  }
  rejectSymlinks(root);
  rejectSymlinks(file);
  const realRoot = fs.realpathSync.native(root);
  const realFile = fs.realpathSync.native(file);
  if (!isInside(realRoot, realFile)) throw new Error('--file resolves outside --root');
  return realFile;
}

function scalar(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function parseFrontmatter(markdown) {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('Missing frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Unclosed frontmatter');
  const lines = normalized.slice(4, end).split('\n');
  const data = {};
  let listKey = null;
  for (const line of lines) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item && listKey) {
      data[listKey].push(scalar(item[1]));
      continue;
    }
    const field = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!field) {
      if (line.trim() && !line.trim().startsWith('#')) throw new Error('Invalid frontmatter line: ' + line);
      continue;
    }
    const [, key, value] = field;
    if (!value) {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map(scalar).filter(Boolean);
      listKey = null;
    } else {
      data[key] = scalar(value);
      listKey = null;
    }
  }
  return { data, body: normalized.slice(end + 5) };
}

function validateSourcePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[<>]/.test(value)) return false;
  if (/^https:\/\//i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || path.isAbsolute(value)
    || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

function sectionContent(body, title) {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## ' + title);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function tableRows(section) {
  const rows = section.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
  const separator = rows.findIndex((row) => row.length > 0
    && row.every((cell) => /^:?-{3,}:?$/.test(cell)));
  return separator < 1 ? [] : rows.slice(separator + 1);
}

function hasValue(value) {
  const normalized = String(value || '').replaceAll('`', '').trim();
  return Boolean(normalized) && !/^<.*>$/.test(normalized) && normalized !== '待填写';
}

function referencedSource(value, sourceIds) {
  const match = String(value || '').match(/\bSRC-\d{3,}\b/);
  return match && sourceIds.has(match[0]);
}

function validateTraceability(body, sourcePaths) {
  const errors = [];
  const sourceSection = sectionContent(body, '来源');
  const sourceRows = tableRows(sourceSection);
  const sourceIds = new Set();
  for (const row of sourceRows) {
    if (row.length < 5 || !/^SRC-\d{3,}$/.test(row[0] || '')
      || row.slice(1, 5).some((cell) => !hasValue(cell))) {
      errors.push('来源 must contain complete table rows with stable SRC-IDs');
      continue;
    }
    if (sourceIds.has(row[0])) errors.push('duplicate source_id: ' + row[0]);
    sourceIds.add(row[0]);
  }
  if (!sourceIds.size) errors.push('来源 must register at least one traceable source');
  for (const sourcePath of sourcePaths || []) {
    if (hasValue(sourcePath) && !sourceSection.includes(sourcePath)) {
      errors.push('source_paths item is not registered in 来源: ' + sourcePath);
    }
  }

  for (const title of ['页面基线', '设计变量', '可复用组件']) {
    const rows = tableRows(sectionContent(body, title));
    if (!rows.length) {
      errors.push(title + ' must contain at least one table record');
      continue;
    }
    for (const row of rows) {
      if (row.length < 5 || [row[0], row[2], row[3]].some((cell) => !hasValue(cell))
        || !['事实', '推断'].includes(row[1])) {
        errors.push(title + ' contains an incomplete record or invalid 性质');
        continue;
      }
      if (!referencedSource(row[3], sourceIds)) {
        errors.push(title + ' record must reference a registered source_id');
      }
      if (row[1] === '推断' && !/[高中低]/.test(row[4] || '')) {
        errors.push(title + ' 推断 record must state confidence 高/中/低');
      }
    }
  }

  const guardRows = tableRows(sectionContent(body, '禁止臆造'));
  if (!guardRows.length) errors.push('禁止臆造 must contain at least one table record');
  for (const row of guardRows) {
    if (row.length < 4 || row.slice(0, 4).some((cell) => !hasValue(cell))) {
      errors.push('禁止臆造 contains an incomplete record');
    } else if (!referencedSource(row[2], sourceIds)) {
      errors.push('禁止臆造 record must reference a registered source_id');
    }
  }

  const pendingRows = tableRows(sectionContent(body, '待确认'));
  if (!pendingRows.length || pendingRows.some((row) => row.length < 4
    || row.slice(0, 4).some((cell) => !hasValue(cell)))) {
    errors.push('待确认 must contain complete question, evidence gap, impact, and owner records');
  }

  const references = body.replace(sourceSection, '').match(/\bSRC-\d{3,}\b/g) || [];
  for (const sourceId of new Set(references)) {
    if (!sourceIds.has(sourceId)) errors.push('unknown source_id reference: ' + sourceId);
  }
  return errors;
}

function validate(file, root) {
  const safeFile = resolveSafeFile(file, root);
  const realRoot = fs.realpathSync.native(path.resolve(root));
  const { data, body } = parseFrontmatter(fs.readFileSync(safeFile, 'utf8'));
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in data) || data[field] === '' || (typeof data[field] === 'string' && /^<.*>$/.test(data[field]))
      || (Array.isArray(data[field]) && data[field].length === 0)) {
      errors.push('frontmatter missing: ' + field);
    }
  }
  if ('source_paths' in data && (!Array.isArray(data.source_paths)
    || data.source_paths.some((item) => !validateSourcePath(item)))) {
    errors.push('source_paths must be a non-empty list of safe relative paths or HTTPS URLs');
  }
  if (typeof data.project_id === 'string' && !ARCHIVE_ID.test(data.project_id)) {
    errors.push('project_id must be a lowercase hyphenated archive ID');
  }
  if (typeof data.product_id === 'string' && !ARCHIVE_ID.test(data.product_id)) {
    errors.push('product_id must be a lowercase hyphenated archive ID');
  }
  if (typeof data.updated_at === 'string'
    && (!ISO_TIME.test(data.updated_at) || Number.isNaN(Date.parse(data.updated_at)))) {
    errors.push('updated_at must be an ISO 8601 timestamp with timezone');
  }
  if (ARCHIVE_ID.test(data.project_id || '')) {
    const expected = path.join(realRoot, 'projects', data.project_id, 'design', 'context.md');
    if (path.relative(expected, safeFile) !== '') {
      errors.push('file path must match projects/<project_id>/design/context.md');
    }
  }
  if (Array.isArray(data.source_paths)) {
    for (const sourcePath of data.source_paths.filter((item) => !/^https:\/\//i.test(item))) {
      if (!validateSourcePath(sourcePath)) continue;
      const candidate = path.resolve(realRoot, sourcePath);
      if (!isInside(realRoot, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        errors.push('local source does not exist as a regular file: ' + sourcePath);
        continue;
      }
      try {
        rejectSymlinks(candidate);
        if (!isInside(realRoot, fs.realpathSync.native(candidate))) {
          errors.push('local source resolves outside --root: ' + sourcePath);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  for (const title of REQUIRED_SECTIONS) {
    const count = body.split('\n').filter((line) => line.trim() === '## ' + title).length;
    if (count !== 1) errors.push(`section "${title}" must appear exactly once as an H2 heading`);
  }
  if (REQUIRED_SECTIONS.every((title) => body.includes('## ' + title))) {
    errors.push(...validateTraceability(body, Array.isArray(data.source_paths) ? data.source_paths : []));
  }
  return errors;
}

function fixture() {
  return `---
project_id: medical
product_id: ct
updated_at: 2026-07-22T10:00:00+08:00
source_paths:
  - projects/medical/design/sources/page.png
---

# Context

## 来源

| source_id | 类型 | 路径或链接 | 精确定位 | 覆盖范围 |
| --- | --- | --- | --- | --- |
| SRC-001 | 截图 | projects/medical/design/sources/page.png | 页面主体 | 主页面 |

## 页面基线

| 页面或状态 | 性质 | 已有表现或交互 | 来源与定位 | 推断置信度/备注 |
| --- | --- | --- | --- | --- |
| 默认态 | 事实 | 左侧导航与内容区 | SRC-001 · 页面主体 | 已记录 |

## 设计变量

| 类别 | 性质 | 已有规则或数值 | 来源与定位 | 推断置信度/适用范围 |
| --- | --- | --- | --- | --- |
| 颜色 | 事实 | 主按钮为蓝色 | SRC-001 · 主按钮 | 主操作 |

## 可复用组件

| 组件 | 性质 | 已有状态与行为 | 来源与定位 | 复用范围与限制 |
| --- | --- | --- | --- | --- |
| 主按钮 | 事实 | 点击触发主操作 | SRC-001 · 主按钮 | 当前页面 |

## 禁止臆造

| 内容 | 原因 | 来源与定位 | 后续处理 |
| --- | --- | --- | --- |
| 不假设次级按钮样式 | 来源未展示 | SRC-001 · 页面主体 | 待确认 |

## 待确认

| 问题 | 缺少的证据 | 对原型的影响 | 建议确认人 |
| --- | --- | --- | --- |
| 次级按钮样式是什么 | 缺少截图 | 只能使用占位 | UI |
`;
}

function shellFixture() {
  return `---
project_id: medical
product_id: ct
updated_at: 2026-07-22T10:00:00+08:00
source_paths:
  - projects/medical/design/sources/page.png
---

# Context

${REQUIRED_SECTIONS.map((title) => `## ${title}\n\n- recorded`).join('\n\n')}
`;
}

function runSelfTest() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-context-'));
  try {
    const root = path.join(temporary, 'pm-knowledge');
    const directory = path.join(root, 'projects', 'medical', 'design');
    fs.mkdirSync(directory, { recursive: true });
    const source = path.join(directory, 'sources', 'page.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'fixture', 'utf8');
    const file = path.join(directory, 'context.md');
    fs.writeFileSync(file, fixture(), 'utf8');
    assert.deepStrictEqual(validate(file, root), []);

    fs.writeFileSync(file, shellFixture(), 'utf8');
    assert(validate(file, root).some((error) => error.includes('traceable source')));

    const incompleteSource = fixture()
      .replace('| SRC-001 | 截图 | projects/medical/design/sources/page.png | 页面主体 | 主页面 |', '| SRC-001 |')
      .replace('## 页面基线', 'projects/medical/design/sources/page.png\n\n## 页面基线');
    fs.writeFileSync(file, incompleteSource, 'utf8');
    assert(validate(file, root).some((error) => error.includes('complete table rows')));

    fs.writeFileSync(file, fixture().replace('## 待确认', '## 其他'), 'utf8');
    assert(validate(file, root).some((error) => error.includes('待确认')));

    const outside = path.join(temporary, 'outside.md');
    fs.writeFileSync(outside, fixture(), 'utf8');
    assert.throws(() => validate(outside, root), /inside --root/);
    assert.strictEqual(validateSourcePath('../secret.png'), false);
    assert.strictEqual(validateSourcePath('https://example.com/page'), true);

    const link = path.join(root, 'linked-design');
    try {
      fs.symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => validate(path.join(link, 'context.md'), root), /Symbolic links/);
      fs.unlinkSync(link);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }
    console.log('self-test passed');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return runSelfTest();
  if (!args.file || !args.root) throw new Error(usage());
  const errors = validate(args.file, args.root);
  if (errors.length) {
    errors.forEach((error) => console.error('- ' + error));
    process.exitCode = 1;
    return;
  }
  console.log('design context valid');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
