# Аудит миграции ai-job-search на Codex

**Этап:** 0 — аудит без рефакторинга
**Снимок upstream:** `c134eef` от 2026-07-10, ветка `master`
**Upstream:** `MadsLorentzen/ai-job-search`
**Private origin:** `Shinobu2/ai-job-search` (`PRIVATE`, standalone upstream-compatible copy)
**Локальное состояние на момент аудита:** `master` отслеживает `origin/master`; оригинал подключён как `upstream`; неотслеживаемая папка `.vs/` сохранена без изменений

## Область и метод аудита

Проверены `README.md`, `SETUP.md`, `CLAUDE.md`, все команды в `.claude/commands/`, основной skill `.claude/skills/job-application-assistant/`, scraper и upskill skills, все portal skills в `.agents/skills/`, их Bun-манифесты и TypeScript-код, структуры `job_scraper/seen_jobs.json` и `job_search_tracker.csv`, LaTeX-шаблоны, CI, Python- и Bun-тесты, а также последние upstream-коммиты.

На этом этапе не менялись workflow, schemas, ranking, connectors, документы кандидата или tracker. Единственный результат этапа — этот аудит.

После первоначального аудита получен amendment о supervised autonomous applications. Legacy-правило уточняется так: **до certification система всегда останавливается перед submission; после certification она следует configured application mode, policy и capabilities конкретного adapter**. Amendment включён в план как отдельный поздний контур после явно определённой certification модели.

## 1. Что есть сейчас

### 1.1. Общая модель проекта

Текущий проект — Claude Code-native фреймворк, в котором Markdown-файлы одновременно служат инструкциями, конфигурацией и основной реализацией orchestration. Корневого приложения или общего runtime-пакета нет.

- `CLAUDE.md` содержит одновременно роль ассистента, персональный профиль, workflow и итоговый verification checklist.
- `.claude/commands/*.md` реализуют пользовательские сценарии `/setup`, `/rank`, `/apply`, `/outcome`, `/interview`, `/expand`, `/reset`, `/add-template` и `/add-portal`.
- `.claude/skills/job-application-assistant/` хранит профиль, поведенческие данные, writing rules, scoring, CV/cover-letter templates и interview guidance.
- `.claude/skills/job-scraper/` оркестрирует поиск, дедупликацию и быстрое ранжирование.
- `.agents/skills/*-search/` содержит реальные Bun/TypeScript CLI-коннекторы к job portals.
- `cv/` и `cover_letters/` содержат рабочие LaTeX-шаблоны.
- `documents/` предназначен для пользовательских исходных документов и архивов заявок.
- `salary_lookup.py` и `tools/convert_salary_excel.py` — отдельная Python-подсистема salary benchmarking.

Корневого `package.json` нет. Каждый portal CLI имеет собственный `package.json`, собственные зависимости и одинаковые scripts `start`, `test`, `typecheck`. Поэтому сейчас невозможны единые команды `bun run setup`, `bun run doctor` или один root-level test command.

### 1.2. Текущий поиск вакансий

`.claude/skills/job-scraper/SKILL.md`:

1. читает `job_scraper/seen_jobs.json`, `job_search_tracker.csv` и `search-queries.md`;
2. обнаруживает portal skills через `.agents/skills/*/SKILL.md`;
3. запускает их CLI через Bun;
4. при отказе использует WebSearch/WebFetch;
5. делает быстрый `high/medium/low` fit;
6. сохраняет состояние и предлагает `/rank` или `/apply`.

В репозитории есть шесть portal CLI:

| Connector | Источник | Примечание |
|---|---|---|
| `freehire-search` | публичный JSON API freehire.dev | multi-market, tech-first, уже агрегирует данные из многих ATS |
| `linkedin-search` | публичные LinkedIn `jobs-guest` endpoints | country-agnostic, personal-use-only, rate-limit risk |
| `jobbank-search` | RSS + JSON-LD/HTML | датский; возможна Cloudflare-блокировка |
| `jobdanmark-search` | API + JSON-LD/HTML fallback | датский |
| `jobindex-search` | HTML/API parsing | датский |
| `jobnet-search` | публичный Jobnet BFF API | датский государственный портал |

Поиск не реализует требуемые direct-company, Greenhouse, Lever, Ashby или Bundesagentur adapters. Для StepStone, Indeed и LinkedIn нет безопасного search-link-generator слоя; LinkedIn сейчас именно автоматически запрашивается через guest endpoints.

### 1.3. Структуры данных вакансий

Общего нормализованного `Job` schema нет. Portal CLI частично придерживаются envelope `{ meta, results }`, но поля несовместимы:

- Jobbank: `id`, `title`, `company`, `location`, `jobType`, `description`, `url`, `posted`, `deadline`.
- Jobindex: `id`, `title`, `company`, `location`, `date`, `deadline`, `url`, `description`.
- LinkedIn: `id`, `title`, `company`, `location`, `date`, `url`.
- Freehire: базовые `id`, `title`, `company`, `location`, `date`, `url` плюс enrichment/facets.
- Jobdanmark: `title`, `companyName`, `companyAddress`, `jobTypes`, `publishedDate`, `applicationDeadline`, `url`, `slug` и presentation-поля.
- Jobnet: `jobAdId`, `title`, `hiringOrgName`, `municipality`, `postalCode`, `publicationDate`, `applicationDeadline`, `workPlaceAddress` и дополнительные portal-specific поля.

