# Career Control Room MVP Runbook

## Setup and health

```powershell
bun install --frozen-lockfile
bun run setup
bun run doctor
```

## Discover and evaluate

```powershell
bun run search:freehire
bun run search:ba
bun run search:employers
bun run job:check -- --file tests/fixtures/jobs/dct-trainee.md
```

`search ba` requires `enabled: true` for the `jobsuche` source in
`workspace/search.yml`. Every source is read/import/evaluate only. No command
submits an application.

Change German cities, keywords, page bounds, or source enablement in
`workspace/search.yml`. Add direct employers, cities, ATS type and access policy
in `config/employer-registry.json`. Only entries with
`policy: public_ats_endpoint` and a supported public ATS reader are fetched;
`manual_only` entries remain links for manual import.

## Documents

Fill `workspace/profile.yml` identity values with `verification_status:
user_confirmed` and user-statement provenance, then run:

```powershell
bun run documents:generate -- --id <job-id>
```

Outputs are written to `workspace/documents/<job-id>/`. A packet remains
`ready_for_submission: false` when identity is missing, the vacancy is blocked
or tier C, mapped evidence is absent, or critical conditions still require
verification.

## Application tracking

```powershell
bun run applications -- set --id <job-id> --status shortlisted --next "Review shift and salary"
bun run applications -- set --id <job-id> --status ready_for_review
bun run applications -- set --id <job-id> --status user_submitted --confirm yes --note "Confirmed by user"
bun run applications -- list
bun run report:daily
```

`ready_for_review` is accepted only when the generated packet metadata says it
is ready. External states (`user_submitted`, `interview`, `offer`, `rejected`,
`withdrawn`) require `--confirm yes`; submission, interview, and offer also
enforce their preceding state. The MVP does not post forms, send email, or
store employer credentials.

## PDF toolchain

MiKTeX and Poppler are installed. Stock template smoke checks use LuaLaTeX for
the two-page CV and XeLaTeX for the one-page cover letter; `pdftotext` verifies
the embedded text layer. Restart Codex once if the current app process has not
yet inherited the updated user PATH.
