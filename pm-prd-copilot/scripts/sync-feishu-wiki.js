#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  archiveResolvedDocument,
  assertArchiveIntegrity,
  assertDocumentArchivable,
  assertSafePath,
  contentHash,
  documentArchiveHash,
  getAccessToken,
  getWikiBreadcrumbs,
  getWikiNode,
  listWikiChildren,
  loadCredentials,
  loadScopeRecords,
  parseFeishuRef,
  readDocument,
  validateId,
} = require('./archive-feishu-prd');

const SCHEMA_VERSION = 1;
const MAX_WIKI_NODES = 10000;
const MAX_WIKI_DEPTH = 50;
const NODE_TOKEN = /^[A-Za-z0-9]+$/;

function usage() {
  return [
    'Usage:',
    '  node sync-feishu-wiki.js --product <product-id> [--url <registered-wiki-root>]',
    '    [--root <pm-knowledge>] [--config <config.json>] [--dry-run]',
    '    [--allow-incomplete]',
    '  node sync-feishu-wiki.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  const booleans = new Set(['dry-run', 'self-test', 'allow-incomplete']);
  const values = new Set(['product', 'url', 'root', 'config']);
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

function registeredWikiRef(value) {
  const ref = parseFeishuRef(value);
  if (ref.kind !== 'wiki') throw new Error('Feishu sync roots must be Wiki URLs');
  return {
    ref,
    key: new URL(ref.url).hostname.toLocaleLowerCase() + '\n' + ref.token,
  };
}

function resolveSyncScope(knowledgeRoot, args) {
  const products = loadScopeRecords(knowledgeRoot, 'product');
  const projects = loadScopeRecords(knowledgeRoot, 'project');
  let requested = null;
  if (args.url) requested = registeredWikiRef(args.url);
  if (args.product) validateId(args.product, 'product');

  const candidates = products.flatMap((product) => product.syncRoots.map((url) => ({
    product,
    registered: registeredWikiRef(url),
  }))).filter((item) => (
    (!args.product || item.product.id === args.product)
    && (!requested || item.registered.key === requested.key)
  ));

  if (candidates.length !== 1) {
    if (candidates.length === 0) {
      throw new Error(
        'Wiki root is not registered. Add it to product.md feishu_sync_roots before syncing.',
      );
    }
    throw new Error('Wiki root matches multiple product registrations');
  }
  const selected = candidates[0];
  const scopedProjects = projects.filter(
    (project) => project.productId === selected.product.id,
  );
  const owners = new Map();
  for (const project of scopedProjects) {
    for (const token of project.syncSubtrees) {
      if (!NODE_TOKEN.test(token)) {
        throw new Error('Invalid feishu_sync_subtrees token in ' + project.file);
      }
      if (owners.has(token) && owners.get(token).id !== project.id) {
        throw new Error('Feishu sync subtree is registered to multiple projects: ' + token);
      }
      owners.set(token, project);
    }
  }
  if (owners.size === 0) {
    throw new Error('No project feishu_sync_subtrees are registered for ' + selected.product.id);
  }
  return {
    product: selected.product,
    projects: scopedProjects,
    ref: requested ? requested.ref : selected.registered.ref,
  };
}

async function discoverWikiTree(rootNode, ref, accessToken, runtime = {}) {
  const listChildrenImpl = runtime.listChildrenImpl || listWikiChildren;
  const breadcrumbs = runtime.breadcrumbs || await getWikiBreadcrumbs(
    ref.token,
    rootNode,
    accessToken,
  );
  const origin = new URL(ref.url).origin;
  const queue = [{
    raw: rootNode,
    parentNodeToken: null,
    breadcrumbs,
    depth: 0,
    root: true,
  }];
  const seen = new Set();
  const nodes = [];

  while (queue.length) {
    const current = queue.shift();
    const nodeToken = current.raw.node_token || (current.root ? ref.token : '');
    if (!NODE_TOKEN.test(nodeToken)) throw new Error('Wiki node is missing a valid node_token');
    if (seen.has(nodeToken)) throw new Error('Wiki tree contains a repeated node or cycle: ' + nodeToken);
    seen.add(nodeToken);
    if (seen.size > MAX_WIKI_NODES) {
      throw new Error('Wiki tree exceeds ' + MAX_WIKI_NODES + ' nodes');
    }
    if (current.depth > MAX_WIKI_DEPTH) {
      throw new Error('Wiki tree exceeds depth ' + MAX_WIKI_DEPTH);
    }

    const node = {
      nodeToken,
      objToken: String(current.raw.obj_token || ''),
      objType: String(current.raw.obj_type || ''),
      title: String(current.raw.title || ''),
      hasChild: Boolean(current.raw.has_child),
      parentNodeToken: current.parentNodeToken,
      breadcrumbs: current.breadcrumbs,
      depth: current.depth,
      root: current.root,
      syncRootToken: ref.token,
      url: origin + '/wiki/' + nodeToken,
    };
    nodes.push(node);

    if (!current.root && !node.hasChild) continue;
    if (current.depth >= MAX_WIKI_DEPTH) {
      throw new Error('Wiki tree exceeds depth ' + MAX_WIKI_DEPTH);
    }
    const children = await listChildrenImpl(rootNode.space_id, nodeToken, accessToken);
    for (const child of children) {
      if (child.parent_node_token && child.parent_node_token !== nodeToken) {
        throw new Error('Wiki child parent mismatch: ' + child.node_token);
      }
      queue.push({
        raw: child,
        parentNodeToken: nodeToken,
        breadcrumbs: current.breadcrumbs.concat([{
          title: String(child.title || ''),
          token: String(child.node_token || ''),
        }]),
        depth: current.depth + 1,
        root: false,
      });
    }
  }
  return nodes;
}

function mapProject(node, projects) {
  const pathTokens = node.breadcrumbs.map((item) => item.token);
  const rootIndex = pathTokens.lastIndexOf(node.syncRootToken);
  if (rootIndex < 0) throw new Error('Wiki path does not contain the registered sync root');
  const scopedTokens = pathTokens.slice(rootIndex);
  const matches = [];
  for (const project of projects) {
    for (const token of project.syncSubtrees) {
      const depth = scopedTokens.lastIndexOf(token);
      if (depth >= 0) matches.push({ project, token, depth });
    }
  }
  matches.sort((left, right) => right.depth - left.depth
    || left.project.id.localeCompare(right.project.id));
  if (matches[1] && matches[1].depth === matches[0].depth
    && matches[1].project.id !== matches[0].project.id) {
    throw new Error('Wiki node maps to multiple projects: ' + node.nodeToken);
  }
  return matches[0] || null;
}

function sourceForNode(node, spaceId) {
  return {
    sourceType: 'feishu-wiki',
    documentType: node.objType,
    documentToken: node.objToken,
    wikiToken: node.nodeToken,
    spaceId,
    breadcrumbs: node.breadcrumbs,
  };
}

function relativeArchivePath(knowledgeRoot, file) {
  const absolute = assertSafePath(knowledgeRoot, file);
  const relative = path.relative(path.resolve(knowledgeRoot), absolute);
  return relative.split(path.sep).join('/');
}

function archiveFileHash(file) {
  return contentHash(fs.readFileSync(file, 'utf8'));
}

function verifyPreviousArchive(knowledgeRoot, pointer, expected) {
  if (!pointer || !pointer.path || !pointer.file_sha256 || pointer.legacy_baseline) return null;
  let file;
  try {
    file = assertSafePath(knowledgeRoot, path.resolve(knowledgeRoot, pointer.path));
  } catch {
    return null;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()
    || fs.lstatSync(file).isSymbolicLink()) return null;
  if (archiveFileHash(file) !== pointer.file_sha256) return null;
  try {
    assertArchiveIntegrity(file, expected);
  } catch {
    return null;
  }
  return file;
}

function cleanError(error) {
  return String(error && error.message ? error.message : error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function topologyRecord(node, mapping, previous, now, runId) {
  const titles = node.breadcrumbs.map((item) => item.title);
  const tokens = node.breadcrumbs.map((item) => item.token);
  const priorTitles = previous && previous.path_titles;
  const priorParent = previous && previous.parent_node_token;
  const moved = previous && (
    priorParent !== node.parentNodeToken
    || JSON.stringify(priorTitles || []) !== JSON.stringify(titles)
  );
  return {
    node_token: node.nodeToken,
    obj_type: node.objType,
    obj_token: node.objToken,
    title: node.title,
    parent_node_token: node.parentNodeToken,
    path_tokens: tokens,
    path_titles: titles,
    source_url: node.url,
    product_id: mapping ? mapping.project.productId : null,
    project_id: mapping ? mapping.project.id : null,
    subtree_token: mapping ? mapping.token : null,
    lifecycle: previous && ['suspected_removed', 'removed_from_scope'].includes(previous.lifecycle)
      ? 'restored'
      : 'active',
    first_seen_at: previous ? previous.first_seen_at : now,
    last_seen_at: now,
    last_seen_run_id: runId,
    missing_complete_runs: 0,
    last_move: moved ? {
      from_parent_node_token: priorParent,
      from_path_titles: priorTitles,
      to_parent_node_token: node.parentNodeToken,
      to_path_titles: titles,
      moved_at: now,
    } : (previous ? previous.last_move || null : null),
    last_observation: previous ? previous.last_observation || null : null,
    latest_archive: previous ? previous.latest_archive || null : null,
    last_error: null,
  };
}

function reusePointer(knowledgeRoot, file, projectId, hashes) {
  return {
    path: relativeArchivePath(knowledgeRoot, file),
    project_id: projectId,
    archive_hash: hashes.archive,
    content_hash: hashes.content,
    file_sha256: archiveFileHash(file),
  };
}

async function processNodes(context, runtime = {}) {
  const readDocumentImpl = runtime.readDocumentImpl || readDocument;
  const archiveImpl = runtime.archiveImpl || archiveResolvedDocument;
  const documentCache = new Map();
  const previousNodes = (context.previous && context.previous.nodes) || {};
  const currentNodes = {};
  const items = [];
  const counts = {
    discovered: context.nodes.length,
    archived: 0,
    unchanged: 0,
    blocked: 0,
    structural: 0,
    unsupported: 0,
    unmapped: 0,
    removed: 0,
  };

  for (const node of context.nodes) {
    const previous = previousNodes[node.nodeToken] || null;
    const mapping = mapProject(node, context.projects);
    const record = topologyRecord(node, mapping, previous, context.now, context.runId);
    currentNodes[node.nodeToken] = record;

    const structuralCandidate = node.root
      || (mapping && node.nodeToken === mapping.token && node.hasChild);
    if (!mapping && !structuralCandidate) {
      record.sync_status = 'unmapped';
      counts.unmapped += 1;
      items.push({ status: 'unmapped', title: node.title, source_url: node.url });
      continue;
    }
    if (node.objType !== 'docx' || !node.objToken) {
      if (structuralCandidate) {
        record.sync_status = 'structural';
        counts.structural += 1;
      } else {
        record.sync_status = 'unsupported';
        counts.unsupported += 1;
        items.push({
          status: 'unsupported',
          title: node.title,
          obj_type: node.objType,
          source_url: node.url,
        });
      }
      continue;
    }

    const source = sourceForNode(node, context.spaceId);
    try {
      if (!documentCache.has(node.objToken)) {
        documentCache.set(node.objToken, readDocumentImpl(source, context.accessToken, {
          allowIncomplete: context.allowIncomplete,
        }));
      }
      const document = await documentCache.get(node.objToken);
      assertDocumentArchivable(document, context.allowIncomplete);
      const hashes = {
        content: contentHash(document.content),
        signature: document.contentSignature,
      };
      hashes.archive = documentArchiveHash(document);
      record.last_observation = {
        revision: document.revision,
        content_hash: hashes.content,
        content_signature: hashes.signature,
        archive_hash: hashes.archive,
        content_fidelity: document.contentFidelity,
        missing_content: document.missingContent,
        checked_at: context.now,
      };
      if (structuralCandidate
        && !String(document.content || '').trim()
        && document.missingContent.length === 0) {
        record.sync_status = 'structural';
        counts.structural += 1;
        continue;
      }
      if (!mapping) {
        record.sync_status = 'unmapped';
        counts.unmapped += 1;
        items.push({
          status: 'unmapped',
          title: node.title,
          source_url: node.url,
          reason: 'sync root contains document content but has no project mapping',
        });
        continue;
      }

      const sameContent = previous
        && previous.project_id === mapping.project.id
        && previous.obj_token === node.objToken
        && previous.last_observation
        && previous.last_observation.archive_hash === hashes.archive;
      const reusable = sameContent ? verifyPreviousArchive(
        context.knowledgeRoot,
        previous.latest_archive,
        {
          sourceToken: node.objToken,
          productId: mapping.project.productId,
          projectId: mapping.project.id,
          archiveHash: hashes.archive,
          contentHash: hashes.content,
          contentSignature: hashes.signature,
          contentFidelity: document.contentFidelity,
          missingContent: document.missingContent,
          richFeatures: document.richFeatures,
          revision: document.revision,
          content: document.content,
          richExport: document.richExport,
        },
      ) : null;
      if (reusable) {
        record.sync_status = 'unchanged';
        record.latest_archive = reusePointer(
          context.knowledgeRoot,
          reusable,
          mapping.project.id,
          hashes,
        );
        counts.unchanged += 1;
        continue;
      }

      const result = archiveImpl({
        ref: parseFeishuRef(node.url),
        source,
        document,
        knowledgeRoot: context.knowledgeRoot,
        product: mapping.project.productId,
        project: mapping.project.id,
        allowIncomplete: context.allowIncomplete,
        dryRun: context.dryRun,
      });
      if (result.status === 'classification_required') {
        throw new Error('Registered subtree failed product/project validation');
      }
      record.sync_status = result.status;
      if (!context.dryRun && result.path) {
        record.latest_archive = reusePointer(
          context.knowledgeRoot,
          result.path,
          mapping.project.id,
          hashes,
        );
      }
      if (result.status === 'archived' || result.status === 'ready') counts.archived += 1;
      else counts.unchanged += 1;
      items.push({
        status: result.status,
        title: node.title,
        path: result.path ? relativeArchivePath(context.knowledgeRoot, result.path) : null,
      });
    } catch (error) {
      record.sync_status = 'blocked';
      record.last_error = {
        message: cleanError(error),
        at: context.now,
        run_id: context.runId,
      };
      counts.blocked += 1;
      items.push({
        status: 'blocked',
        title: node.title,
        source_url: node.url,
        error: record.last_error.message,
      });
    }
  }

  for (const [token, previous] of Object.entries(previousNodes)) {
    if (currentNodes[token]) continue;
    const misses = Number(previous.missing_complete_runs || 0) + 1;
    currentNodes[token] = Object.assign({}, previous, {
      lifecycle: misses >= 2 ? 'removed_from_scope' : 'suspected_removed',
      missing_complete_runs: misses,
      missing_since: previous.missing_since || context.now,
    });
    counts.removed += 1;
  }
  return { counts, items, nodes: currentNodes };
}

function runId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
    + '-' + Math.random().toString(16).slice(2, 10);
}

function stateLocation(knowledgeRoot, ref, spaceId, productId) {
  const host = new URL(ref.url).hostname.toLocaleLowerCase();
  const syncId = contentHash([host, spaceId, ref.token, productId].join('\n')).slice(0, 20);
  const directory = path.join(knowledgeRoot, '.sync', 'feishu', syncId);
  return {
    syncId,
    directory,
    lock: path.join(directory, 'sync.lock'),
    manifests: path.join(directory, 'manifests'),
  };
}

function acquireLock(knowledgeRoot, state, id) {
  assertSafePath(knowledgeRoot, state.lock);
  fs.mkdirSync(state.directory, { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(state.lock, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      run_id: id,
      started_at: new Date().toISOString(),
    }) + '\n', 'utf8');
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error.code === 'EEXIST') {
      throw new Error('Another sync is running, or a stale lock needs manual review: ' + state.lock);
    }
    throw error;
  }
  fs.closeSync(descriptor);
}

function releaseLock(state) {
  if (fs.existsSync(state.lock)) fs.rmSync(state.lock);
}

function manifestFiles(state) {
  if (!fs.existsSync(state.manifests)) return [];
  return fs.readdirSync(state.manifests)
    .filter((name) => /^\d{6}-.+\.json$/.test(name))
    .sort();
}

function validateManifest(manifest, expected) {
  if (!manifest || manifest.schema_version !== SCHEMA_VERSION
    || !manifest.root || !manifest.scope
    || !manifest.nodes || typeof manifest.nodes !== 'object') {
    throw new Error('Invalid Feishu sync manifest');
  }
  if (manifest.sync_id !== expected.syncId
    || manifest.root.host !== expected.host
    || manifest.root.space_id !== expected.spaceId
    || manifest.root.node_token !== expected.nodeToken
    || manifest.scope.product_id !== expected.productId) {
    throw new Error('Feishu sync manifest scope mismatch');
  }
}

function loadLatestManifest(state, expected) {
  const files = manifestFiles(state);
  if (!files.length) return null;
  const file = path.join(state.manifests, files.at(-1));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Latest Feishu sync manifest is unreadable: ' + file);
  }
  validateManifest(manifest, expected);
  return manifest;
}