Ни один общий слой не гарантирует требуемые `source`, `source_id`, `canonical_url`, `workplace_address`, normalized salary, language/education/experience requirements, `recruiter_or_direct`, `source_confidence` или `raw_hash`.

`job_scraper/seen_jobs.json` описан только в Markdown и имеет форму:

```json
{
  "seen": {
    "<url_or_company_title_key>": {
      "title": "...",
      "company": "...",
      "url": "...",
      "first_seen": "YYYY-MM-DD",
      "fit": "high/medium/low",
      "status": "new/skipped/evaluated/ranked/expired",
      "rank_score": 0,
      "rank_verdict": "strong fit",
      "rank_date": "YYYY-MM-DD"
    }
  }
}
```

У схемы нет runtime-validation, versioning или migration path. Дедупликация основана на URL или `company+title` и отдельно на `company+role` в tracker. Canonical URL, source ID и content hash не объединены в детерминированный алгоритм.

### 1.4. Текущий ranking pipeline

Есть два уровня оценки:

1. Scraper quick fit: `high/medium/low`, без формального вычисления.
2. `/rank`: четыре оценки `technical`, `experience`, `behavioral`, `career`; веса 30/25/15/30; location — veto; deadline — tiebreaker.

`/apply` повторяет более глубокую оценку и считает её authoritative. Это полезное разделение triage/final evaluation, но scoring исполняется LLM по текстовым инструкциям, а не детерминированным модулем. Нет role taxonomy A/AT/BT/F/X, track-specific weights, confidence, evidence mapping или требуемых hard-gate statuses.

Текущий location gate знает только `PASS/FAIL/FLAG`. Не различаются `VERIFY`, `PASS_WITH_RISK`, `EMERGENCY_ONLY`; неизвестные shift, salary, language и exact workplace не получают единообразного статуса.

### 1.5. Document generation

`.claude/commands/apply.md` уже содержит ценный drafter-reviewer pipeline:

1. parse/fetch posting;
2. evaluate fit;
3. запросить подтверждение пользователя перед drafting;
4. создать CV и cover letter;
5. передать drafts отдельному reviewer agent;
6. применить factual/content review;
7. скомпилировать CV через `lualatex`, cover letter через `xelatex`;
8. визуально проверить 2 страницы CV и 1 страницу cover letter;
9. проверить ATS text layer через `pdftotext -layout`;
10. не скрывать реальные skill gaps.

Это самая зрелая часть upstream и её следует мигрировать, а не переписывать. Основной недостаток — жёсткая привязка к Claude Agent/Read/Edit/WebFetch/WebSearch semantics и к `.claude`-файлам как источникам персональных фактов.

### 1.6. Tracker и application archive

`job_search_tracker.csv` имеет текущий header:

```text
date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source
```

`/outcome` обновляет tracker и архивирует материалы в `documents/applications/<company>_<role>/`. Архив включает job posting, submitted CV, cover letter и `outcome.md`. `/setup` затем использует завершённые outcomes для calibration.

Полезный feedback loop уже существует, но tracker schema не совпадает с целевым `workspace/applications.csv`: отсутствуют job ID, archetype, confidence, document language, direct/agency, salary, next action, follow-up date и rejection tags.

### 1.7. Тесты и CI

CI проверяет:

- lint skills/commands/settings;
- security guards для Claude permissions, `.gitignore` и package lifecycle scripts;
- Python tests salary tools;
- LaTeX smoke compilation и page counts;
- typecheck всех шести portal CLI;
- placeholder integrity только в upstream.

Существующие tests полезны для parser regressions, CLI flag validation, salary tools и security guards. Однако нет тестов для ranking, hard gates, evidence mapping, dedup across sources, setup rerun, tracker, document truthfulness или end-to-end job workflow. Большая часть core behavior находится в Markdown и поэтому не покрыта executable tests.

На машине аудита найден Python 3.14.6. Не найдены Bun, `lualatex`, `xelatex`, `pdflatex` и `pdftotext`; полный CI-equivalent baseline локально пока невоспроизводим.

### 1.8. Текущее отсутствие application automation

Upstream умеет оценивать вакансии и готовить документы, но не имеет исполняемого application-form layer. В проекте отсутствуют:

- application modes `prepare_only`, `supervised_auto`, `full_auto`;
- `workspace/auto-apply.yml` и policy enforcement;
- persistent human-question queue;
- transactional submission state и run lock;
- ATS application adapters, form inspection и semantic field mapping;
- pre-submit reviewer, receipt verification и submission idempotency;
- resumable `jobs:run`/`jobs:resume` orchestration;
- autonomous run reports и skill-opportunity analytics.

Следовательно, autonomous submission нельзя безопасно добавить как расширение Markdown-команды `/apply`. Сначала требуется детерминированный и тестируемый core, затем отдельная capability-based submission подсистема.

## 2. Что можно использовать без изменений

### Использовать напрямую

- `cv/main_example.tex`, если сохранить `lualatex`, moderncv/banking и двухстраничный контракт.
- `cover_letters/cover.cls`, `cover_letters/OpenFonts/` и `cover_example.tex`, если сохранить `xelatex` и одностраничный контракт.
- Основные honesty rules из `03-writing-style.md`: не выдумывать, не keyword-stuff, применять interview-backtrack test.
- Factual/content categories reviewer pass из `/apply`.
- Compile → visual inspection → `pdftotext` ATS loop.
- Идею triage ranking отдельно от authoritative application evaluation.
- Идею idempotent onboarding: read-before-write, explicit conflict resolution, no silent overwrite.
- Application archive и feedback loop `outcome` → profile calibration.
- Error contract portal CLIs: stderr JSON + non-zero exit; продолжение поиска при отказе одного connector.
- Network-free unit-test fixtures и запрет live portal calls в обычном CI.
- Security guards как принцип: personal-data ignore rules, запрет install lifecycle scripts, review permission widening.

