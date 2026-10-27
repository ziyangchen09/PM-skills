#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const STARTER_DIR = path.join(SKILL_DIR, 'assets', 'vue-starter');
const MANIFEST_TEMPLATE = path.join(SKILL_DIR, 'assets', 'prototype-manifest-template.md');
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIREMENT_ID = /^REQ-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_ID = /^v\d{3}$/;
const DESIGN_MODES = new Set(['preserve', 'refine', 'explore']);
const EXCLUDED = new Set(['node_modules', 'dist', '.git']);

function usage() {
  return [
    'Usage:',
    '  node init-vue-prototype.js --root <pm-knowledge> --project <project-id>',
    '    --requirement <REQ-YYYYMMDD-feature-slug> [--version vNNN]',
    '    [--design-mode preserve|refine|explore]',
    '  node init-vue-prototype.js --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  const known = new Set(['root', 'project', 'requirement', 'version', 'design-mode', 'self-test']);
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

function rejectSymlinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed: ' + cursor);
    }
  }
}

function validateId(value, pattern, label) {
  if (!pattern.test(value || '')) throw new Error('Invalid ' + label + ': ' + value);
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
}

function ensureChildDirectory(parent, name) {
  rejectSymlinks(parent);
  const realParent = fs.realpathSync.native(parent);
  const target = path.join(parent, name);
  if (!fs.existsSync(target)) {
    try {
      fs.mkdirSync(target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed: ' + target);
  if (!stat.isDirectory()) throw new Error('Expected directory: ' + target);
  rejectSymlinks(target);
  if (!isInside(realParent, fs.realpathSync.native(target))) {
    throw new Error('Directory resolves outside its parent: ' + target);
  }
  return target;
}

function listVersions(directory) {
  rejectSymlinks(directory);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!VERSION_ID.test(entry.name)) return false;
      const candidate = path.join(directory, entry.name);
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error('Symbolic version directory is not allowed: ' + candidate);
      }
      return entry.isDirectory();
    })
    .map((entry) => entry.name)
    .sort();
}

function nextVersion(versions) {
  if (!versions.length) return 'v001';
  const next = Number(versions.at(-1).slice(1)) + 1;
  if (next > 999) throw new Error('Prototype version limit reached');
  return 'v' + String(next).padStart(3, '0');
}

function copySource(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (sourcePath) => {
      if (fs.lstatSync(sourcePath).isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed in prototype source: ' + sourcePath);
      }
      const relative = path.relative(source, sourcePath);
      const first = relative.split(path.sep)[0];
      return relative !== 'prototype.md' && !EXCLUDED.has(first);
    },
  });
}

function renderManifest(values) {
  let template = fs.readFileSync(MANIFEST_TEMPLATE, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    template = template.replaceAll('{{' + key + '}}', value);
  }
  return template;
}

function initializePrototype(options) {
  const designMode = options['design-mode'] || 'preserve';
  if (!DESIGN_MODES.has(designMode)) throw new Error('Invalid design mode: ' + designMode);
  const project = validateId(options.project, PROJECT_ID, 'project ID');
  const requirement = validateId(options.requirement, REQUIREMENT_ID, 'requirement ID');
  const root = path.resolve(options.root || '');
  if (!options.root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('--root must be an existing directory');
  }
  rejectSymlinks(root);

  const projectDirectory = path.join(root, 'projects', project);
  if (!fs.existsSync(path.join(projectDirectory, 'project.md'))) {
    throw new Error('Project archive not found: ' + projectDirectory);
  }
  rejectSymlinks(projectDirectory);

  const prototypesDirectory = ensureChildDirectory(projectDirectory, 'prototypes');
  const requirementDirectory = ensureChildDirectory(prototypesDirectory, requirement);
  const versions = listVersions(requirementDirectory);
  const expected = nextVersion(versions);
  const version = options.version || expected;
  validateId(version, VERSION_ID, 'version');
  if (version !== expected) throw new Error('Next version must be ' + expected);

  const previous = versions.length ? versions.at(-1) : null;
  const source = previous ? path.join(requirementDirectory, previous) : STARTER_DIR;
  const target = path.join(requirementDirectory, version);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error('Prototype source not found: ' + source);
  }
  rejectSymlinks(source);
  if (fs.existsSync(target)) throw new Error('Target version already exists: ' + target);

  const stage = path.join(
    requirementDirectory,
    `.prototype-stage-${version}-${process.pid}-${randomUUID()}`,
  );
  try {
    copySource(source, stage);
    const manifest = renderManifest({
      PROJECT_ID: project,
      REQUIREMENT_ID: requirement,
      VERSION: version,
      BASED_ON: previous || 'none',
      CREATED_AT: new Date().toISOString(),
      DESIGN_MODE: designMode,
    });
    fs.writeFileSync(path.join(stage, 'prototype.md'), manifest, { encoding: 'utf8', flag: 'wx' });
    rejectSymlinks(requirementDirectory);
    fs.renameSync(stage, target);
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    if (fs.existsSync(target)) throw new Error('Target version already exists: ' + target);
    throw error;
  }
  return target;
}

