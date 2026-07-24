#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = 'https://open.feishu.cn/open-apis';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
const EXPORT_POLL_DELAY_MS = 600;
const EXPORT_POLL_ATTEMPTS = 50;
const MAX_BREADCRUMB_DEPTH = 50;
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_FEISHU_CODES = new Set([99991400]);
const PLAIN_TEXT_BLOCK_TYPES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 22,
]);
const BLOCK_TYPE_NAMES = {
  18: 'bitable',
  19: 'callout',
  20: 'chat-card',
  21: 'diagram',
  23: 'file',
  24: 'grid',
  25: 'grid-column',
  26: 'iframe',
  27: 'image',
  28: 'isv',
  29: 'mindnote',
  30: 'sheet',
  31: 'table',
  32: 'table-cell',
  33: 'view',
  34: 'quote-container',
  35: 'task',
  36: 'okr',
  37: 'okr-objective',
  38: 'okr-key-result',
  39: 'okr-progress',
  40: 'add-ons',
  41: 'jira-issue',
  999: 'unsupported',
};
const INLINE_FEATURE_NAMES = {
  file: 'inline-file',
  inline_file: 'inline-file',
  inline_block: 'inline-block',
  equation: 'equation',
  undefined_element: 'undefined-element',
  image: 'inline-image',
  attachment: 'inline-attachment',
  mention_doc: 'document-mention',
  mention_user: 'user-mention',
  reminder: 'reminder',
  link: 'inline-link',
};

function usage() {
  return [
    'Usage:',
    '  node archive-feishu-prd.js --url <feishu-url> [--root <pm-knowledge>]',
    '    [--product <product-id>] [--project <project-id>] [--config <config.json>]',
    '    [--dry-run] [--allow-incomplete]',
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
    if (key === 'dry-run' || key === 'self-test' || key === 'list-children'
      || key === 'allow-incomplete') {
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableResponse(status, code) {
  return RETRYABLE_HTTP_STATUS.has(status) || RETRYABLE_FEISHU_CODES.has(Number(code));
}

async function fetchJson(url, options = {}, runtime = {}) {
  const fetchImpl = runtime.fetchImpl || fetch;
  const sleepImpl = runtime.sleepImpl || sleep;
  const timeoutMs = runtime.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const attempts = runtime.attempts ?? MAX_REQUEST_ATTEMPTS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, Object.assign({}, options, {
        signal: controller.signal,
      }));
      let data;
      try {
        data = await response.json();
      } catch {
        const error = new Error('Feishu returned a non-JSON response (' + response.status + ')');
        error.retryable = isRetryableResponse(response.status);
        throw error;
      }
      if (isRetryableResponse(response.status, data && data.code)) {
        const error = new Error((data && data.msg) || 'Feishu request temporarily failed');
        error.retryable = true;
        throw error;
      }
      return { response, data };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const retryable = timedOut
        || error.retryable === true
        || error.name === 'AbortError'
        || error instanceof TypeError;
      lastError = timedOut
        ? new Error('Feishu request timed out after ' + timeoutMs + 'ms')
        : error;
      if (!retryable || attempt === attempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    await sleepImpl(RETRY_DELAY_MS * (2 ** (attempt - 1)));
  }
  throw lastError;
}

async function requestJson(endpoint, accessToken, options = {}) {
  const headers = Object.assign({}, options.headers || {}, {
    Authorization: 'Bearer ' + accessToken,
  });
  const { response, data } = await fetchJson(
    API_BASE + endpoint,
    Object.assign({}, options, { headers }),
  );
  if (!data || typeof data !== 'object' || !response.ok || data.code !== 0) {
    throw new Error(
      ((data && data.msg) || 'Feishu request failed')
      + ' (Code: ' + ((data && data.code) ?? response.status) + ')',
    );
  }
  return data.data;
}

async function requestBinary(endpoint, accessToken, runtime = {}) {
  const fetchImpl = runtime.fetchImpl || fetch;
  const response = await fetchImpl(API_BASE + endpoint, {
    headers: { Authorization: 'Bearer ' + accessToken },
    signal: runtime.signal,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data.msg || data.message || '';
    } catch {}
    throw new Error((detail || 'Feishu binary download failed') + ' (Code: ' + response.status + ')');
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || '',
  };
}

function assertValidDocx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4
    || buffer[0] !== 0x50 || buffer[1] !== 0x4b
    || !([0x03, 0x05, 0x07].includes(buffer[2]))) {
    throw new Error('Feishu rich export is not a valid DOCX/ZIP file');
  }
}

