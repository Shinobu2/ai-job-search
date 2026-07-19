---
name: job-hunt
description: Run the user's personal German job search when they say “Start my job search”, ask for more vacancies, choose a numbered job, request tailored application documents, or prepare a supervised application. Use for mobile-friendly German vacancy discovery, comparison, CV tailoring, cover letters, and tracker updates.
---

# Personal German job hunt

Keep this a practical workflow for one candidate. Use existing search, deduplication, persistence, document compilation, and tracking. Use model judgment—not code, scores, or keyword gates—to understand the candidate, compare jobs, and write applications.

## Start or continue a search

1. Run `py tools/extract_cv.py`. Read the extracted CV and any facts already confirmed in the conversation. If no CV is locally available, ask the user to attach it.
2. State a short candidate summary: proven strengths, developing skills, preferences, and uncertainties. Ask critical missing questions once, in one short batch. Do not repeat questions already answered.
3. Read [references/search-germany.md](references/search-germany.md), then search in three waves: direct target roles, adjacent realistic roles, and paid short-onboarding/`Quereinstieg` roles. Run the existing commands first:
   - `bun run search:freehire`
   - `bun run search:ba`
   - `bun run search:employers`
4. Improve coverage with web search and direct employer career pages; do not add connectors. Verify a promising aggregator result against the employer page when possible. Let existing code handle retrieval, deduplication, and persistence.
5. Apply hard facts before ranking: location/commute, legal work eligibility and start date, required licence/certificate, contract, and explicit language minimum. Treat salary, shifts, physical load, stress, travel, and training as preferences unless the user calls them hard limits. Mark unknowns as “уточнить”; never silently reject them.
6. Read full descriptions of plausible jobs and choose the best 5–8 yourself. Prefer a strong, explainable match over a long list. Do not create or use a deterministic semantic evaluator.

## Mobile-first shortlist

Start with a two-sentence verdict, then compact numbered cards. Each card must show:

- role, company, location, freshness, and a direct clickable link;
- pay as advertised (label gross/net and estimate nothing silently), contract, language, shifts/on-call, travel, and physical load;
- `Почему подходит`, `Риски/что уточнить`, and `Вердикт`;
- one fast preparation step only when it materially improves the chance.

End with source coverage and simple commands that work on a phone: `details 3`, `apply 2`, `skip 4`, `more` (also understand Russian equivalents). Keep numbering stable for the latest shortlist. On `details N`, translate and explain the full advert. On `more`, search a new wave and do not repeat rejected jobs.

## Prepare a selected application

1. Re-open the full selected advert and read [references/cv-cover-letter-2026.md](references/cv-cover-letter-2026.md).
2. Never invent experience, metrics, certificates, languages, availability, or work status. Ask only about a missing fact that changes the application.
3. Tailor a real `cv/main_<company>.tex` from the upstream CV template and `cover_letters/cover_<company>_<role>.tex` from the upstream letter template. Match the letter language to the vacancy unless the user asks otherwise.
4. Compile and inspect both PDFs: CV with `lualatex` (maximum two pages), letter with `xelatex` (one page). Confirm text is selectable and important facts survived extraction.
5. After selection, update the existing tracker to `ready_for_review` with the vacancy link and document paths. Show the PDFs for review.
6. Never submit, send email, accept terms, or move the tracker to a submitted state without explicit confirmation for that vacancy.

## Phone and cloud use

Keep responses usable without a terminal. Work on Android cannot directly read this Windows folder: if the active desktop task is available through Remote, continue it there; otherwise use a ChatGPT Project/cloud Work conversation with the CV and relevant files uploaded. Never imply that a cloud/mobile conversation can see unuploaded local files.
