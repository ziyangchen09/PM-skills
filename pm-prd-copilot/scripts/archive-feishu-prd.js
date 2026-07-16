#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = 'https://open.feishu.cn/open-apis';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function usage() {
  return [
    'Usage:',
    '  node archive-feishu-prd.js --url <feishu-url> [--root <pm-knowledge>]',
    '    [--product <product-id>] [--project <project-id>] [--config <config.json>]',
    '    [--dry-run]',
    '  node archive-feishu-prd.js --url <feishu-wiki-url> --list-children',
    '  node archive-feishu-prd.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new Error('Unexpected argument: ' + item);
    const key = item.slice(2);
    if (key === 'dry-run' || key === 'self-test' || key === 'list-children') {
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

function parseFeishuRef(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid Feishu URL');
  }
  if (!url.hostname.endsWith('.feishu.cn') && url.hostname !== 'feishu.cn') {
    throw new Error('Only feishu.cn links are accepted');
  }
  const match = url.pathname.match(/^\/(wiki|docx|doc)\/([A-Za-z0-9]+)/);
  if (!match) throw new Error('Expected a Feishu wiki, docx, or doc link');
  return { kind: match[1], token: match[2], url: url.toString() };
}

function loadCredentials(explicitPath) {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
    };
  }

  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  if (process.env.FEISHU_CONFIG) candidates.push(path.resolve(process.env.FEISHU_CONFIG));

  const skillsRoot = path.join(os.homedir(), '.agents', 'skills');
  if (fs.existsSync(skillsRoot)) {
    const installed = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('feishu-doc'))
      .map((entry) => path.join(skillsRoot, entry.name, 'config.json'))
      .sort()
      .reverse();
    candidates.push(...installed);
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let config;
    try {
      config = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      throw new Error('Invalid Feishu config JSON: ' + candidate);
    }
    if (config.app_id && config.app_secret) {
      return { appId: config.app_id, appSecret: config.app_secret };
    }
  }
  throw new Error('Missing Feishu credentials. Set FEISHU_APP_ID/FEISHU_APP_SECRET or pass --config.');
}

async function requestJson(endpoint, accessToken, options = {}) {
  const headers = Object.assign({}, options.headers || {}, {
    Authorization: 'Bearer ' + accessToken,
  });
  const response = await fetch(API_BASE + endpoint, Object.assign({}, options, { headers }));
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Feishu returned a non-JSON response (' + response.status + ')');
  }
  if (!response.ok || data.code !== 0) {
    throw new Error((data.msg || 'Feishu request failed') + ' (Code: ' + (data.code ?? response.status) + ')');
  }
  return data.data;
}

async function getAccessToken(credentials) {
  const response = await fetch(API_BASE + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error((data.msg || 'Unable to authenticate with Feishu') + ' (Code: ' + (data.code ?? response.status) + ')');
  }
  return data.tenant_access_token;
}

async function getWikiNode(token, accessToken) {
  const data = await requestJson('/wiki/v2/spaces/get_node?token=' + encodeURIComponent(token), accessToken);
  if (!data.node) throw new Error('Wiki node was not returned');
  return data.node;
}

async function getWikiBreadcrumbs(initialToken, initialNode, accessToken) {
  const chain = [];
  const seen = new Set();
  let token = initialToken;
  let node = initialNode;

  for (let depth = 0; depth < 20 && node; depth += 1) {
    const nodeToken = node.node_token || token;
    if (seen.has(nodeToken)) break;
    seen.add(nodeToken);
    chain.push({ title: node.title || '', token: nodeToken });
    token = node.parent_node_token;
    if (!token) break;
    node = await getWikiNode(token, accessToken);
  }
  return chain.reverse();
}

