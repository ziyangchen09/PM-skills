#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');

const {
  contentHash,
  extractVersion,
  findDuplicate,
  listMarkdownFiles,
  localDate,
  parseFrontmatter,
  slugifyTitle,
  validateId,
  writeArchive,
  yamlString,
} = require('./archive-feishu-prd');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt']);
const ATTACHMENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.csv', '.mp3', '.wav', '.mp4', '.mov',
]);

function usage() {
  return [
    'Usage:',
    '  node archive-local-prd.js --file <prd.md|prd.txt> --product <product-id>',
    '    --project <project-id> [--root <pm-knowledge>] [--title <title>] [--dry-run]',
    '    [--allow-incomplete]',
    '  node archive-local-prd.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  const booleans = new Set(['dry-run', 'self-test', 'allow-incomplete']);
  const values = new Set(['file', 'product', 'project', 'root', 'title']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error('Unexpected argument: ' + item);
    const key = item.slice(2);
    if (booleans.has(key)) {
      args[key] = true;
      continue;
    }
    if (!values.has(key)) throw new Error('Unknown option: --' + key);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    args[key] = value;
    index += 1;
  }
  return args;
}

function readUtf8(file) {
  const bytes = fs.readFileSync(file);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Local source must be valid UTF-8: ' + file);
  }
}

function sourceType(extension) {
  return extension === '.md' ? 'local-markdown' : 'local-text';
}

function sourceToken(file) {
  const normalized = process.platform === 'win32' ? file.toLocaleLowerCase() : file;
  return 'local-' + contentHash(normalized).slice(0, 24);
}

