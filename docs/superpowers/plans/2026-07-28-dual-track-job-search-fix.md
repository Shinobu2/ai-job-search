# Dual-Track Job Search Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development task-by-task.

**Goal:** Make the personal workflow use honest planned §24 wording, keep shift-based data-centre jobs visible, and search separate data-centre and bridge tracks.

**Architecture:** Extend the existing profile/evidence schemas, evaluator, source configs, discovery utilities, document packet, and CLI. Keep one profile and one SQLite tracker; model judgment remains outside deterministic code.

**Tech Stack:** TypeScript, Bun, AJV/JSON Schema, YAML, SQLite, DOCX.

## Global Constraints

- No new frameworks, parallel stores, deterministic ATS/EV scoring, or generic connector layer.
- Never present home-lab/theory as employment.
- Never claim the §24 permit is already issued; always pair planned authorization with 17 August 2026.
- Submission remains supervised.

### Task 1: Candidate facts and authorization wording

**Files:**
- Modify: `config/schemas/profile.schema.json`
- Modify: `config/schemas/evidence.schema.json`
- Modify: `workspace/profile.yml`
- Modify: `workspace/evidence.yml`
- Create: `config/work-authorization-wording.json`
- Test: `tests/config/workspace-schemas.test.ts`
- Test: `tests/core/application-answers.test.ts`

**Produces:** verified planned-§24 data plus exact EN/DE text and form-answer helpers.

- [ ] Add failing schema/answer tests for planned §24, evidence kinds, exact wording, and review-only authorization questions.
- [ ] Run the two test files and confirm the expected failures.
- [ ] Extend existing schemas/data and application-answer helpers minimally.
- [ ] Rerun the tests green.

### Task 2: Evaluation and reviewability fixes

**Files:**
- Modify: `config/role-taxonomy.json`
- Modify: `config/evaluation-rules.json`
- Modify: `packages/jobs/src/rules.ts`
- Modify: `packages/jobs/src/types.ts`
- Modify: `packages/jobs/src/evaluate.ts`
- Modify: `packages/search/src/types.ts`
- Test: `tests/jobs/evaluate.test.ts`
- Test: `tests/search/cli.test.ts`

**Produces:** `REVIEW` archetype, `needs_model` mappings, reviewable tier-C jobs, available-night-shift handling, bilingual salary/experience parsing, and English-only language pass.

- [ ] Add focused failing tests for every section-3 evaluator behavior.
- [ ] Run focused tests and confirm failures represent the missing behavior.
- [ ] Implement token overlap and explicit hard-gate changes without adding semantic scoring.
- [ ] Rerun focused tests green.

### Task 3: Dual-track discovery and shared helpers

**Files:**
- Modify: `config/schemas/search.schema.json`
- Modify: `config/extraction-rules.json`
- Modify: `config/employer-registry.json`
- Modify: `workspace.example/search.yml`
- Modify: `workspace/search.yml`
- Modify: `packages/search/src/scheduler.ts`
- Modify: `packages/search/src/freehire.ts`
- Modify: `packages/search/src/jobsuche.ts`
- Modify: `packages/search/src/employer-registry.ts`
- Modify: `scripts/cli.ts`
- Test: `tests/search/freehire.test.ts`
- Test: `tests/search/jobsuche.test.ts`
- Test: `tests/search/scheduler.test.ts`
- Test: `tests/search/cli.test.ts`

**Produces:** datacenter/bridge batches, BA native radius/freshness filters, FreeHire semantic ratio, config-driven skills, and single-count skipped identities.

- [ ] Add failing URL, counters, config, skill-extraction, and track-output tests.
- [ ] Run search tests and confirm expected failures.
- [ ] Move only duplicated scope/loop state into plain scheduler utilities.
- [ ] Implement track-aware source runs and separate CLI sections.
- [ ] Rerun search tests green.

### Task 4: Documents, shortlist copy, handoff, and completion

**Files:**
- Modify: `packages/documents/src/ats-docx.ts`
- Modify: `packages/documents/src/generate.ts`
- Modify: `.agents/skills/job-hunt/SKILL.md`
- Modify: `CHATGPT_WORK_HANDOFF.md`
- Test: `tests/documents/ats-docx.test.ts`
- Test: `tests/documents/generate.test.ts`
- Test: `tests/e2e/mvp-lifecycle.test.ts`

**Produces:** exact §24 text in ATS CV/letters and stable separate shortlist instructions.

- [ ] Add failing document tests for exact EN/DE wording and no duplicate availability paragraph.
- [ ] Implement the minimal document/model fields and skill copy.
- [ ] Run document/e2e tests green.
- [ ] Run `bun run typecheck`, relevant tests, `py tests/test_job_hunt_smoke.py`, and `git diff --check`.
- [ ] Update the sanitized handoff and commit the verified blocks.