async function listWikiChildren(spaceId, parentNodeToken, accessToken) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < 100; page += 1) {
    let endpoint = '/wiki/v2/spaces/' + encodeURIComponent(spaceId) + '/nodes?page_size=50'
      + '&parent_node_token=' + encodeURIComponent(parentNodeToken);
    if (pageToken) endpoint += '&page_token=' + encodeURIComponent(pageToken);
    const data = await requestJson(endpoint, accessToken);
    items.push(...(data.items || []));
    if (!data.has_more) return items;
    if (!data.page_token || seenPageTokens.has(data.page_token)) {
      throw new Error('Feishu returned an invalid Wiki pagination token');
    }
    seenPageTokens.add(data.page_token);
    pageToken = data.page_token;
  }
  throw new Error('Wiki child listing exceeded 5000 nodes');
}

function summarizeWikiChildren(ref, items) {
  const origin = new URL(ref.url).origin;
  return items.map((item) => ({
    title: item.title || '',
    node_token: item.node_token,
    obj_type: item.obj_type,
    obj_token: item.obj_token,
    has_child: Boolean(item.has_child),
    url: origin + '/wiki/' + item.node_token,
  }));
}

async function resolveSource(ref, accessToken) {
  if (ref.kind !== 'wiki') {
    return {
      sourceType: 'feishu-' + ref.kind,
      documentType: ref.kind,
      documentToken: ref.token,
      wikiToken: null,
      spaceId: null,
      breadcrumbs: [],
    };
  }

  const node = await getWikiNode(ref.token, accessToken);
  const breadcrumbs = await getWikiBreadcrumbs(ref.token, node, accessToken);
  return {
    sourceType: 'feishu-wiki',
    documentType: node.obj_type,
    documentToken: node.obj_token,
    wikiToken: ref.token,
    spaceId: node.space_id || null,
    breadcrumbs,
  };
}

async function readDocument(source, accessToken) {
  if (source.documentType !== 'docx') {
    throw new Error('Unsupported document type: ' + source.documentType + '. V1 archives Feishu docx documents.');
  }
  const token = encodeURIComponent(source.documentToken);
  const [info, raw] = await Promise.all([
    requestJson('/docx/v1/documents/' + token, accessToken),
    requestJson('/docx/v1/documents/' + token + '/raw_content', accessToken),
  ]);
  const document = info.document || {};
  return {
    title: document.title || source.breadcrumbs.at(-1)?.title || 'Untitled PRD',
    revision: document.revision_id ?? null,
    content: raw.content || '',
  };
}

function parseValue(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (value === '[]') return [];
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{') || value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.replace(/^"|"$/g, '');
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return {};
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return {};
  const result = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    result[line.slice(0, separator).trim()] = parseValue(line.slice(separator + 1));
  }
  return result;
}

function listMarkdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
    }
  }
  return files;
}

function loadScopeRecords(knowledgeRoot, kind) {
  const base = path.join(knowledgeRoot, kind === 'product' ? 'products' : 'projects');
  const filename = kind === 'product' ? 'product.md' : 'project.md';
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(base, entry.name, filename);
      if (!fs.existsSync(file)) return null;
      const meta = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      return {
        id: String(meta[kind + '_id'] || entry.name),
        name: String(meta.name || entry.name),
        aliases: Array.isArray(meta.aliases) ? meta.aliases.map(String) : [],
        keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String) : [],
        productId: kind === 'project' ? String(meta.product_id || '') : '',
        spaceIds: Array.isArray(meta.feishu_space_ids) ? meta.feishu_space_ids.map(String) : [],
        nodeTokens: Array.isArray(meta.feishu_node_tokens) ? meta.feishu_node_tokens.map(String) : [],
        file,
      };
    })
    .filter(Boolean);
}

function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase();
}