async function exportDocument(source, accessToken, runtime = {}) {
  const requestImpl = runtime.requestJsonImpl || requestJson;
  const sleepImpl = runtime.sleepImpl || sleep;
  const downloadImpl = runtime.downloadImpl
    || ((fileToken) => requestBinary(
      '/drive/v1/export_tasks/file/' + encodeURIComponent(fileToken) + '/download',
      accessToken,
    ));
  const created = await requestImpl('/drive/v1/export_tasks', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_extension: 'docx',
      token: source.documentToken,
      type: 'docx',
    }),
  });
  if (!created.ticket) throw new Error('Feishu export task did not return a ticket');
  const attempts = runtime.pollAttempts || EXPORT_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleepImpl(EXPORT_POLL_DELAY_MS);
    const data = await requestImpl(
      '/drive/v1/export_tasks/' + encodeURIComponent(created.ticket)
        + '?token=' + encodeURIComponent(source.documentToken),
      accessToken,
    );
    const result = data.result || {};
    if (!result.file_token) continue;
    const downloaded = await downloadImpl(result.file_token);
    assertValidDocx(downloaded.buffer);
    return {
      buffer: downloaded.buffer,
      contentType: downloaded.contentType
        || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: result.file_name || '',
      size: downloaded.buffer.length,
      sha256: crypto.createHash('sha256').update(downloaded.buffer).digest('hex'),
    };
  }
  throw new Error('Feishu rich export timed out before a downloadable DOCX was ready');
}

async function getAccessToken(credentials) {
  const { response, data } = await fetchJson(API_BASE + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    }),
  });
  if (!data || typeof data !== 'object' || !response.ok
    || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(
      ((data && data.msg) || 'Unable to authenticate with Feishu')
      + ' (Code: ' + ((data && data.code) ?? response.status) + ')',
    );
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

  for (let depth = 0; depth < MAX_BREADCRUMB_DEPTH && node; depth += 1) {
    const nodeToken = node.node_token || token;
    if (!nodeToken) throw new Error('Wiki breadcrumb node is missing node_token');
    if (seen.has(nodeToken)) throw new Error('Wiki breadcrumb cycle detected');
    seen.add(nodeToken);
    chain.push({ title: node.title || '', token: nodeToken });
    token = node.parent_node_token;
    if (!token) return chain.reverse();
    node = await getWikiNode(token, accessToken);
  }
  throw new Error('Wiki breadcrumb depth exceeded ' + MAX_BREADCRUMB_DEPTH);
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

async function listDocumentBlocks(documentToken, accessToken, requestImpl = requestJson) {
  const items = [];
  const seenPageTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < 100; page += 1) {
    let endpoint = '/docx/v1/documents/' + encodeURIComponent(documentToken)
      + '/blocks?page_size=500';
    if (pageToken) endpoint += '&page_token=' + encodeURIComponent(pageToken);
    const data = await requestImpl(endpoint, accessToken);
    items.push(...(data.items || []));
    if (!data.has_more) return items;
    if (!data.page_token || seenPageTokens.has(data.page_token)) {
      throw new Error('Feishu returned an invalid document block pagination token');
    }
    seenPageTokens.add(data.page_token);
    pageToken = data.page_token;
  }
  throw new Error('Feishu document block listing exceeded 50000 blocks');
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

function collectInlineFeatures(value, features) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectInlineFeatures(item, features));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'comment_ids' && hasValue(child)) features.add('comments');
    if (INLINE_FEATURE_NAMES[key] && hasValue(child)) features.add(INLINE_FEATURE_NAMES[key]);
    collectInlineFeatures(child, features);
  }
}

function increment(counts, name) {
  counts.set(name, (counts.get(name) || 0) + 1);
}

function inspectDocumentBlocks(blocks, document = {}) {
  const counts = new Map();
  for (const block of blocks || []) {
    const type = Number(block && block.block_type);
    const blockName = PLAIN_TEXT_BLOCK_TYPES.has(type)
      ? null
      : (BLOCK_TYPE_NAMES[type] || 'block-type-' + type);
    if (blockName) increment(counts, blockName);
    const features = new Set();
    collectInlineFeatures(block, features);
    for (const feature of features) {
      if (feature === blockName || (blockName === 'image' && feature === 'inline-image')) continue;
      if (blockName === 'file' && feature === 'inline-file') continue;
      increment(counts, feature);
    }
  }
  if (hasValue(document.cover)) increment(counts, 'cover');
  const missingContent = Array.from(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => name + ':' + count);
  return {
    contentFidelity: missingContent.length ? 'plain-text-incomplete' : 'plain-text',
    missingContent,
  };
}

function assertDocumentArchivable(document, allowIncomplete) {
  if (document.missingContent.length && !allowIncomplete) {
    throw new Error(
      'Feishu document contains rich blocks that raw_content cannot preserve: '
      + document.missingContent.join(', ')
      + '. Re-run with --allow-incomplete only after accepting a text-only archive.',
    );
  }
}

