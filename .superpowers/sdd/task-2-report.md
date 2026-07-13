# Reliability Foundation Task 2 report

## Scope

Implemented repository-level application transition enforcement and persisted
document-packet attestation. Document generation now writes four separate
Markdown artifacts plus metadata, computes SHA-256 hashes for the exact written
contents, records the evaluation and evidence bindings in SQLite, and exposes
the packet ID and hashes in generated metadata and CLI output. The CLI delegates
state validation to `StorageRepository` and only translates `--confirm yes` to
the repository's `confirmed` option.

## Changed files

- `packages/storage/migrations/005_document_packets.sql`
- `packages/storage/src/repository.ts`
- `packages/documents/src/generate.ts`
- `scripts/cli.ts`
- `tests/storage/migrations.test.ts`
- `tests/tracking/tracking.test.ts`
- `tests/tracking/cli.test.ts`
- `.superpowers/sdd/task-2-report.md`

`.superpowers/sdd/progress.md` was intentionally excluded from the Task 2
commit.

## TDD evidence

### Inherited RED

The prior Task 2 RED run of
`bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts`
reported **1 pass and 5 failures**. The failures demonstrated the intended
gaps: migration `005_document_packets.sql` and the packet repository API were
missing, application transitions were not enforced by the repository, and a
forged `metadata.json` readiness boolean was accepted by the CLI.

### GREEN

1. Focused Task 2 suite:
   `bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts`
   exited 0 with **7 pass, 0 fail, 32 expectations**.
2. Full suite: `bun test` exited 0 with **96 pass, 0 fail, 316 expectations**.
3. Type check: `bun run typecheck` exited 0.

## Behavior verified

- Migration 005 creates the packet-attestation table and remains repeatable
  under the migration checksum mechanism.
- Packet records require a persisted matching evaluation, the evaluation's
  evidence snapshot hash, metadata plus four named artifact hashes, and valid
  SHA-256 values.
- `readCurrentDocumentPacket()` returns the latest persisted packet and parsed
  artifact hashes.
- The repository enforces
  `none -> shortlisted -> ready_for_review -> user_submitted -> interview -> offer`.
- `ready_for_review` requires the latest packet to be ready and bound to the
  latest evaluation fingerprint; its attested directory becomes the
  application's document directory.
- `user_submitted`, `interview`, `offer`, `rejected`, and `withdrawn` require
  explicit confirmation. Rejection and withdrawal also require an existing
  application.
- Editing or creating document metadata without a persisted packet cannot
  advance an application to `ready_for_review`.

## Self-review and concerns

- The patch stays within the Task 2 files and preserves the existing Stage 1
  prepare-only boundary; it adds no submission or browser behavior.
- Markdown remains the artifact format permitted by this milestone.
- Metadata contains the packet ID, job snapshot hash, evaluation fingerprint,
  evidence snapshot hash, and the four artifact hashes. The metadata file's own
  hash is stored in the database and CLI result rather than recursively inside
  itself.
- No open Task 2 correctness concern was found in the final diff review.

---

## Attestation review correction

### Findings reproduced

Review against `d37602f` confirmed five related gaps:

1. Migration 005 stored only a job ID and evaluation fingerprint, not the exact
   job snapshot hash or evaluation-run ID. The real workspace database had only
   migrations 001-004 applied, so migration 005 remained safe to amend without
   causing a checksum mismatch.
2. `ready_for_review` trusted packet-row hashes without reading the current
   artifact bytes. Modified or missing files therefore remained review-ready.
3. Packet directories were caller-controlled and were not confined to the
   exact `workspace/documents/<job-id>/<packet-id>` directory.
4. A newer evaluation run with the same semantic fingerprint did not stale the
   earlier packet because only the fingerprint was compared.
5. Document generation wrote directly into one mutable per-job directory, so a
   later generation replaced the bytes referenced by an earlier packet.

### Review RED

Command:

```powershell
bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts
```

Result: exited 1 with **4 pass, 5 fail, and 26 expectations**. The failures
showed the missing schema columns, shared mutable output directory, acceptance
of a forged job snapshot, acceptance of modified artifact bytes, and acceptance
of a stale evaluation run whose fingerprint matched the latest run.

Self-review then added a cross-job packet-directory regression. Its targeted RED
run exited 1 with **0 pass, 1 fail, 4 filtered tests, and 4 expectations** because
a packet for job `j` could point at `workspace/documents/other/packet-z`.

### Correction

- Migration 005 now persists `job_snapshot_hash` and the foreign-keyed
  `evaluation_run_id` in addition to the fingerprint and evidence snapshot.
- Packet recording verifies the exact job snapshot, evaluation run, fingerprint,
  and run-scoped evidence snapshot before insertion.
- `ready_for_review` requires the latest evaluation-run ID and rechecks every
  current artifact file, including metadata, against its SHA-256 byte hash.
- Artifact verification resolves from the configured workspace root, rejects
  traversal, symlinked packet/file targets, and any directory other than the
  packet-specific job path.
- Document generation writes all five files to a packet-specific staging
  directory, atomically renames the directory into place, and cleans up an
  unattested promoted directory if recording fails. A later generation creates
  a new directory and leaves earlier packet bytes unchanged.

### Review GREEN and final verification

Focused command:

```powershell
bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts
```

Result: exited 0 with **9 pass, 0 fail, and 42 expectations**.

Repository-wide verification:

```powershell
bun test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
bun run typecheck
```

Result: exited 0 with **98 pass, 0 fail, and 326 expectations**, followed by a
clean `tsc --noEmit` run. The real workspace database was inspected read-only
and was not migrated or otherwise mutated.

---

## Identifier-boundary re-review correction

### Root cause and RED

The packet-specific directory comparison constructed its expected path with
`resolve(documentsRoot, jobId, packetId)` before validating either identifier.
A packet ID such as `../other/packet-z` therefore normalized to another job's
directory and could make the later equality check succeed.

Targeted RED:

```powershell
bun test tests/tracking/tracking.test.ts --test-name-pattern "modified, missing, and traversal"
```

Result: exited 1 with **0 pass, 1 fail, 4 filtered tests, and 5 expectations**.
`packetId="../other/packet-z"` was accepted and persisted instead of being
rejected as a non-segment identifier.

### Correction and additional coverage

- `recordDocumentPacket()` now validates both packet ID and job ID against a
  single safe path-segment grammar before any database lookup or path
  resolution. Dots inside an identifier remain supported, while `.`, `..`,
  slashes, backslashes, and separator-based traversal are rejected.
- The existing safe cross-job directory regression remains in place.
- A Windows junction capability probe succeeded, so a non-skipped regression
  now proves that a packet routed through a job-directory ancestor junction is
  rejected after real-path comparison.
- A deterministic CLI regression changes the evidence snapshot after
  evaluation, forces attestation recording to fail after directory promotion,
  and verifies that the promoted packet directory is removed.

Focused GREEN:

```powershell
bun test tests/storage/migrations.test.ts tests/tracking/tracking.test.ts tests/tracking/cli.test.ts
```

Result: exited 0 with **11 pass, 0 fail, and 49 expectations**.

Final repository verification:

```powershell
bun test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
bun run typecheck
```

Result: exited 0 with **100 pass, 0 fail, and 333 expectations**, followed by a
clean `tsc --noEmit` run.
