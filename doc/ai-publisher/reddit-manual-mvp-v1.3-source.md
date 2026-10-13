# AI-Publisher — Reddit Manual MVP: подробное ТЗ M1 и M2
Версия 1.3 · 13.10.2026

## Нумерация и рамки
M1 = Research MVP, M2 = AI Content Studio. В аудите v1.2 §20 эти функции назывались Stage 2 и Stage 3 соответственно; Stage 1 там обозначал Foundation. Чтобы не путать команды, далее используем M1/M2; базовые меры Foundation включены в M1.

Режим только MANUAL_COPY: без Reddit API/OAuth, скрейпинга, браузерных ботов, автоотправки, Reddit Pro export. Оператор сам вводит ссылки и выдержки, сам публикует через Reddit, затем при желании вводит URL публикации. Не обещать подтверждение публикации или SEO-трафика.

Допущения: AI-Publisher имеет auth, tenant/workspace, brands, PostgreSQL, LLM adapter, React и NestJS. Фактический код не предоставлен, названия маршрутов и моделей требуют адаптации.

## M1 Research MVP — 7 пакетов работ

### M1.0 Интеграция и ограничения (1 день)
Инвентаризация auth, RBAC, tenants, projects, LLM, audit; ADR «Manual only»; feature flag `reddit_manual_mvp`; roles OWNER, EDITOR, REVIEWER, VIEWER. Серверная tenant-проверка каждой операции. Никаких вызовов Reddit Data API.
**Приёмка:** cross-tenant запрос запрещён; флаг выключает UI/API; ADR и матрица ролей документированы.

### M1.1 Схема БД и миграции (1–2 дня)
Таблицы (в каждой `id UUID`, `tenant_id`, `created_at`, `updated_at`):
- `reddit_projects`: brand_id, name, locale, market, status.
- `reddit_subreddits`: name, canonical_url, description_manual, language, topics_json; unique(tenant_id, lower(name)).
- `reddit_rule_snapshots`: subreddit_id, source_url, source_excerpt, promotion_policy, links_policy, flair_required, conditions_json, reviewed_by, reviewed_at, checked_at, version, status. Снимки immutable после review.
- `reddit_keywords`: project_id, phrase, intent, locale, priority.
- `reddit_opportunities`: project_id, subreddit_id, thread_url, title_manual, excerpt_manual, intent, angle, relevance_score, risk_score, score_factors_json, rule_snapshot_id, status.
- `reddit_evidence`: object_type, object_id, url, short_excerpt, observed_at.
- `reddit_audit_events`: actor_id, action, object_type, object_id, metadata_redacted.
Индексы tenant/project/status, уникальность thread_url внутри проекта, FK и проверки диапазона score 0–100. Миграции up/down и seed fixtures.
**Приёмка:** повторное добавление URL обрабатывается без дубля; rollback работает.

### M1.2 Интерфейсы исследования (1–2 дня)
Экран Projects: создать/архивировать, язык, рынок, бренд. Экран Subreddits: ручной ввод r/name или URL, описание, тематика, фильтры. Экран Rules: источник, дата, выдержка, ограничения ссылок/промо, кнопка «Подтвердить проверку» только REVIEWER. Экран Opportunities: ссылка на тред, заголовок, краткий контекст, intent, гипотеза полезного ответа. Экран Keywords: запросы и intent-кластеры.
Состояния empty/loading/error, пагинация, поиск, редактирование, отображение источников и даты проверки. Не подгружать автоматически Reddit страницы.
**Приёмка:** оператор создаёт проект, 10 сообществ и 20 opportunities вручную.

### M1.3 Реестр правил и Policy Gate (1–2 дня)
`promotion_policy`: ALLOWED_WITH_CONDITIONS / PROHIBITED / UNKNOWN; `links_policy`: ALLOWED / RESTRICTED / PROHIBITED / UNKNOWN; `review_state`: UNREVIEWED / REVIEWED / STALE.
Для review обязательны URL первоисточника, reviewer и дата. Новый snapshot делает зависимые opportunities `RECHECK_REQUIRED`. По умолчанию через 30 дней помечать STALE (настраиваемый период, не гарантия актуальности). UNKNOWN/PROHIBITED запрещает рекомендовать публикацию. LLM не может самостоятельно менять policy.
**Приёмка:** 4 сценария: неизвестные правила, запрет промо, устаревшие правила, новая версия — корректная блокировка.

