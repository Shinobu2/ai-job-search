# Expanded Chatbot Search Defaults

Date: 2026-08-01
Status: approved design

## Objective

Make the broad Frankfurt/Rhine-Main job search available by default to both local agents and cloud chatbots that read this repository, without tracking the candidate's private `workspace/` files or creating a second search configuration system.

## Existing system

- `workspace.example/search.yml` is the tracked source of workspace defaults.
- `scripts/setup.ts` creates `workspace/search.yml` and merges newly shipped default objects into an existing local workspace while preserving the user's existing scalar and array values.
- Search commands load only `workspace/search.yml` at runtime.
- `.agents/skills/job-hunt/` tells local and cloud chatbots how to conduct the search.
- `workspace/*` remains ignored by Git to protect personal data and locally generated documents.

## Decision

Use the existing tracked template and agent instructions as the canonical distribution mechanism.

1. Expand `workspace.example/search.yml` with the approved cities and role families.
2. Represent customer and back-office work as a distinct `customer_ops` track instead of a second source entry with the existing `bridge` track.
3. Update the job-hunt skill and Germany-search reference so local agents synchronize defaults before searching and cloud chatbots reproduce the same coverage when no local shell or workspace is available.
4. Keep `workspace/search.yml` as the private runtime configuration and do not force-add it to Git.

## Default search coverage

The default configuration will contain five active semantic tracks:

- `datacenter`: data-centre hardware, remote hands, NOC, monitoring and entry-level infrastructure operations.
- `bridge`: light technical production, electronics quality, IT rollout, break/fix, test operation and other realistic technical transition roles.
- `customer_ops`: English-friendly customer support, customer operations, back office, claims operations, trust and safety, content moderation, gaming/community support and related administrative work.
- `airport_logistics`: airport customer operations, passenger service, light coordination, dispatch and English-friendly logistics administration, while retaining existing cargo discovery terms for model review.
- `monitoring_security`: control room, CCTV, alarm and technical monitoring roles.

The broader Rhein-Main city coverage will include the current core cities plus Hanau, Bad Homburg, Ruesselsheim and Gross-Gerau where relevant. Airport-oriented sources retain their specialised nearby-city list.

Each source entry will stay within the existing schema limit of sixteen keywords. Extra role families use a distinct track rather than duplicate `(source id, track)` identities.

## Data flow

1. A fresh clone runs `bun run setup`; the tracked template becomes the local private `workspace/search.yml`.
2. An existing clone runs `bun run setup`; new distinct source/track objects are added while existing local arrays and user choices are preserved.
3. A local chatbot runs `bun run search:all`, which reads the synchronized private configuration and searches all enabled configured sources plus the existing public ATS employer registry.
4. A cloud chatbot without shell access reads the tracked job-hunt instructions and applies the same five-track vocabulary, Rhine-Main geography and coverage ladder through available web/app search tools.

## Chatbot instructions

The job-hunt skill will:

- prefer `bun run setup` once before a new local search wave so newly shipped defaults are available;
- use `bun run search:all` as the main broad search command instead of omitting enabled providers;
- describe all five default tracks and preserve the existing hard gates for German level, work authorization and physical load;
- tell cloud Work/chatbots to reproduce those tracks and the existing official-source coverage ladder when the private workspace and shell are unavailable;
- continue to cap detailed model review to a small set of genuinely new live vacancies rather than treating raw retrieval volume as a shortlist.

## Failure and safety behaviour

- Schema-invalid defaults fail during setup or doctor checks before a search runs.
- A failed source remains isolated by the existing `search all` batch handling; successful sources still report their results and the summary exposes partial or failed status.
- Existing local keyword and city arrays are not silently overwritten by setup.
- Explicit language, qualification, work-right and physical-load gates remain model-reviewed; the broader configuration must not promote unsuitable vacancies merely because they were retrieved.
- No CV, address, email, phone, application document, SQLite tracker or other private workspace artifact is committed.

## Tracked changes

- Modify `workspace.example/search.yml`.
- Modify `.agents/skills/job-hunt/SKILL.md`.
- Modify `.agents/skills/job-hunt/references/search-germany.md` where needed for cloud parity.
- Modify `README.md` only to document the default synchronization and broad command.
- Add or update focused tests under `tests/setup/` and `tests/search/`.

No new runtime configuration loader, schema version, storage system, connector abstraction or search framework will be introduced.

## Verification

The implementation must demonstrate:

1. The tracked example validates against `config/schemas/search.schema.json`.
2. Setup adds the `customer_ops` source entries to an older local configuration.
3. Setup preserves customized existing `bridge` cities and keywords.
4. Setup is idempotent on a second run.
5. `bun run search:all -- --dry-run --limit 1` lists all five tracks and performs no network requests or persistence.
6. The relevant setup and search tests pass.
7. Git staging contains only the intended tracked defaults, instructions, documentation and tests; private `workspace/` files remain ignored.

## Success criteria

- A new local chatbot receives the expanded search after normal setup without manual config editing.
- An existing local chatbot can synchronize the new track without losing local customizations.
- A cloud chatbot reading the repository follows the same expanded role and geography strategy even though it cannot access the private workspace.
- The committed configuration contains no personal candidate data.