### Использовать как reference implementation, но не как финальный connector contract

- Retry/backoff и error handling из Freehire/LinkedIn helpers.
- HTML/JSON-LD fallback из Jobdanmark.
- Явное распознавание Cloudflare failure из Jobbank.
- Search/detail separation во всех portal CLI.
- Freehire как дополнительный multi-market source.

Датские connector implementations можно временно оставить в дереве для upstream compatibility, но они не должны участвовать в default Germany search.

## 3. Что зависит от Claude Code

- Корневой instruction source — `CLAUDE.md`; корневого `AGENTS.md` нет.
- Пользовательский интерфейс основан на slash-командах `.claude/commands/`.
- Основные skills находятся в `.claude/skills/`, тогда как `.agents/skills/` сейчас используется только для portal CLI.
- Commands ссылаются на Claude-specific tools: `Agent`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `AskUserQuestion`.
- `/apply` явно запускает `general-purpose` reviewer через Claude Agent tool.
- `/rank` явно делит вакансии между параллельными Claude agents.
- `/setup` полагается на способность Claude читать PDF напрямую и удерживать несколько документов в context.
- `.claude/settings.json` и связанные security guards проверяют именно Claude permission syntax.
- README, SETUP и user guidance требуют запускать `claude` и помнить `/setup`, `/scrape`, `/rank`, `/apply`.
- `CLAUDE.md` требует упоминать Claude Code в CV при описании agentic tooling; это vendor-specific правило нельзя переносить как универсальное требование.
- Markdown specs являются фактической реализацией, поэтому Codex не может надёжно использовать pipeline только через обычный естественный запрос без router skill.

## 4. Что нужно адаптировать для Codex

### Product direction: Career Control Room

Рабочее название продукта — **Career Control Room**. Текущая миссия — **DCT Germany**, но country/role specifics должны оставаться configuration, а не core architecture.

Главная цель — максимизировать подходящие interviews и offers при соблюдении health, transport, financial, legal и career constraints. Application count — только вторичная operational metric. Strategy engine должен измерять полный funnel `discovered → eligible → applied → response → screening → interview → offer`, conversion по ключевым cohorts, time-to-response/interview, direct/agency и primary/fallback outcomes, document language/profile performance, confirmed failures и user time per qualified application. Любой вывод обязан показывать sample size и confidence; thresholds и blockers не меняются молча.

### Instruction и routing layer

- Добавить компактный root `AGENTS.md` и перенести operational skills в `.agents/skills/`.
- Не создавать `.codex/skills/`.
- Реализовать `job-router`, чтобы natural-language intent заменил необходимость помнить slash-команды.
- Оставить `.claude/` как временный upstream/reference layer до завершения parity migration, затем решить отдельно, сохранять ли его для merge compatibility.

### System/user boundary

- Создать git-tracked system layer под `packages/`, `config/` и `.agents/skills/`.
- Создать gitignored `workspace/`; system updates не должны изменять user data.
- Объявить единственными authoritative candidate-fact sources `workspace/profile.yml`, Evidence Vault `workspace/evidence.yml` и `workspace/document-pack.yml`.
- Ввести rule: отсутствие evidence означает `unknown`, а не inferred fact.
- Представлять home lab как project, Discord assistance как informal assistance, образование без эквивалентности Ausbildung/degree.
- Единственный `workspace/evidence.yml` сделать provenance-aware Evidence Vault с уровнями `UNKNOWN`, `THEORY`, `GUIDED_PRACTICE`, `INDEPENDENT_PRACTICE`, `HOME_LAB_EVIDENCE`, `FORMAL_CERTIFICATE`, `PROFESSIONAL_EXPERIENCE`.
- Для каждого evidence record хранить allowed/prohibited CV claims, source/evidence artifacts, independence, reviewer status и review/expiry date; не повышать уровень автоматически из чтения, планов или разговора.
- Добавить controlled documentation/legal-fact pack для work authorization wording, education evidence/recognition status, licence, availability, translations, certificates, references и permitted background-check answers.
- Генерировать отдельные career profiles для Data Center Hardware/Network, Data Center Trainee и IT Support/Onsite fallback из общих facts/evidence, а не копировать факты между CV.

### Executable core

- Добавить root `package.json` и единые `bun run setup`, `bun run doctor`, `bun test`.
- Ввести versioned YAML/JSON schemas и validation.
- Нормализовать все connector outputs через один `Job` contract.
- Вынести canonical URL normalization, source ID, content hash и deterministic dedup в отдельный package.
- Реализовать taxonomy и hard gates до scoring.
- Реализовать evidence mapping до вычисления score.
- Сделать scoring детерминированным; LLM должен извлекать/объяснять, а не свободно выбирать веса.
- Добавить independent reviewer result с machine-readable итогом.
- Отделить application tier `S/A/B/C` от numeric fit score: S — strategic/manual-or-supervised, A — strong/supervised-auto eligible, B — constrained fallback, C — never auto-submit.
- Добавить отдельный survival score для net income, commute/time/cost, public transport, shift bounds, car, physical/night/on-call load, stability, agency/training и 6/12-month career value; высокий fit не отменяет низкий survival score.
- Ввести vacancy-integrity/scam gate до подготовки/подачи: verified employer/ATS domain, consistent company/recruiter identity, no payment/malware/premature-ID request, live original listing и materially consistent conditions.
- Реализовать response state model и conversion event log до strategy automation.

