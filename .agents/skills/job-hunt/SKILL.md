---
name: job-hunt
description: Use when one candidate asks to start or continue a German job search from a CV, review vacancies, tailor application documents, or prepare supervised applications from desktop or phone.
---

# Personal German job hunt

Run one small loop:

`search -> dedupe/liveness/hard gates -> model comparison -> shortlist -> tailored documents -> fill once -> user submits -> tracker`

Keep this personal. Reuse the repository's search, persistence, document compilation and tracker. Never add scoring code, schemas, connectors, browser frameworks or another profile store. Use model reasoning for CV/vacancy understanding, matching, questions and tailoring.

## Load candidate facts once

- Locally, run `py tools/extract_cv.py` only for a new inbox CV or missing extraction. Otherwise reuse `workspace/profile.yml`, `workspace/evidence.yml`, `workspace/MOBILE_BRIEF.md` and confirmed conversation facts. In cloud Work, use only explicitly uploaded files.
- Separate employment evidence from lab/self-study. Never present lab work as employment.
- Ask one short batch only for missing facts that change a hard gate or mandatory field. Reuse every confirmed answer.
- Never invent experience, metrics, certificates, education, languages, location, availability, salary, address or work rights.

## Search with a fixed budget

1. Read [references/search-germany.md](references/search-germany.md) when starting a search or when the user asks for more. Run existing commands once, preferably in parallel: `bun run search:freehire`, `bun run search:ba`, `bun run search:employers`.
2. Cover direct roles, adjacent technical roles and paid short-onboarding/`Quereinstieg` roles. Use at most four focused web queries and inspect at most twelve exact postings per wave.
3. Let code handle retrieval, deduplication, liveness, persistence and explicit filters. Do not build or report a deterministic semantic score.
4. Prefer a live employer/ATS advert, then an authorised recruiter advert. Use boards only for discovery. Recheck the exact advert immediately before recommending or applying.
5. Apply hard gates before model comparison: commute, start/work eligibility, mandatory licence/certificate/degree, contract, explicit language and work style. Mark unknowns `уточнить`; never average away a failed gate.
6. For this candidate, reject continuous lifting, prolonged standing, conveyor/warehouse work, routine rack installation/decommissioning and constant field travel. Occasional server swaps, short walks and light carrying are acceptable. Treat multi-day travel as a separate risk.
7. Prefer computer-heavy work: NOC/monitoring, IT operations, international internal/desktop support, data-centre repair/remote hands, access/incident coordination and asset/ticket operations. German user support requiring B1-C1 is a stretch, not a top match.
8. Compare surviving full descriptions together once. Put the best three first and at most two genuine reserves below. Stop instead of padding.

## Return a mobile shortlist

Start with a two-sentence verdict. Keep numbering stable until a new wave replaces it. Each of the three main cards contains:

- role, company, location, posted/updated date, checked date and exact clickable advert;
- advertised pay and basis, or a labelled estimate;
- contract, language, shifts/on-call, travel and training;
- physical load: `низкая`, `умеренная` or `высокая`, with advert evidence; use `уточнить` when the advert is silent;
- `Почему подходит`, `Минусы/риски`, `Шанс`, `Вердикт`;
- one fast preparation step only when it materially improves the chance.

List up to two reserves in one line. End with coverage and phone commands: `подробнее 3`, `отклик 2`, `пропустить 4`, `ещё`. On `ещё`, do not repeat applied, rejected or closed jobs.

## Prepare selected applications once

1. Re-open the canonical advert and read [references/cv-cover-letter-2026.md](references/cv-cover-letter-2026.md).
2. Scan the whole form before editing. Build one compact matrix: `field -> proposed value -> evidence -> known | ask | user decision`. Batch all `ask` fields. Leave consent, declarations, work-authorisation wording, salary changes, EEO answers and relocation commitments for explicit review.
3. Tailor only proven evidence through the upstream templates: `cv/main_<company>.tex` and `cover_letters/cover_<company>_<role>.tex`. Generate a letter only when accepted or requested.
4. Compile and inspect: CV with `lualatex` (maximum two pages), letter with `xelatex` (one page). Verify extracted text order, contacts, dates and every substantive claim.
5. Use one browser tab per application and the signed-in exact role page. Prefer Chrome/Computer Use when an existing login or file upload is required. Upload once, batch-fill known fields and review once; if the active surface cannot upload, leave one exact manual attachment tap. Never generate, store or fill a password.
6. Make at most two evidence-based attempts on a custom dropdown/upload. Then keep the live tab at that field and state the exact manual tap.
7. Stop before Submit/Send, terms/privacy acceptance, CAPTCHA, OTP, login, e-signature or an unknown mandatory answer. State only the remaining taps.
8. Prefer straightforward ATS forms such as Greenhouse, Lever, Ashby, Workable, Personio and Teamtailor. Keep LinkedIn supervised and low-volume.
9. Update the tracker idempotently. Respect its attested-document guard for `ready_for_review`; never bypass it for portal-only applications. Set `user_submitted` only after user confirmation.

## Recover cheaply across desktop and phone

- Re-understand the CV only when it changes. Compare vacancies and generate documents in batches.
- Persist one checkpoint per application in the existing tracker `next_action`: canonical URL, completed fields, uploaded file, blocker and one remaining manual action. Resume there; do not reopen adverts or refill confirmed fields.
- Prefer Android Remote for the full workflow; the paired PC must stay powered, online, awake and unlocked for browser work.
- Android Work is separate: a GitHub URL does not expose private/ignored workspace files, cookies, generated PDFs or the local tracker. Require authorised repo access plus uploaded CV/brief. Use focused web/app search when no shell exists and return a compact tracker delta.
- Use cloud schedules only for public-source monitoring. Use a local schedule when the tracker must be updated.
