---
name: job-hunt
description: Use when one candidate asks to start or continue a German job search from a CV, review current vacancies, tailor application documents, or prepare supervised applications from desktop or phone.
---

# Personal German job hunt

Run one evidence-based loop:

`existing search -> dedup/liveness/hard gates -> model review of top candidates -> shortlist -> evidence-locked documents -> scan once -> fill once -> user submits -> tracker`

Keep this personal and small. Reuse the repository's search, deduplication, persistence, document compilation, and tracker. Do not add scoring code, schemas, connectors, browser frameworks, or another profile/answer store.

## Candidate facts

1. Run `py tools/extract_cv.py` only when the inbox CV is new or no current extraction exists. Reuse the extracted CV and facts explicitly confirmed in the conversation on later turns.
2. Separate professional evidence, lab/self-study evidence, languages, licences, location, availability, work status, pay, shifts, travel, and physical-work preferences. Never promote lab work into employment.
3. Ask once, in one short batch, only for missing facts that change a hard gate or block a mandatory form field. Reuse confirmed answers; do not ask them again.
4. Never invent experience, metrics, certificates, languages, education, availability, salary, address, or work rights.

## Search with a small budget

1. Run the existing commands once, preferably in parallel:
   - `bun run search:freehire`
   - `bun run search:ba`
   - `bun run search:employers`
2. Search three lanes: direct target roles, adjacent realistic technical roles, and paid short-onboarding/`Quereinstieg` roles. Use at most four focused web queries and inspect at most twelve plausible exact postings per wave.
3. Let code handle retrieval, canonical URLs, deduplication, liveness, persistence, and explicit hard filters. Use model judgment only after this cheap pass. Do not build or report a deterministic semantic score.
4. Prefer an open employer/ATS advert, then an authorised recruiter advert. Use boards only for discovery. Check the exact advert immediately before recommending or applying.
5. Apply hard gates first: location/commute, work eligibility and start date, mandatory licence/certificate/degree, contract, and explicit language minimum. Do not average away a failed gate. Mark unresolved facts `уточнить`.
6. Compare the surviving full descriptions together in one model pass. Default to the best 5–8; when the user says to apply now, choose the best three plus a reserve. Stop instead of padding the list.

## Mobile-first shortlist

Open with a two-sentence verdict, then stable numbered cards containing:

- role, company, location, posted/updated date, checked date, and exact clickable advert;
- advertised pay with gross/net basis, or a clearly labelled estimate and basis;
- contract, language, shifts/on-call, travel, training, and physical load;
- `Почему подходит`, `Минусы/риски`, `Шанс`, `Вердикт`;
- one fast preparation step only when it materially improves the chance.

End with source coverage and phone commands: `details 3`, `apply 2`, `skip 4`, `more` (and Russian equivalents). Keep numbering stable until a new shortlist replaces it. On `more`, search a new wave without repeating applied, rejected, or closed jobs.

## Prepare applications in one pass

1. Re-open each selected canonical advert and read [references/cv-cover-letter-2026.md](references/cv-cover-letter-2026.md).
2. Before filling anything, scan the whole application form once. Build one compact plan across all selected jobs: `field -> proposed value -> CV/conversation source -> known | ask | user decision`.
3. Batch all `ask` fields into one message. Leave consent, declarations, work-authorisation wording, salary changes, EEO questions, relocation commitments, and other `user decision` fields for explicit review.
4. Tailor only from proven evidence. Create a small, vacancy-specific diff from the upstream templates:
   - `cv/main_<company>.tex`
   - `cover_letters/cover_<company>_<role>.tex`
5. Compile and inspect both PDFs: CV with `lualatex` (maximum two pages), letter with `xelatex` (one page). Extract the text and verify reading order, contact details, dates, and every substantive claim.
6. Use one browser tab per application. Reuse the signed-in session and exact role page. Prefer accessible roles and exact selectors; do not repeatedly dump the whole DOM. Upload once, fill known fields in one pass, then review once.
7. Stop before Submit, email Send, terms/privacy acceptance, CAPTCHA, OTP, login, e-signature, or any unknown mandatory answer. State the exact taps left for the user. Never store passwords or cookies in the repository or prompt logs.
8. Prioritise straightforward ATS forms such as Greenhouse, Lever, Ashby, Workable, Personio, and Teamtailor. Keep LinkedIn automation low-volume; use it as a supervised UI, not unattended mass-apply.
9. Update the existing tracker idempotently. Set `ready_for_review` only when its attested document-packet requirement is satisfied. Do not bypass that guard for a portal-only application. Set `user_submitted` only after the user confirms the final action.

## Token and recovery rules

- Re-understand the CV only when it changes.
- Batch vacancy comparison and document generation; use one repair pass only after PDF/form QA finds a concrete problem.
- Use browser interaction only for finalists and applications; use APIs/CLI/web text for discovery.
- After a browser failure, resume from the current application step. Do not reopen every advert or refill confirmed fields.
- Generate a cover letter only when the employer requests or accepts one.

## Phone and cloud use

Keep every response actionable without a terminal. Continue the same desktop task through Remote when browser access or Windows files are required. In a separate Android/cloud conversation, use the GitHub repository plus uploaded CV/documents; never claim it can see an unuploaded Windows path. Search, shortlist, translation, and drafting work on phone; desktop browser control and local LaTeX compilation require the connected desktop task.
