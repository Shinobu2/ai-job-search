# Job Evaluation Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local vacancy import, reuse/deduplication, deterministic evaluation, card display, JSON export, and SQLite persistence usable through the four approved `bun run job:*` commands.

**Architecture:** Keep the accepted workspace, SQLite migrations, and capability registry. Add one cohesive `packages/jobs/` module for ingestion, deterministic fixture extraction, evaluation and rendering; extend `StorageRepository` only with queries and idempotent writes required by that flow. CLI is a thin argument parser over that module.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, existing Ajv/YAML workspace loader, saved local text/Markdown/HTML fixtures.

## Global Constraints

- No network, browser automation, application submission, Gmail/calendar/outreach, document generation, Proof Builder, or advanced analytics.
- Accept plain text, local `.txt`, `.md`, and `.html`; preserve original content and its SHA-256 hash. A supplied URL is metadata only.
- Deduplicate by canonical URL, source identifier, normalized company/title/location, then content hash; reruns must reuse the job.
- Extraction output is versioned, validated, and deterministic under tests; absent facts are `unknown`.
- Final archetypes are A, AT, BT, F, or X; UPS/generator/high-voltage/HVAC/critical switching are facilities, not ordinary DCT hardware.
- Hard blockers override scores. Verified current facts only feed survival. Unknown salary/address/transport/shift lowers confidence and is shown under VERIFY.
- Proven/partial evidence mappings cite evidence IDs. Never fabricate experience or promote home lab, Discord help, theory, planned learning, or school education.
- `job:export` prints JSON and writes `workspace/exports/<job-id>.json`; `job:check` is the complete local demo.

---

### Task 1: Local import, normalized job identity, deduplication, and validated extraction

**Files:**
- Create: `packages/jobs/src/import.ts`
- Create: `packages/jobs/src/extract.ts`
- Create: `packages/jobs/src/types.ts`
- Create: `config/extraction-rules.json`
- Create: `tests/fixtures/jobs/dct-trainee.md`
- Create: `tests/fixtures/jobs/a-hardware-dct.md`
- Create: `tests/fixtures/jobs/bt-facilities-trainee.md`
- Create: `tests/fixtures/jobs/unqualified-facilities.md`
- Create: `tests/fixtures/jobs/f-it-support.md`
- Create: `tests/fixtures/jobs/local-html.html`
- Create: `tests/jobs/import.test.ts`
- Create: `tests/jobs/extract.test.ts`
- Modify: `packages/storage/src/repository.ts`

**Interfaces:**

```ts
export type ImportRequest = { text?: string; file?: string; sourceUrl?: string; sourceId?: string };
export type ImportedJob = { id: string; reused: boolean; sourceHash: string; title: string | null; company: string | null; location: string | null };
export type ExtractedJob = { version: "extraction-v1"; fields: Record<string, ExtractedField>; requirements: ExtractedRequirement[]; uncertainties: string[] };
export function importVacancy(request: ImportRequest, repository: StorageRepository): Promise<ImportedJob>;
export function extractVacancy(text: string): ExtractedJob;
```

- [ ] **Step 1: Write failing import tests**

Create tests for `--text`, `.txt`, `.md`, and local HTML visible-text extraction. Assert raw source content/hash are stored, URLs are never fetched, missing/unsupported files fail clearly, and importing a fixture twice returns the same job ID and one `jobs` row. Add cases for the four deduplication precedence keys.

