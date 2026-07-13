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