function writeManifest(knowledgeRoot, state, manifest) {
  assertSafePath(knowledgeRoot, path.join(state.manifests, 'manifest.json'));
  fs.mkdirSync(state.manifests, { recursive: true });
  const files = manifestFiles(state);
  const latest = files.length ? Number(files.at(-1).slice(0, 6)) : 0;
  const generation = latest + 1;
  manifest.generation = generation;
  const prefix = String(generation).padStart(6, '0') + '-' + manifest.last_run.run_id;
  const finalFile = path.join(state.manifests, prefix + '.json');
  const temporary = path.join(state.manifests, prefix + '.tmp');
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, finalFile);
  return finalFile;
}

function classificationHash(projects) {
  const mappings = projects.flatMap((project) => project.syncSubtrees.map((token) => ({
    product_id: project.productId,
    project_id: project.id,
    token,
  }))).sort((left, right) => left.token.localeCompare(right.token)
    || left.project_id.localeCompare(right.project_id));
  return contentHash(JSON.stringify(mappings));
}

async function syncWiki(args, runtime = {}) {
  const knowledgeRoot = path.resolve(args.root || path.join(process.cwd(), 'pm-knowledge'));
  const scope = resolveSyncScope(knowledgeRoot, args);
  const credentials = runtime.credentials || loadCredentials(args.config);
  const accessToken = runtime.accessToken || await getAccessToken(credentials);
  const rootNode = runtime.rootNode || await getWikiNode(scope.ref.token, accessToken);
  if (!rootNode.space_id) throw new Error('Wiki root did not return space_id');
  const state = stateLocation(
    knowledgeRoot,
    scope.ref,
    String(rootNode.space_id),
    scope.product.id,
  );
  const id = runId();
  const expected = {
    syncId: state.syncId,
    host: new URL(scope.ref.url).hostname.toLocaleLowerCase(),
    spaceId: String(rootNode.space_id),
    nodeToken: scope.ref.token,
    productId: scope.product.id,
  };
  assertSafePath(knowledgeRoot, path.join(state.manifests, 'manifest.json'));
  const locked = !args['dry-run'];
  if (locked) acquireLock(knowledgeRoot, state, id);
  try {
    const previous = loadLatestManifest(state, expected);
    const nodes = await discoverWikiTree(rootNode, scope.ref, accessToken, runtime);
    const startedAt = new Date().toISOString();
    const processed = await processNodes({
      accessToken,
      allowIncomplete: Boolean(args['allow-incomplete']),
      dryRun: Boolean(args['dry-run']),
      knowledgeRoot,
      nodes,
      now: startedAt,
      previous,
      projects: scope.projects,
      runId: id,
      spaceId: String(rootNode.space_id),
    }, runtime);
    const partial = processed.counts.blocked > 0
      || processed.counts.unmapped > 0;
    const finishedAt = new Date().toISOString();
    const manifest = {
      schema_version: SCHEMA_VERSION,
      generated_by: 'pm-prd-copilot/sync-feishu-wiki',
      sync_id: state.syncId,
      root: {
        host: expected.host,
        space_id: expected.spaceId,
        node_token: expected.nodeToken,
        url: scope.ref.url,
        title: String(rootNode.title || ''),
      },
      scope: { product_id: scope.product.id },
      classification_hash: classificationHash(scope.projects),
      policy: { allow_incomplete: Boolean(args['allow-incomplete']) },
      created_at: previous ? previous.created_at : startedAt,
      updated_at: finishedAt,
      last_run: {
        run_id: id,
        started_at: startedAt,
        finished_at: finishedAt,
        status: partial ? 'partial' : 'complete',
        tree_complete: true,
        counts: processed.counts,
      },
      nodes: processed.nodes,
    };
    const manifestFile = args['dry-run']
      ? null
      : writeManifest(knowledgeRoot, state, manifest);
    return {
      status: partial ? 'partial' : (args['dry-run'] ? 'ready' : 'complete'),
      root: manifest.root,
      manifest: manifestFile ? relativeArchivePath(knowledgeRoot, manifestFile) : null,
      counts: processed.counts,
      items: processed.items,
    };
  } finally {
    if (locked) releaseLock(state);
  }
}

