#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDate } = require('./archive-feishu-prd');
const { readMarkdown } = require('./build-prd-context');
const { validatePrd } = require('./validate-prd');

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUIREMENT_ID = /^REQ-\d{8}-[a-z0-9][a-z0-9-]{0,80}$/;
const VERSION = /^V\d+(?:\.\d+)*$/i;

function usage() {
  return [
    'Usage:',
    '  node save-prd.js --input <validated-draft.md> --handoff <handoff.md>',
    '    --root <pm-knowledge>',
    '  node save-prd.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error('Unexpected argument: ' + item);
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

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertRegularFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(label + ' not found: ' + file);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(label + ' cannot be a symbolic link');
}

function versionParts(value) {
  return String(value).slice(1).split('.').map(Number);
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function savePrd(args, runtime = {}) {
  if (!args.input || !args.handoff || !args.root) throw new Error(usage());
  const input = path.resolve(args.input);
  const handoff = path.resolve(args.handoff);
  const knowledgeRoot = path.resolve(args.root);
  assertRegularFile(input, 'Draft PRD');
  assertRegularFile(handoff, 'handoff.md');
  if (!fs.existsSync(knowledgeRoot) || !fs.statSync(knowledgeRoot).isDirectory()) {
    throw new Error('Knowledge root not found: ' + knowledgeRoot);
  }
  if (fs.lstatSync(knowledgeRoot).isSymbolicLink()) throw new Error('Knowledge root cannot be a symbolic link');

  const prd = readMarkdown(input);
  const projectId = String(prd.frontmatter.project_id || '');
  const productId = String(prd.frontmatter.product_id || '');
  const requirementId = String(prd.frontmatter.requirement_id || '');
  const version = String(prd.frontmatter.version || '');
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(productId)) throw new Error('Invalid product_id or project_id');
  if (!REQUIREMENT_ID.test(requirementId)) throw new Error('Invalid requirement_id');
  if (!VERSION.test(version)) throw new Error('Invalid PRD version');

  const expectedHandoff = path.join(
    knowledgeRoot,
    'projects',
    projectId,
    'requirements',
    requirementId,
    'handoff.md',
  );
  assertRegularFile(expectedHandoff, 'Expected handoff.md');
  const expectedReal = fs.realpathSync.native(expectedHandoff);
  const handoffReal = fs.realpathSync.native(handoff);
  const sameHandoff = process.platform === 'win32'
    ? expectedReal.toLowerCase() === handoffReal.toLowerCase()
    : expectedReal === handoffReal;
  if (!sameHandoff) {
    throw new Error('--handoff does not match the PRD product/project/requirement');
  }

  const projectFile = path.join(knowledgeRoot, 'projects', projectId, 'project.md');
  const productFile = path.join(knowledgeRoot, 'products', productId, 'product.md');
  assertRegularFile(productFile, 'Product registry');
  assertRegularFile(projectFile, 'Project registry');
  if (readMarkdown(productFile).frontmatter.product_id !== productId) {
    throw new Error('Product registry id mismatch: ' + productId);
  }
  const projectMeta = readMarkdown(projectFile).frontmatter;
  if (projectMeta.project_id !== projectId) throw new Error('Project registry id mismatch: ' + projectId);
  if (projectMeta.product_id !== productId) {
    throw new Error('Project ' + projectId + ' does not belong to product ' + productId);
  }

  const validate = runtime.validatePrd || validatePrd;
  const errors = validate(input, handoff, { checkHandoffGate: runtime.checkHandoffGate !== false });
  if (errors.length) throw new Error('PRD validation failed:\n- ' + errors.join('\n- '));

  const prdRoot = path.join(knowledgeRoot, 'projects', projectId, 'prds');
  fs.mkdirSync(prdRoot, { recursive: true });
  const realKnowledgeRoot = fs.realpathSync.native(knowledgeRoot);
  const realPrdRoot = fs.realpathSync.native(prdRoot);
  if (!isContained(realKnowledgeRoot, realPrdRoot)) throw new Error('PRD output directory resolves outside pm-knowledge');
  const requestedVersion = versionParts(version);
  for (const entry of fs.readdirSync(prdRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const existing = readMarkdown(path.join(prdRoot, entry.name)).frontmatter;
    if (existing.requirement_id !== requirementId || !VERSION.test(existing.version || '')) continue;
    if (compareVersions(requestedVersion, versionParts(existing.version)) <= 0) {
      throw new Error('PRD version must be greater than existing ' + existing.version + ': ' + entry.name);
    }
  }
  const slug = requirementId.replace(/^REQ-\d{8}-/, '');
  const date = runtime.date || localDate();
  const filename = `${date}-${slug}-v${version.slice(1)}.md`;
  const output = path.join(prdRoot, filename);
  fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
  return { status: 'saved', output, version, requirement_id: requirementId };
}

function runSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-save-prd-'));
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  try {
    const requirementId = 'REQ-20260720-layout';
    write('knowledge/products/ct/product.md', '---\nproduct_id: "ct"\n---\n');
    write('knowledge/projects/viewer/project.md', '---\nproject_id: "viewer"\nproduct_id: "ct"\n---\n');
    const handoff = write(
      'knowledge/projects/viewer/requirements/' + requirementId + '/handoff.md',
      '---\nproject_id: "viewer"\nproduct_id: "ct"\nrequirement_id: "' + requirementId + '"\n---\n',
    );
    const input = write('draft.md', [
      '---',
      'title: "布局"',
      'product_id: "ct"',
      'project_id: "viewer"',
      'requirement_id: "' + requirementId + '"',
      'version: "V1.0"',
      '---',
      '# Draft',
    ].join('\n'));
    const options = {
      input,
      handoff,
      root: path.join(root, 'knowledge'),
    };
    const first = savePrd(options, {
      checkHandoffGate: false,
      date: '2026-07-20',
      validatePrd: () => [],
    });
    assert.strictEqual(first.status, 'saved');
    assert.strictEqual(fs.readFileSync(first.output, 'utf8'), fs.readFileSync(input, 'utf8'));
    assert.throws(() => savePrd(options, {
      checkHandoffGate: false,
      date: '2026-07-20',
      validatePrd: () => [],
    }), /version must be greater/);
    assert.strictEqual(fs.readFileSync(first.output, 'utf8'), fs.readFileSync(input, 'utf8'));
    const otherHandoff = write('other/handoff.md', 'other');
    assert.throws(() => savePrd({ ...options, handoff: otherHandoff }, {
      checkHandoffGate: false,
      validatePrd: () => [],
    }), /does not match/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Self-test passed\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) return runSelfTest();
  process.stdout.write(JSON.stringify(savePrd(args), null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write('Error: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { savePrd };
