# Task 2 implementation report

## Scope

Implemented only Task 2: checksum-protected SQLite migrations, transactional
operational storage, an explicit capability registry, and local setup/doctor/
capability-list wiring. No manual vacancy import, extraction, evaluation,
document generation, connector, browser, outreach, or submission behavior was
implemented.

## TDD evidence

### RED

1. `C:\Users\Emperor\.bun\bin\bun.exe test tests/storage`
   - Exit 1. The three suites failed because
     `packages/storage/src/capabilities`, `migrate`, and `database` did not
     exist. This established the migration, repository, and registry APIs.
2. `C:\Users\Emperor\.bun\bin\bun.exe test tests/setup/setup.test.ts`
   - Exit 1 after adding the SQLite setup regression. The new test expected
     `workspace/control-room.sqlite` after setup and received `false` because
     setup did not yet initialize storage.

### GREEN

1. `C:\Users\Emperor\.bun\bin\bun.exe test tests/storage`
   - Exit 0; 7 pass, 0 fail, 22 expectations. Covers fresh/repeated
     migrations, checksum rejection, FK enforcement, import rollback,
     reopen persistence, immutable events, duplicate run-key history, explicit
     capability certification, and Stage 1 effective mode.
2. `C:\Users\Emperor\.bun\bin\bun.exe run typecheck`
   - Exit 0; `tsc --noEmit` completed cleanly.
3. `C:\Users\Emperor\.bun\bin\bun.exe test tests/config/workspace-schemas.test.ts tests/setup/setup.test.ts`
   - Exit 0; 13 pass, 0 fail, 28 expectations. This includes the new setup
     storage-initialization regression and preserved Task 1 coverage.
4. `python tools/security_guards.py`
   - Exit 0; `security_guards: OK (permissions allowlist, gitignore rules,
     package manifests)`.
5. `git diff --check`
   - Exit 0.

## Changed files

- Migrations and SQLite opening/migration support:
  `packages/storage/migrations/001_stage1.sql`,
  `packages/storage/migrations/002_capabilities.sql`,
  `packages/storage/src/database.ts`, and
  `packages/storage/src/migrate.ts`.
- Atomic job/evaluation operational storage:
  `packages/storage/src/repository.ts`.
- Capability definitions and lifecycle enforcement:
  `config/capability-definitions.json` and
  `packages/storage/src/capabilities.ts`.
- Runtime wiring: `scripts/setup.ts`, `scripts/doctor.ts`, and
  `scripts/cli.ts`.
- Tests: `tests/storage/migrations.test.ts`,
  `tests/storage/persistence.test.ts`,
  `tests/storage/capabilities.test.ts`, and the storage setup assertion in
  `tests/setup/setup.test.ts`.

## Assumptions

- The initial registry contains 17 deliberately named Stage 1 capabilities:
  currently delivered workspace/storage/registry capabilities begin
  `implemented`; evaluation/document/PDF/export capabilities remain
  `unavailable`; remote or submission-adjacent capabilities are `disabled`.
- SQLite is an immutable operational record, not an Evidence Vault. Evidence
  mappings contain only evidence IDs, the snapshot hash, evaluator payload, and
  provenance; they never store mutable candidate evidence records.
- `configured_mode` remains user configuration in YAML. The registry computes
  `effective_mode` in memory and returns `prepare_only` for every Stage 1 mode,
  including `supervised_auto`.
- `certify()` is the only route to `certified`; it requires `tested`, an actor,
  reason, SHA-256 report hash, and explicit passing evidence. All transitions
  append an event history row.

## Self-review

- `openDatabase` enables and verifies FK enforcement, sets a 5-second busy
  timeout, and uses WAL/NORMAL only for file databases.
- Migrations are ordered, checksummed against their current bytes, and applied
  in immediate transactions. A changed applied file aborts migration.
- Imports and evaluation graphs run in immediate transactions. The run key is
  unique and returns the historical evaluation instead of overwriting it.
- Every derived evaluation table stores creation time, evaluator version, and
  JSON-valid provenance. Event update/delete triggers reject mutation.
- Changes are scoped to Task 2. The CLI only exposes a read-only capability
  listing; it does not add the future job import/evaluation/export workflows.

## Review fix wave: evidence references and run-key serialization

### Root causes

1. `EvaluationInput.evidenceMappings` was structurally typed as an arbitrary
   record and `insertMappings()` persisted `JSON.stringify(row)`. A caller
   could therefore send mutable evidence content and turn SQLite into a second
   Evidence Vault.
2. The original `evidence_mappings.requirement_id` column had no foreign key
   to `extracted_requirements`, so an evaluation could persist an orphaned
   mapping.
3. `persistEvaluation()` read `run_key` before it started its immediate
   transaction. A competing writer could insert the same key in the resulting
   check-then-act window.

### RED

`C:\Users\Emperor\.bun\bin\bun.exe test tests/storage/migrations.test.ts tests/storage/persistence.test.ts`
exited 1 with all three intended failures:

- expected migration `003_evidence_mapping_requirement_fk.sql` was absent;
- a mapping containing `mutableEvidenceContent` was accepted; and
- a mapping pointing to `req_missing` committed instead of rolling back.

### Fix and GREEN

- Added `003_evidence_mapping_requirement_fk.sql`, which rebuilds the mapping
  table with `requirement_id REFERENCES extracted_requirements(id)` without
  changing an already-checksummed migration.
- Replaced arbitrary mapping records with an explicit ID/hash/provenance input
  shape. Runtime validation rejects extra properties and persistence writes a
  freshly constructed whitelist payload, never caller-provided evidence text.
- Moved the duplicate lookup inside the same `immediate()` transaction as the
  insert. A two-connection regression injects a competing same-key write at
  the duplicate lookup: the primary write succeeds while the competing writer
  is locked out, proving there is no pre-transaction check window.

1. `C:\Users\Emperor\.bun\bin\bun.exe test tests/storage/persistence.test.ts`
   - Exit 0; 6 pass, 0 fail, 16 expectations, including the two-connection
     run-key regression.
2. `C:\Users\Emperor\.bun\bin\bun.exe test tests/storage/migrations.test.ts tests/storage/persistence.test.ts`
   - Exit 0; 7 pass, 0 fail, 19 expectations.
3. `C:\Users\Emperor\.bun\bin\bun.exe run typecheck`
   - Exit 0; `tsc --noEmit` completed cleanly.
