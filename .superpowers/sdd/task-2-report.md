# Job-evaluation Task 2 report

## Scope

Implemented only deterministic Stage 1 evaluation: versioned role taxonomy,
ordered gates, evidence mappings, fit/survival/confidence/tier/verdict,
deterministic fingerprints, and an immutable `persistEvaluation` payload.
No card, CLI command, network, model, connector, document, or submission
behavior was added. Task 1 import and extraction were consumed unchanged.

## Changed files

- `config/role-taxonomy.json` and `config/evaluation-rules.json`
- `packages/jobs/src/rules.ts`, `packages/jobs/src/evaluate.ts`, and
  `packages/jobs/src/types.ts`
- `packages/storage/src/repository.ts`
- `tests/jobs/evaluate.test.ts` and the four Task 2 job fixtures:
  `night-shift.md`, `own-car.md`, `german-b2.md`, and `unknown-shift.md`

## TDD evidence

### RED

1. `C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/evaluate.test.ts`
   exited 1 with `Cannot find module '../../packages/jobs/src/evaluate'`.
   The named classification/gate suite was present and the evaluator did not
   yet exist.
2. After adding the classification/gate implementation, the expanded evidence,
   scoring, and persistence-payload test was added first. The same command
   exited 1 with `Export named 'buildEvaluationInput' not found`, establishing
   the absent persisted-evaluation graph API.

### GREEN

1. `C:\Users\Emperor\.bun\bin\bun.exe test tests/jobs/evaluate.test.ts tests/storage`
   exited 0: 17 pass, 0 fail, 73 expectations.
2. `C:\Users\Emperor\.bun\bin\bun.exe run typecheck` exited 0.
3. `git diff --check` exited 0.

## Gate precedence and evidence facts

- Classification is config-backed and deterministic: forced X, AT, BT, A, F,
  then X. Facilities cues outrank generic hardware cues; a facilities trainee
  remains BT while explicitly excluded/high-voltage roles are X.
- Gates are emitted in config order: archetype, shift, transport, physical,
  scope, facilities, language, experience, salary, deadline. Each includes its
  decisive posting/profile fact references. Any `BLOCKED` result forces verdict
  `BLOCKED` and tier C; critical `VERIFY` caps an otherwise higher tier at B.
- Verified current profile facts alone feed survival; no relevant verified fact
  yields `null`. Fit is derived solely from integer mapping credits and does
  not change when verified profile facts change.
- Schema-valid direct evidence is `partial`; mappings include evidence IDs.
  Planned/home-lab/theory claims are
  `unknown`; Discord is never professional support; education/Ausbildung/degree
  language is not treated as equivalence.
- The persistence input includes both config versions as system provenance,
  stable requirement and derived-row IDs, evidence snapshot SHA-256, mapping
  status/credit, ordered gates, fit/survival scores, tier/confidence, and the
  recommendation. Repository validation whitelists these immutable mapping
  fields and still rejects mutable candidate evidence content.

## Concerns

- The extractor currently creates material requirements from the skills field;
  evaluation safely handles any additional future requirement types without
  promoting unsupported candidate claims.
- Salary blocks only when an explicit net-monthly amount can be compared to a
  verified candidate floor. Gross or ambiguous salary remains VERIFY rather
  than receiving a fabricated conversion.

## P1 review corrections

### Root causes

1. `verified()` accepted every status except `unknown`, so rejected and expired
   profile values could block gates.
2. The language gate treated any lowercase `english` mention as an alternative,
   including explicit rejection and preference-only wording.
3. Evidence matching filtered planned-project kinds only in the exact path;
   home-lab/planned/theory statements could still receive exact or transferable
   ordinary-skill credit.

### RED

`bun test tests/jobs/evaluate.test.ts` exited 1 with three targeted regressions:

1. A rejected false car value produced a `BLOCKED` transport gate rather than
   `VERIFY`.
2. `German B2 required; english not accepted` produced a `PASS` language gate.
3. Home-lab hardware and networking-theory records produced `partial`, and a
   home-lab hardware record produced `transferable`, mappings rather than
   evidence-free `unknown` mappings.

### GREEN

`bun test tests/jobs/evaluate.test.ts` exited 0: 10 pass, 0 fail, 49
expectations. The evaluator now limits verified values to `user_confirmed` and
`document_verified`, recognizes only explicit English alternatives, and
filters home-lab/planned/theory evidence before exact or transferable matching.

## P1 re-review corrections

### Root causes

1. The English-acceptance fallback considered any `English is accepted` phrase
   to be a German alternative, even when the posting stated that English was
   accepted in addition to mandatory German.
2. Origin guards only matched the space-separated phrase `home lab`; a
   hyphenated `home-lab` record could enter exact evidence matching and become
   `proven`.
3. A verified German level at or above the posting requirement did not have a
   success branch, so it fell through to the critical `VERIFY` result and did
   not contribute its profile fact to survival.

### RED

Each regression was added and run separately with
`bun test tests/jobs/evaluate.test.ts` before its implementation change:

