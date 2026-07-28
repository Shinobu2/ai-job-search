# ChatGPT Work handoff

This repository is public. This file intentionally contains no address, phone
number, email address, CV, work-permit document, password, or application-form
answers.

## Source of truth

- The desktop-only application tracker is `workspace/control-room.sqlite`.
- `workspace/` is intentionally excluded from Git because it contains personal
  data and application documents.
- A cloud/phone session cannot access that tracker merely from this repository.
- Do not reconstruct application state from old chats. Ask the user for the
  latest private tracker export or the compact status list below.

## Workflow update (2026-07-28)

- Search now runs independent `datacenter` and `bridge` tracks through
  `bun run search:freehire`, `bun run search:ba` and
  `bun run search:employers`. Keep their shortlists separate.
- The employer search reads approved public Personio, Greenhouse and Lever
  endpoints and prints a trusted official manual watchlist for direct
  employers and established agencies. Recheck the canonical advert before
  recommending it; reject pay-to-apply and unverifiable recruiter sources.
- Unclassified, tier-C and uncertain vacancies stay visible for model review
  unless an explicit hard gate fails. Code does not decide `Apply | Maybe |
  Skip` from a semantic score.
- Work-authorisation text comes only from
  `config/work-authorization-wording.json`: the permit is planned after
  arrival, no employer sponsorship is required, and the stated start date must
  travel with the wording. Never imply that the permit is already issued.
- Bridge work must remain light/moderate. Continuous heavy work plus prolonged
  standing, conveyor work, continuous box loading and cold meat/poultry
  production are excluded. The configured salary floor is emergency-only;
  prioritize stronger credible offers.

## Current application status (2026-07-25)

Submitted / waiting:

- Tokyo Electron — Field Service Engineer CT, Dresden — R26-00491.
- PŸUR — NOC Operator, Leipzig.
- Amazon — Data Center Operations Technician — 3123915.
- Verda — Junior Data Center Technician.
- 23M.
- EOS IT Solutions.
- OVHcloud.
- Adecco.
- Titanicom.
- erasys.
- Impossible Cloud.
- Hornetsecurity — Technical Support Specialist 1st/2nd Level.

Rejected or closed:

- Amazon IT Specialist — 10421933.
- Leaseweb.
- YER / Mamgo.
- Microsoft Data Center Technician.
- AWS Trainee — old posting unavailable.

Before every application, deduplicate against this list and ask the user whether
the private desktop tracker contains newer entries.

## How to continue in ChatGPT Work

1. Read `.agents/skills/job-hunt/SKILL.md` and `AGENTS.md`.
2. Ask the user to paste their current private candidate brief; never infer
   contact data, address, availability, work rights, salary, or form answers
   from this public file.
3. Search and evaluate vacancies, but do not submit duplicates.
4. A public GitHub checkout does not include the CV, generated PDFs, browser
   sessions, email access, or the SQLite tracker.
5. Return tracker deltas in a compact list so they can later be copied back to
   the desktop tracker.

## Recommended secure setup

Keep this public handoff sanitized. For full cross-device state, use a separate
private repository or encrypted archive and connect that private repository to
ChatGPT Work. Do not commit an encryption key or password alongside encrypted
data.