### Germany search layer

- Добавить direct career/Greenhouse/Lever/Ashby connectors.
- Добавить отключаемый Bundesagentur adapter с timeout, bounded retries, cache, schema validation и health check.
- Для StepStone/Indeed/LinkedIn по умолчанию генерировать search links и поддерживать manual import; не делать aggressive scraping.
- Реализовать configurable anchors, radius, commute limit и transport verification.

### Application layer

- Мигрировать drafter-reviewer workflow в Codex skill без ослабления проверки фактов.
- Перед drafting повторять hard gates и live check.
- Выбирать document language с объяснением.
- Показывать concise diff master vs tailored CV.
- До завершения core reliability milestone работать в принудительном `prepare_only`/dry-run режиме.
- После milestone добавить явные modes `prepare_only`, `supervised_auto`, `full_auto`; default — `supervised_auto`, без silent mode changes.
- Разделить `configured_mode` и `effective_mode`: пользователь может настроить `supervised_auto`, но `effective_mode` остаётся `prepare_only`, пока core capabilities и конкретный target adapter не имеют статуса `certified`.
- Ни один configured mode не обходит certification registry.
- Применять `workspace/auto-apply.yml`: hard blockers всегда имеют приоритет над score, confidence и archetype thresholds.
- Разделить fill, preview, submit и verifySubmission; клик по кнопке сам по себе не означает успешную подачу.
- Считать успешной автоматической подачей только `SUBMITTED_CONFIRMED`; ambiguous result хранить как `SUBMITTED_UNCONFIRMED` и не retry автоматически.
- Очередь неизвестных вопросов должна блокировать только затронутую вакансию; остальные вакансии продолжают обрабатываться.
- CAPTCHA, auth failure и unsupported forms должны сохранять recoverable state и не обходиться.
- Каждая application проходит два независимых review: machine review PDF/text/sections/ATS/terminology/unsupported claims и human ten-second review target clarity/evidence/naturalness/specificity/honest experience framing.
- S-tier и selected A-tier могут получать verified human-outreach draft и максимум один follow-up по умолчанию; outreach не должен превращаться в массовую рассылку или выдуманную связь.
- Important recruiter replies остаются draft-for-review, если пользователь отдельно не разрешил отправку.

## 5. Где сейчас дублируется логика

| Логика/данные | Где дублируется | Риск |
|---|---|---|
| Персональный профиль | `CLAUDE.md`, `01-candidate-profile.md`, `cv/main_example.tex`, исходные документы | расхождение фактов и дат |
| Skills/career constraints | `CLAUDE.md`, `01`, `02`, `04`, `search-queries.md` | ranking и drafting используют разные версии |
| Verification checklist | `CLAUDE.md`, `/apply`, `05-cv-templates.md`, README | drift обязательных проверок |
| LaTeX engine/page rules | README, SETUP, `CLAUDE.md`, `/apply`, `05`, `06`, CI | изменения требуют синхронных edits |
| Honesty/no fabrication | `CLAUDE.md`, job assistant skill, `03`, `/apply`, `/rank`, scraper | правильный принцип, но нет единого enforcement layer |
| Scoring | `04-job-evaluation.md`, `/rank`, `/apply` | формулы и interpretations могут расходиться |
| Dedup | scraper Step 2/4, tracker exclusion, `/rank` | разные keys и разные определения duplicate |
| Tracker schema | `/outcome`, scraper, rank, upskill, documents README | изменение columns ломает несколько text workflows |
| Portal contract | каждый CLI и каждый `SKILL.md` | нет compile-time общего interface |
| Candidate onboarding | `/setup` Path A/B/C и manual editing guidance | несколько способов менять одни и те же факты |

Миграция не должна просто скопировать эти инструкции в новые skills. Повторяемые правила нужно вынести в schemas/config/packages, а skills должны ссылаться на них.

## 6. Какие файлы являются источниками истины

### Фактическое состояние upstream

| Область | Текущий фактический источник истины | Комментарий |
|---|---|---|
| Workflow apply | `.claude/commands/apply.md` | наиболее полный pipeline |
| Scoring definitions | `.claude/skills/job-application-assistant/04-job-evaluation.md` | `/rank` должен повторять эти веса |
| Candidate data | `.claude/skills/job-application-assistant/01-candidate-profile.md` | documents README прямо называет skill files canonical, но `CLAUDE.md` тоже используется |
| Behavioral data | `02-behavioral-profile.md` | используется reviewer/interview logic |
| Writing rules | `03-writing-style.md` | factual framing и tone |
| CV contract | `05-cv-templates.md` + `cv/main_example.tex` | spec + executable template |
| Cover letter contract | `06-cover-letter-templates.md` + `cover_letters/cover.cls` | spec + executable class |
| Search orchestration | `.claude/skills/job-scraper/SKILL.md` | state schema существует только здесь |
| Search queries | `.claude/skills/job-scraper/search-queries.md` | placeholder-based user config |
| Tracker | `/outcome` header + `job_search_tracker.csv` | CSV обычно gitignored и отсутствует в fresh clone |
| Application archive | `documents/README.md` | format `outcome.md` |
| Portal behavior | каждый `.agents/skills/<portal>/SKILL.md` + соответствующий CLI | documentation и code могут drift |
| CI/security | `.github/workflows/ci.yml`, `tools/lint_skills.py`, `tools/security_guards.py` | upstream framework safeguards |