async function readDocument(source, accessToken, runtime = {}) {
  if (source.documentType !== 'docx') {
    throw new Error('Unsupported document type: ' + source.documentType + '. V1 archives Feishu docx documents.');
  }
  const token = encodeURIComponent(source.documentToken);
  const requestImpl = runtime.requestJsonImpl || requestJson;
  const listBlocksImpl = runtime.listDocumentBlocksImpl
    || ((documentToken, tokenValue) => listDocumentBlocks(documentToken, tokenValue, requestImpl));
  const sleepImpl = runtime.sleepImpl || sleep;
  const attempts = runtime.attempts || MAX_REQUEST_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await requestImpl('/docx/v1/documents/' + token, accessToken);
    const [raw, blocks] = await Promise.all([
      requestImpl('/docx/v1/documents/' + token + '/raw_content', accessToken),
      listBlocksImpl(source.documentToken, accessToken),
    ]);
    const fidelity = inspectDocumentBlocks(blocks, before.document || {});
    const exportImpl = runtime.exportDocumentImpl || exportDocument;
    let richExport = null;
    if (fidelity.missingContent.length) {
      try {
        richExport = await exportImpl(source, accessToken, runtime.exportRuntime || {});
      } catch (error) {
        if (!runtime.allowIncomplete) throw error;
      }
    }
    const after = await requestImpl('/docx/v1/documents/' + token, accessToken);
    const beforeDocument = before.document || {};
    const afterDocument = after.document || {};
    const beforeRevision = beforeDocument.revision_id ?? null;
    const afterRevision = afterDocument.revision_id ?? null;
    if (beforeRevision === null || afterRevision === null) {
      if (attempt === attempts) throw new Error('Feishu document did not return revision_id; stable archival is unavailable');
      await sleepImpl(RETRY_DELAY_MS * (2 ** (attempt - 1)));
      continue;
    }
    if (String(beforeRevision) !== String(afterRevision)) {
      if (attempt === attempts) {
        throw new Error('Feishu document changed while archiving; retry after editing stops');
      }
      await sleepImpl(RETRY_DELAY_MS * (2 ** (attempt - 1)));
      continue;
    }
    const document = afterDocument;
    return {
      title: document.title || source.breadcrumbs.at(-1)?.title || 'Untitled PRD',
      revision: afterRevision,
      content: raw.content || '',
      contentFidelity: richExport ? 'rich-export' : fidelity.contentFidelity,
      missingContent: richExport ? [] : fidelity.missingContent,
      richFeatures: fidelity.missingContent,
      richExport,
      contentSignature: contentHash(stableStringify({
        blocks,
        cover: document.cover || null,
      })),
    };
  }
  throw new Error('Unable to read a stable Feishu document revision');
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
      const id = meta[kind + '_id'];
      if (typeof id !== 'string' || id !== entry.name) {
        throw new Error(kind + ' registry id must match directory name: ' + file);
      }
      validateId(id, kind);
      if (kind === 'project' && (typeof meta.product_id !== 'string' || !meta.product_id)) {
        throw new Error('project registry missing product_id: ' + file);
      }
      if (kind === 'project') validateId(meta.product_id, 'product');
      return {
        id,
        name: String(meta.name || entry.name),
        aliases: Array.isArray(meta.aliases) ? meta.aliases.map(String) : [],
        keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String) : [],
        productId: kind === 'project' ? meta.product_id : '',
        spaceIds: Array.isArray(meta.feishu_space_ids) ? meta.feishu_space_ids.map(String) : [],
        nodeTokens: Array.isArray(meta.feishu_node_tokens) ? meta.feishu_node_tokens.map(String) : [],
        syncRoots: Array.isArray(meta.feishu_sync_roots) ? meta.feishu_sync_roots.map(String) : [],
        syncSubtrees: Array.isArray(meta.feishu_sync_subtrees)
          ? meta.feishu_sync_subtrees.map(String)
          : [],
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
    const selected = records.find((record) => record.id === explicitId) || null;
    return {
      selected,
      candidates: [],
      reason: selected ? 'explicit' : 'explicit-not-found',
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
  const productRecords = loadScopeRecords(knowledgeRoot, 'product');
  const productResult = pickScope(
    productRecords,
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
  const registeredProducts = new Set(productRecords.map((product) => product.id));
  const orphan = allProjects.find((project) => !registeredProducts.has(project.productId));
  if (orphan) throw new Error('Project ' + orphan.id + ' references unknown product ' + orphan.productId);
  const projects = allProjects.filter((project) => project.productId === productResult.selected.id);
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

function documentArchiveHash(document) {
  return contentHash(
    contentHash(document.content) + '\n' + document.contentSignature
      + (document.richExport ? '\nrich-export-v1' : ''),
  );
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ':' + stableStringify(value[key]),
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function findDuplicate(records, sourceToken, revision, hash) {
  for (const record of records) {
    if (String(record.meta.source_token || '') !== sourceToken) continue;
    const recordHash = record.meta.archive_hash || record.meta.content_hash;
    if (revision !== null
      && String(record.meta.source_revision) === String(revision)
      && recordHash === hash) {
      return { status: 'duplicate', path: record.path };
    }
    if (recordHash === hash) {
      return { status: 'unchanged', path: record.path };
    }
  }
  return null;
}

function findExistingArchive(knowledgeRoot, sourceToken, revision, hash, projectId) {
  if (projectId) validateId(projectId, 'project');
  const searchRoot = projectId
    ? path.join(knowledgeRoot, 'projects', projectId, 'prds')
    : path.join(knowledgeRoot, 'projects');
  const records = listMarkdownFiles(searchRoot).map((file) => ({
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

function renderArchive(ref, source, document, classification, hashes, richContent = null) {
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
    'content_hash: ' + yamlString(hashes.content),
    'content_signature: ' + yamlString(hashes.signature),
    'archive_hash: ' + yamlString(hashes.archive),
    'content_fidelity: ' + yamlString(document.contentFidelity),
    'missing_content: ' + JSON.stringify(document.missingContent),
    'rich_content_features: ' + JSON.stringify(document.richFeatures || []),
  );
  if (richContent) lines.push(
    'rich_content_path: ' + yamlString(richContent.path),
    'rich_content_sha256: ' + yamlString(richContent.sha256),
    'rich_content_size: ' + richContent.size,
  );
  lines.push(
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

function archivedDocumentContent(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const frontmatterEnd = normalized.indexOf('\n---\n', 4);
  if (frontmatterEnd < 0) return null;
  const body = normalized.slice(frontmatterEnd + 5).replace(/^\n/, '');
  const header = body.match(/^# [^\n]*\n\n> 来源：[^\n]*\n\n/);
  return header ? body.slice(header[0].length).trim() : null;
}

function assertArchiveIntegrity(file, expected) {
  const text = fs.readFileSync(file, 'utf8');
  const meta = parseFrontmatter(text);
  if (String(meta.source_token || '') !== expected.sourceToken
    || String(meta.product_id || '') !== expected.productId
    || String(meta.project_id || '') !== expected.projectId
    || String(meta.archive_hash || '') !== expected.archiveHash
    || String(meta.content_hash || '') !== expected.contentHash
    || String(meta.content_signature || '') !== expected.contentSignature
    || String(meta.content_fidelity || '') !== expected.contentFidelity
    || JSON.stringify(meta.missing_content || []) !== JSON.stringify(expected.missingContent)
    || JSON.stringify(meta.rich_content_features || []) !== JSON.stringify(expected.richFeatures || [])
    || String(meta.source_revision ?? '') !== String(expected.revision ?? '')) {
    throw new Error('Existing archive metadata failed integrity check: ' + file);
  }
  if (expected.richExport) {
    const relative = String(meta.rich_content_path || '');
    const richFile = path.resolve(path.dirname(file), relative);
    const safeRelative = path.relative(path.dirname(file), richFile);
    if (!relative || safeRelative.startsWith('..' + path.sep) || safeRelative === '..'
      || path.isAbsolute(safeRelative) || !fs.existsSync(richFile)
      || !fs.statSync(richFile).isFile() || fs.lstatSync(richFile).isSymbolicLink()) {
      throw new Error('Rich-content archive is missing or unsafe: ' + file);
    }
    const richBuffer = fs.readFileSync(richFile);
    const richHash = crypto.createHash('sha256').update(richBuffer).digest('hex');
    if (String(meta.rich_content_sha256 || '') !== richHash
      || Number(meta.rich_content_size) !== richBuffer.length) {
      throw new Error('Rich-content archive failed checksum validation: ' + richFile);
    }
  }
  const archived = archivedDocumentContent(text);
  const current = String(expected.content || '').replace(/\r\n/g, '\n').trim();
  if (archived === null || archived !== current) {
    throw new Error('Existing archive body failed integrity check: ' + file);
  }
}

function archivePath(knowledgeRoot, classification, document, source, hash) {
  validateId(classification.product, 'product');
  validateId(classification.project, 'project');
  const revision = document.revision === null ? hash.slice(0, 12) : String(document.revision);
  const filename = [
    localDate(),
    slugifyTitle(document.title, source.documentToken.slice(0, 12)),
    'r' + revision,
    's' + contentHash(source.documentToken).slice(0, 16),
    'h' + hash.slice(0, 12),
  ].join('-') + '.md';
  return path.join(knowledgeRoot, 'projects', classification.project, 'prds', filename);
}

function assertSafePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..'
    || path.isAbsolute(relative)) {
    throw new Error('Path must stay inside pm-knowledge: ' + resolvedTarget);
  }
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error('pm-knowledge root not found: ' + resolvedRoot);
  }
  let current = resolvedRoot;
  if (fs.lstatSync(current).isSymbolicLink()) {
    throw new Error('Refusing symbolic-link pm-knowledge root: ' + current);
  }
  for (const segment of path.relative(resolvedRoot, path.dirname(resolvedTarget)).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Refusing symbolic-link archive path: ' + current);
    }
  }
  return resolvedTarget;
}

function writeArchive(file, content, knowledgeRoot) {
  if (knowledgeRoot) assertSafePath(knowledgeRoot, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
}

function writeArchiveBundle(file, content, richExport, knowledgeRoot) {
  if (!richExport) return writeArchive(file, content, knowledgeRoot);
  const richFile = file.replace(/\.md$/i, '.source.docx');
  assertSafePath(knowledgeRoot, richFile);
  fs.mkdirSync(path.dirname(richFile), { recursive: true });
  try {
    fs.writeFileSync(richFile, richExport.buffer, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(richFile);
    const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
    if (existingHash !== richExport.sha256 || existing.length !== richExport.size) throw error;
  }
  writeArchive(file, content, knowledgeRoot);
}

function archiveResolvedDocument(options) {
  const {
    ref,
    source,
    document,
    knowledgeRoot,
    product,
    project,
    allowIncomplete = false,
    dryRun = false,
  } = options;
  assertDocumentArchivable(document, allowIncomplete);
  const classification = classifyScope(
    knowledgeRoot,
    source,
    document,
    product,
    project,
  );
  if (classification.status !== 'classified') {
    return Object.assign({
      status: 'classification_required',
      source: sourceSummary(source, document),
    }, classification);
  }

  const hashes = {
    content: contentHash(document.content),
    signature: document.contentSignature,
  };
  hashes.archive = documentArchiveHash(document);
  const existing = findExistingArchive(
    knowledgeRoot,
    source.documentToken,
    document.revision,
    hashes.archive,
    classification.project,
  );
  if (existing) {
    assertArchiveIntegrity(existing.path, {
      sourceToken: source.documentToken,
      productId: classification.product,
      projectId: classification.project,
      archiveHash: hashes.archive,
      contentHash: hashes.content,
      contentSignature: hashes.signature,
      contentFidelity: document.contentFidelity,
      missingContent: document.missingContent,
      richFeatures: document.richFeatures,
      revision: document.revision,
      content: document.content,
      richExport: document.richExport,
    });
    return Object.assign(existing, {
      product: classification.product,
      project: classification.project,
      hashes,
      source: sourceSummary(source, document),
    });
  }

  const output = archivePath(knowledgeRoot, classification, document, source, hashes.archive);
  const richContent = document.richExport ? {
    path: './' + path.basename(output).replace(/\.md$/i, '.source.docx'),
    sha256: document.richExport.sha256,
    size: document.richExport.size,
  } : null;
  if (!dryRun) {
    try {
      writeArchiveBundle(
        output,
        renderArchive(ref, source, document, classification, hashes, richContent),
        document.richExport,
        knowledgeRoot,
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!fs.existsSync(output)) throw error;
      assertArchiveIntegrity(output, {
        sourceToken: source.documentToken,
        productId: classification.product,
        projectId: classification.project,
        archiveHash: hashes.archive,
        contentHash: hashes.content,
        contentSignature: hashes.signature,
        contentFidelity: document.contentFidelity,
        missingContent: document.missingContent,
        richFeatures: document.richFeatures,
        revision: document.revision,
        content: document.content,
        richExport: document.richExport,
      });
      return {
        status: 'duplicate',
        path: output,
        product: classification.product,
        project: classification.project,
        hashes,
        source: sourceSummary(source, document),
      };
    }
  }
  return {
    status: dryRun ? 'ready' : 'archived',
    path: output,
    product: classification.product,
    project: classification.project,
    hashes,
    source: sourceSummary(source, document),
  };
}

function sourceSummary(source, document) {
  return {
    title: document.title,
    document_type: source.documentType,
    document_token: source.documentToken,
    revision: document.revision,
    space_id: source.spaceId,
    content_fidelity: document.contentFidelity,
    missing_content: document.missingContent,
    rich_content_features: document.richFeatures || [],
    rich_content_exported: Boolean(document.richExport),
    content_signature: document.contentSignature,
    breadcrumbs: source.breadcrumbs.map((item) => item.title),
    breadcrumb_tokens: source.breadcrumbs.map((item) => ({
      title: item.title,
      token: item.token,
    })),
  };
}

async function runSelfTest() {
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
  assert.strictEqual(pickScope([
    { id: 'viewer', name: '影像阅片', aliases: [], keywords: [], spaceIds: [], nodeTokens: [] },
  ], 'missing', {
    title: '', content: '', breadcrumbs: '', nodeTokens: [], spaceId: null,
  }).selected, null);
  assert.deepStrictEqual(findDuplicate([
    { path: 'a.md', meta: { source_token: 'token', source_revision: 2, archive_hash: 'hash-a' } },
  ], 'token', 2, 'hash-a'), { status: 'duplicate', path: 'a.md' });
  assert.strictEqual(findDuplicate([
    { path: 'a.md', meta: { source_token: 'token', source_revision: 2, archive_hash: 'hash-a' } },
  ], 'token', 2, 'hash-b'), null);
  assert.deepStrictEqual(findDuplicate([
    { path: 'a.md', meta: { source_token: 'token', source_revision: 1, content_hash: 'hash-a' } },
  ], 'token', 2, 'hash-a'), { status: 'unchanged', path: 'a.md' });
  assert.strictEqual(
    stableStringify({ b: 2, a: { d: 4, c: 3 } }),
    stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
  );
  assert.strictEqual(slugifyTitle('布局（多窗视图）', 'fallback'), '布局(多窗视图)');
  assert.throws(() => validateId('../bad', 'project'));
  assert.deepStrictEqual(parseArgs([
    '--url', 'https://a.feishu.cn/wiki/token', '--list-children', '--allow-incomplete',
  ]), {
    url: 'https://a.feishu.cn/wiki/token',
    'list-children': true,
    'allow-incomplete': true,
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
  const fidelity = inspectDocumentBlocks([
    { block_type: 2 },
    { block_type: 27 },
    { block_type: 31 },
    { block_type: 32 },
    { block_type: 32 },
  ]);
  assert.deepStrictEqual(fidelity, {
    contentFidelity: 'plain-text-incomplete',
    missingContent: ['image:1', 'table:1', 'table-cell:2'],
  });
  const inlineFidelity = inspectDocumentBlocks([{
    block_type: 2,
    comment_ids: ['comment-1'],
    text: {
      elements: [
        { file: { file_token: 'file-1' } },
        { text_run: { content: '链接', text_element_style: { link: { url: 'https://example.com' } } } },
      ],
    },
  }], { cover: { token: 'cover-1' } });
  assert.deepStrictEqual(inlineFidelity, {
    contentFidelity: 'plain-text-incomplete',
    missingContent: ['comments:1', 'cover:1', 'inline-file:1', 'inline-link:1'],
  });
  assert.throws(
    () => assertDocumentArchivable({
      missingContent: fidelity.missingContent,
    }, false),
    /--allow-incomplete/,
  );
  assert.doesNotThrow(() => assertDocumentArchivable({
    missingContent: fidelity.missingContent,
  }, true));
  let attempts = 0;
  const fetched = await fetchJson('https://example.invalid', {}, {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ code: 99991400, msg: 'rate limited' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { ok: true } }),
      };
    },
    sleepImpl: async () => {},
  });
  assert.strictEqual(attempts, 2);
  assert.strictEqual(fetched.data.data.ok, true);
  attempts = 0;
  await assert.rejects(
    () => fetchJson('https://example.invalid', {}, {
      attempts: 2,
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError('offline');
      },
      sleepImpl: async () => {},
    }),
    /offline/,
  );
  assert.strictEqual(attempts, 2);
  const fakeDocx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  const exported = await exportDocument({ documentToken: 'doc-token' }, 'access-token', {
    sleepImpl: async () => {},
    requestJsonImpl: async (endpoint) => {
      if (endpoint === '/drive/v1/export_tasks') return { ticket: 'ticket-1' };
      return { result: { job_status: 0, file_token: 'file-token', file_name: 'PRD' } };
    },
    downloadImpl: async () => ({ buffer: fakeDocx, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  });
  assert.strictEqual(exported.size, fakeDocx.length);
  assert.strictEqual(exported.sha256, crypto.createHash('sha256').update(fakeDocx).digest('hex'));
  assert.throws(() => assertValidDocx(Buffer.from('not-docx')), /valid DOCX/);
  let infoCalls = 0;
  const stableDocument = await readDocument({
    documentType: 'docx',
    documentToken: 'doc-token',
    breadcrumbs: [],
  }, 'access-token', {
    attempts: 2,
    sleepImpl: async () => {},
    requestJsonImpl: async (endpoint) => {
      if (endpoint.endsWith('/raw_content')) return { content: '正文' };
      infoCalls += 1;
      return { document: { title: 'PRD', revision_id: infoCalls === 1 ? 1 : 2 } };
    },
    listDocumentBlocksImpl: async () => [{ block_type: 2 }],
  });
  assert.strictEqual(stableDocument.revision, 2);
  assert.strictEqual(infoCalls, 4);
  await assert.rejects(
    () => readDocument({
      documentType: 'docx',
      documentToken: 'doc-token',
      breadcrumbs: [],
    }, 'access-token', {
      attempts: 1,
      requestJsonImpl: async (endpoint) => (
        endpoint.endsWith('/raw_content') ? { content: '正文' } : { document: { title: 'PRD' } }
      ),
      listDocumentBlocksImpl: async () => [{ block_type: 2 }],
    }),
    /revision_id/,
  );
  const collisionRoot = path.join(os.tmpdir(), 'pm-feishu-path-test');
  const firstPath = archivePath(
    collisionRoot,
    { product: 'ct', project: 'viewer' },
    { title: '同名 PRD', revision: 1 },
    { documentToken: 'abcdefgh-token-one' },
    'a'.repeat(64),
  );
  const secondPath = archivePath(
    collisionRoot,
    { product: 'ct', project: 'viewer' },
    { title: '同名 PRD', revision: 1 },
    { documentToken: 'abcdefgh-token-two' },
    'a'.repeat(64),
  );
  assert.notStrictEqual(firstPath, secondPath);
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-feishu-registry-'));
  try {
    const productFile = path.join(registryRoot, 'products', 'folder-id', 'product.md');
    fs.mkdirSync(path.dirname(productFile), { recursive: true });
    fs.writeFileSync(productFile, '---\nproduct_id: "meta-id"\n---\n', 'utf8');
    assert.throws(() => loadScopeRecords(registryRoot, 'product'), /match directory name/);
    fs.writeFileSync(productFile, '---\nproduct_id: "folder-id"\n---\n', 'utf8');
    const projectFile = path.join(registryRoot, 'projects', 'viewer', 'project.md');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, '---\nproject_id: "viewer"\n---\n', 'utf8');
    assert.throws(() => loadScopeRecords(registryRoot, 'project'), /missing product_id/);
    fs.writeFileSync(projectFile, '---\nproject_id: "viewer"\nproduct_id: "missing"\n---\n', 'utf8');
    assert.throws(() => classifyScope(registryRoot, {
      breadcrumbs: [], spaceId: null,
    }, {
      title: 'PRD', content: '',
    }, 'folder-id', 'viewer'), /unknown product/);
    fs.writeFileSync(
      projectFile,
      '---\nproject_id: "viewer"\nproduct_id: "folder-id"\n---\n',
      'utf8',
    );
    const archivedResult = archiveResolvedDocument({
      ref: parseFeishuRef('https://example.feishu.cn/wiki/WikiToken'),
      source: {
        sourceType: 'feishu-wiki',
        documentType: 'docx',
        documentToken: 'DocToken',
        wikiToken: 'WikiToken',
        spaceId: 'space',
        breadcrumbs: [{ title: 'PRD', token: 'WikiToken' }],
      },
      document: {
        title: 'Integrity PRD',
        revision: 1,
        content: 'Original body',
        contentFidelity: 'plain-text',
        missingContent: [],
        contentSignature: 'signature',
      },
      knowledgeRoot: registryRoot,
      product: 'folder-id',
      project: 'viewer',
    });
    assert.strictEqual(archivedResult.status, 'archived');
    const richDocument = {
      title: 'Rich PRD',
      revision: 2,
      content: 'Searchable body',
      contentFidelity: 'rich-export',
      missingContent: [],
      richFeatures: ['image:1', 'table:1'],
      contentSignature: 'rich-signature',
      richExport: exported,
    };
    const richResult = archiveResolvedDocument({
      ref: parseFeishuRef('https://example.feishu.cn/wiki/RichWikiToken'),
      source: {
        sourceType: 'feishu-wiki', documentType: 'docx', documentToken: 'RichDocToken',
        wikiToken: 'RichWikiToken', spaceId: 'space',
        breadcrumbs: [{ title: 'Rich PRD', token: 'RichWikiToken' }],
      },
      document: richDocument,
      knowledgeRoot: registryRoot,
      product: 'folder-id',
      project: 'viewer',
    });
    assert.strictEqual(richResult.status, 'archived');
    const richMeta = parseFrontmatter(fs.readFileSync(richResult.path, 'utf8'));
    const richFile = path.resolve(path.dirname(richResult.path), richMeta.rich_content_path);
    assert.strictEqual(fs.readFileSync(richFile).equals(fakeDocx), true);
    assertArchiveIntegrity(richResult.path, {
      sourceToken: 'RichDocToken', productId: 'folder-id', projectId: 'viewer',
      archiveHash: documentArchiveHash(richDocument),
      contentHash: contentHash(richDocument.content), contentSignature: richDocument.contentSignature,
      contentFidelity: 'rich-export', missingContent: [], revision: 2,
      richFeatures: richDocument.richFeatures,
      content: richDocument.content, richExport: exported,
    });
    assert.strictEqual(archiveResolvedDocument({
      ref: parseFeishuRef('https://example.feishu.cn/wiki/WikiToken'),
      source: {
        sourceType: 'feishu-wiki',
        documentType: 'docx',
        documentToken: 'DocToken',
        wikiToken: 'WikiToken',
        spaceId: 'space',
        breadcrumbs: [{ title: 'PRD', token: 'WikiToken' }],
      },
      document: {
        title: 'Integrity PRD',
        revision: 1,
        content: 'Original body',
        contentFidelity: 'plain-text',
        missingContent: [],
        contentSignature: 'signature',
      },
      knowledgeRoot: registryRoot,
      product: 'folder-id',
      project: 'viewer',
    }).status, 'duplicate');
    const validArchive = fs.readFileSync(archivedResult.path, 'utf8');
    fs.writeFileSync(
      archivedResult.path,
      validArchive.replace('product_id: "folder-id"', 'product_id: "wrong"'),
      'utf8',
    );
    assert.throws(() => archiveResolvedDocument({
      ref: parseFeishuRef('https://example.feishu.cn/wiki/WikiToken'),
      source: {
        sourceType: 'feishu-wiki',
        documentType: 'docx',
        documentToken: 'DocToken',
        wikiToken: 'WikiToken',
        spaceId: 'space',
        breadcrumbs: [{ title: 'PRD', token: 'WikiToken' }],
      },
      document: {
        title: 'Integrity PRD',
        revision: 1,
        content: 'Original body',
        contentFidelity: 'plain-text',
        missingContent: [],
        contentSignature: 'signature',
      },
      knowledgeRoot: registryRoot,
      product: 'folder-id',
      project: 'viewer',
    }), /metadata failed integrity/);
    fs.writeFileSync(
      archivedResult.path,
      validArchive
        .replace('content_fidelity: "plain-text"', 'content_fidelity: "plain-text-incomplete"')
        .replace('missing_content: []', 'missing_content: ["image:1"]'),
      'utf8',
    );
    assert.throws(() => archiveResolvedDocument({
      ref: parseFeishuRef('https://example.feishu.cn/wiki/WikiToken'),
      source: {
        sourceType: 'feishu-wiki',
        documentType: 'docx',
        documentToken: 'DocToken',
        wikiToken: 'WikiToken',
        spaceId: 'space',
        breadcrumbs: [{ title: 'PRD', token: 'WikiToken' }],
      },
      document: {
        title: 'Integrity PRD',
        revision: 1,
        content: 'Original body',
        contentFidelity: 'plain-text',
        missingContent: [],
        contentSignature: 'signature',
      },
      knowledgeRoot: registryRoot,
      product: 'folder-id',
      project: 'viewer',
    }), /metadata failed integrity/);
    fs.writeFileSync(
      archivedResult.path,
      validArchive.replace('Original body', 'CORRUPT'),
      'utf8',
    );
    assert.throws(() => archiveResolvedDocument({
      ref: parseFeishuRef('https://example.feishu.cn/wiki/WikiToken'),
      source: {
        sourceType: 'feishu-wiki',
        documentType: 'docx',
        documentToken: 'DocToken',
        wikiToken: 'WikiToken',
        spaceId: 'space',
        breadcrumbs: [{ title: 'PRD', token: 'WikiToken' }],
      },
      document: {
        title: 'Integrity PRD',
        revision: 1,
        content: 'Original body',
        contentFidelity: 'plain-text',
        missingContent: [],
        contentSignature: 'signature',
      },
      knowledgeRoot: registryRoot,
      product: 'folder-id',
      project: 'viewer',
    }), /body failed integrity/);
    assert.throws(
      () => assertSafePath(registryRoot, path.join(registryRoot, '..', 'outside.md')),
      /stay inside/,
    );
  } finally {
    fs.rmSync(registryRoot, { recursive: true, force: true });
  }
  console.log('self-test passed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    await runSelfTest();
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
  const document = await readDocument(source, accessToken, {
    allowIncomplete: Boolean(args['allow-incomplete']),
  });
  const result = archiveResolvedDocument({
    ref,
    source,
    document,
    knowledgeRoot,
    product: args.product,
    project: args.project,
    allowIncomplete: Boolean(args['allow-incomplete']),
    dryRun: Boolean(args['dry-run']),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'classification_required') {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  archiveResolvedDocument,
  archivedDocumentContent,
  assertArchiveIntegrity,
  assertDocumentArchivable,
  assertSafePath,
  archivePath,
  classifyScope,
  contentHash,
  extractVersion,
  findDuplicate,
  findExistingArchive,
  getAccessToken,
  getWikiBreadcrumbs,
  getWikiNode,
  inspectDocumentBlocks,
  listMarkdownFiles,
  listWikiChildren,
  loadCredentials,
  loadScopeRecords,
  localDate,
  parseFeishuRef,
  parseFrontmatter,
  pickScope,
  readDocument,
  renderArchive,
  requestJson,
  requestBinary,
  exportDocument,
  assertValidDocx,
  documentArchiveHash,
  sourceSummary,
  stableStringify,
  slugifyTitle,
  validateId,
  writeArchive,
  writeArchiveBundle,
  yamlString,
};
