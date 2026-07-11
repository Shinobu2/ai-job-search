# Job Evaluation Vertical Slice Design

## Goal

Deliver the first user-visible, local-only flow:

```text
vacancy text or local file
→ normalized job and deduplication
→ structured requirements
→ archetype, gates, evidence mapping and deterministic scores
→ persisted evaluation, result card and JSON export
```

The commands are `job:import`, `job:evaluate`, `job:export`, and `job:check`.
`job:check` is the demonstration command and runs the whole flow for one local
file. `job:export` writes the same structured result to stdout and to
`workspace/exports/<job-id>.json`.

## Boundaries

The existing YAML workspace, SQLite migrations, transaction helpers and
capability registry remain unchanged as foundations. The new logic lives in
one compact `packages/jobs/` module; it uses `packages/storage/` only for
persistence. No new connector, browser automation, submission, email,
calendar, document generation, proof builder, or advanced analytics is in
scope.

## Import and persistence

`job:import` accepts `--text` or `--file`, with an optional `--url` metadata
flag. Supported files are text, Markdown, and local HTML. HTML is converted to
visible text before normalization while the original bytes and SHA-256 hash are
persisted as the source snapshot.

Deduplication resolves in order: canonical source URL, source identifier,
normalized company/title/location, then content hash. A duplicate returns the
existing job ID and does not create a second source/job pair. SQLite remains
the durable store for source snapshots, normalized jobs, evaluations and
exports; YAML remains the editable candidate evidence vault.

## Extraction and evaluation

The module produces a versioned validated requirement object with all fields
required by the approved milestone: role and workplace details, employment and
contract type, salary, languages, education, experience, skills,
certifications, shift/on-call/car/physical requirements, training, seniority,
deadline, and explicit uncertainties. Normal test fixtures use a deterministic
mock extraction table. Missing posting facts stay `unknown`.

Final archetypes are constrained by versioned taxonomy rules: `A`, `AT`, `BT`,
`F`, and `X`. UPS, generator, high-voltage, HVAC, and critical-switching work
is facilities work and is never silently treated as ordinary data-center
hardware.

Gates return pass, risk, verify, or block information. A blocker overrides
scores. Mandatory nights, own car, continuous heavy labour, non-IT
warehouse/conveyor work, untrained electrical/HVAC qualification, German B2/C1
without English alternative, senior-only experience, salary below the configured
floor, and an expired reliable deadline are blockers. Unknown shift, transport,
address, or salary facts decrease confidence and appear in `VERIFY`.

Evidence mapping has only `proven`, `partial`, `transferable`, `missing`,
`unknown`, and `contradicted`. Proven/partial mappings cite evidence IDs. The
evaluator never promotes home lab to employment, Discord help to professional
support, theory to hands-on practice, planned learning to completed skill, or
school education to German Ausbildung/degree equivalence.

Fit, survival, confidence, tier, and verdict use deterministic versioned rules.
Survival uses only verified, currently available candidate facts. The evaluator
does not call a model to invent weights; model-assisted extraction is optional
outside deterministic fixture tests.

## User output and errors

`job:evaluate --id` evaluates a persisted job and records an immutable result.
`job:export --id` prints and saves JSON. `job:check --file` imports/reuses,
evaluates, persists, prints the concise card, and exports JSON. CLI errors are
actionable for missing input, unsupported local file type, unknown job ID, and
malformed workspace data. The demo remains stable across repeated runs.

## Tests

Saved local fixtures cover AT, A, BT, unqualified facilities, F, night, car,
German, unknown-shift, evidence truthfulness, deterministic repeated scoring,
blocker override, fit/survival independence, duplicate import, SQLite reopen,
and JSON export. No test calls a network or model.