1. `German B2 required; English is accepted in addition` returned a `PASS`
   language gate instead of blocking verified A2 German.
2. A `Home-lab hardware troubleshooting` record with reviewer status
   `verified` mapped an ordinary `hardware troubleshooting` requirement as
   `proven` with evidence ID `HOME_LAB`, rather than evidence-free `unknown`.
3. Verified German B2 against a German B2 requirement returned critical
   `VERIFY` with no profile fact rather than `PASS` and
   `profile.languages.german`.

### GREEN

After each minimal evaluator change, the same focused suite exited 0:

1. English acceptance now requires an explicit alternative phrase (or an
   `or`/`/` construction), so additive English remains additive and verified
   insufficient German blocks.
2. Home-lab origin guards recognize both `home lab` and `home-lab` before
   exact or transferable evidence matching.
3. A verified German level that meets B2/C1 now emits a critical `PASS` gate
   with `profile.languages.german`; its verified fact remains part of the
   survival calculation (the regression evaluates survival as `100`).

## Final review corrections

### Root causes

1. The explicit German-or-English path returned `PASS` before inspecting the
   candidate's English fact, allowing missing, rejected, expired, or
   insufficient English to pass a critical language gate.
2. Exact evidence matching recognized a `reviewer_status: verified` value even
   though `config/schemas/evidence.schema.json` only permits `unreviewed` and
   `UNKNOWN`; this made a schema-impossible `proven` mapping reachable in
   tests and code.

### RED

`bun test tests/jobs/evaluate.test.ts` exited 1 for each new language
regression before its matching implementation change:

1. A posting with `German B2 required or English` and no verified English
   produced `PASS` rather than critical `VERIFY`.
2. The same posting with document-verified English A2 produced `PASS` rather
   than critical `BLOCKED` with `profile.languages.english` as its fact.

### GREEN

1. `bun test tests/jobs/evaluate.test.ts tests/config/workspace-schemas.test.ts`
   exited 0: 25 pass, 0 fail, 75 expectations.
2. Explicit alternatives now require `user_confirmed` or `document_verified`
   English at or above the stated B2/C1 level: missing/unverified values
   `VERIFY`, verified insufficient values `BLOCK`, and sufficient verified
   values `PASS` with the English profile fact.
3. The invalid `reviewer_status: verified` fixture was changed to
   `unreviewed`; a schema-aware regression proves that `verified` is rejected
   and an exact schema-valid unreviewed record maps only to `partial`.

## German-or-English symmetry correction

### RED

`bun test tests/jobs/evaluate.test.ts` exited 1: a posting with `German B2
required or English`, document-verified German B2, and no English fact
returned critical `VERIFY` because the alternative branch inspected English
only.

### GREEN

`bun test tests/jobs/evaluate.test.ts tests/storage` exited 0: 28 pass, 0
fail, 89 expectations; `bun run typecheck` exited 0. Explicit alternatives
now pass for either verified sufficient German or English, block only when
both verified alternatives are insufficient, and otherwise remain `VERIFY`.

## Salary-floor closure

### RED

`bun test tests/jobs/evaluate.test.ts` exited 1: a posting with an explicit
€2,000 net monthly salary returned `PASS` with `Explicit net salary meets the
verified floor` when the candidate floor was either absent or unverified.

### GREEN

`bun test tests/jobs/evaluate.test.ts` exited 0: 19 pass, 0 fail, 61
expectations. A parsed net monthly salary now returns `VERIFY` with `Candidate
salary floor needs verification` unless the candidate has a current verified
numeric `floor_eur`; only then can the comparison result in `BLOCKED` or
`PASS`.

## Salary-format P1 correction

### Root cause

The salary gate deleted both `.` and `,` from an explicit net-monthly amount
before numeric conversion. Consequently, the unambiguous German amount
`€1.200,00 net per month` was interpreted as `120000` rather than `1200` and
could incorrectly pass a verified €1,750 candidate floor.

### RED

`bun test tests/jobs/evaluate.test.ts` exited 1 with two targeted regressions:

1. The German-formatted €1,200 amount did not produce a blocking salary gate.
2. The locale-ambiguous comma-only format `€1,200 net per month` was treated
   as a blocking €1,200 amount rather than remaining `VERIFY`.

### GREEN

The evaluator now compares only explicit `€... net per month` values in either
plain digits or strict German decimal/thousands notation. It parses
`€1.200,00` as `1200`; separator-only ambiguous forms are deliberately not
guessed and return `VERIFY` with the deterministic-comparison reason.

## Unknown shift and deadline closure

### RED

`bun test tests/jobs/evaluate.test.ts` exited 1: `Shift: TBD` was a critical
`PASS`, and `Deadline: TBD` was a non-expired `PASS`.

### GREEN

Placeholder shift values (`TBD` and `unknown`) now produce critical `VERIFY`.
Deadlines must be calendar-valid ISO dates before they can pass or block; a
reliable past ISO date still blocks, while non-ISO or invalid values remain
`VERIFY`.