function runSelfTest() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-prototype-'));
  try {
    const root = path.join(temporary, 'pm-knowledge');
    const project = path.join(root, 'projects', 'ct-system');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'project.md'), '# CT system\n', 'utf8');

    const first = initializePrototype({
      root,
      project: 'ct-system',
      requirement: 'REQ-20260722-nodule-validation',
    });
    assert(first.endsWith(path.join('REQ-20260722-nodule-validation', 'v001')));
    assert(fs.existsSync(path.join(first, 'src', 'App.vue')));
    assert(fs.existsSync(path.join(first, 'prototype.md')));
    assert(fs.readFileSync(path.join(first, 'prototype.md'), 'utf8').includes('design_mode: preserve'));

    fs.appendFileSync(path.join(first, 'src', 'App.vue'), '\n<!-- retained -->\n', 'utf8');
    fs.mkdirSync(path.join(first, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(first, 'node_modules', 'skip.txt'), 'skip', 'utf8');
    const second = initializePrototype({
      root,
      project: 'ct-system',
      requirement: 'REQ-20260722-nodule-validation',
      'design-mode': 'refine',
    });
    assert(second.endsWith(path.join('REQ-20260722-nodule-validation', 'v002')));
    assert(fs.readFileSync(path.join(second, 'src', 'App.vue'), 'utf8').includes('retained'));
    assert(!fs.existsSync(path.join(second, 'node_modules')));
    assert(fs.readFileSync(path.join(second, 'prototype.md'), 'utf8').includes('based_on: v001'));
    assert(fs.readFileSync(path.join(second, 'prototype.md'), 'utf8').includes('design_mode: refine'));

    const third = initializePrototype({ root, project: 'ct-system',
      requirement: 'REQ-20260722-nodule-validation', 'design-mode': 'explore' });
    assert(fs.readFileSync(path.join(third, 'prototype.md'), 'utf8').includes('design_mode: explore'));
    assert.throws(() => initializePrototype({ root, project: 'ct-system',
      requirement: 'REQ-20260722-nodule-validation', 'design-mode': 'unknown' }), /Invalid design mode/);
    assert(!fs.existsSync(path.join(path.dirname(third), 'v004')));

    assert.throws(() => initializePrototype({
      root,
      project: '../outside',
      requirement: 'REQ-20260722-nodule-validation',
    }), /Invalid project ID/);
    assert.throws(() => initializePrototype({
      root,
      project: 'ct-system',
      requirement: 'REQ-20260722-nodule-validation',
      version: 'v005',
    }), /Next version must be v004/);

    const unsafeProject = path.join(root, 'projects', 'unsafe-system');
    const outside = path.join(temporary, 'outside-prototypes');
    fs.mkdirSync(unsafeProject, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(unsafeProject, 'project.md'), '# Unsafe fixture\n', 'utf8');
    const linkedPrototypes = path.join(unsafeProject, 'prototypes');
    try {
      fs.symlinkSync(outside, linkedPrototypes, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => initializePrototype({
        root,
        project: 'unsafe-system',
        requirement: 'REQ-20260722-link-escape',
      }), /Symbolic links/);
      fs.unlinkSync(linkedPrototypes);
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
  if (!args.root || !args.project || !args.requirement) throw new Error(usage());
  const target = initializePrototype(args);
  console.log('Prototype initialized: ' + target);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
