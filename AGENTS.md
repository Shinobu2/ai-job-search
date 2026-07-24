# Personal German Job Hunt

- This repository serves one person's German job search. Prefer a working workflow over reusable platform architecture.
- Use model reasoning for CV understanding, vacancy matching, questions, recommendations, and document tailoring.
- Use code only for search, deduplication, persistence, document compilation, tracking, and supervised browser interaction.
- Reuse FreeHire, Bundesagentur Jobsuche, Personio employer search, existing persistence/tracker, and the upstream LaTeX templates.
- Do not add migrations, schemas, capability records, scoring frameworks, storage abstractions, connectors, broad tests, or design documents.
- Ask missing critical questions once in a short batch. Never invent experience, education, languages, availability, salary, address, or work rights.
- Keep submission controlled by explicit user approval. A clear task-specific instruction such as “submit applications 1–4” or “send these two drafts” authorizes the final Submit/Send actions for that named or numbered batch without asking again. Stop for an unknown mandatory answer, CAPTCHA, OTP, login, e-signature, or separate legally meaningful consent.
- Keep personal files in `workspace/`; Git tracks only `workspace/inbox/.gitkeep`.
- Use Serena symbol tools for code navigation. Avoid rereading large files when a symbol-level view is enough.
- Run only the smoke test and relevant tests for touched code.
