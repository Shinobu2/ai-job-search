# Career Control Room Stage 1 Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, locally testable path from authoritative candidate facts and a manually imported vacancy to a persisted evaluation, human-readable card, and machine-readable JSON export.

**Architecture:** A single root Bun project uses YAML plus JSON Schema for user-editable facts/config, `bun:sqlite` for immutable operational history, and three focused packages: `core` for validation/import types, `storage` for migrations/transactions/capabilities, and `evaluation` for deterministic extraction and decisions. No network, browser, connector, document-generation, or submission code exists in Stage 1.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, `bun:sqlite`, Ajv 8.20.0, YAML 2.9.0, Bun test, retained Python unittest suite.

## Global Constraints

- `workspace/profile.yml`, `workspace/evidence.yml`, and `workspace/document-pack.yml` are the only authoritative candidate-fact sources.
- SQLite is the transactional operational store; CSV, JSON, and Markdown are exports/reports only.
- Every derived row retains provenance, UTC timestamp, evaluator version, and config versions/hashes.
- `configured_mode` may be `supervised_auto`; Stage 1 `effective_mode` is always `prepare_only` because submission capabilities are unavailable/disabled.
- Capability status is one of `unavailable`, `implemented`, `tested`, `certified`, `disabled`; certification requires a separate explicit action and never follows automatically from code/tests.
- Unknown means unknown. Never infer work authorization, German equivalence, professional experience, certification, salary conversion, commute, or transport.
- Home lab is not employment. Informal Discord assistance is not professional remote support.
- Deterministic code owns taxonomy, gates, evidence mapping, scores, confidence, tier, and verdict. The model may extract/explain through the skill but cannot silently alter rules.
- Hard blockers override numeric scores. Critical unknowns produce `VERIFY`, not `PASS`.
- Normal tests use saved fixtures only and never access live job sites.
- Do not create future placeholder packages or implement connectors, browser automation, submission, email/calendar, outreach, dashboards, Proof Builder, or strategy automation.
- Use TDD for every production behavior: write a focused failing test, verify expected RED, implement minimum GREEN, rerun focused and regression tests, then commit.

---