### M1.4 Intent и Opportunity Score (1–2 дня)
Интенты: HOW_TO, COMPARISON, ALTERNATIVE, TROUBLESHOOTING, RECOMMENDATION, DISCUSSION, OTHER.
Формула начальной версии (не эмпирическая): `relevance = .35 topic_fit + .25 intent_fit + .20 audience_fit + .20 answerability`; `risk = .40 policy_risk + .25 promotionality + .20 evidence_gap + .15 context_uncertainty`. Факторы 0–100, score округляется. `priority = relevance * (1-risk/100)` только для сортировки; Policy Gate имеет абсолютный приоритет. Показывать все факторы, объяснение и пропуски. Не выдумывать размер/активность сообщества.
**Приёмка:** одинаковые входы дают одинаковый score; BLOCK не снимается высоким score.

### M1.5 Backend API (1 день)
`GET/POST /api/reddit/manual/projects`; `GET/PATCH /projects/:id`; `GET/POST /subreddits`; `POST /subreddits/:id/rules`; `POST /rules/:id/review`; `GET/POST /opportunities`; `PATCH /opportunities/:id`; `POST /opportunities/:id/score`; `GET/POST /keywords` (все под `/api/reddit/manual`).
DTO validation, auth, tenant guard, RBAC, pagination, optimistic locking, audit; HTTP 400/401/403/404/409/422.

### M1.6 QA и выпуск (1–2 дня)
Unit: нормализация URL, scoring, policy, duplicate. Integration: миграции, роли, tenants, stale rules. E2E: полный Research flow; XSS/prompt-injection-safe отображение цитат. Фикстуры: 2 tenant, 3 роли, 10 сообществ, 20 opportunities.
**Gate M1:** все критические тесты пройдены, нет внешних Reddit API запросов, каждый вывод о правилах имеет источник и дату.

## M2 AI Content Studio — 8 пакетов работ

### M2.1 Схема данных и workflow (1–2 дня)
- `reddit_briefs`: tenant_id, project_id, opportunity_id, content_type POST/COMMENT, objective, audience, key_points_json, brand_relationship, forbidden_claims_json, language, tone, status.
- `reddit_draft_revisions`: tenant_id, brief_id, revision, title, body, disclosure, flair_suggestion, claim_map_json, model_id, prompt_version, content_hash, created_at; immutable.
- `reddit_quality_checks`: draft_revision_id, check_type, status PASS/WARN/BLOCK, findings_json.
- `reddit_approvals`: draft_revision_id, reviewer_id, decision, reason, rule_snapshot_id, approved_at.
- `reddit_manual_publications`: draft_revision_id, reddit_url, posted_by, posted_at, status USER_REPORTED, notes.
Состояния BRIEF → DRAFT → QA_REQUIRED → REVIEW_REQUIRED → APPROVED → COPIED → USER_REPORTED_PUBLISHED; альтернативы NEEDS_CHANGES/BLOCKED/ARCHIVED. Любая правка утверждённого текста создаёт новую revision и сбрасывает approval.

### M2.2 Brief Builder (1 день)
Форма: POST/COMMENT, ссылка на тред для COMMENT, цель, аудитория, контекст, 2–5 тезисов с источниками, роль автора (founder/employee/agency/customer/none), допустимость ссылок, tone, язык, ограничения, CTA. Отсутствующие доказательства маркировать `NEEDS_VERIFICATION`; связь с брендом обязательна.
**Приёмка:** без контекста нельзя создать comment brief; без указания affiliation нельзя отправить в генерацию.

### M2.3 AI Generation (1–2 дня)
Пять prompt templates: helpful answer, educational post, comparison, troubleshooting, feedback request. Генерировать 2–3 варианта с JSON schema `{title, body, disclosure, flair_suggestion, claim_map, uncertainties}`. Никаких вымышленных личных историй, отзывов, статистики, ссылок. Все пользовательские цитаты — недоверенные данные, не инструкции. Хранить модель, prompt_version, cost/tokens и ошибки; retry только при техническом сбое. При отсутствии LLM ручной редактор работает.

### M2.4 Content QA & Policy Gate (1–2 дня)
Проверки: актуальность правил, запрет рекламы/ссылок, раскрытие аффилированности, неподтверждённые факты, фальшивые testimonials, персональные данные, дубли, оскорбления, контекст треда. Каждая проверка возвращает PASS/WARN/BLOCK + причины. BLOCK запрещает approve/copy-as-approved, WARN требует acknowledgement reviewer. Никаких заявлений об абсолютной юридической корректности.