function scoreScope(record, context) {
  let score = 0;
  if (context.spaceId && record.spaceIds.includes(context.spaceId)) score += 100;
  const matchedNodeDepths = record.nodeTokens
    .map((token) => context.nodeTokens.indexOf(token))
    .filter((index) => index >= 0);
  if (matchedNodeDepths.length) score += 80 + Math.max(...matchedNodeDepths) * 5;

  const strongText = normalized(context.title + '\n' + context.breadcrumbs);
  const weakText = normalized(context.content.slice(0, 12000));
  const terms = [record.name, ...record.aliases, ...record.keywords]
    .map(normalized)
    .filter((term) => term.length >= 2);
  for (const term of new Set(terms)) {
    if (strongText.includes(term)) score += 20;
    else if (weakText.includes(term)) score += 2;
  }
  return score;
}

function pickScope(records, explicitId, context) {
  if (explicitId) {
    validateId(explicitId, 'scope');
    return {
      selected: records.find((record) => record.id === explicitId) || {
        id: explicitId,
        name: explicitId,
        aliases: [],
        keywords: [],
        productId: '',
        spaceIds: [],
        nodeTokens: [],
        file: null,
      },
      candidates: [],
      reason: 'explicit',
    };
  }
  if (records.length === 0) return { selected: null, candidates: [], reason: 'no-registry' };
  if (records.length === 1) return { selected: records[0], candidates: [], reason: 'single-scope' };

  const ranked = records
    .map((record) => ({ record, score: scoreScope(record, context) }))
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  const top = ranked[0];
  if (top.score <= 0 || (ranked[1] && ranked[1].score === top.score)) {
    return {
      selected: null,
      candidates: ranked.slice(0, 5).map((item) => ({
        id: item.record.id,
        name: item.record.name,
        score: item.score,
      })),
      reason: top.score <= 0 ? 'no-match' : 'ambiguous',
    };
  }
  return { selected: top.record, candidates: [], reason: 'matched' };
}

function classifyScope(knowledgeRoot, source, document, explicitProduct, explicitProject) {
  const context = {
    title: document.title,
    content: document.content,
    breadcrumbs: source.breadcrumbs.map((item) => item.title).join(' / '),
    nodeTokens: source.breadcrumbs.map((item) => item.token),
    spaceId: source.spaceId,
  };
  const productResult = pickScope(
    loadScopeRecords(knowledgeRoot, 'product'),
    explicitProduct,
    context,
  );
  if (!productResult.selected) {
    return {
      status: 'classification_required',
      missing: 'product',
      productCandidates: productResult.candidates,
      projectCandidates: [],
    };
  }

  const allProjects = loadScopeRecords(knowledgeRoot, 'project');
  const projects = allProjects.filter((project) => !project.productId || project.productId === productResult.selected.id);
  const projectResult = pickScope(projects, explicitProject, context);
  if (!projectResult.selected) {
    return {
      status: 'classification_required',
      missing: 'project',
      product: productResult.selected.id,
      productCandidates: [],
      projectCandidates: projectResult.candidates,
    };
  }
  if (projectResult.selected.productId && projectResult.selected.productId !== productResult.selected.id) {
    throw new Error('Project ' + projectResult.selected.id + ' belongs to product ' + projectResult.selected.productId);
  }
  return {
    status: 'classified',
    product: productResult.selected.id,
    project: projectResult.selected.id,
    productReason: productResult.reason,
    projectReason: projectResult.reason,
  };
}

