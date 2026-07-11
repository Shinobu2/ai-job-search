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
- Direct evidence is `partial` unless a verified record proves it. Proven and
  partial mappings include evidence IDs. Planned/home-lab/theory claims are
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
