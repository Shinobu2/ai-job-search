# Chatbot playbook: поиск вакансий без компьютера

Эту инструкцию можно целиком передать чатботу с доступом в интернет. Цель — найти вакансии, извлечь подтверждённые данные, оценить их рассуждением и подготовить ручной handoff. Ничего не выдумывай и не подавай заявку без явного разрешения пользователя.

## 1. Сначала уточни контекст

Одним коротким сообщением запроси недостающее: желаемые роли и города, радиус, языки, доступность, право на работу/нужен ли sponsorship, допустимые смены, физические и транспортные ограничения, зарплатный минимум и подтверждённый опыт. Неизвестное оставляй `VERIFY`; отсутствие факта не означает ни соответствие, ни несоответствие.

## 2. Публичные источники

Подставляй URL-кодированные значения вместо `{...}`. Эти источники предназначены только для чтения; для ATS без поисковых параметров загрузи доску компании и отфильтруй результаты по ключевым словам и городам самостоятельно.

- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
  — массив `jobs`; используй только реальные `id`, `title`, `company_name`, `location.name`, `absolute_url`, `content`.
- Lever: `GET https://api.lever.co/v0/postings/{slug}?mode=json`
  — ответ-массив; используй `id`, `text`, `categories.location`, `descriptionPlain`, `hostedUrl`/`applyUrl`. Для доски на `jobs.eu.lever.co` замени API-хост на `api.eu.lever.co`.
- Personio: `GET https://{slug}.jobs.personio.com/xml?language=en`
  — позиции находятся в XML; сохрани домен `.jobs.personio.de`, если его использует доска, а при пустом английском описании можно повторить с `language=de`.
- Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
  — массив `jobs`; используй `id`, `title`, `location`, `descriptionPlain`, `jobUrl`.
- SmartRecruiters: `GET https://api.smartrecruiters.com/v1/companies/{slug}/postings`
  — читай `content`, `offset`, `limit`, `totalFound`; следующие страницы запрашивай как `?limit={limit}&offset={next_offset}`. Для полного описания открой HTTPS-URL из `content[].ref`.
- Recruitee: `GET https://{slug}.recruitee.com/api/offers`
  — массив `offers`; используй `id`, `title`, `company_name`, `location`, `description`, `requirements`, `careers_url`.
- Arbeitnow: `GET https://www.arbeitnow.com/api/job-board-api?page={page}`
  — вакансии в `data`, следующая страница в `links.next`; фильтруй по названию/описанию и городу.

### Bundesagentur für Arbeit (Jobsuche)

Поиск:

```http
GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/app/jobs?was={keywords}&wo={city}&umkreis=80&size=20
Accept: application/json
X-API-Key: jobboerse-jobsuche
```

Возьми `referenznummer`, преобразуй UTF-8 строку стандартным Base64, затем URL-кодируй результат и запроси детали с теми же заголовками:

```http
GET https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/{base64(referenznummer)}
Accept: application/json
X-API-Key: jobboerse-jobsuche
```

Если источник отвечает `403`/`404` или временно недоступен, запиши диагностику и продолжай остальные источники. Не обращайся напрямую и не скрейпь Indeed, LinkedIn, XING, StepStone, Monster или Google Jobs.

## 3. Дедупликация

Сначала нормализуй apply-URL: убери фрагмент и параметры `utm_*`, `gclid`, `fbclid`, `ref`, `source` и другие явные трекеры. Считай записи дублями при одинаковом нормализованном URL или одинаковой нормализованной тройке `(компания, заголовок, город)`. Сохрани наиболее полный вариант, но перечисли все URL-источники.

## 4. Карточка из страницы вакансии

Возьми URL вакансии, найди на странице `<script type="application/ld+json">`, рекурсивно просмотри массивы и `@graph`, затем выбери объект с `@type: "JobPosting"`. HTML из `description` преобразуй в обычный текст. Если JSON-LD отсутствует или повреждён, используй видимый текст страницы и пометь источник как `model-fallback`.

Заполни карточку в формате `job import`; отсутствующие значения оставь `null`:

```json
{
  "title": null,
  "company": null,
  "location": {
    "addressLocality": null,
    "addressRegion": null,
    "addressCountry": null
  },
  "datePosted": null,
  "validThrough": null,
  "employmentType": null,
  "baseSalary": {
    "amount": null,
    "minValue": null,
    "maxValue": null,
    "unitText": null
  },
  "description": null,
  "directApply": null,
  "identifier": null
}
```

Маппинг: `hiringOrganization.name → company`, `jobLocation.address → location`, `baseSalary.value → baseSalary`, `identifier.value → identifier`. Если целиком отсутствуют `jobLocation` или `baseSalary`, поставь для соответствующего объекта `null`. URL вакансии и метку `json-ld`/`model-fallback` сохрани рядом с карточкой.

## 5. Оценка без репозитория

Для каждой вакансии выдай:

1. точные данные карточки и URL;
2. совпадение с желаемой ролью и городом;
3. hard gates по языку, сменам, физическим/транспортным ограничениям, праву на работу и зарплате — только против подтверждённых фактов пользователя;
4. требования работодателя и соответствующее подтверждённое доказательство опыта; непроверенное не называй опытом;
5. вердикт `APPLY`, `REVIEW` или `SKIP`, список `VERIFY` и один следующий шаг.

Не вычисляй ATS/EV-баллы. Если профиля кандидата нет, оцени только содержание вакансии, а все зависящие от кандидата пункты пометь `VERIFY`.

## 6. Ручной handoff

Не перезаписывай предыдущие записи. В конец `handoff.md` добавь:

```markdown
## YYYY-MM-DD — {company} — {title}
- Status: APPLY | REVIEW | SKIP
- Source: {source_name}
- Vacancy: {identifier}
- Location: {city}
- URL: {normalized_apply_url}
- Match: {краткое модельное обоснование}
- Hard gates: {PASS/BLOCKED/VERIFY с причинами}
- Evidence: {подтверждённое соответствие требованиям}
- Unknowns: {что уточнить}
- Next step: {одно конкретное действие}

{JSON-карточка из раздела 4}
```

После добавления сообщи пользователю, сколько уникальных вакансий найдено, какие требуют уточнения и что никакая заявка не была отправлена.