function deriveTitle(content, file, explicitTitle) {
  if (explicitTitle && explicitTitle.trim()) return explicitTitle.trim();
  const meta = parseFrontmatter(content);
  if (typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim();
  const heading = content.match(/^#\s+(.+?)\s*$/m);
  return heading ? heading[1].trim() : path.basename(file, path.extname(file));
}

function assertProjectProduct(knowledgeRoot, productId, projectId) {
  const productFile = path.join(knowledgeRoot, 'products', productId, 'product.md');
  if (!fs.existsSync(productFile)) throw new Error('Product registry not found: ' + productId);
  const productMeta = parseFrontmatter(fs.readFileSync(productFile, 'utf8'));
  if (String(productMeta.product_id || '') !== productId) {
    throw new Error('Product registry id mismatch: ' + productId);
  }
  const projectFile = path.join(knowledgeRoot, 'projects', projectId, 'project.md');
  if (!fs.existsSync(projectFile)) throw new Error('Project registry not found: ' + projectId);
  const meta = parseFrontmatter(fs.readFileSync(projectFile, 'utf8'));
  if (String(meta.project_id || '') !== projectId) {
    throw new Error('Project registry id mismatch: ' + projectId);
  }
  if (typeof meta.product_id !== 'string' || !meta.product_id) {
    throw new Error('Project registry missing product_id: ' + projectId);
  }
  if (String(meta.product_id) !== productId) {
    throw new Error('Project ' + projectId + ' belongs to product ' + meta.product_id);
  }
}

function localReference(value) {
  let target = String(value || '').trim().replace(/^<|>$/g, '');
  target = target.replace(/\s+["'][^"']*["']\s*$/, '').trim();
  if (!target || /^(?:https?:|data:|mailto:|#)/i.test(target)) return null;
  return target;
}

function inspectLocalMarkdown(content) {
  const references = new Set();
  const definitions = new Map();
  for (const match of content.matchAll(/^\s*\[([^\]]+)\]:\s*(.+?)\s*$/gm)) {
    const target = localReference(match[2]);
    if (target) definitions.set(match[1].trim().toLowerCase(), target);
  }
  for (const match of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = localReference(match[1]);
    if (target) references.add('image:' + target);
  }
  for (const match of content.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const target = localReference(match[1]);
    if (target) references.add('image:' + target);
  }
  for (const match of content.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const key = (match[2] || match[1]).trim().toLowerCase();
    const target = definitions.get(key);
    if (target) references.add('image:' + target);
  }
  for (const match of content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = localReference(match[1]);
    if (target && ATTACHMENT_EXTENSIONS.has(path.extname(target.split(/[?#]/, 1)[0]).toLowerCase())) {
      references.add('attachment:' + target);
    }
  }
  for (const match of content.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    const target = localReference(match[1]);
    if (target && ATTACHMENT_EXTENSIONS.has(path.extname(target.split(/[?#]/, 1)[0]).toLowerCase())) {
      references.add('attachment:' + target);
    }
  }
  for (const match of content.matchAll(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const key = (match[2] || match[1]).trim().toLowerCase();
    const target = definitions.get(key);
    if (target && ATTACHMENT_EXTENSIONS.has(path.extname(target.split(/[?#]/, 1)[0]).toLowerCase())) {
      references.add('attachment:' + target);
    }
  }
  const missingContent = [...references].sort();
  return {
    contentFidelity: missingContent.length ? 'source-incomplete' : 'source-complete',
    missingContent,
  };
}

function findLocalDuplicate(knowledgeRoot, projectId, token, hash) {
  const records = listMarkdownFiles(path.join(
    knowledgeRoot,
    'projects',
    projectId,
    'prds',
  )).map((file) => ({
    path: file,
    meta: parseFrontmatter(fs.readFileSync(file, 'utf8')),
  }));
  return findDuplicate(records, token, null, hash);
}

function localArchivePath(knowledgeRoot, productId, projectId, title, token, hash) {
  validateId(productId, 'product');
  validateId(projectId, 'project');
  const filename = [
    localDate(),
    slugifyTitle(title, token.slice(0, 12)),
    'h' + hash.slice(0, 12),
    's' + token.slice(6, 14),
  ].join('-') + '.md';
  return path.join(knowledgeRoot, 'projects', projectId, 'prds', filename);
}

function renderLocalArchive(source, content, metadata) {
  const lines = [
    '---',
    'title: ' + yamlString(metadata.title),
    'product_id: ' + yamlString(metadata.productId),
    'project_id: ' + yamlString(metadata.projectId),
  ];
  const version = extractVersion(content);
  if (version) lines.push('version: ' + yamlString(version));
  lines.push(
    'source_type: ' + yamlString(metadata.sourceType),
    'source_path: ' + yamlString(source),
    'source_token: ' + yamlString(metadata.sourceToken),
    'content_hash: ' + yamlString(metadata.contentHash),
    'archive_hash: ' + yamlString(metadata.archiveHash),
    'content_fidelity: ' + yamlString(metadata.contentFidelity),
    'missing_content: ' + JSON.stringify(metadata.missingContent),
    'archived_at: ' + yamlString(new Date().toISOString()),
    'tags: []',
    'related_prds: []',
    '---',
    '',
    '# ' + metadata.title,
    '',
    '> 本地来源：' + source,
    '',
    content,
  );
  if (!content.endsWith('\n')) lines.push('');
  return lines.join('\n');
}

function archiveLocal(args) {
  if (!args.file || !args.product || !args.project) throw new Error(usage());
  validateId(args.product, 'product');
  validateId(args.project, 'project');

  const requestedFile = path.resolve(args.file);
  if (!fs.existsSync(requestedFile) || !fs.statSync(requestedFile).isFile()) {
    throw new Error('Local source file not found: ' + requestedFile);
  }
  const extension = path.extname(requestedFile).toLocaleLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(
      'Unsupported local format "' + (extension || '(none)')
      + '". Only UTF-8 .md and .txt files are supported.',
    );
  }

  const source = fs.realpathSync.native(requestedFile);
  const content = readUtf8(source);
  if (!content.trim()) throw new Error('Local source file is empty: ' + source);
  const knowledgeRoot = path.resolve(args.root || path.join(process.cwd(), 'pm-knowledge'));
  assertProjectProduct(knowledgeRoot, args.product, args.project);

  const fidelity = extension === '.md'
    ? inspectLocalMarkdown(content)
    : { contentFidelity: 'source-complete', missingContent: [] };
  if (fidelity.missingContent.length && !args['allow-incomplete']) {
    throw new Error(
      'Local Markdown references assets that are not copied into the archive: '
      + fidelity.missingContent.join(', ')
      + '. Re-run with --allow-incomplete only after accepting an incomplete archive.',
    );
  }

  const token = sourceToken(source);
  const rawHash = contentHash(content);
  const archiveHash = contentHash(rawHash + '\n' + JSON.stringify(fidelity.missingContent));
  const duplicate = findLocalDuplicate(knowledgeRoot, args.project, token, archiveHash);
  if (duplicate) {
    return Object.assign(duplicate, {
      product: args.product,
      project: args.project,
      source,
    });
  }

  const title = deriveTitle(content, source, args.title);
  const output = localArchivePath(
    knowledgeRoot,
    args.product,
    args.project,
    title,
    token,
    archiveHash,
  );
  if (!args['dry-run']) {
    writeArchive(
      output,
      renderLocalArchive(source, content, {
        title,
        productId: args.product,
        projectId: args.project,
        sourceType: sourceType(extension),
        sourceToken: token,
        contentHash: rawHash,
        archiveHash,
        contentFidelity: fidelity.contentFidelity,
        missingContent: fidelity.missingContent,
      }),
      knowledgeRoot,
    );
  }
  return {
    status: args['dry-run'] ? 'ready' : 'archived',
    path: output,
    product: args.product,
    project: args.project,
    source,
    content_fidelity: fidelity.contentFidelity,
    missing_content: fidelity.missingContent,
  };
}

function runSelfTest() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-local-archive-'));
  try {
    const source = path.join(temporaryRoot, 'source.md');
    const knowledgeRoot = path.join(temporaryRoot, 'knowledge');
    const projectRoot = path.join(knowledgeRoot, 'projects', 'viewer');
    const productRoot = path.join(knowledgeRoot, 'products', 'ct');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(productRoot, { recursive: true });
    fs.writeFileSync(
      path.join(productRoot, 'product.md'),
      '---\nproduct_id: "ct"\n---\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'project.md'),
      '---\nproject_id: "viewer"\nproduct_id: "ct"\n---\n',
      'utf8',
    );
    fs.writeFileSync(source, '# Layout V1.0\n\nOriginal requirement.\n', 'utf8');

    const first = archiveLocal({
      file: source,
      root: knowledgeRoot,
      product: 'ct',
      project: 'viewer',
    });
    assert.strictEqual(first.status, 'archived');
    const archived = fs.readFileSync(first.path, 'utf8');
    assert.match(archived, /content_fidelity: "source-complete"/);
    assert.match(archived, /missing_content: \[\]/);

    const duplicate = archiveLocal({
      file: source,
      root: knowledgeRoot,
      product: 'ct',
      project: 'viewer',
    });
    assert.strictEqual(duplicate.status, 'unchanged');
    assert.strictEqual(duplicate.path, first.path);

    fs.writeFileSync(source, '# Layout V1.1\n\nChanged requirement.\n', 'utf8');
    const dryRun = archiveLocal({
      file: source,
      root: knowledgeRoot,
      product: 'ct',
      project: 'viewer',
      'dry-run': true,
    });
    assert.strictEqual(dryRun.status, 'ready');
    assert.strictEqual(fs.existsSync(dryRun.path), false);
    fs.writeFileSync(source, '# Layout V1.2\n\n![截图](image.png)\n', 'utf8');
    assert.throws(
      () => archiveLocal({
        file: source,
        root: knowledgeRoot,
        product: 'ct',
        project: 'viewer',
      }),
      /--allow-incomplete/,
    );
    const incomplete = archiveLocal({
      file: source,
      root: knowledgeRoot,
      product: 'ct',
      project: 'viewer',
      'allow-incomplete': true,
    });
    assert.strictEqual(incomplete.content_fidelity, 'source-incomplete');
    assert.deepStrictEqual(incomplete.missing_content, ['image:image.png']);
    assert.match(fs.readFileSync(incomplete.path, 'utf8'), /content_fidelity: "source-incomplete"/);
    assert.deepStrictEqual(
      inspectLocalMarkdown('![图][img]\n\n[规格][file]\n\n[img]: image.png\n[file]: spec.pdf\n').missingContent,
      ['attachment:spec.pdf', 'image:image.png'],
    );
    const collision = path.join(temporaryRoot, 'collision.md');
    writeArchive(collision, 'first');
    assert.throws(() => writeArchive(collision, 'second'), /EEXIST/);

    const otherProductRoot = path.join(knowledgeRoot, 'products', 'other');
    fs.mkdirSync(otherProductRoot, { recursive: true });
    fs.writeFileSync(path.join(otherProductRoot, 'product.md'), '---\nproduct_id: "other"\n---\n', 'utf8');
    assert.throws(
      () => archiveLocal({
        file: source,
        root: knowledgeRoot,
        product: 'other',
        project: 'viewer',
      }),
      /belongs to product ct/,
    );
    assert.throws(
      () => archiveLocal({
        file: source,
        root: knowledgeRoot,
        product: 'missing',
        project: 'viewer',
      }),
      /Product registry not found/,
    );
    assert.throws(
      () => archiveLocal({
        file: source,
        root: knowledgeRoot,
        product: 'ct',
        project: 'missing',
      }),
      /Project registry not found/,
    );
    const looseProject = path.join(knowledgeRoot, 'projects', 'loose');
    fs.mkdirSync(looseProject, { recursive: true });
    fs.writeFileSync(path.join(looseProject, 'project.md'), '---\nproject_id: "loose"\n---\n', 'utf8');
    assert.throws(
      () => archiveLocal({
        file: source,
        root: knowledgeRoot,
        product: 'ct',
        project: 'loose',
      }),
      /missing product_id/,
    );
    const unsupported = path.join(temporaryRoot, 'source.docx');
    fs.writeFileSync(unsupported, 'not-a-docx', 'utf8');
    assert.throws(
      () => archiveLocal({
        file: unsupported,
        root: knowledgeRoot,
        product: 'ct',
        project: 'viewer',
      }),
      /Only UTF-8 \.md and \.txt/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log('self-test passed');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    runSelfTest();
    return;
  }
  console.log(JSON.stringify(archiveLocal(args), null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  archiveLocal,
  deriveTitle,
  inspectLocalMarkdown,
};