### Целевое решение

После миграции единственными источниками персональных фактов должны стать:

- `workspace/profile.yml` — пользовательские ограничения, цели и текущие значения;
- `workspace/evidence.yml` — Evidence Vault: provenance, evidence level, artifacts, reviewer status и разрешённые/запрещённые формулировки для навыков, опыта и образования;
- `workspace/document-pack.yml` — контролируемые contact/legal/document facts без автоматического признания немецкой эквивалентности;
- `workspace/source-documents/` — исходные документы, но не автоматически доверенный structured truth.

Derived career profiles, CV variants, cover letters, form answers и outreach messages не являются самостоятельными источниками истины: они рендерятся из profile/evidence/document-pack и vacancy context. Funnel/conversion facts и response events должны храниться transactionally с immutable provenance, а CSV/Markdown использоваться как exports/reports.

System truth должен находиться в versioned schemas/config/packages. `AGENTS.md` и skills должны описывать orchestration, но не дублировать веса, taxonomy или пользовательские факты.

## 7. Какие изменения могут затруднить merge с upstream

### Высокий риск

- Удаление или массовое перемещение `.claude/commands/` и `.claude/skills/`.
- Переписывание portal CLI вместо адаптеров вокруг существующих outputs.
- Массовое форматирование README/SETUP/Markdown files.
- Замена `cv/main_example.tex` или `cover.cls` новыми template engines.
- Изменение master branch conventions или существующего CI целиком.
- Перемещение датских connectors из `.agents/skills/` до появления compatibility strategy.

### Средний риск

- Изменение `job_search_tracker.csv` in place вместо нового `workspace/applications.csv` и migration/import step.
- Изменение `seen_jobs.json` in place вместо нового normalized `workspace/jobs.jsonl`.
- Перенос salary tools без compatibility wrapper.
- Добавление Germany-specific поведения в универсальные upstream files, которые upstream продолжает менять.
- Редактирование `.gitignore` без одновременного обновления security guards и tests.

### Низкий риск / рекомендуемая стратегия

- Добавлять новые Codex-first packages и config paths рядом с legacy layer.
- Сохранять legacy Claude files как reference/compatibility во время миграции.
- Делать small commits по фазам и минимальные adapters к существующим portal CLIs.
- Изолировать Germany-specific taxonomy/queries/connectors в новых config/packages.
- Хранить user layer только в `workspace/`, полностью отделённо от upstream-managed files.
- Перед upstream sync использовать `upstream/master` как отдельный remote и не смешивать персональные данные с system commits.

## 8. Пошаговый план миграции

### Фаза 1. Workspace и schemas

1. Добавить root `package.json` без смены текущего стека.
2. Создать `config/schemas/`, `config/defaults/` и schema validation.
3. Добавить `.gitignore` rules для всего user layer и tests security guards.
4. Реализовать versioned `profile.yml`, Evidence Vault `evidence.yml`, `document-pack.yml`, `search.yml`, `jobs.jsonl`, `applications.csv` и funnel/response event schemas.
5. Добавить system catalogues для evidence levels, proof projects/learning effort и безопасных CV claim rules.
6. Добавить import path из legacy profile/tracker без автоматического удаления legacy files.

**Gate:** rerun setup сохраняет существующие значения; invalid YAML даёт понятную ошибку; user layer не отслеживается Git; derived documents не содержат независимых копий facts.

### Фаза 2. `AGENTS.md` и Codex skills

1. Добавить компактный root `AGENTS.md`.
2. Создать `job-router`, `candidate-profile`, `job-search`, `job-evaluate`, `job-apply`, `portal-bundesagentur` в `.agents/skills/`.
3. Вынести подробные instructions в `SKILL.md`/`references/`, не копируя schemas и weights.
4. Обеспечить natural-language routing для поиска, URL/text evaluation, compare, apply, profile update и tracker review.

**Gate:** пользователь может начать каждый основной flow обычной фразой; unsupported intent объясняется без silent action.

### Фаза 3. Setup и doctor

1. Реализовать короткий idempotent setup wizard.
2. Заполнить предоставленные стартовые значения только в user layer.
3. Все непредоставленные значения сохранять как `unknown`.
4. Реализовать doctor checks для Bun, LaTeX, `pdftotext`, YAML, workspace, connectors и tracked secrets.

**Gate:** `bun run setup` и `bun run doctor` работают из fresh clone и повторно.

### Фаза 4. Evidence Vault, taxonomy и hard gates

1. Реализовать evidence-level validation, provenance и allowed/prohibited claim enforcement без automatic promotion.
2. Реализовать A/AT/BT/F/X classifier до scoring.
3. Реализовать mandatory nights, own car, facilities qualification, German B2/C1, health/physical и compensation gates.
4. Ввести statuses `PASS`, `PASS_WITH_RISK`, `VERIFY`, `BLOCKED`, `EMERGENCY_ONLY`.
5. Сопоставлять каждое важное requirement с evidence и сохранять proven/partial/transferable/missing/unknown.
6. Добавить vacancy-integrity/scam checks до eligibility.

**Gate:** каждый обязательный fixture даёт ожидаемый archetype и hard-gate status; score не отменяет blocker; home lab не превращается в employment; unsupported claim не проходит evaluator/reviewer.

### Фаза 5. Scoring, application tiers и result cards

