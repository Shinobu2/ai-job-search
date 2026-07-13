# Reliable Daily Application Control Loop Design

## Objective

Turn the existing read/import/evaluate prototype into a dependable daily job-search control loop that finds current relevant vacancies, explains rankings, prepares truthful ATS-readable English and German application documents, and assists with form filling. The system may automate discovery, preparation, validation, and preview, but a real application is submitted only after the user explicitly confirms that exact application.

The system optimizes for accurate keyword coverage, clear human-readable writing, and evidence-backed tailoring. It does not attempt to deceive AI or human reviewers, fabricate experience, or guarantee an interview.

## Scope and delivery order

1. Establish an isolated synthetic-candidate end-to-end test.
2. Close known safety and correctness gaps.
3. Add persistent discovery runs, vacancy freshness, and source diagnostics.
4. Add a single daily command and persistent shortlist UX.
5. Harden and normalize existing connectors.
6. Add NTT Workday, SmartRecruiters, and Amazon Jobs sources.
7. Add a verified `prepare` workflow for CV and cover-letter artifacts.
8. Add supervised form-fill preview while retaining manual final submission.
9. Replace stale Claude/Danish documentation with the current Bun workflow.

UI work and broad source expansion are postponed until this control loop is proven reliable.

## Safety boundary

- The real `workspace/` remains the only candidate-fact authority.
- Synthetic facts exist only under test fixtures and temporary test workspaces. The synthetic identity must visibly say `SYNTHETIC TEST CANDIDATE — DO NOT SUBMIT` and use `example.com` contact data.
- Unknown requirements remain `VERIFY`; missing extraction must never become `PASS`.
- Only user-confirmed or document-verified identity and evidence may make an artifact ready.
- Fit may show provisional user-reported evidence separately, but it must not be described as verified or as a strong confirmed match.
- Application state transitions are enforced below the CLI boundary.
- Readiness is bound to hashes of the job snapshot, evaluation, evidence snapshot, and generated artifacts. Editing a metadata boolean is insufficient.
- Connectors perform bounded read-only public vacancy access. They never call application, candidate, outreach, email, or credential endpoints.
- Browser assistance may populate a preview using an approved artifact packet. It must show the exact values and attachments before submission. The final submit action requires explicit confirmation for that application and is never batched.

## Architecture

### Synthetic lifecycle harness

An end-to-end test copies `workspace.example/` into a temporary directory, overlays an explicitly synthetic confirmed profile/evidence fixture, and drives the public CLI through import, evaluation, export, document preparation, state tracking, and daily reporting. It verifies database events and effective `prepare_only` mode and never reads or mutates the repository's real `workspace/`.

### Domain correctness layer

Critical gates treat absent transport, physical, shift, language, deadline, and salary requirements conservatively. Source adapters normalize explicit facts from descriptions before evaluation, including German negation and shift phrases. Evidence mapping prefers verified exact evidence over weaker or contradictory informal evidence. Identity readiness validates value, verification status, and provenance.

Application transitions move into a domain/repository service. The CLI remains a presentation layer and cannot bypass the same rules used by tests or future automation.

### Persistent discovery and freshness

SQLite records a discovery run with configured source, query/city coverage, start/end time, success/partial/failure status, counters, and bounded diagnostics. Each observed posting has a logical vacancy identity and immutable content versions with first-seen, last-seen, and latest-version projection.

A posting is not marked closed after one connector error or one missed run. It becomes stale only after conservative repeated successful runs of the same source/query scope fail to observe it. Cross-source records are not merged solely by title/company/location; stable source identity or exact canonical URL is required unless a separately auditable high-confidence link is introduced later.

Search scheduling distributes the result budget fairly across keyword/city combinations. Detail reads use bounded concurrency, timeout, limited retry/backoff for transient failures, and per-item diagnostics. One source or employer failure does not discard successful results from other sources.

### Daily workflow and shortlist

`bun run daily`:

1. validates workspace and tools;
2. runs every enabled source independently;
3. persists new, changed, reused, skipped, and stale observations;
4. evaluates new/changed latest versions;
5. builds a freshness-aware non-blocked shortlist;
6. saves `workspace/reports/YYYY-MM-DD.md` and `.json` in the configured timezone;
7. prints a concise source-health summary, top matches, verification questions, and due actions;
8. never prepares or submits applications implicitly.

