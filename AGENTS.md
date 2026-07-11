# Career Control Room Agent Guide

- Treat `workspace/profile.yml`, `workspace/evidence.yml`, and `workspace/document-pack.yml` as the only candidate-fact authority.
- Unknown remains `unknown`; never infer legal status, credentials, experience, salary conversion, commute, or transport.
- Every established fact requires provenance. User-provided facts use `user_confirmed` and `user_statement`.
- Home-lab work is a planned project, never employment. Discord help is informal assistance, never professional support.
- Use the JSON schemas in `config/schemas/` to validate workspace YAML.
- Run `bun run setup` to create or safely merge the untracked local `workspace/` directory.
- Run `bun run doctor` before relying on local tooling; it reports optional LaTeX/Poppler tools as warnings unless `--strict` is set.
- Stage 1 is local and deterministic: no live connectors, browser automation, outreach, or submission.
- Add focused tests first, observe RED, implement minimum GREEN, then run relevant regressions.
- Keep changes narrow. Do not overwrite user-owned workspace scalars, maps, or lists.
- Keep private files out of Git; `python tools/security_guards.py` verifies the repository guards.
- See `docs/superpowers/plans/2026-07-10-stage-1-vertical-slice.md` for the Stage 1 delivery sequence.