1. Реализовать отдельные веса A/AT и F.
2. Вычислять confidence из полноты shift/salary/language/location data.
3. Добавить отдельный application tier S/A/B/C с правилами, не сводимыми к score.
4. Добавить deterministic result summary и human-readable cards.
5. Сохранить independent reviewer pass отдельно от primary evaluator.

**Gate:** одинаковый normalized input даёт одинаковый machine score/status/tier; C-tier никогда не auto-submit; объяснение ссылается на evidence и unknowns.

### Фаза 6. Normalization, dedup и manual import

1. Создать общий `Job` schema.
2. Добавить adapters для существующих portal CLI outputs.
3. Реализовать canonical URL/source ID/company-title-location/content-hash dedup.
4. Добавить URL и pasted-description import.
5. Перевести state с `seen_jobs.json` на `workspace/jobs.jsonl` с migration/import compatibility.

**Gate:** duplicate fixtures из разных sources объединяются детерминированно; raw source сохраняется для диагностики.

### Фаза 7. Search connectors

1. Реализовать direct company/Greenhouse/Lever/Ashby connectors.
2. Добавить StepStone/Indeed/LinkedIn search-link generators.
3. Оставить existing connectors behind adapters и disabled-by-default where inappropriate for Germany.
4. Реализовать 70/30 search split и widening reasons.
5. Добавить location anchors и transport verification fields.

**Gate:** failure одного connector не прерывает остальные; normal tests не ходят в live sites.

### Фаза 8. Bundesagentur adapter

1. Зафиксировать adapter как unofficial/unstable.
2. Добавить bounded timeout/retry, cache, health check и schema validation.
3. Добавить disable switch и ясные degraded-mode errors.

**Gate:** saved fixtures проходят; timeout/schema failure не ломают общий поиск.

### Фаза 9. Career profiles и Codex drafter-reviewer migration

1. Генерировать три career profiles из общего Evidence Vault: DCT Hardware/Network, DCT Trainee, IT Support/Onsite fallback; каждый на английском и немецком.
2. Перенести `/apply` semantics в `job-apply` без копирования персональных данных.
3. Повторять live/hard-gate/integrity checks перед drafting.
4. Выбирать document language и cover-letter necessity с объяснением.
5. Проверять drafts против `evidence.yml` и отдельно reviewer pass.
6. Добавить machine review и human ten-second review как разные gates.
7. Показывать concise CV diff.

**Gate:** tests ловят fabricated skill, employment-vs-project, unsupported keyword, generic AI language и unclear target profile; submission ещё отключён, потому что эта фаза доказывает только надёжность документов.

### Фаза 10. PDF, funnel, response state и tracker integration

1. Сохранить `lualatex`/`xelatex` compile rules и visual page checks.
2. Сделать `pdftotext` обязательным для успешного ATS status либо явным degraded result — выбор зафиксировать в implementation spec.
3. Записывать target tracker fields, future-readiness fields, application tier/profile/language и cover-letter usage.
4. Ввести event/state model для `discovered → eligible → applied → response → screening → interview → offer`, deadlines и rejection reasons.
5. Сохранять outputs в `workspace/outputs/` и application archive.
6. Считать conversion/time metrics с sample size и confidence, не делая стратегических выводов на малой выборке.

**Gate:** PDF text fixture проверяет contacts, reading order и keywords; tracker rerun не дублирует row; state transitions и conversion cohorts воспроизводимы из event log.

### Фаза 11. Core end-to-end tests и документация

1. Добавить все 15 обязательных fixture-based tests из ТЗ.
2. Добавить fresh-clone setup/search/evaluate/apply dry-run без реальной submission.
3. Обновить README на Codex-first natural-language flow.
4. Документировать upstream sync и system/user separation.

**P0/Core reliability milestone:** Evidence Vault, career profiles, dual review, application tiers, conversion tracking и response state model работают; fresh-clone flow стабильно доходит до `FILLED_WAITING_FOR_REVIEW`; все candidate claims доказуемы, LaTeX и `pdftotext` проходят, tracker idempotent, а тесты никогда не отправляют реальные заявки. Этот milestone сам по себе не выдаёт certification.

### Explicit capability certification model

1. Versioned registry хранит capabilities `workspace_schema`, `profile_validation`, `evidence_validation`, `manual_job_import`, `vacancy_extraction`, `archetype_classification`, `hard_gates`, `evidence_mapping`, `deterministic_scoring`, `survival_scoring`, `result_card`, `transactional_storage`, `document_generation`, `factual_review`, `pdf_compile`, `ats_extract`, `application_orchestration` и позднее adapter-specific submission capabilities.
2. Каждый capability имеет один status: `unavailable`, `implemented`, `tested`, `certified`, `disabled`.
3. `implemented` означает наличие кода; `tested` требует определённого test suite; `certified` требует успешных certification checks **и отдельного explicit certification action**. Код и green tests не повышают status автоматически.
4. Во время Stage 1 все submission capabilities остаются `unavailable` или `disabled`.
5. `effective_mode = prepare_only`, пока все required core capabilities и target adapter не `certified`, независимо от `configured_mode`.
6. После certification поведение определяется configured mode, auto-apply policy и adapter capability flags; certification можно явно отозвать переводом в `disabled`.

### Фаза 12 (P1). Proof Builder