function validateId(value, label) {
  if (!SAFE_ID.test(value)) {
    throw new Error(label + ' id must use lowercase letters, digits, and hyphens (max 64 characters)');
  }
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function findDuplicate(records, sourceToken, revision, hash) {
  for (const record of records) {
    if (String(record.meta.source_token || '') !== sourceToken) continue;
    if (revision !== null && String(record.meta.source_revision) === String(revision)) {
      return { status: 'duplicate', path: record.path };
    }
    if (record.meta.content_hash === hash) {
      return { status: 'unchanged', path: record.path };
    }
  }
  return null;
}

function findExistingArchive(knowledgeRoot, sourceToken, revision, hash) {
  const records = listMarkdownFiles(path.join(knowledgeRoot, 'projects')).map((file) => ({
    path: file,
    meta: parseFrontmatter(fs.readFileSync(file, 'utf8')),
  }));
  return findDuplicate(records, sourceToken, revision, hash);
}

function slugifyTitle(title, fallback) {
  const slug = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function localDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function extractVersion(content) {
  const match = content.slice(0, 1000).match(/\bV\d+(?:\.\d+)*\b/i);
  return match ? match[0].toUpperCase() : null;
}

function renderArchive(ref, source, document, classification, hash) {
  const lines = [
    '---',
    'title: ' + yamlString(document.title),
    'product_id: ' + yamlString(classification.product),
    'project_id: ' + yamlString(classification.project),
  ];
  const version = extractVersion(document.content);
  if (version) lines.push('version: ' + yamlString(version));
  lines.push(
    'source_type: ' + yamlString(source.sourceType),
    'source_url: ' + yamlString(ref.url),
    'source_token: ' + yamlString(source.documentToken),
  );
  if (source.wikiToken) lines.push('source_wiki_token: ' + yamlString(source.wikiToken));
  if (source.spaceId) lines.push('source_space_id: ' + yamlString(source.spaceId));
  if (document.revision !== null) lines.push('source_revision: ' + document.revision);
  if (source.breadcrumbs.length) {
    lines.push('source_path: ' + yamlString(source.breadcrumbs.map((item) => item.title).join(' / ')));
  }
  lines.push(
    'content_hash: ' + yamlString(hash),
    'archived_at: ' + yamlString(new Date().toISOString()),
    'tags: []',
    'related_prds: []',
    '---',
    '',
    '# ' + document.title,
    '',
    '> 来源：' + ref.url,
    '',
    document.content.trim(),
    '',
  );
  return lines.join('\n');
}

function archivePath(knowledgeRoot, classification, document, source, hash) {
  validateId(classification.product, 'product');
  validateId(classification.project, 'project');
  const revision = document.revision === null ? hash.slice(0, 12) : String(document.revision);
  const filename = [
    localDate(),
    slugifyTitle(document.title, source.documentToken.slice(0, 12)),
    'r' + revision,
  ].join('-') + '.md';
  return path.join(knowledgeRoot, 'projects', classification.project, 'prds', filename);
}

function writeArchive(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
}

function sourceSummary(source, document) {
  return {
    title: document.title,
    document_type: source.documentType,
    document_token: source.documentToken,
    revision: document.revision,
    space_id: source.spaceId,
    breadcrumbs: source.breadcrumbs.map((item) => item.title),
    breadcrumb_tokens: source.breadcrumbs.map((item) => ({
      title: item.title,
      token: item.token,
    })),
  };
}

function runSelfTest() {
  assert.deepStrictEqual(
    parseFeishuRef('https://example.feishu.cn/wiki/Abc123'),
    {
      kind: 'wiki',
      token: 'Abc123',
      url: 'https://example.feishu.cn/wiki/Abc123',
    },
  );
  assert.deepStrictEqual(parseFrontmatter('---\nproject_id: "viewer"\naliases: ["阅片"]\n---\n'), {
    project_id: 'viewer',
    aliases: ['阅片'],
  });
  const picked = pickScope([
    { id: 'viewer', name: '影像阅片', aliases: ['阅片'], keywords: [], spaceIds: [], nodeTokens: [] },
    { id: 'admin', name: '后台管理', aliases: [], keywords: [], spaceIds: [], nodeTokens: [] },
  ], null, {
    title: '阅片布局',
    content: '',
    breadcrumbs: '需求 / 阅片',
    nodeTokens: [],
    spaceId: null,
  });
  assert.strictEqual(picked.selected.id, 'viewer');
  const mapped = pickScope([
    { id: 'parent', name: '父级', aliases: [], keywords: [], spaceIds: [], nodeTokens: ['parent-token'] },
    { id: 'child', name: '子级', aliases: [], keywords: [], spaceIds: [], nodeTokens: ['child-token'] },
  ], null, {
    title: '功能需求',
    content: '',
    breadcrumbs: '父级 / 子级 / 功能需求',
    nodeTokens: ['parent-token', 'child-token', 'doc-token'],
    spaceId: null,
  });
  assert.strictEqual(mapped.selected.id, 'child');
  assert.deepStrictEqual(findDuplicate([
    { path: 'a.md', meta: { source_token: 'token', source_revision: 2, content_hash: 'hash-a' } },
  ], 'token', 2, 'hash-b'), { status: 'duplicate', path: 'a.md' });
  assert.deepStrictEqual(findDuplicate([
    { path: 'a.md', meta: { source_token: 'token', source_revision: 1, content_hash: 'hash-a' } },
  ], 'token', 2, 'hash-a'), { status: 'unchanged', path: 'a.md' });
  assert.strictEqual(slugifyTitle('布局（多窗视图）', 'fallback'), '布局(多窗视图)');
  assert.throws(() => validateId('../bad', 'project'));
  assert.deepStrictEqual(parseArgs(['--url', 'https://a.feishu.cn/wiki/token', '--list-children']), {
    url: 'https://a.feishu.cn/wiki/token',
    'list-children': true,
  });
  assert.deepStrictEqual(summarizeWikiChildren(
    { url: 'https://a.feishu.cn/wiki/root' },
    [{ title: 'PRD', node_token: 'child', obj_type: 'docx', obj_token: 'doc', has_child: false }],
  )[0], {
    title: 'PRD',
    node_token: 'child',
    obj_type: 'docx',
    obj_token: 'doc',
    has_child: false,
    url: 'https://a.feishu.cn/wiki/child',
  });
  console.log('self-test passed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    runSelfTest();
    return;
  }
  if (!args.url) throw new Error(usage());

  const knowledgeRoot = path.resolve(args.root || path.join(process.cwd(), 'pm-knowledge'));
  const ref = parseFeishuRef(args.url);
  const credentials = loadCredentials(args.config);
  const accessToken = await getAccessToken(credentials);
  if (args['list-children']) {
    if (ref.kind !== 'wiki') throw new Error('--list-children requires a Feishu Wiki URL');
    const rootNode = await getWikiNode(ref.token, accessToken);
    const children = await listWikiChildren(rootNode.space_id, ref.token, accessToken);
    console.log(JSON.stringify({
      status: 'ok',
      parent: { title: rootNode.title || '', node_token: ref.token, space_id: rootNode.space_id },
      children: summarizeWikiChildren(ref, children),
    }, null, 2));
    return;
  }
  const source = await resolveSource(ref, accessToken);
  const document = await readDocument(source, accessToken);
  const classification = classifyScope(
    knowledgeRoot,
    source,
    document,
    args.product,
    args.project,
  );

  if (classification.status !== 'classified') {
    console.log(JSON.stringify(Object.assign({
      status: 'classification_required',
      source: sourceSummary(source, document),
    }, classification), null, 2));
    process.exitCode = 2;
    return;
  }

  const hash = contentHash(document.content);
  const existing = findExistingArchive(
    knowledgeRoot,
    source.documentToken,
    document.revision,
    hash,
  );
  if (existing) {
    console.log(JSON.stringify(Object.assign(existing, {
      source: sourceSummary(source, document),
      product: classification.product,
      project: classification.project,
    }), null, 2));
    return;
  }

  const output = archivePath(knowledgeRoot, classification, document, source, hash);
  if (!args['dry-run']) {
    writeArchive(output, renderArchive(ref, source, document, classification, hash));
  }
  console.log(JSON.stringify({
    status: args['dry-run'] ? 'ready' : 'archived',
    path: output,
    product: classification.product,
    project: classification.project,
    source: sourceSummary(source, document),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  classifyScope,
  contentHash,
  findDuplicate,
  listWikiChildren,
  parseFeishuRef,
  parseFrontmatter,
  pickScope,
  slugifyTitle,
};