- [ ] **Step 2: Run RED tests**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/import.test.ts`
Expected: FAIL because `packages/jobs/src/import.ts` does not exist.

- [ ] **Step 3: Add minimal storage lookup/write methods and importer**

Add repository methods that find a job by supplied canonical URL, source ID, normalized triple, and raw hash without changing the accepted migration model. `importVacancy` reads local bytes, derives type from extension, removes script/style tags and decodes visible HTML text, creates stable SHA-256-derived IDs, extracts title/company/location for the normalized job, then reuses or transactionally persists it.

- [ ] **Step 4: Write failing extraction tests**

Use saved fixtures to assert a versioned object covers title, company, location/exact workplace, employment/contract type, salary, languages, education, experience, skills, certifications, shift/night/on-call/car/physical requirements, training, seniority, deadline, and uncertainties. Assert absent fields are explicitly `unknown` and field spans point into the fixture text.

- [ ] **Step 5: Implement deterministic extraction and validate GREEN**

Implement only rule/config-backed extraction using `config/extraction-rules.json`; every extracted field has `{ state: "known" | "unknown" | "conflicting", value, spans, rule_ids }`. Make requirement IDs stable from normalized type/text. Run:

```powershell
C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/import.test.ts tests/jobs/extract.test.ts
C:\Users\Emperor\.bun\bin\bun.exe run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/jobs/src/import.ts packages/jobs/src/extract.ts packages/jobs/src/types.ts packages/storage/src/repository.ts config/extraction-rules.json tests/jobs tests/fixtures/jobs
git commit -m "feat: import and extract local vacancies"
```

### Task 2: Deterministic taxonomy, gates, evidence mapping, scores, and persisted evaluation

**Files:**
- Create: `packages/jobs/src/evaluate.ts`
- Create: `packages/jobs/src/rules.ts`
- Create: `config/role-taxonomy.json`
- Create: `config/evaluation-rules.json`
- Create: `tests/jobs/evaluate.test.ts`
- Create: `tests/fixtures/jobs/night-shift.md`
- Create: `tests/fixtures/jobs/own-car.md`
- Create: `tests/fixtures/jobs/german-b2.md`
- Create: `tests/fixtures/jobs/unknown-shift.md`
- Modify: `packages/jobs/src/types.ts`
- Modify: `packages/storage/src/repository.ts`

**Interfaces:**

```ts
export type EvaluationResult = { jobId: string; archetype: "A" | "AT" | "BT" | "F" | "X"; gates: Gate[]; mappings: EvidenceMapping[]; fit: number; survival: number | null; confidence: "low" | "medium" | "high"; tier: "S" | "A" | "B" | "C"; verdict: string; fingerprint: string };
export function evaluateVacancy(job: StoredJob, extracted: ExtractedJob, workspace: WorkspaceSnapshot, asOf: string): EvaluationResult;
```

- [ ] **Step 1: Write failing classification/gate tests**

Assert AT trainee, A hardware DCT, BT facilities trainee, unqualified facilities role, and F support classifications. Assert mandatory/rotating nights, own car, heavy labour, warehouse/conveyor, untrained electrical/HVAC, German B2/C1 without an English alternative, senior-only experience, low explicit salary, and reliable expired deadlines block. Assert unknown shifts produce VERIFY rather than a candidate-friendly assumption.

- [ ] **Step 2: Run RED tests**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/evaluate.test.ts`
Expected: FAIL because `evaluateVacancy` does not exist.

- [ ] **Step 3: Implement versioned classification and gates before scoring**

Load both JSON configs and enforce precedence `forced X → AT → BT → A → F → X`; facilities cues win over generic hardware cues. Emit ordered gate results with `PASS`, `PASS_WITH_RISK`, `VERIFY`, `BLOCKED`, or `EMERGENCY_ONLY`; a `BLOCKED` gate forces the final verdict/tier regardless of fit.

- [ ] **Step 4: Add failing evidence and score tests, then implement them**

Assert every material requirement maps to exactly one of proven/partial/transferable/missing/unknown/contradicted; proven/partial include IDs from `evidence.yml`. Test that home lab is not employment, Discord is not professional support, planned learning/theory do not become hands-on skills, and education is not Ausbildung/degree equivalence. Test repeated evaluation has the same fingerprint/scores, blockers override high fit, and a verified-fact change can alter survival without altering fit.

- [ ] **Step 5: Implement deterministic scoring and persistence graph**