1. Агрегировать repeated gaps и связывать их с текущими blocked vacancies, required/preferred counts и primary/fallback tracks.
2. Добавить maintained project catalogue: Linux/SSH, systemd, network diagnostics, component replacement, BIOS/UEFI, Ethernet termination/testing, fiber/transceiver theory, VLAN, mock tickets/SLA, inventory, incident report, rack diagram и safe equipment handling.
3. Для каждого проекта хранить effort, equipment/cost, exact tasks, acceptance criteria, evidence to capture, allowed CV wording и interview topics.
4. Приоритизировать realistically completable, low-budget, visible-evidence projects, открывающие несколько DCT-track вакансий.
5. Не повышать evidence level и не считать проект завершённым до выполнения acceptance criteria и появления artifacts.

**Gate:** planned/read/discussed task не становится evidence; completed fixture создаёт только разрешённую формулировку и никогда не employment claim.

### Фаза 13 (P1). Strategy engine и Response Center

1. Считать funnel/conversion cohorts по archetype, tier, source, direct/agency, career profile, language, cover-letter usage, adapter, vacancy age и major gaps.
2. Выдавать recommendations только при meaningful sample size: document revision при qualified/no-response, interview preparation при interview/no-offer, fallback widening только при недостаточном primary funnel.
3. Логировать каждое предложенное/применённое strategy change с reason; не менять thresholds молча и не ослаблять hard blockers.
4. Добавить response-management state: связать recruiter messages с applications, классифицировать rejection/information/assessment/screening/interview/offer и извлекать deadlines/new fact requests.
5. Готовить reply drafts, follow-up state и calendar suggestions; important replies default to review, а любой response останавливает redundant follow-ups.

**Gate:** small cohorts не порождают стратегических выводов; response transition обновляет funnel и прекращает follow-up automation; replies не отправляются без configured authorization.

### Фаза 14 (P1). Interview preparation и survival analysis

1. Генерировать evidence-grounded prep packs для English recruiter screen, basic German screen, DCT technical и asynchronous/AI-led interview.
2. Включать HR/technical questions, honest answer outlines, employer questions, unknowns, company brief, language practice, troubleshooting scenarios и concise self-introduction.
3. Запретить deceptive live assessment assistance; система готовит кандидата, а не отвечает вместо него в реальном тесте.
4. Реализовать отдельный survival score: approximate net, commute time/cost, public transport, shift bounds, car, physical/night/on-call load, stability, agency/training и 6/12-month career value.
5. Не позволять fit score перекрывать плохой survival score; unknown address/shift остаётся `VERIFY`.

**Gate:** interview content трассируется к evidence/job; survival blockers сохраняются независимо от fit и strategy recommendations.

### Фаза 15. Application policy и transactional state

1. Добавить `application.mode` и gitignored `workspace/auto-apply.yml` с amendment defaults и per-archetype/tier rules.
2. Реализовать policy evaluator: score, confidence, tier, archetype, survival, integrity, live status, canonical destination, cooldowns, run/day limits и blocked conditions.
3. Расширить tracker полями `application_mode`, `auto_submitted`, `submission_status`, `adapter`, timestamps, receipt/payload paths, pending questions, retry/error/blocker и reviewer flags.
4. Ввести transactional state store для concurrency/checkpoints; CSV сохранить как export, а не единственный runtime store.
5. Добавить run lock и per-job idempotency key.

**Gate:** threshold, tier/survival/integrity gates, hard-blocker override, duplicate protection, cooldown, limits, crash recovery и concurrent-run lock покрыты unit tests.

### Фаза 16. Persistent human-question queue

1. Реализовать `workspace/questions.jsonl` либо SQLite через `bun:sqlite`, если это не создаёт лишний второй state model.
2. Хранить полный question schema, normalized keys, provenance, reuse и expiry.
3. Консервативно нормализовать ответы и перед записью показывать пользователю сохраняемый факт.
4. Записывать reusable facts в `profile.yml`/`evidence.yml`, переоценивать зависимые pending jobs и возобновлять только ставшие eligible заявки.
5. Optional demographic questions по умолчанию отвечать `prefer not to say`, если вариант доступен; sensitive/legal facts никогда не infer.

**Gate:** неизвестный факт создаёт один вопрос, подтверждённый ответ переиспользуется, ambiguous answer не расширяется, один pending job не останавливает другие, resume работает после ответа.

### Фаза 17. Capability-based ATS adapters

1. Определить adapter interface: detect, inspectForm, mapFields, validateAnswers, uploadDocuments, fill, preview, submit, verifySubmission, captureReceipt и failure diagnostics.
2. Реализовать shared semantic mapper плюс отдельные adapters в порядке Greenhouse, Lever, Ashby, Personio, Recruitee, SmartRecruiters, Workable.
3. Workday оставить manual-approval/experimental до dedicated fixtures.
4. Generic adapter разрешить только fill-to-review; automatic submit включать лишь для явно протестированных form families.
5. Для LinkedIn, StepStone и Indeed оставить in-platform submission disabled в v1; предпочитать direct employer destination.
6. Добавить dry-run, fixtures, timeouts, bounded retries, screenshot on failure и CAPTCHA/auth detection.

**Gate:** каждый adapter доказывает field validation и receipt/failure behavior на локальных mock forms; реальные заявки не отправляются в development, tests или CI.

### Фаза 18. Pre-submit, submission и receipt pipeline

1. Расширить pipeline: form inspector → answer mapper → independent pre-submit reviewer → submitter → receipt verifier → tracker/reporter.
2. Pre-submit reviewer сравнивает каждое form field с `profile.yml`, `evidence.yml`, document pack, CV и cover letter.
3. До submit сохранять audit payload в gitignored `workspace/application-payloads/`.
4. После submit требовать success signal/confirmation page и сохранять receipt; uncertain result не retry.
5. Использовать headed persistent browser profile для initial validation/auth/CAPTCHA и headless только для проверенных adapters.
6. Не обходить CAPTCHA, rate limits, authentication или platform restrictions.