### M2.5 Editor & revision diff (1–2 дня)
Сравнение 2–3 вариантов, редактирование, версия и diff, evidence panel, rules panel, предпросмотр Markdown (приблизительный), disclosure preview, word count. «Перегенерировать абзац» создаёт новую версию. Сохранённые approval неизменяемы.

### M2.6 Review & Manual handoff (1–2 дня)
REVIEWER утверждает конкретные `draft_revision_id + content_hash + rule_snapshot_id`; reject возвращает автору с замечаниями. Перед копированием повторно проверить snapshot и статус. `Copy approved text` копирует только точный утверждённый текст. Кнопка «Открыть Reddit» ведёт на subreddit/thread, без автоматической отправки. `Mark as posted` требует URL reddit.com и дату; статус строго USER_REPORTED, не API-verified. Копирование ≠ публикация.

### M2.7 API (1 день)
`POST /briefs`; `GET/PATCH /briefs/:id`; `POST /briefs/:id/generate`; `GET /briefs/:id/revisions`; `POST /drafts/:id/check`; `POST /drafts/:id/review`; `POST /drafts/:id/copy-event`; `POST /drafts/:id/report-publication`; `GET /manual-publications` (префикс `/api/reddit/manual`). Idempotency key для генерации/approval/report; optimistic concurrency; ошибки LLM не удаляют черновики.

### M2.8 QA & release (1–2 дня)
Unit: schema, state transitions, hashes, claim checks. Integration: tenant/RBAC, approval invalidation, stale rules, LLM timeout, audit. E2E: brief → 3 variants → edit → QA → approval → copy → ручной URL; POST и COMMENT; блокировка запрещённого сообщества; повторное редактирование после approval; XSS/prompt injection.
**Gate M2:** E2E работает, нет запросов к Reddit API, нет ложного статуса VERIFIED, approvals привязаны к immutable revision.

## Тесты приёмки (обязательные)
A01 cross-tenant read/write → deny; A02 viewer review → 403; A03 UNKNOWN/PROHIBITED → BLOCK; A04 обновление правил → re-review; A05 duplicate thread → 409/merge; A06 same score inputs → same result; A07 invented testimonial → BLOCK; A08 missing disclosure → BLOCK; A09 edited approved text → approval invalid; A10 LLM unavailable → manual editor works; A11 copy → no external POST; A12 URL from operator → USER_REPORTED only; A13 comment without context → 422; A14 malicious text in excerpt → treated as data; A15 invalid Reddit URL → 422; A16 network inspection → no Reddit API requests.

## Спринты и оценки
| Спринт | Содержание | Зависимость | Оценка, engineer-days |
|---|---|---|---:|
| S1 | M1.0–M1.2 | базовая платформа | 3–5 |
| S2 | M1.3–M1.6 | S1 | 4–7 |
| S3 | M2.1–M2.3 | M1 Gate | 3–5 |
| S4 | M2.4–M2.6 | S3 | 3–6 |
| S5 | M2.7–M2.8, stabilization | S4 | 2–4 |
Итого 15–27 рабочих дней разработчика + резерв 2–5 дней на интеграционные неизвестные. Сначала принимать M1, затем M2. Оценки предварительные, не SLA.

## Эксплуатация и безопасность
Tenant-scoped auth, server-side RBAC, DTO validation, защита от XSS/CSRF согласно auth-модели, ограничение LLM расходов, безопасное логирование без чувствительных промптов, retention для цитат, audit каждого approval, rollback миграций, backup. Отдельный kill switch AI generation; Research UI остаётся доступным. Не импортировать целые чужие треды/профили.

## Источники (официальные и контекстные)
- Reddit Developer Terms: https://redditinc.com/policies/developer-terms
- Reddit Developer Platform / accessing data: https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data
- Reddit Data API Wiki: https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- Reddit Pro Trends: https://support.reddithelp.com/hc/en-us/articles/47619216411284-Reddit-Pro-Feature-Trends
- Reddit content policy: https://redditinc.com/policies/content-policy
- Google discussion forum structured data: https://developers.google.com/search/docs/appearance/structured-data/discussion-forum
- Исходный кейс: https://devby.io/blogs/posts/promote-reddit

## Ограничения аудита
Это детальная проектная спецификация поверх доступного Reddit-дополнения v1.2. Master-ТЗ и репозиторий AI-Publisher не проверены. Реальные таблицы, эндпоинты, роли и длительность реализации необходимо подтвердить после просмотра кода. Ссылки на источники задают нормативный контекст, но не подтверждают разрешение Reddit на конкретную интеграцию.