async function runSelfTest() {
  assert.deepStrictEqual(parseArgs([
    '--product', 'medical', '--dry-run', '--allow-incomplete',
  ]), {
    product: 'medical',
    'dry-run': true,
    'allow-incomplete': true,
  });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-wiki-sync-'));
  try {
    const productRoot = path.join(temporaryRoot, 'products', 'medical');
    const projectRoot = path.join(temporaryRoot, 'projects', 'ct');
    fs.mkdirSync(productRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(productRoot, 'product.md'), [
      '---',
      'product_id: "medical"',
      'feishu_sync_roots: ["https://example.feishu.cn/wiki/root"]',
      '---',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'project.md'), [
      '---',
      'project_id: "ct"',
      'product_id: "medical"',
      'feishu_sync_subtrees: ["ctroot"]',
      '---',
      '',
    ].join('\n'), 'utf8');
    const scope = resolveSyncScope(temporaryRoot, { product: 'medical' });
    assert.strictEqual(scope.ref.token, 'root');
    const rootNode = {
      node_token: 'root',
      obj_type: 'docx',
      obj_token: 'rootdoc',
      title: 'PRD',
      has_child: true,
      space_id: 'space',
    };
    const children = {
      root: [{
        node_token: 'ctroot',
        obj_type: 'docx',
        obj_token: 'ctindex',
        title: 'CT',
        has_child: true,
      }, {
        node_token: 'other',
        obj_type: 'docx',
        obj_token: 'otherdoc',
        title: 'Other',
        has_child: false,
      }],
      ctroot: [{
        node_token: 'prd',
        obj_type: 'docx',
        obj_token: 'prddoc',
        title: 'PRD V1',
        has_child: false,
      }],
    };
    const discovered = await discoverWikiTree(
      rootNode,
      scope.ref,
      'token',
      {
        breadcrumbs: [{ title: 'PRD', token: 'root' }],
        listChildrenImpl: async (_space, token) => children[token] || [],
      },
    );
    assert.strictEqual(discovered.length, 4);
    assert.strictEqual(mapProject(discovered.find((node) => node.nodeToken === 'prd'), scope.projects).project.id, 'ct');
    assert.strictEqual(mapProject(discovered.find((node) => node.nodeToken === 'other'), scope.projects), null);
    const prdRoot = path.join(projectRoot, 'prds');
    fs.mkdirSync(prdRoot, { recursive: true });
    const legacyFile = path.join(prdRoot, 'legacy.md');
    fs.writeFileSync(legacyFile, [
      '---',
      'project_id: "ct"',
      'source_token: "prddoc"',
      'source_revision: 1',
      'content_hash: ' + JSON.stringify(contentHash('Body')),
      '---',
      '',
      'Body',
      '',
    ].join('\n'), 'utf8');
    const readDocuments = (options = {}) => async (source) => ({
      title: source.documentToken === 'ctindex' ? 'CT' : 'PRD V1',
      revision: 1,
      content: source.documentToken === 'rootdoc'
        ? ''
        : (source.documentToken === 'ctindex' ? (options.indexContent || '') : 'Body'),
      contentFidelity: options.rich && source.documentToken === 'prddoc'
        ? 'plain-text-incomplete'
        : 'plain-text',
      missingContent: options.rich && source.documentToken === 'prddoc' ? ['image:1'] : [],
      contentSignature: options.signature || 'signature-1',
    });
    const baseline = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: false,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-01T00:00:00.000Z',
      previous: null,
      projects: scope.projects,
      runId: 'baseline',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments(),
    });
    assert.strictEqual(baseline.nodes.root.sync_status, 'structural');
    assert.strictEqual(baseline.nodes.ctroot.sync_status, 'structural');
    assert.strictEqual(baseline.nodes.prd.sync_status, 'archived');
    assert.notStrictEqual(
      path.resolve(temporaryRoot, baseline.nodes.prd.latest_archive.path),
      legacyFile,
    );
    const unchanged = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: false,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-02T00:00:00.000Z',
      previous: { nodes: baseline.nodes },
      projects: scope.projects,
      runId: 'unchanged',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments(),
    });
    assert.strictEqual(unchanged.nodes.prd.sync_status, 'unchanged');
    const currentArchive = path.resolve(
      temporaryRoot,
      baseline.nodes.prd.latest_archive.path,
    );
    const missingChecksum = JSON.parse(JSON.stringify(baseline.nodes));
    delete missingChecksum.prd.latest_archive.file_sha256;
    fs.writeFileSync(
      currentArchive,
      fs.readFileSync(currentArchive, 'utf8').replace('Body\n', 'CORRUPT\n'),
      'utf8',
    );
    const corrupted = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: false,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-02T01:00:00.000Z',
      previous: { nodes: missingChecksum },
      projects: scope.projects,
      runId: 'corrupted',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments(),
    });
    assert.strictEqual(corrupted.nodes.prd.sync_status, 'blocked');
    const changedSignature = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: false,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-02T02:00:00.000Z',
      previous: { nodes: baseline.nodes },
      projects: scope.projects,
      runId: 'changed-signature',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments({ signature: 'signature-2' }),
    });
    assert.strictEqual(changedSignature.nodes.prd.sync_status, 'archived');
    const richBaseline = await processNodes({
      accessToken: 'token',
      allowIncomplete: true,
      dryRun: false,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-02T03:00:00.000Z',
      previous: { nodes: changedSignature.nodes },
      projects: scope.projects,
      runId: 'rich-allowed',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments({ rich: true, signature: 'signature-rich' }),
    });
    assert.strictEqual(richBaseline.nodes.prd.sync_status, 'archived');
    const richStrict = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: false,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-02T04:00:00.000Z',
      previous: { nodes: richBaseline.nodes },
      projects: scope.projects,
      runId: 'rich-strict',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments({ rich: true, signature: 'signature-rich' }),
    });
    assert.strictEqual(richStrict.nodes.prd.sync_status, 'blocked');
    const contentfulIndex = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: true,
      knowledgeRoot: temporaryRoot,
      nodes: discovered,
      now: '2026-01-02T05:00:00.000Z',
      previous: null,
      projects: scope.projects,
      runId: 'contentful-index',
      spaceId: 'space',
    }, {
      readDocumentImpl: readDocuments({ indexContent: 'Index body' }),
    });
    assert.notStrictEqual(contentfulIndex.nodes.ctroot.sync_status, 'structural');
    assert.strictEqual(mapProject({
      nodeToken: 'inside',
      syncRootToken: 'root',
      breadcrumbs: [
        { token: 'outsideparent' },
        { token: 'root' },
        { token: 'inside' },
      ],
    }, [{
      id: 'outside',
      productId: 'medical',
      syncSubtrees: ['outsideparent'],
    }]), null);
    const firstMissing = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: true,
      knowledgeRoot: temporaryRoot,
      nodes: [],
      now: '2026-01-03T00:00:00.000Z',
      previous: { nodes: { gone: baseline.nodes.prd } },
      projects: scope.projects,
      runId: 'missing-1',
      spaceId: 'space',
    });
    assert.strictEqual(firstMissing.nodes.gone.lifecycle, 'suspected_removed');
    const secondMissing = await processNodes({
      accessToken: 'token',
      allowIncomplete: false,
      dryRun: true,
      knowledgeRoot: temporaryRoot,
      nodes: [],
      now: '2026-01-04T00:00:00.000Z',
      previous: { nodes: firstMissing.nodes },
      projects: scope.projects,
      runId: 'missing-2',
      spaceId: 'space',
    });
    assert.strictEqual(secondMissing.nodes.gone.lifecycle, 'removed_from_scope');

    const state = stateLocation(temporaryRoot, scope.ref, 'space', 'medical');
    const id = 'test-run';
    acquireLock(temporaryRoot, state, id);
    assert.throws(() => acquireLock(temporaryRoot, state, 'second'), /Another sync/);
    releaseLock(state);
    const manifest = {
      schema_version: SCHEMA_VERSION,
      generated_by: 'test',
      sync_id: state.syncId,
      root: {
        host: 'example.feishu.cn',
        space_id: 'space',
        node_token: 'root',
        url: scope.ref.url,
        title: 'PRD',
      },
      scope: { product_id: 'medical' },
      created_at: '2026-01-01T00:00:00.000Z',
      nodes: {},
      last_run: { run_id: id },
    };
    const file = writeManifest(temporaryRoot, state, manifest);
    assert.strictEqual(fs.existsSync(file), true);
    assert.strictEqual(loadLatestManifest(state, {
      syncId: state.syncId,
      host: 'example.feishu.cn',
      spaceId: 'space',
      nodeToken: 'root',
      productId: 'medical',
    }).generation, 1);
    assert.throws(
      () => resolveSyncScope(temporaryRoot, {
        product: 'medical',
        url: 'https://example.feishu.cn/wiki/unregistered',
      }),
      /not registered/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log('self-test passed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    await runSelfTest();
    return;
  }
  if (!args.product && !args.url) throw new Error(usage());
  const result = await syncWiki(args);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'partial') process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(cleanError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  discoverWikiTree,
  loadLatestManifest,
  mapProject,
  parseArgs,
  processNodes,
  resolveSyncScope,
  stateLocation,
  syncWiki,
  writeManifest,
};
