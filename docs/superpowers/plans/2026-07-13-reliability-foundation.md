# Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, freshness-aware, one-command daily control loop with a persistent shortlist and an isolated synthetic end-to-end proof.

**Architecture:** Safety rules live below the CLI in evaluation, document, and storage services. Discovery runs persist source health and immutable logical-vacancy versions; connectors return results plus structured diagnostics. A workflow module orchestrates enabled sources and produces timezone-correct Markdown and JSON reports, while CLI commands only render/query persisted state.

**Tech Stack:** Bun 1.3, TypeScript 7, `bun:sqlite`, AJV/YAML, Bun test, Python security guards, PowerShell-compatible commands.

## Global Constraints

- The real `workspace/` remains the only candidate-fact authority and is never populated with synthetic facts.
- Synthetic identity is exactly `SYNTHETIC TEST CANDIDATE — DO NOT SUBMIT` with `synthetic@example.com` contact data and exists only in test fixtures/temp workspaces.
- Unknown critical requirements remain `VERIFY`; missing extraction never becomes `PASS`.
- Only `user_confirmed` or `document_verified` identity/evidence with provenance can make artifacts ready.
- Readiness is bound to job snapshot, evaluation, evidence snapshot, and artifact hashes; an edited metadata boolean is insufficient.
- Connectors are bounded, read-only, allowlisted, and never call apply/candidate/outreach/email/credential endpoints.
- One source failure yields a partial daily run and never ages vacancies toward stale.
- Tier C, X, and blocked jobs remain auditable but are not actionable.
- Final application submission is outside this milestone and always requires explicit per-application confirmation.

---

### Task 1: Conservative evaluation and verified document identity

**Files:**
- Modify: `packages/jobs/src/evaluate.ts`
- Modify: `packages/jobs/src/card.ts`
- Modify: `packages/documents/src/generate.ts`
- Test: `tests/jobs/evaluate.test.ts`
- Test: `tests/documents/generate.test.ts`

**Interfaces:**
- Consumes: existing `EvaluationResult`, workspace profile/evidence records.
- Produces: `Gate` values where absent critical facts are `VERIFY`; document packets that accept identity fields only through `verifiedFactValue()`; cards use the neutral heading `Evidence mappings (verification status shown)` instead of claiming every non-zero mapping is a strong verified match.

- [ ] **Step 1: Add failing critical-unknown, evidence-precedence, identity-verification, and card-copy tests**

Add tests that assert:

```ts
expect(result.gates).toContainEqual(expect.objectContaining({ id: "transport", status: "VERIFY", critical: true }));
expect(result.gates).toContainEqual(expect.objectContaining({ id: "physical", status: "VERIFY", critical: true }));
expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "VERIFY", critical: true }));
expect(mapping).toMatchObject({ status: "proven", evidenceIds: ["VERIFIED_SUPPORT"] });
expect(packet.ready_for_submission).toBe(false);
expect(packet.missing).toContain("profile.identity.email");
expect(renderResultCard(result)).toContain("Evidence mappings (verification status shown):");
expect(renderResultCard(result)).not.toContain("Strong matches:");
```

The identity fixture has a non-empty email with `verification_status: "unknown"` and empty provenance. The mapping fixture contains both verified exact support evidence and informal Discord evidence.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/jobs/evaluate.test.ts tests/documents/generate.test.ts`

Expected: FAIL because critical absences currently pass, identity checks only value presence, and evidence/card precedence is not explicit.

- [ ] **Step 3: Implement conservative gates and verified identity helper**

Use this identity rule in `generate.ts`:

```ts
type VerifiedField = {
  value?: string | null;
  verification_status?: string;
  provenance?: Array<{ source_type?: string; source_ref?: string }>;
};

function verifiedFactValue(field: VerifiedField | undefined): string | null {
  if (!field?.value) return null;
  if (!["user_confirmed", "document_verified"].includes(field.verification_status ?? "")) return null;
  if (!field.provenance?.some((item) => item.source_type && item.source_ref)) return null;
  return field.value;
}
```

For transport, physical, and language gates, return critical `VERIFY` when the posting fact is absent/placeholder and only return `PASS` for an explicit non-requirement. In evidence mapping, evaluate verified exact evidence before informal contradiction. Rename the result-card heading to `Evidence mappings (verification status shown)` and retain each mapping's explicit `proven`, `partial`, or `transferable` label; do not call provisional evidence strong.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/jobs/evaluate.test.ts tests/documents/generate.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add packages/jobs/src/evaluate.ts packages/jobs/src/card.ts packages/documents/src/generate.ts tests/jobs/evaluate.test.ts tests/documents/generate.test.ts
git commit -m "fix(safety): verify critical facts and document identity"
```