Persistent commands provide `jobs list`, `jobs show <short-id>`, and `prepare <short-id>`. Entries include source URL, employer, location, observed age, fit/tier, confirmed and provisional evidence, blockers, verification questions, document state, and application state. Tier C and excluded/blocked roles are retained for audit but not labeled actionable.

### Connector contract

All connectors return normalized discoveries plus structured diagnostics. Raw public payloads and canonical public posting URLs are preserved. Hosts are allowlisted, redirects outside allowlisted hosts are rejected, page/result limits are fixed, and requests are rate-limited.

Existing BA Jobsuche, FreeHire, and Personio adapters are hardened first. Personio XML handling must support CDATA, entities, nested HTML, multiple locations, and missing optional fields.

New sources:

- NTT Global Data Centers Workday public career tenant, using bounded search and detail reads only.
- SmartRecruiters documented public Posting API with a curated, configurable company registry.
- Amazon Jobs public search and official detail pages, treated as an undocumented read surface with conservative limits and fixtures.

Digital Realty Oracle remains disabled/experimental until access-policy uncertainty is resolved. LinkedIn automated import is not added because of terms risk. Equinix API access remains manual because robots policy disallows it.

### Verified preparation workflow

`prepare <short-id>` archives the exact posting/evaluation/evidence snapshots and generates four separate artifacts: English CV, German CV, English cover letter, and German cover letter. Generation uses only confirmed facts and vacancy-supported terminology.

The workflow compiles PDFs using the configured LaTeX templates, verifies page limits, extracts the ATS text layer, checks literal contact details and reading order, measures truthful supported keyword coverage, and rejects unsupported keyword stuffing. A reviewer pass critiques relevance, specificity, language quality, and consistency before final artifacts are accepted.

The packet records hashes and validation results. Tracker status can become `ready_for_review` only when all required checks pass for the current job/evaluation/evidence snapshots.

### Supervised application assistance

After the preparation workflow is stable, a site-specific browser adapter may open the official application page, fill fields, and attach the approved files. It captures a preview and reports unsupported/ambiguous questions rather than guessing. The user must explicitly approve the exact target, field values, attachments, and declarations before the adapter can perform the final submit action.

No generic blind form filler, credential storage, mass submission, stealth behavior, CAPTCHA bypass, or automated email outreach is in scope.

## Error handling

- Source-level errors produce partial daily success when other sources succeed.
- Item-level malformed/expired details are counted and diagnosed without aborting the source.
- Transient 429/5xx/timeout responses receive bounded retry with backoff; permanent 4xx errors do not.
- Malformed payloads are failures, not successful empty searches.
- Failed or partial runs never age vacancies toward stale/closed.
- Failed artifact checks preserve diagnostics and leave application readiness unchanged.
- Browser ambiguity stops at preview and requests user input; it never invents an answer.

## Testing and acceptance

Each behavior is developed RED-GREEN-REFACTOR with focused tests and reviewed commits.

Acceptance requires:

- the synthetic lifecycle passes through the public CLI without touching real workspace data;
- critical unknowns yield `VERIFY` and confirmed negations are interpreted correctly;
- document readiness cannot be forged with unverified identity or edited metadata;
- repository-level transition tests reject invalid application sequences;
- fair discovery coverage and partial outage diagnostics are tested deterministically;
- logical vacancy versions preserve history and daily output excludes superseded/stale records from actionable results;
- `bun run daily` saves matching Markdown and JSON reports and succeeds partially when one source fails;
- existing and new adapters have fixture contract tests plus bounded live smoke checks;
- `prepare` produces separate PDFs whose page counts and ATS text layers pass validation;
- supervised form-fill tests stop before submit unless an explicit per-application confirmation is supplied;
- the full Bun, Python, TypeScript, security, and PDF smoke suites pass.

## Reused upstream components

Reuse the upstream LaTeX CV and cover-letter templates, application drafter/reviewer guidance, relevance-weighted CV cutting, ATS text-layer checks, outcome archive format, interview preparation framework, and template-registration concepts. Adapt their useful logic into the local deterministic workflow instead of relying on Claude-only slash commands or the legacy CSV as authoritative state.

## Explicit postponements

- graphical UI;
- large numbers of low-confidence job sites;
- Digital Realty Oracle enabled by default;
- LinkedIn scraping;
- unsupervised or bulk submission;
- automatic answers to legal, salary, demographic, or consent questions;
- guarantees about bypassing AI screening or receiving interviews.