### Task 1: Root Runtime, Workspace Schemas, Examples, Setup, Doctor, and Repository Guards

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `AGENTS.md`
- Create: `config/schemas/common.schema.json`
- Create: `config/schemas/profile.schema.json`
- Create: `config/schemas/evidence.schema.json`
- Create: `config/schemas/document-pack.schema.json`
- Create: `config/schemas/search.schema.json`
- Create: `config/schemas/auto-apply.schema.json`
- Create: `workspace.example/profile.yml`
- Create: `workspace.example/evidence.yml`
- Create: `workspace.example/document-pack.yml`
- Create: `workspace.example/search.yml`
- Create: `workspace.example/auto-apply.yml`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/workspace.ts`
- Create: `scripts/setup.ts`
- Create: `scripts/doctor.ts`
- Create: `scripts/cli.ts`
- Create: `tests/config/workspace-schemas.test.ts`
- Create: `tests/setup/setup.test.ts`
- Modify: `.gitignore`
- Modify: `tools/security_guards.py`
- Modify: `tests/test_security_guards.py`

**Interfaces:**
- Produces `VerificationStatus = "unknown" | "user_confirmed" | "document_verified" | "rejected" | "expired"` and `VerifiedValue<T> { value: T | null; verification_status: VerificationStatus; provenance: ProvenanceRef[] }`.
- Produces `loadWorkspace(root): WorkspaceSnapshot`, `validateWorkspaceFile(name, value): void`, and `setupWorkspace(root): SetupSummary`.
- Produces CLI commands `setup` and `doctor`; later tasks add job/capability commands to the same dispatcher.

- [ ] **Step 1: Add failing schema and setup tests**

Create tests that assert all five example YAML files validate, null candidate facts remain explicit, candidate values from the original specification retain `source_type: user_statement`, and invalid legal inference fails. Add a rerun test that changes an existing scalar, map, and list, runs setup again, and proves values are unchanged while missing files/keys are added.

```ts
test("setup rerun preserves existing user values", async () => {
  const root = await copyExamplesToTemp();
  await setupWorkspace(root);
  const profile = await readYaml(`${root}/workspace/profile.yml`);
  profile.locations.radius_km.value = 55;
  await writeYaml(`${root}/workspace/profile.yml`, profile);
  await setupWorkspace(root);
  expect((await readYaml(`${root}/workspace/profile.yml`)).locations.radius_km.value).toBe(55);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/config/workspace-schemas.test.ts tests/setup/setup.test.ts`  
Expected: FAIL because root package/modules and schemas do not exist.

- [ ] **Step 3: Add pinned root package and TypeScript configuration**

Use this manifest and remove the old `bun.lock` ignore so the generated lockfile is committed:

```json
{
  "name": "career-control-room",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "setup": "bun run scripts/cli.ts setup",
    "doctor": "bun run scripts/cli.ts doctor",
    "job:import": "bun run scripts/cli.ts job import",
    "job:evaluate": "bun run scripts/cli.ts job evaluate",
    "job:export": "bun run scripts/cli.ts job export",
    "capabilities": "bun run scripts/cli.ts capabilities",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "ajv": "8.20.0", "yaml": "2.9.0" },
  "devDependencies": { "@types/bun": "1.3.14", "typescript": "7.0.2" }
}
```

- [ ] **Step 4: Implement schemas and authoritative examples**

Use `additionalProperties: false` for closed structures and a shared `$defs.verifiedValue`. Populate established facts only: DCT A/AT primary, F fallback, Frankfurt 40 km, target start 2026-08-15..2026-08-31, licence yes, car no, public transport required, English self-assessed B2, German self-assessed A2, stated education/document status, agencies fallback-only, night/continuous-heavy blockers, and the stated estimated-net compensation floor/target. Mark them `user_confirmed`, not document-verified. Leave work authorization and unspecified legal facts `unknown`. Evidence records for PC hardware/router/informal Discord use `reviewer_status: unreviewed`; planned home lab uses `UNKNOWN` and prohibits completed/employment wording.

- [ ] **Step 5: Implement workspace validation, idempotent setup, and doctor**

`setupWorkspace` atomically creates missing files, validates before replace, never overwrites existing scalar/list/map values, initializes SQLite through Task 2 once available, and reports unknown/unverified paths. `doctor` checks Bun, SQLite initialization, schemas, security guard/gitignore, Python, LaTeX engines, and `pdftotext`; missing LaTeX/Poppler are warnings in default mode and errors only under `--strict`. It never installs software.

- [ ] **Step 6: Add compact AGENTS.md and strengthen security guards**

Keep AGENTS.md under roughly 80 lines and reference config/skills instead of copying rules. Extend the guard to scan root `package.json`, require `.vs/` and `workspace/`, reject tracked workspace files and manifest lifecycle scripts/trustedDependencies, and preserve the existing Claude checks.

- [ ] **Step 7: Verify GREEN and regressions**

Run:

```powershell
C:\Users\Emperor\.bun\bin\bun.exe install
C:\Users\Emperor\.bun\bin\bun.exe test tests/config/workspace-schemas.test.ts tests/setup/setup.test.ts
python -m unittest discover -s tests -t .
python tools/lint_skills.py
python tools/security_guards.py
C:\Users\Emperor\.bun\bin\bun.exe run typecheck
```

Expected: all commands exit 0; doctor may report LaTeX/Poppler warnings.

- [ ] **Step 8: Commit**

```powershell
git add package.json bun.lock tsconfig.json AGENTS.md config/schemas workspace.example packages/core scripts tests/config tests/setup .gitignore tools/security_guards.py tests/test_security_guards.py
git commit -m "feat: add Stage 1 workspace foundation"
```

### Task 2: SQLite Migrations, Transactional Storage, and Capability Registry

**Files:**
- Create: `packages/storage/migrations/001_stage1.sql`
- Create: `packages/storage/migrations/002_capabilities.sql`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/migrate.ts`
- Create: `packages/storage/src/repository.ts`
- Create: `packages/storage/src/capabilities.ts`
- Create: `config/capability-definitions.json`
- Create: `tests/storage/migrations.test.ts`
- Create: `tests/storage/persistence.test.ts`
- Create: `tests/storage/capabilities.test.ts`
- Modify: `scripts/setup.ts`
- Modify: `scripts/doctor.ts`
- Modify: `scripts/cli.ts`

**Interfaces:**
- Produces `openDatabase(path): Database`, `migrate(db): MigrationSummary`, `StorageRepository.importJob`, `StorageRepository.persistEvaluation`, and `CapabilityRegistry`.
- Capability registry computes effective mode; it never stores `effective_mode` in YAML.

- [ ] **Step 1: Add failing migration, transaction, and capability tests**

Tests require fresh/repeated migrations, checksum rejection, `foreign_keys=1`, FK failure, rollback on an injected child failure, persistence after reopen, immutable event history, explicit transitions, and `configured_mode=supervised_auto` resolving to `prepare_only`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/storage`  
Expected: FAIL because storage modules/migrations do not exist.

- [ ] **Step 3: Implement checksum migrations and schema**

Create `schema_migrations`, then tables `job_sources`, `jobs`, `evaluation_runs`, `extracted_requirements`, `evidence_mappings`, `gate_results`, `fit_scores`, `survival_scores`, `application_tiers`, `recommendations`, `capabilities`, and `event_history`. Enable and verify `PRAGMA foreign_keys=ON`; use `busy_timeout=5000`, WAL/NORMAL for file DB. Derived tables include `created_at`, `evaluator_version`, and valid provenance JSON. Add append-only event triggers.

- [ ] **Step 4: Implement atomic repositories**

Use `db.transaction(fn).immediate()` around each import/evaluation graph. Validate complete graph before writing. `run_key` uniqueness returns the existing evaluation; never overwrite historical rows. SQLite stores evidence IDs plus the evidence snapshot hash/provenance, not a second mutable Evidence Vault.

- [ ] **Step 5: Implement explicit capability transitions**

Seed all 17 initial capabilities. Stage 1 delivered core entries start `implemented`; document/PDF/application capabilities start `unavailable` or `disabled`. Allow `unavailable→implemented→tested→certified`, any→disabled, with explicit actor/report hash/reason and an event. Reject certification without a distinct explicit call and required passing evidence. Stage 1 `getEffectiveMode()` always returns `prepare_only`.

- [ ] **Step 6: Verify GREEN and commit**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/storage && C:\Users\Emperor\.bun\bin\bun.exe run typecheck`  
Expected: PASS.

```powershell
git add packages/storage config/capability-definitions.json tests/storage scripts/setup.ts scripts/doctor.ts scripts/cli.ts
git commit -m "feat: add transactional Stage 1 storage"
```

### Task 3: Manual Vacancy Import and Deterministic Extraction

**Files:**
- Create: `config/schemas/job.schema.json`
- Create: `config/schemas/extraction.schema.json`
- Create: `packages/core/src/hash.ts`
- Create: `packages/core/src/job-import.ts`
- Create: `packages/evaluation/src/extract.ts`
- Create: `tests/fixtures/jobs/at-dct-trainee.md`
- Create: `tests/fixtures/jobs/a-hardware-dct.md`
- Create: `tests/fixtures/jobs/bt-facilities-trainee.md`
- Create: `tests/fixtures/jobs/x-facilities-electrician.md`
- Create: `tests/fixtures/jobs/f-it-support.md`
- Create: `tests/fixtures/jobs/manual-html.html`
- Create: `tests/import/manual-import.test.ts`
- Create: `tests/evaluation/extraction.test.ts`
- Modify: `scripts/cli.ts`

**Interfaces:**
- `ManualJobImport { sourceType; rawContent; sourceLocator?; suppliedUrl?; importedAt }`.
- `importManualJob(input, repository): JobAggregate` preserves original raw input/hash and creates immutable source/job snapshots.
- `extractVacancy(raw, extractionVersion, asOf): ExtractedJob` returns known/unknown/conflicting fields with source spans and stable requirement IDs.

- [ ] **Step 1: Add failing import/extraction tests**

Cover pasted text, `.txt`, Markdown, local HTML, metadata-only URL, original SHA-256, LF-normalized extraction, no network, source spans, unknown fields, and same-source/same-hash idempotency.

- [ ] **Step 2: Verify RED**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/import tests/evaluation/extraction.test.ts`  
Expected: FAIL because import/extraction modules do not exist.

- [ ] **Step 3: Implement manual import and stable hashing**

Accept exactly one `--file` or `--stdin`; infer file media type only for files; never fetch supplied URLs. Hash original UTF-8 bytes, preserve raw text, normalize only the extraction view, and create stable IDs from hashes.

- [ ] **Step 4: Implement deterministic extraction**

Use versioned cue/rule dictionaries only. Every extracted value stores state, value, spans, and rule IDs. Requirements use `req_` plus the first 12 SHA-256 hex characters of normalized statement/kind/importance. Conflicting cues remain `conflicting`; unrecognized information remains `unknown`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/import tests/evaluation/extraction.test.ts && C:\Users\Emperor\.bun\bin\bun.exe run typecheck`  
Expected: PASS.

```powershell
git add config/schemas/job.schema.json config/schemas/extraction.schema.json packages/core packages/evaluation/src/extract.ts tests/fixtures/jobs tests/import tests/evaluation/extraction.test.ts scripts/cli.ts
git commit -m "feat: add deterministic manual vacancy import"
```

### Task 4: Deterministic Classification, Gates, Evidence Mapping, Fit/Survival Scores, Tier, and Verdict

**Files:**
- Create: `config/role-taxonomy.yml`
- Create: `config/evaluation-rules.yml`
- Create: `config/schemas/evaluation.schema.json`
- Create: `packages/evaluation/src/config.ts`
- Create: `packages/evaluation/src/classify.ts`
- Create: `packages/evaluation/src/gates.ts`
- Create: `packages/evaluation/src/evidence-map.ts`
- Create: `packages/evaluation/src/score.ts`
- Create: `packages/evaluation/src/evaluate.ts`
- Create: `tests/evaluation/classification.test.ts`
- Create: `tests/evaluation/gates.test.ts`
- Create: `tests/evaluation/evidence-map.test.ts`
- Create: `tests/evaluation/scoring.test.ts`
- Add fixture variants under `tests/fixtures/jobs/` and `tests/fixtures/workspaces/`

**Interfaces:**
- `classify(job, taxonomy): ClassificationResult` returns A/AT/BT/F/X plus matched rules/spans.
- `evaluateGates(job, profile, rules, asOf): GateSummary` uses `PASS|PASS_WITH_RISK|VERIFY|BLOCKED|EMERGENCY_ONLY`.
- `mapEvidence(requirements, vault, rules): EvidenceMapping[]` uses proven/partial/transferable/missing/unknown/contradicted.
- `scoreEvaluation(...)` returns fit, survival, confidence, tier, verdict, operands, and semantic fingerprint.

- [ ] **Step 1: Add failing classification and gate tests**

Cover A, AT, BT, F, X/electrician, mandatory nights, rotating nights, own car, continuous heavy work, non-IT warehouse, mandatory electrical/HVAC without training, German B2/C1 without English alternative, senior-only, explicit comparable salary below floor, expired/integrity-failed, and critical unknown→VERIFY.

- [ ] **Step 2: Verify RED**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/evaluation/classification.test.ts tests/evaluation/gates.test.ts`  
Expected: FAIL because evaluation modules/config do not exist.

- [ ] **Step 3: Implement taxonomy and hard gates before scoring**

Precedence: forced X → AT → BT → A → F → X; ambiguous equally explicit IT/facilities trainee cues return X with classification VERIFY. Overall gate precedence: BLOCKED → EMERGENCY_ONLY → VERIFY → PASS_WITH_RISK → PASS. Job salary compares only like-for-like verified units; never derive gross from net, exchange currencies, or invent commute.

- [ ] **Step 4: Add failing evidence tests, then implement mapping**

Absence of evidence maps to `unknown` with `evidence_ids: []`, not `missing` or match. `HOME_LAB_EVIDENCE` may support project skill wording but never professional employment/years. Informal Discord evidence never proves professional support. Every important requirement gets a mapping row and rationale.

- [ ] **Step 5: Add failing score/tier tests, then implement integer deterministic formulas**

Use config-owned mapping credits and weights. Fit is weighted requirement credit plus track alignment. Survival renormalizes only verified available dimensions and is `null` when none exist. Confidence combines critical completeness, mapping certainty, and traceability. Tier rules are top-down; blocker/X always C, critical VERIFY caps at B. Use integer basis points plus round-half-up. Semantic fingerprint excludes run IDs/timestamps.

- [ ] **Step 6: Verify GREEN and commit**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/evaluation && C:\Users\Emperor\.bun\bin\bun.exe run typecheck`  
Expected: PASS, including repeatability, high-score blocker override, and independent survival change.

```powershell
git add config/role-taxonomy.yml config/evaluation-rules.yml config/schemas/evaluation.schema.json packages/evaluation tests/evaluation tests/fixtures
git commit -m "feat: add deterministic job evaluation"
```

### Task 5: Result Cards, Transactional Evaluation Integration, JSON Export, and Capability Commands

**Files:**
- Create: `config/schemas/result-card.schema.json`
- Create: `packages/evaluation/src/result-card.ts`
- Create: `tests/integration/stage1-flow.test.ts`
- Create: `tests/evaluation/result-card.test.ts`
- Modify: `packages/evaluation/src/evaluate.ts`
- Modify: `packages/storage/src/repository.ts`
- Modify: `scripts/cli.ts`

**Interfaces:**
- `renderResultCard(result): string` produces fixed deterministic sections.
- `evaluateAndPersist(jobId, workspace, storage, asOf): PersistedEvaluation` writes one atomic graph.
- CLI supports `job import`, `job evaluate`, `job export`, and `capabilities list|show|mark-tested|certify|disable`.

- [ ] **Step 1: Add failing card and end-to-end tests**

Assert title/company/location/archetype/fit/survival/tier/confidence/verdict/matches/evidence/gaps/blockers/unknowns/reason/next action; JSON schema validity; atomic persistence; export; same semantic fingerprint on rerun; distinct timestamps excluded from fingerprint.

- [ ] **Step 2: Verify RED**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/evaluation/result-card.test.ts tests/integration/stage1-flow.test.ts`  
Expected: FAIL because card/integration commands do not exist.

- [ ] **Step 3: Implement result card and atomic integration**

Use fixed ordering: blockers/gaps/unknowns by rule priority then requirement ID; matches by contribution then ID; evidence IDs ascending. Persist requirements, mappings, gates, scores, tier, recommendation/card, and `evaluation.completed` event in one immediate transaction.

- [ ] **Step 4: Implement CLI contracts**

All commands resolve repository root, accept Windows paths, keep stdout machine-clean under `--json`, send diagnostics to stderr, and use exit 0 for domain BLOCKED results. Export refuses overwrite without `--force`. Capability certification is explicit and Stage 1 rejects submission certification.

- [ ] **Step 5: Verify GREEN and commit**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/evaluation/result-card.test.ts tests/integration/stage1-flow.test.ts tests/storage && C:\Users\Emperor\.bun\bin\bun.exe run typecheck`  
Expected: PASS.

```powershell
git add config/schemas/result-card.schema.json packages/evaluation packages/storage scripts/cli.ts tests/evaluation/result-card.test.ts tests/integration
git commit -m "feat: complete Stage 1 evaluation flow"
```

### Task 6: Codex Skill, Windows Guide, Demonstration, and Full Verification

**Files:**
- Create: `.agents/skills/job-evaluate/SKILL.md`
- Create: `.agents/skills/job-evaluate/references/cli.md`
- Create: `docs/windows-setup.md`
- Create: `docs/stage-1-schema-and-migrations.md`
- Create: `docs/stage-1-demonstration.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Skill routes natural-language manual import/evaluation through deterministic CLI and explains output; it never browses, submits, infers facts, or mutates rules/database directly.
- Documentation gives exact PowerShell commands and recorded demonstration output.

- [ ] **Step 1: Add/verify complete 18-case acceptance matrix**

Map every Stage 1 required test to a stable test name. Add any missing saved fixture or boundary table test. Confirm `.vs/`, `workspace/profile.yml`, `workspace/control-room.sqlite`, WAL/SHM, exports, payloads, receipts, screenshots, browser-profile, secrets, and auth/storage-state files are ignored and absent from tracked files.

- [ ] **Step 2: Add skill and documentation**

Document the exact demo:

```powershell
bun install --frozen-lockfile
bun run setup
bun run doctor
bun run job:import -- --file "tests/fixtures/jobs/at-dct-trainee.md" --source-type markdown_file --source-id stage1-dct-trainee --url "https://example.invalid/jobs/stage1-dct-trainee"
bun run job:evaluate -- --source-id stage1-dct-trainee --source-type markdown_file --card-out "workspace/exports/stage1-dct-trainee.md"
bun run job:export -- --latest --source-id stage1-dct-trainee --format json --output "workspace/exports/stage1-dct-trainee.json"
bun run job:evaluate -- --source-id stage1-dct-trainee --source-type markdown_file
```

- [ ] **Step 3: Run the real demonstration twice and capture output**

Run exactly the documented commands from a clean temporary workspace, record the result card and JSON summary, and prove identical semantic fingerprint/gates/scores.

- [ ] **Step 4: Run full verification**

```powershell
bun install --frozen-lockfile
bun test
bun run typecheck
python -m unittest discover -s tests -t . -v
python tools/lint_skills.py
python tools/security_guards.py
bun run doctor
git diff --check
git status --short
```

Expected: Bun/Python/lint/security/typecheck/tests pass. Doctor reports missing LaTeX/Poppler as nonblocking Stage 1 warnings if still absent. No live network test or real submission occurs.

- [ ] **Step 5: Commit**

```powershell
git add .agents/skills/job-evaluate docs README.md .github/workflows/ci.yml tests package.json bun.lock
git commit -m "docs: document Stage 1 workflow"
```

## Plan Self-Review

- Scope is limited to the requested vertical slice; no future package is empty.
- Facts/config and operational/derived sources of truth are separated.
- All production behavior is preceded by a named RED test step.
- Certification is explicit and cannot be bypassed by configured mode.
- Every required Stage 1 demonstration step has a CLI owner and persistence owner.
- Normal tests are saved-fixture-only and cannot submit applications.