---

### Task 2: Repository-level application state machine and packet attestation

**Files:**
- Create: `packages/storage/migrations/005_document_packets.sql`
- Modify: `packages/storage/src/repository.ts`
- Modify: `scripts/cli.ts`
- Modify: `packages/documents/src/generate.ts`
- Test: `tests/storage/migrations.test.ts`
- Test: `tests/tracking/tracking.test.ts`
- Test: `tests/tracking/cli.test.ts`

**Interfaces:**
- Produces: `DocumentPacketRecord`, `StorageRepository.recordDocumentPacket()`, `StorageRepository.readCurrentDocumentPacket()`, and repository-enforced `setApplicationStatus()` transitions.
- `recordDocumentPacket(input)` consumes exact hashes for job snapshot, evaluation fingerprint, evidence snapshot, metadata, and four artifact slots (Markdown slots are permitted until PDF preparation milestone).

- [ ] **Step 1: Add failing migration, attestation, and transition tests**

Test schema and behavior:

```sql
CREATE TABLE document_packets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  evaluation_fingerprint TEXT NOT NULL,
  evidence_snapshot_hash TEXT NOT NULL,
  artifact_hashes_json TEXT NOT NULL CHECK(json_valid(artifact_hashes_json)),
  ready INTEGER NOT NULL CHECK(ready IN (0,1)),
  directory TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Assertions:

```ts
expect(() => repository.setApplicationStatus("j", "user_submitted", { confirmed: true })).toThrow("ready_for_review");
expect(() => repository.setApplicationStatus("j", "ready_for_review")).toThrow("attested current document packet");
expect(repository.readCurrentDocumentPacket("j")).toMatchObject({ ready: true, directory: "workspace/documents/j" });
```

State transitions are `none -> shortlisted -> ready_for_review -> user_submitted -> interview -> offer`; `rejected` and `withdrawn` require an existing application and explicit confirmation. External states require `confirmed: true` in repository options.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts`

Expected: FAIL because migration 005 and repository guards/packet records do not exist.

- [ ] **Step 3: Implement migration, packet hashing, and repository guards**

Add repository types:

```ts
export type DocumentPacketInput = {
  id: string; jobId: string; evaluationFingerprint: string;
  evidenceSnapshotHash: string; artifactHashes: Record<string, string>;
  ready: boolean; directory: string;
};

export type ApplicationOptions = {
  nextAction?: string; documentDir?: string; actor?: string; note?: string;
  confirmed?: boolean;
};
```

`ready_for_review` must load the latest evaluation and latest packet and require matching fingerprint plus `ready=true`. External transition checks live in repository code, not CLI. `documents generate` computes SHA-256 for written files, hashes the evidence snapshot deterministically, records the packet, and writes the packet ID and hashes to metadata. CLI delegates transition validation to repository and passes `confirmed: flags.confirm === "yes"`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts`

Expected: all focused tests PASS and forged metadata alone is rejected.

- [ ] **Step 5: Commit Task 2**

```powershell
git add packages/storage/migrations/005_document_packets.sql packages/storage/src/repository.ts scripts/cli.ts packages/documents/src/generate.ts tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts
git commit -m "feat(tracking): attest packets and enforce transitions"
```

---

### Task 3: Isolated synthetic lifecycle proof

**Files:**
- Create: `tests/fixtures/candidates/synthetic/profile.yml`
- Create: `tests/fixtures/candidates/synthetic/evidence.yml`
- Create: `tests/fixtures/jobs/synthetic-day-dct.md`
- Create: `tests/e2e/mvp-lifecycle.test.ts`

**Interfaces:**
- Consumes only public CLI commands and `workspace.example/`.
- Produces a regression proof covering import, reuse, evaluate, export, document generation, attested tracking, reporting, and effective `prepare_only` mode.

- [ ] **Step 1: Write the synthetic fixtures and failing lifecycle test**

The profile must use:

```yaml
identity:
  name: {value: "SYNTHETIC TEST CANDIDATE — DO NOT SUBMIT", verification_status: user_confirmed, provenance: [{source_type: user_statement, source_ref: synthetic_test_fixture}]}
  email: {value: synthetic@example.com, verification_status: user_confirmed, provenance: [{source_type: user_statement, source_ref: synthetic_test_fixture}]}
  phone: {value: "+49 000 000000", verification_status: user_confirmed, provenance: [{source_type: user_statement, source_ref: synthetic_test_fixture}]}