Use integer config weights and mapping credits only. Fit uses weighted requirement mappings; survival uses verified present profile facts only and is `null` with no facts; confidence decreases for critical unknowns. Tier rules map deterministic score bands but cap at B on critical VERIFY and force C on blocker/X. Build the existing `StorageRepository.persistEvaluation` payload with evaluator/config versions, provenance, requirement IDs, evidence snapshot hash, gates, scores, tier and recommendation.

- [ ] **Step 6: Verify GREEN and commit**

```powershell
C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/evaluate.test.ts tests/storage
C:\Users\Emperor\.bun\bin\bun.exe run typecheck
```

Expected: PASS.

```powershell
git add packages/jobs/src/evaluate.ts packages/jobs/src/rules.ts packages/jobs/src/types.ts packages/storage/src/repository.ts config/role-taxonomy.json config/evaluation-rules.json tests/jobs/evaluate.test.ts tests/fixtures/jobs
git commit -m "feat: evaluate vacancies deterministically"
```

### Task 3: Functional CLI, result card, JSON export, and repeatable demo

**Files:**
- Create: `packages/jobs/src/card.ts`
- Create: `tests/jobs/cli-flow.test.ts`
- Modify: `scripts/cli.ts`
- Modify: `package.json`
- Modify: `packages/storage/src/repository.ts`

**Interfaces:**

```ts
export function renderResultCard(result: EvaluationResult): string;
export function readEvaluation(jobId: string): EvaluationResult;
```

- [ ] **Step 1: Write failing CLI flow tests**

Spawn the CLI in a copied temporary workspace. Assert functional `job:import -- --file`, `job:import -- --text`, `job:evaluate -- --id`, `job:export -- --id`, and `job:check -- --file`. Assert `job:check` imports/reuses, persists, prints the card, writes `workspace/exports/<job-id>.json`, returns the same scores/gates/fingerprint on repeat, and exits 0 for a domain blocker. Assert malformed flags/unknown IDs have actionable stderr and nonzero exit.

- [ ] **Step 2: Run RED tests**

Run: `C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/cli-flow.test.ts`
Expected: FAIL because `scripts/cli.ts` currently has no `job` dispatcher.

- [ ] **Step 3: Implement card, export and CLI contracts**

Render title/company, archetype, fit, survival, tier, confidence, verdict, strong matches with evidence IDs, gaps, VERIFY conditions, and one next action in stable order. Wire commands through shared import/evaluate/export functions; `job:export` emits JSON to stdout and atomically writes `workspace/exports/<job-id>.json`. Ensure `job:check -- --file tests/fixtures/jobs/dct-trainee.md` prints a human card and JSON path, not an unimplemented command error.

- [ ] **Step 4: Run full verification and real demo twice**

```powershell
C:\Users\Emperor\.bun\bin\bun.exe run setup
C:\Users\Emperor\.bun\bin\bun.exe run job:check -- --file tests/fixtures/jobs/dct-trainee.md
C:\Users\Emperor\.bun\bin\bun.exe run job:check -- --file tests/fixtures/jobs/dct-trainee.md
C:\Users\Emperor\.bun\bin\bun.exe test
C:\Users\Emperor\.bun\bin\bun.exe run typecheck
python -m unittest discover -s tests -t . -v
python tools/security_guards.py
git diff --check
```

Expected: the second check reuses the job and matches the first scores/gates/fingerprint; all tests/typecheck/guards pass. No connector or document behavior is invoked.

- [ ] **Step 5: Commit**

```powershell
git add packages/jobs/src/card.ts packages/storage/src/repository.ts scripts/cli.ts package.json tests/jobs/cli-flow.test.ts
git commit -m "feat: deliver local job evaluation flow"
```

## Plan Self-Review

- Every approved command has an implementation task and an integration assertion.
- All required import formats, deduplication keys, extraction fields, archetypes, gates, evidence constraints, deterministic scores, persistence, card, and JSON export are covered.
- The three tasks create only one new cohesive module and do not extend into connectors, documents, submission, or advanced analytics.
- Each production behavior has a named RED test and a focused GREEN command.
