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

## Current application status

<!-- generated:status:start -->
### Generated tracker status

- Status counts: interview: 1 · rejected: 7 · shortlisted: 12 · user\_submitted: 11

Companies and vacancy numbers:

- Adecco — `job_fed24c28caca5393c765aa7d4bd6aa6b7d39f3fd0e433923d3d83970f1e87758`
- Amazon — `jobsuche:13644-309079-S`
- Amazon — `jobsuche:13644-309081-S`
- Amazon Web Services — `job_e7c591cbdc7352d6832b2f452bd93761676192bc9005086efa04086c13ab1835`
- Amazon Web Services — `job_f9c09124ef86a66d56c744993260dd5895f8e31a2cae9af3345a119a8af724f5`
- BCLP — `job_f01e82c3e1d653ae56177c00c067735677180e1be572035798b83c6418f6fdae`
- Cofinity-X GmbH — `job_d293f33bdc9e60c696b528e859840f0fc2a89ce2f32fc8524562ca015caa5a44`
- Collectors — `job_044bbc3c77e3a12d4f496062be0182e80e883f8337301b992aceb81b7ead4863`
- Creativ Personaldienstleistungen GmbH — `job_841a4d10e46ddaa67c4a37ee640ef0b8d38055b50d76af49ba60ac62c8e3255e`
- DSP IT Service — `personio:dsp-it-service:2465156`
- erasys building ROMEO — `job_44abe8968e67f69beea5aa60e787131c0463b51b067c71bedbbf061d86dd65d9`
- Expert Select GmbH — `job_06df26faa33cefc942fcc79382790560ff70a1de2b3cc5f8bb06c105c902d77b`
- I. K. Hofmann — `job_075a852dd966677bd807e741a593ce231797b0d7d9823057a6ba0fdf17e76108`
- Impossible Cloud — `job_dcd4a1dbf342f5ed7086d93f505d4a82bb25060e5df019f011c87b6984266de4`
- INEOS Styrolution — `job_8e32074f8caf8d5b949276603979367227d5515f822cb490e382a711d635abb9`
- Leaseweb — `job_62eb1854403333863cc75172f476fec7fc74c9563276db51b6240a16af54ed50`
- Microsoft — `freehire:data-center-technician-microsoft-fwbxbs6b`
- NConsult — `job_89c6c41a2f8304486b529c8694b8dfbf12311454fa044a3bdeafa7571ffc4e59`
- Titanicom Tech Limited — `job_95ef52bfbeb2e91af6f753c316b6935c3a2cbe87bc992aec6ad2b43cdf6867e1`
- Unknown company — `job_23c2ab007e381bc6c08b2fb50e38aaf1ab84c31e74513bc1b91d9ccea0eb93f1`
- Unknown company — `job_381a89304633760bc6630967c4b9aa52f0cd309187cdc570a96bd45f6b8fd257`
- Unknown company — `job_613e68e6436d442ec49076487ae92b8caea4bc93ea50444ad45abd61dabbae91`
- Unknown company — `job_67be8e2e7877b632adc86fc051c88dbff666ae5fedd12571b894c684fbc42de8`
- Unknown company — `job_9e105ccf03da3b5f55d8dee2fbecfc2942c23822f2c1c01002f94b8b34b16aa0`
- Unknown company — `job_a170b318720373e9263856e5862c94d1146a2db33a30ac1804472f9d2961d93c`
- Unknown company — `job_a981daa250673af17c5949c94067ba7537a3cf361dec5a41c5145fbf7546a3fd`
- Unknown company — `job_bbb6127d3ae187e090956cbd24c778df32ee1e300212aee76d076b8cb67723d6`
- Unknown company — `job_c412f7d6f89cb270d62bcef432ac3631e3dac20bca12a0ed276eed50354f1044`
- Unknown company — `job_e358a907dca7acb510886bcf60a07234e80b48f4d4ff35356520efae93db3cc3`
- Verda — `freehire:junior-data-center-technician-verda-hpm44p4g`
- YER / Mamgo — `job_f8165a5047d6254bc73f29379092b598f673bc9052f1d02f8ea3625561cc1508`
<!-- generated:status:end -->

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
