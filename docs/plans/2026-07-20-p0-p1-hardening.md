# PM Skills P0/P1 Hardening Implementation Plan

> **For Codex:** Implement task-by-task, preserve the dirty worktree, and do not commit unless the user asks.

**Goal:** Make the existing PM Skills chain trustworthy, safely versioned, observable, and usable from evidence collection through validated PRD generation.

**Architecture:** Keep the existing stage files as the workflow state. Strengthen the existing readiness validator, add one generated-PRD validator and one requirement-status/index script, and add a single-purpose evidence research Skill. Use Node/Python standard libraries only.

**Tech Stack:** Markdown/YAML frontmatter, Node.js CommonJS, Python standard library, PowerShell installer.

---

### Task 1: Define confirmed and stale state rules

**Files:**
- Modify: `PM-skills-pre-PRD-pack-v2/pm-prd-readiness-gate/references/handoff-contract.md`
- Modify: four existing pre-PRD `SKILL.md` files and templates
- Modify: `PM-skills-pre-PRD-pack-v2/README.md`

**Steps:**
1. Define who may transition `draft → confirmed`, required confirmation metadata, and when an artifact becomes `superseded`.
2. Require upstream artifacts to be confirmed before READY/CONDITIONAL.
3. Declare readiness/handoff stale when an upstream `updated_at` is newer.
4. Document safe replacement: archive a confirmed prior artifact before rewriting it.

### Task 2: Close semantic READY false positives

**Files:**
- Modify: `PM-skills-pre-PRD-pack-v2/pm-prd-readiness-gate/scripts/validate_handoff.py`
- Modify: readiness and handoff templates/references

**Steps:**
1. Add failing self-tests for empty problem, empty solution, empty handoff, missing source files, missing confirmation evidence, and stale handoff.
2. Validate required headings, critical fields, tables, and local source paths.
3. Validate confirmed decisions against confirmer, timestamp, and direct source.
4. Keep existing P0/P1 and path-containment checks.
5. Run `--self-test` and the Skill validator.

### Task 3: Validate generated PRDs

**Files:**
- Create: `pm-prd-copilot/scripts/validate-prd.js`
- Modify: `pm-prd-copilot/SKILL.md`
- Modify: `pm-prd-copilot/references/input-to-prd-workflow.md`
- Modify: `pm-prd-copilot/assets/prd-template.md`

**Steps:**
1. Add a self-test with READY, CONDITIONAL, missing metadata, missing stories, and dropped P1 cases.
2. Validate PRD identity, readiness, sources, required sections, user stories, acceptance scenarios, and open P0 items.
3. For CONDITIONAL, compare P1 values with `handoff.md`.
4. Require the validator before treating a generated file as a formal PRD.

### Task 4: Prevent report and artifact data loss

**Files:**
- Modify: `pm-prd-copilot/scripts/analyze-prd-change.js`
- Modify: `pm-prd-copilot/references/change-impact-rules.md`
- Modify: stage update instructions

**Steps:**
1. Add a failing test for an existing `--output` file.
2. Write impact reports with create-only semantics.
3. Define timestamped output naming and prior-artifact history rules.

### Task 5: Make Feishu/local archiving honest and resilient

**Files:**
- Modify: `pm-prd-copilot/scripts/archive-feishu-prd.js`
- Create: `pm-prd-copilot/scripts/archive-local-prd.js`
- Modify: archive documentation and README

**Steps:**
1. Add timeout and bounded retry for Feishu API requests.
2. Inspect document blocks and refuse silent text-only archival when rich blocks exist unless explicitly allowed.
3. Record content fidelity in archive frontmatter.
4. Add deterministic Markdown/text local archival with hash dedupe and create-only writes.
5. Document credentials, permissions, supported formats, and downgrade behavior.

### Task 6: Add the evidence research loop

**Files:**
- Create: `PM-skills-pre-PRD-pack-v2/pm-evidence-research/`
- Modify: intake/problem/readiness routing and contract
- Modify: installer and README

**Steps:**
1. Initialize the Skill with `skill-creator` tooling.
2. Define research planning, evidence synthesis, data validation, counterexamples, and next-route rules.
3. Add `evidence.md` template and contract fields.
4. Keep evidence optional; require it only when intake routes through research.
5. Validate and forward-test the new Skill.

### Task 7: Add workflow status, project index, and review closure

**Files:**
- Create: `pm-prd-copilot/scripts/requirement-status.js`
- Modify: `pm-prd-copilot/assets/prd-template.md`
- Modify: Copilot instructions and README

**Steps:**
1. Report current stage, stale/missing files, blockers, and next Skill for one requirement.
2. Generate a project requirements table from existing frontmatter without a database.
3. Add review status, final answer, decision source, confirmer, and sign-off fields to the PRD template.
4. Add self-tests for direct, research, conditional, stale, and complete routes.

### Task 8: Provide one-command install and verification

**Files:**
- Modify: `PM-skills-pre-PRD-pack-v2/install.ps1`
- Create: root `install.ps1`
- Modify: root `README.md`

**Steps:**
1. Install five pre-PRD Skills plus `pm-prd-copilot` with staging, backup, rollback, and path checks.
2. Run all Skill validations and script self-tests before replacement.
3. Update the root README and pack README with the final command and current behavior.
4. Parse-test the installer and perform an isolated install test.

### Task 9: Integration and forward testing

**Steps:**
1. Run every script self-test and all Skill validations.
2. Forward-test direct READY, research→READY, CONDITIONAL P1 preservation, stale handoff, rich Feishu warning, local archive, and change-output collision.
3. Install the validated suite once, retaining backups.
4. Re-run tests from the installed directories.