**Gate:** unsupported/exaggerated claims отклоняются; confirmed, unconfirmed, CAPTCHA, auth, unsupported и failed statuses различаются; повторный submit после ambiguous response невозможен.

### Фаза 19. Resumable jobs runner, daily report и autonomous hardening

1. Добавить `bun run jobs:run`, `jobs:resume`, `jobs:report`, `jobs:questions`, `jobs:pause`, `jobs:status`.
2. Persist checkpoint после каждой вакансии и продолжать run при `WAITING_FOR_USER`, CAPTCHA или adapter failure отдельной вакансии.
3. Добавить `docs/scheduled-run-prompt.md` для Codex scheduled tasks/Windows Task Scheduler.
4. Генерировать `workspace/runs/<timestamp>/summary.md` и `summary.json`; normal daily report оставлять коротким: best jobs, submissions, questions, responses, deadlines/interviews, one proof task, market change и today's action.
5. Реализовать natural-language controls для thresholds, direct-only, agencies, pause/resume, company blocklist и adapter approval.
6. Добавить все 23 autonomous-amendment tests, secret/personal-data scans и full autonomous dry-run fixtures.
7. Провести headed validation каждого adapter перед `supervised_auto`; `full_auto` оставить explicit opt-in.

**Gate:** scheduled noninteractive dry run завершается чисто, resumable state не повторяет submissions, daily report совпадает с transactional store и показывает только решения, требующие внимания.

### Фаза 20. Skill-opportunity analytics

1. Агрегировать mention/required/preferred/blocked/access counts, primary/fallback split и salary samples.
2. Хранить learning-time estimates в maintained catalogue либо маркировать как rough.
3. Вычислять opportunity value с учётом jobs unblocked, repeated requirement, primary relevance, learning speed и evidence feasibility.
4. Не приоритизировать formal multi-year qualifications как быстрый skill; не представлять salary correlation или hiring probability как causal guarantee.
5. Связать analytics с Proof Builder и показывать один highest-value task в daily output.

**Gate:** analytics отказывается от unsupported percentage/salary claims и всегда показывает sample size/confidence.

### Фаза 21 (P2). Human outreach, weekly strategy и deeper market analytics

1. Для S-tier/selected A-tier находить recruiter/hiring contact только из reliable public sources, проверять связь с vacancy/company и готовить individualized message.
2. Записывать outreach и максимум один default follow-up; останавливать follow-ups после ответа; не выдумывать referral/relationship.
3. Генерировать weekly review: conversion, track/profile/source/language outcomes, rejection reasons, gaps/evidence/proof task и обоснование search widening/threshold changes.
4. Добавить deeper salary/market analytics только при достаточных samples и с явной маркировкой observed association.
5. Не строить graphical dashboard, пока natural-language search/application/response loop не доказал полезность.

**Updated Definition of Done:** Career Control Room оптимизирует suitable interviews/offers, а не объём. После dry run пользователь явно включает `supervised_auto`; `jobs:run` находит и оценивает вакансии, применяет fit/tier/survival/integrity gates, готовит доказуемые документы, отправляет только policy-eligible заявки через протестированные adapters, подтверждает receipts, не блокируется из-за вопросов по другим вакансиям, возобновляет pending jobs после ответов и выдаёт короткий decision-oriented report. Funnel strategy показывает sample size/confidence, Proof Builder создаёт проверяемые evidence tasks, Response Center и interview prep остаются truth-grounded. Ни один test/dev/CI flow не отправляет реальную заявку.

## Риски, которые остаются после Stage 0

- Создан `PRIVATE` standalone repository `Shinobu2/ai-job-search`; он сохраняет upstream remote, но GitHub не считает его fork (`isFork=false`), поэтому sync выполняется обычным fetch/merge/rebase из `upstream`.
- Текущий компьютер не готов к полному workflow: отсутствуют Bun, LaTeX engines и `pdftotext`.
- Формат Bundesagentur API и правила допустимого использования нужно подтвердить перед реализацией.
- Надёжные public-transport commute данные не гарантированы; безопасный default — `VERIFY` с точным адресом/городом.
- Legacy Claude layer и новый Codex layer будут временно сосуществовать; до удаления legacy нужен explicit parity checklist.
- Autonomous submission значительно повышает последствия ошибки: policy/state/evidence/PDF/adapter gates должны быть executable и transactional, а не только prompt instructions.
- Persistent browser profile, payloads, receipts и screenshots содержат персональные данные и должны оставаться gitignored с OS-level access controls.
- ATS forms и confirmation flows меняются без предупреждения; automatic submit разрешается только adapters с актуальными fixtures и явным capability flag.
- `full_auto` не должен включаться по умолчанию или автоматически наследоваться из `supervised_auto`.
- Application-volume metrics могут стимулировать spam-like поведение; product decisions должны опираться на qualified funnel conversion, user time, sample size и confidence.
- Response/email/calendar integrations добавляют новые privacy и external-action boundaries; important replies и events требуют отдельной authorization policy.
- Evidence Vault потеряет смысл, если derived CV wording сможет повышать evidence level; provenance и claim permissions должны проверяться на schema/service boundary.
- `.vs/` уже присутствует как untracked local artifact и должна оставаться вне migration commits.