```

The evidence fixture includes confirmed PC hardware, cabling, and troubleshooting records plus one unreviewed claim that must not enter documents. The vacancy explicitly states day shift, no night work, no own-car requirement, light/normal physical work, English B2 accepted, current deadline, and matching skills.

The test copies examples to a temp root and sequentially spawns:

```ts
await cli("job", "import", "--file", fixture);
await cli("job", "evaluate", "--id", id);
await cli("job", "export", "--id", id);
await cli("documents", "generate", "--id", id);
await cli("applications", "set", "--id", id, "--status", "shortlisted");
await cli("applications", "set", "--id", id, "--status", "ready_for_review");
await cli("applications", "set", "--id", id, "--status", "user_submitted", "--confirm", "yes");
await cli("report", "daily");
await cli("capabilities");
```

Assert repeated import reuses the job, metadata is ready, only confirmed synthetic evidence appears, application events are ordered, the report contains counts/actions, mode is `prepare_only`, and the repository real workspace timestamps/hashes are unchanged.

- [ ] **Step 2: Run lifecycle test and verify RED**

Run: `bun test tests/e2e/mvp-lifecycle.test.ts`

Expected: FAIL until all explicit fixture facts are extracted and packet attestation is wired end to end.

- [ ] **Step 3: Make only fixture/extraction adjustments required by the public lifecycle**

If an explicit negative phrase is not extracted, add deterministic labels to the fixture rather than weakening gates. The final fixture must remain representative and include `Description:` prose, but all critical readiness facts must also be explicit labeled fields accepted by current extraction rules.

- [ ] **Step 4: Run lifecycle and relevant regressions**

Run: `bun test tests/e2e/mvp-lifecycle.test.ts tests/jobs tests/documents tests/tracking`

Expected: PASS; no files created under repository `workspace/` by the test.

- [ ] **Step 5: Commit Task 3**

```powershell
git add tests/fixtures/candidates/synthetic tests/fixtures/jobs/synthetic-day-dct.md tests/e2e/mvp-lifecycle.test.ts
git commit -m "test(e2e): prove synthetic MVP lifecycle"
```

---

### Task 4: Discovery ledger and logical vacancy versions

**Files:**
- Create: `packages/storage/migrations/006_discovery_ledger.sql`
- Modify: `packages/storage/src/repository.ts`
- Modify: `packages/jobs/src/import.ts`
- Test: `tests/storage/migrations.test.ts`
- Test: `tests/storage/persistence.test.ts`
- Test: `tests/jobs/import.test.ts`

**Interfaces:**
- Produces: `DiscoveryRunInput`, `ObservationInput`, `StorageRepository.startDiscoveryRun()`, `finishDiscoveryRun()`, `observeVacancy()`, `listCurrentVacancies()`.
- `ImportedJob` gains `logicalVacancyId` and `version` while retaining immutable job IDs.

- [ ] **Step 1: Add failing ledger/version tests**

Migration tables:

```sql
CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
  counters_json TEXT NOT NULL CHECK(json_valid(counters_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE logical_vacancies (
  id TEXT PRIMARY KEY, stable_key TEXT NOT NULL UNIQUE,
  canonical_url TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  consecutive_misses INTEGER NOT NULL DEFAULT 0, lifecycle_status TEXT NOT NULL
);
CREATE TABLE vacancy_versions (
  logical_vacancy_id TEXT NOT NULL REFERENCES logical_vacancies(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), version INTEGER NOT NULL,
  observed_at TEXT NOT NULL, PRIMARY KEY(logical_vacancy_id, version)
);
```

Assert same stable source ID + same hash reuses the same version; changed hash creates version 2; a failed/partial run does not increment misses; two successful same-scope misses mark stale; separate stable IDs with identical title/company/location remain separate.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/storage/migrations.test.ts tests/storage/persistence.test.ts tests/jobs/import.test.ts`

Expected: FAIL because discovery ledger/version APIs do not exist.

- [ ] **Step 3: Implement stable-key versioning and conservative staleness**

Stable key precedence is exact normalized canonical URL, then `source-id:<connector-id>`, then raw hash. `importVacancy()` asks repository to attach each immutable job snapshot to the logical vacancy. `finishDiscoveryRun()` increments misses only when status is `success`, only for vacancies previously observed in the same source/scope, resets observed vacancies to active, and marks stale at two misses. Never infer closed.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/storage/migrations.test.ts tests/storage/persistence.test.ts tests/jobs/import.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add packages/storage/migrations/006_discovery_ledger.sql packages/storage/src/repository.ts packages/jobs/src/import.ts tests/storage/migrations.test.ts tests/storage/persistence.test.ts tests/jobs/import.test.ts
git commit -m "feat(discovery): persist vacancy versions and freshness"
```

---

### Task 5: Connector diagnostics, fair scheduling, and resilient reads

**Files:**
- Create: `packages/search/src/types.ts`
- Create: `packages/search/src/scheduler.ts`
- Modify: `packages/search/src/jobsuche.ts`
- Modify: `packages/search/src/freehire.ts`
- Modify: `packages/search/src/personio.ts`
- Modify: `scripts/cli.ts`
- Test: `tests/search/scheduler.test.ts`
- Test: `tests/search/jobsuche.test.ts`
- Test: `tests/search/freehire.test.ts`
- Test: `tests/search/personio.test.ts`
- Test: `tests/search/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export type SourceDiagnostic = { stage: "search" | "detail" | "parse"; locator: string; code: string; message: string; transient: boolean };
export type DiscoveryBatch = { sourceId: string; jobs: DiscoveredJob[]; counters: { searched: number; detailed: number; imported: number; skipped: number; failed: number }; diagnostics: SourceDiagnostic[] };
export async function mapBounded<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<PromiseSettledResult<R>[]>;
export function roundRobinScopes(keywords: string[], cities: string[]): Array<{ keyword: string; city: string }>;
```

- [ ] **Step 1: Add failing fairness, partial outage, retry, location, negation, and XML tests**

Assert every configured keyword/city receives one search before any scope receives page 2; concurrency never exceeds 5; one failed detail produces a diagnostic and preserves good jobs; malformed JSON/XML is not a successful empty response; 429/5xx retries at most twice; out-of-area jobs are stored/diagnosed but excluded from actionable results; `keine Nachtschicht` does not become a night requirement while `Nachtarbeit`, `Wechselschicht`, and `24/7` do; Personio supports CDATA, entities, nested HTML, multiple offices, and missing optional fields.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/search`

Expected: FAIL because current connectors return arrays, schedule nested loops, silently skip failures, and regex-parse Personio XML.

- [ ] **Step 3: Implement shared scheduler and diagnostic contract**

Use concurrency 5, request timeout 15 seconds, maximum two retries for 429/5xx/timeout, exponential delays of 250 ms then 500 ms, and no retry for other 4xx. Search scopes are round-robin and enforce the existing global result bound only after every scope's current round. Replace silent catches with `SourceDiagnostic` entries. Employer iteration catches per-employer failures. Keep all calls read-only and existing host restrictions.

For Personio, add the smallest dependency-free XML tokenizer needed by fixtures: decode named/numeric entities, unwrap CDATA, preserve nested text, and collect repeated `<office>` nodes. Do not use regex to match nested `<position>` elements.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/search`

Expected: all search tests PASS with deterministic counters/diagnostics.

- [ ] **Step 5: Commit Task 5**

```powershell
git add packages/search/src/types.ts packages/search/src/scheduler.ts packages/search/src/jobsuche.ts packages/search/src/freehire.ts packages/search/src/personio.ts scripts/cli.ts tests/search
git commit -m "feat(search): add fair resilient discovery diagnostics"
```

---

### Task 6: One-command daily workflow and persistent shortlist

**Files:**
- Create: `packages/workflows/src/daily.ts`
- Create: `packages/jobs/src/shortlist.ts`
- Modify: `packages/storage/src/repository.ts`
- Modify: `scripts/cli.ts`
- Modify: `package.json`
- Test: `tests/workflows/daily.test.ts`
- Test: `tests/jobs/shortlist.test.ts`
- Test: `tests/search/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export type DailyReport = { date: string; timezone: string; status: "success" | "partial" | "failed"; sources: SourceSummary[]; counts: { new: number; changed: number; reused: number; stale: number; actionable: number }; matches: ShortlistEntry[]; actions: string[] };
export async function runDaily(root: string, options?: { now?: Date }): Promise<DailyReport>;
export type ShortlistEntry = { shortId: string; jobId: string; title: string; company: string | null; location: string | null; sourceUrl: string | null; firstSeen: string; lastSeen: string; tier: string; fit: number; verdict: string; confirmedMatches: string[]; provisionalMatches: string[]; verify: string[]; documentState: string; applicationState: string | null };
```

- [ ] **Step 1: Add failing partial-daily, report persistence, and shortlist tests**

Fixture connectors return one successful source, one failed source, one new job, one changed job, and one stale historical job. Assert `status === "partial"`, successful jobs persist/evaluate, failed source diagnostics appear, failed scope does not age jobs, Markdown and JSON are saved under the same configured local date, and parsed JSON matches the returned report. Assert shortlist excludes tier C/X/BLOCKED/stale/superseded jobs and produces stable eight-character short IDs. `jobs show` resolves a unique prefix and errors clearly on none/ambiguous.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/workflows/daily.test.ts tests/jobs/shortlist.test.ts tests/search/cli.test.ts`

Expected: FAIL because workflow/shortlist modules and CLI commands do not exist.

- [ ] **Step 3: Implement daily orchestration, rendering, and CLI commands**

`runDaily()` validates the workspace, opens one repository, runs enabled sources independently, finishes each discovery run with correct status/counters, evaluates only new/changed current versions, builds the shortlist, and atomically writes `workspace/reports/YYYY-MM-DD.json` plus `.md`. Use `Intl.DateTimeFormat("en-CA", { timeZone })` for the configured date; add `timezone: Europe/Berlin` to search schema/example with safe setup merge.

CLI commands:

```text
bun run daily
bun run scripts/cli.ts jobs list [--limit 20]
bun run scripts/cli.ts jobs show --id <short-id-or-job-id>
```

Human output includes clickable public URLs, age/freshness, confirmed versus provisional evidence, verification questions, document/application state, and concise source health. JSON report remains machine-readable. Exit code is 0 for success/partial with at least one source success and 1 when every enabled source fails.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/workflows/daily.test.ts tests/jobs/shortlist.test.ts tests/search/cli.test.ts`

Expected: all focused tests PASS and reports are deterministic under injected time.

- [ ] **Step 5: Commit Task 6**

```powershell
git add packages/workflows/src/daily.ts packages/jobs/src/shortlist.ts packages/storage/src/repository.ts scripts/cli.ts package.json config/schemas/search.schema.json workspace.example/search.yml scripts/setup.ts tests/workflows/daily.test.ts tests/jobs/shortlist.test.ts tests/search/cli.test.ts
git commit -m "feat(workflow): add daily control loop and shortlist"
```

---

### Task 7: Documentation, full regression, and live read-only smoke

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/mvp-runbook.md`
- Modify: `scripts/cli.ts`
- Test: `tests/e2e/mvp-lifecycle.test.ts`

**Interfaces:**
- Produces accurate quick start/help for the Bun control loop and records verified test/live-smoke evidence.

- [ ] **Step 1: Add a failing CLI help assertion**

Assert `bun run scripts/cli.ts help` exits 0 and lists `daily`, `jobs list`, `jobs show`, `documents generate`, `applications`, and the no-submission boundary.

- [ ] **Step 2: Run help/E2E tests and verify RED**

Run: `bun test tests/e2e/mvp-lifecycle.test.ts tests/search/cli.test.ts`

Expected: FAIL because `help` is not implemented.

- [ ] **Step 3: Implement help and rewrite active documentation**

README quick start must use `bun install --frozen-lockfile`, `bun run setup`, `bun run doctor`, `bun run daily`, `bun run scripts/cli.ts jobs list`, and `documents generate`. State that Claude slash-command/Danish files are reusable upstream references, not the active authoritative workflow. AGENTS must no longer claim there are no live connectors. Runbook documents partial source failures, freshness semantics, synthetic test isolation, and troubleshooting.

- [ ] **Step 4: Run complete verification**

Run:

```powershell
bun test
bun run typecheck
python -m unittest discover -s tests -p "test_*.py"
python tools/security_guards.py
bun run doctor
git diff --check
```

Expected: all Bun/Python tests and typecheck pass; security guards say OK; doctor has no errors (real-profile readiness warnings are allowed); diff check has no errors.

- [ ] **Step 5: Run bounded live read-only smoke**

Run BA and enabled employer discovery with the current workspace, confirm at least one source succeeds, inspect the saved daily report, and verify output ends with `No application was submitted.` No live test may call submission/candidate endpoints.

- [ ] **Step 6: Commit Task 7**

```powershell
git add README.md AGENTS.md docs/mvp-runbook.md scripts/cli.ts tests/e2e/mvp-lifecycle.test.ts tests/search/cli.test.ts
git commit -m "docs: document reliable daily control loop"
```

## Final review gate

After Tasks 1–7, generate a full branch review package from the pre-plan base commit, dispatch a fresh whole-branch reviewer, fix every Critical/Important finding in one fix wave, rerun the complete verification commands, and push the branch only after the reviewer approves.

The next independent plan starts only after this milestone is green: `2026-07-13-sources-and-verified-prepare.md` will cover NTT Workday, SmartRecruiters, Amazon Jobs, separate EN/DE LaTeX/PDF artifacts, ATS/page validation, and supervised form-fill preview.
