# D1. Безопасность приложения AI Publisher — внутренний аудит 19.10.2026

> **Внутренний аудит.** Исполнитель — агент-аудитор D1 той же модели, что и разработчики (внутренняя независимость ролей по плану v2 §1, не внешняя). Код и требования не правились. Секреты не читались и не выводились: в отчёте только имена переменных, тестовые значения стенда из `scripts/publisher-e2e.sh` и отпечатки (sha256[:12]) срабатываний сканера.

- **План:** [internal-audit-plan-v2.md](../internal-audit-plan-v2.md) §4 п.3; внешний план v1.1 §9 D1, §15, §16, §6.
- **Проверенная версия:** commit `4e644293` (= origin/main). Дельта к манифесту предаудита 13.10: в `publisher/**`, `publisher-site/src` 60 файлов изменено, 46 новых (`/tmp/ia-d1-ev/delta-preaudit.txt`, md5 `294ed3cf40f591b6d513915a67e52002`). Значимые для D1: весь `reddit/**` (40 маршрутов кабинета + внутренний API Админки), `core/roles.ts`, `core/operation.ts`, `content/source-import.ts`, `leads/contacts.controller.ts` (исправление D1-02). Поэтому матрица, идемпотентность, SSRF и раскрытие контакта повторены полностью, а не перенесены.
- **Глубина:** К — конфигурация, Ч — чтение кода, Д — динамический тест на стенде, Э — согласованная попытка эксплуатации. Мутаций в этом проходе нет (по заданию они необязательны). Глубина каждой проверки указана в §2.

## 0. Итог

> **E1 (после исправлений FX-A/B/C):**
> - IA-D1-01, IA-D1-02, IA-D1-03 → `verified_closed`;
> - наблюдения Н-D1-1, Н-D1-5 закрыты, Н-D1-2 закрыто на стенде;
> - регрессия матрицы — 0 изменённых ячеек;
> - новый дефект **IA-D1-04 (S3)**: кодированный email проходит маску;
> - production-проход 19.10 — passed, синтетическая заявка — blocked (production `closed`).
>
> Подробности — §14.3 и §18. Таблица ниже — первый проход.

**Дефектов S0/S1 нет. Новых дефектов — 3, все класса S3. Доступа к чужим данным, утечки контактов или секретов не найдено.** Все три находки D1 предаудита повторены по исходному сценарию и проходят: `verified_closed`. D2-02 и D2-03 остаются за пакетом D2 (`deferred`); от D1 добавлены частичные доказательства.

| ID | Класс | Суть | Глубина | Статус |
|---|---|---|---|---|
| IA-D1-01 | S3 | `GET` раскрытия контакта или заметок отвечает 405 с кодом ошибки `INTERNAL_SERVER_ERROR`: в общем фильтре нет кода для 405 | Д+Ч | new |
| IA-D1-02 | S3 | Проект §4.2 описывает раскрытие контакта как `GET`, а код после исправления D1-02 принимает только `POST` | Ч | new |
| IA-D1-03 | S3 | Отложенный вызов `pub.reddit.draft` от оператора Админки исполняется очередью без перепроверки статуса оператора — аналог D2-03 для актора `admin:` | Ч (PLAUSIBLE) | new |
| D1-01 | S2 | Пометка команд в источнике при сохранении | Д | **verified_closed** |
| D1-02 | S2 | Раскрытие контакта запросом с чужого сайта | Д | **verified_closed** |
| D1-03 | S2 | CSV журнала AI для оператора | Д | **verified_closed** |
| D2-02 / D2-03 | S2 | Маска телефона, очередь после отзыва роли | Д (функция) / Ч | deferred → D2 |

**Счёт проверок §2: 27 пунктов — 23 passed (в п. 21 часть «HSTS сайта» — blocked), 1 наблюдение по ТЗ (п. 12, Н-1), 1 deferred (п. 25: D2-02 и D2-03 → D2), 1 blocked (п. 26, production из песочницы → 403 прокси), 1 not_run (п. 27, синтетическая заявка: зависит от режима продукта, §14).** Матрица — **4718 ячеек, 0 расхождений с документом** (2 ячейки F1 объяснены и подтверждены отдельной пробой).

## 1. Стенд

- Сборка: `tsc -p tsconfig.build.json --outDir /tmp/ia-d1-back/dist` из `sites-backend` (rc=0). `dist` лежит вне рабочего дерева и подключается через `BACKEND_ROOT`.
- Стенд: `WORK=/tmp/ia-d1-w1 DB=ia_d1_main PORT=4151 SITE_PORT=3030 KEEP_SERVER=1 BACKEND_ROOT=/tmp/ia-d1-back bash scripts/publisher-e2e.sh --site`. Драйвер: **фаза a — 19/19, итог — 51/51 passed**, rc=0 (`/tmp/ia-d1-ev/e2e-site-run.log`, md5 `6de4b0d218b8d7959c4c7b7e14adfa8f`).
- Перезапуски backend выполнялись с теми же переменными, что у скрипта (`/tmp/ia-d1-scripts/start.sh`), и добавками:
  - `PUBLISHER_REDDIT_ENABLED`, `PUBLISHER_REDDIT_AI_ENABLED`, `PUBLISHER_STAND_FAKE_AI`;
  - `SITES_INTERNAL_SECRET` — тестовое значение;
  - `ASSIST_INTERNAL_SITE_IDS` — сайт кабинета B, он стал платформенным продуктом Админки;
  - `WEB_CABINET_ORIGINS=https://cabinet.test` и тот же origin в `CORS_ORIGIN`.

  Варианты запуска: без `TRUSTED_PROXY_CIDRS` — для проб публичного приёма; `NODE_ENV=production` — для заголовков и гардов; без флага Reddit — для AT-RD-17.
- Аутентификация настоящая:
  - `X-Telegram-Init-Data` подписывается HMAC тестовым токеном бота стенда, как в драйвере E2E;
  - веб-кабинет — `POST /sites/auth/web-login` с подписью Login Widget и cookie.
- **Субъекты** (`subjects.json`, md5 `bc408c2b406c2acc2bf4ddeb9e249449`):
  - `account_owner` и шесть ролей продукта — из сида и грантов драйвера;
  - `admin` (`publisher=admin` без грантов), `no_grants` (`publisher=member`), `publisher_none` (роль кабинета manager, `publisher=none`) — через приглашение владельца по API и принятие;
  - `foreign_owner` — владелец кабинета B со своим `X-Site-Account`;
  - `foreign_owner_hdrA` — тот же человек с `X-Site-Account` кабинета A;
  - `anonymous`.
- SQL на стенде — только чтение id и счётчиков. Единственная запись — `delete from pub_rate_hits`, сброс окна лимита перед пробами формы, как в предаудите.
- Сайт: `.next` стенда (`$WORK/site`) повторно запущен через `next start -p 3030` для проверки заголовков. После проверки остановлен.

## 2. Глубина и статус по пунктам

| # | Пункт | Глубина | Статус | Доказательство (`/tmp/ia-d1-ev/…`, md5) |
|---|---|---|---|---|
| 1 | Реестр маршрутов из декораторов `dist` (245) ≡ роутер Nest (`Mapped {…}`) | Ч+Д | passed | `routes.json` 4f858b99…, `router-mapped.txt` 33b9cd55… |
| 2 | Кодировка ожиданий из таблиц документа (§4.2 ДИЗ, §5 reddit-mvp) ≡ `PUB_PERMISSIONS` | Ч | passed (0 расхождений; 7 действий — code-only, как в предаудите) | `matrix.mjs` |
| 3 | Матрица кабинета: 221 маршрут × 13 субъектов (R/C/U/D) | Д | passed (2873 ячейки) | `matrix.json` 98bc92c8… |
| 4 | Экспорт (`?format=csv\|md`): 81 GET × 13 | Д | passed (1053) | `matrix-export.json` 8e569ae8… |
| 5 | Внутренний API `/internal/admin/reddit/**`: 72 шаблона × 6 вариантов входа; закрытый список, выход за таблицу | Д | passed (432) | `admin-internal.json` 1166e85d… |
| 6 | Журнал доступа Админки (Р-RD-ADM-7) | Д+Ч | passed | `admin-internal.json`, §4 |
| 7 | Прокси backend `/api/admin/reddit/*`: 72 × 5 + отзыв оператора | Ч+Д (in-process, upstream подменён) | passed (360) | `backend-proxy.json` 7ce8ef2f… |
| 8 | Изоляция Админки: объект ложится в платформенный продукт, не в продукт A | Д | passed | `admin-isolation.json` 9a9de3e5… |
| 9 | Тонкие права F1 (QA technical/editorial у оператора) | Д | passed | `f1.json` de4da05d… |
| 10 | Подмена кабинета, продукта, объекта, полей тела (X1–X6) | Д | passed | `probes-xr.json` c2f36d8d… |
| 11 | Отзыв роли при том же initData (R1), веб-сессия и удаление участника (R2) | Д | passed | `probes-xr.json` |
| 12 | Самовыдача роли администратором (Н-1) | Д | наблюдение (поведение по ТЗ, уведомления владельцу нет) | `probes-xr.json` F6 |
| 13 | Идемпотентность: повтор `opKey` чужим участником, ПД в ключах | Д | passed | `idem.json` ee593833… |
| 14 | Секреты: дерево, история git (371 коммит), `.env*` | К+Д | passed | `secrets-tree.json` d559f495…, `secrets-git.json` f794b021… |
| 15 | Секреты в клиентских бандлах: publisher-site `.next`, assist `dist` (сборка с маркерами) | Д | passed | `secrets-site-*.json` d7517139…, `secrets-assist.json` 3902364b…, `assist-build.log` 2e39f63e… |
| 16 | Журналы стенда (секреты, initData, cookie, ПД проб) | Д | passed (0 вхождений) | §7 |
| 17 | Публичный приём P1–P6 (Origin, лимит/XFF, повтор, размер, ловушка, быстрое заполнение, `__proto__`, валидация, события) | Ч+Д | passed | `probes-public.json` 17c81d45… |
| 18 | Тестовый режим: автопометка `test_mode`, запрет снятия, фильтр | Д | passed | `probes-public.json` T1 |
| 19 | SSRF: HTTP-импорт (22 цели), DNS-слой (13), редиректы через TLS-сервер (8) | Д | passed | `ssrf.json` 8fe44d82… |
| 20 | Заголовки, CORS, гарды стенда, дев-вход в production-режиме backend | К+Д | passed | `prod-mode.json` 5bd76b9c… |
| 21 | Заголовки сайта в рантайме (`next start`): CSP, XFO, Referrer, X-Robots-Tag, robots, sitemap, revalidate | К+Д | passed; HSTS сайта — blocked (ставит Vercel) | `site-headers.txt` b9dfb072… |
| 22 | Кроны и внутренний секрет: нет / неверный / в query / `x-vercel-cron`; нет env → 503 | Ч+Д | passed | `prod-mode.json`, `reddit-flag-off.json` 04a53d6c… |
| 23 | Выключатель Reddit (AT-RD-17) | Д | passed | `reddit-flag-off.json` |
| 24 | Перепроверка D1-01, D1-02, D1-03 | Д | passed → verified_closed | `probes-d1retest.json` 1cd64c37… |
| 25 | Перепроверка D2-02 (маска) и D2-03 (очередь) | Д функции / Ч | deferred → D2 | §11 |
| 26 | Production `ai-publisher.org`: заголовки, noindex, robots, sitemap | — | **blocked** (из песочницы 403 прокси) → шаги в §14 | — |
| 27 | Одна синтетическая заявка на production | Ч+Д (механизм на стенде) | **not_run**: условна по режиму продукта, §14 | — |

## 3. Матрица ролей

Сводные данные — `D1-role-matrix.csv` (md5 `d6664051983843eed7fc88fdf4925f3a`, 4718 строк). Столбцы: поверхность, субъект, маршрут, действия, класс операции, ожидание, источник ожидания, факт, статус, код, вердикт, `Cache-Control`, признак «новый после предаудита», примечание.

**Метод.**
- Маршруты сняты из метаданных декораторов собранного `dist` скриптом `routes.cjs`, без запуска приложения: `PATH/METHOD`, `@PubAllow`, `@RequireProductRoles`, `@PublicRoute`, гарды.
- Всего 245 маршрутов: 221 кабинетный (179 прежних + 40 Reddit + 2 новых `POST …/leads/:id/contact|notes`), 5 публичных, 3 крона, 2 часов стенда, 14 внутреннего API Админки.
- Набор совпал с журналом роутера 1:1.
- У всех 221 кабинетных маршрутов есть `@PubAllow` и цепочка `PubNoStoreGuard → SiteAccountGuard → PubRoleGuard`. У Reddit первым стоит `RedditEnabledGuard`.
- Параметры пути — реальные id продукта A, где они есть. Мутации отправлялись с `{}`: роль проверяется до валидации.
- Ожидание закодировано из таблиц документа, независимо от `roles.ts`.

| Субъект | Разрешено / отказ (кабинет, 221) | из них Reddit (40) |
|---|---|---|
| account_owner | 221 / 0 | 40 / 0 |
| product_owner | 209 / 12 | 40 / 0 |
| editor | 126 / 95 | 38 / 2 (handoff — PO/OP) |
| operator | 88 / 133 | 18 / 22 |
| analyst | 73 / 148 | 15 / 25 |
| sales | 69 / 152 | **0 / 40** (Р-RD-11) |
| viewer | 50 / 171 | 15 / 25 |
| admin | 72 / 149 | 15 / 25 |
| no_grants, publisher_none, foreign_owner, foreign_owner_hdrA, anonymous | 0 / 221 каждый | 0 / 40 |

**Коды отказа:**

| Субъект | Код |
|---|---|
| anonymous | 401 |
| publisher_none | 403 `PRODUCT_ROLE_REQUIRED` |
| no_grants и роли без действия | 403 `PUB_ROLE_REQUIRED` |
| foreign_owner_hdrA | 403 `ACCOUNT_REQUIRED` |
| foreign_owner | 404 `PUB_NOT_FOUND`, как у несуществующего продукта |

5xx — 0. `Cache-Control: private, no-store` есть у всех ответов участникам, включая 403/404. Исключение — 401 анонима, см. Н-D1-1.

**Отмеченные ячейки:**
1. `operator POST versions/:vid/qa-checks` с `{}` → 403: без `kind` действует `qa.editorial`. Проба F1: `technical` → 201, `editorial` → 403 на трёх версиях. Ожидание выполнено.
2. `POST leads/:id/notes` с `{}` → 200 для владельца, PO и sales: раскрытие заметок не требует `purpose`, в отличие от контакта. Роли разрешённые, раскрытие журналируется как `reveal_contact {what:notes}`. Это не дефект.

Скрытая кнопка не подтверждает запрет: все проверки — прямые HTTP-запросы к серверу, UI `assist` не участвовал. По коду экраны (`LeadsScreen`) показывают пометку «тест» и фильтр `test`.

## 4. Внутренний API Админки, прокси backend, журнал доступа

**`/internal/admin/reddit/**`** (`admin.mjs`): 72 шаблона = 40 `rx` + 24 `cx` + 8 собственных.

| Вариант входа | Результат |
|---|---|
| Без секрета; неверный секрет; initData владельца без секрета | 401 × 72 каждый |
| Секрет без `X-Admin-Actor`; актор неверного формата | 400 `ADMIN_ACTOR_REQUIRED` × 72 каждый |
| Секрет + актор | 200 × 13, 400 × 36 (валидация `{}`), 404 × 23 (ghost-id) |

- 5xx нет. `no-store` у всех ответов.
- `SITES_INTERNAL_SECRET` не задан → 503.
- Пути вне закрытой таблицы дают 404 `PUB_NOT_FOUND`, произвольного проксирования нет: `cx/leads`, `cx/leads/:id/contact` (GET/POST), `cx/roles`, `cx/backups`, `cx/..%2F..%2Fproducts`, `rx/projects/:id/../../leads`.
- Проект, созданный через `rx/projects`, лёг в платформенный продукт кабинета B. Продукт A не затронут.

**Журнал доступа (Р-RD-ADM-7):**
- на 72 запроса с актором — ровно 72 строки; запросы без входа строк не дают;
- в строке — шаблон маршрута (57 различных), без id, query и тел;
- `UPDATE` и `DELETE` свежей строки отклоняет триггер (`append-only`, «удаление — только старше 365 дней»).

Наблюдение Н-D1-8: триггер проверяет только формат `route`, строку с id в нём он пропустит. Отсутствие id обеспечивает приложение.

**Прокси backend** (`/tmp/ia-d1-bk/proxy.ts`): in-process Nest + supertest, настоящие `AdminSessionGuard`, `configureApp`, `AdminRedditController`. Сессии, `assertOperator` и upstream подменены.

- 72 маршрута контроллера = таблица `ADMIN_REDDIT_ROUTES` 1:1, у каждого есть вызов `fwd`/`send`.

| Субъект | Результат × 72 | Дошёл до sites-backend |
|---|---|---|
| Без cookie | 401 | нет |
| Просроченная сессия | 401 | нет |
| Пользователь не оператор | 403 | нет |
| Оператор | 200 | да, `X-Admin-Actor` = id оператора |
| Оператор, чужой Origin | 403 | нет |

- Снятие оператора при активной сессии → 403, запрос не пересылается.
- Глубина — Ч+Д in-process. Живой backend с БД не поднимался.

## 5. Подмена кабинета, продукта, объекта (`probes-xr.json`)

| Проба | Факт | Статус |
|---|---|---|
| X1 | Владелец A, `pid` продукта B, 10 маршрутов: статус, код и `details` совпадают с несуществующим id (404 `PUB_NOT_FOUND`). Запись в B — 404 | passed |
| X2 | `siteId` кабинета B: чтение и создание продукта — 404, как у ghost | passed |
| X3 | `X-Site-Account` = B у участника A: 403 `ACCOUNT_REQUIRED` одинаково для своего, чужого и ghost-продукта | passed |
| X4 | Свой продукт + источник B: GET/PATCH/revoke — 404; context-preview не включает B; Reddit-проект B через продукт A — 404 (GET/PATCH); источник B не изменён | passed |
| X5 | Владелец B: свой продукт + заявка A (карточка, `POST contact`, `POST notes`) — 404; продукт A в пути — 404 | passed |
| X6 | `productId`, `siteId`, `accountId` кабинета B в теле создания источника: 201, поля проигнорированы, строка в A, в B — 0 | passed |

## 6. Отзыв роли и сессии

**R1.** Новый участник получил гранты `sales` и `operator` от admin через API. Дальше запросы шли с одним и тем же заголовком initData, то есть в активной сессии.

| Шаг | Результат |
|---|---|
| Раскрытие контакта до отзыва | 200 |
| После отзыва `sales` | 403 `PUB_ROLE_REQUIRED {action: lead.contact.reveal}` |
| Права оператора (`venues`) после отзыва `sales` | 200 |
| После отзыва `operator`: чтение | 403 `{action: product.read}` |
| После отзыва `operator`: запись | 403 `{action: venue.manage}` |

**R2.** Тот же участник, вход через настоящий `web-login`.

| Шаг | Результат |
|---|---|
| Cookie | `HttpOnly; Secure; SameSite=Lax` |
| Запрос по cookie | 200 |
| Владелец ставит `publisher=none` | cookie и initData — 403 `PRODUCT_ROLE_REQUIRED` |
| Возврат `member` | 200 (гранты сохраняются, по дизайну) |
| `DELETE` участника | cookie и initData — 403 `ACCOUNT_REQUIRED` |
| До крона | 1 активный грант остаётся |
| После `GET /cron/publisher-tick` | грант закрыт, `revokedBy=system:member-removed` |

Кэша прав нет: проверка идёт на каждом запросе.

**F6 (Н-1).** `admin` выдал себе `sales` → 201, в журнале `meta.selfReview=true`. Новых уведомлений владельцу нет. Поведение по ТЗ, вопрос владельцу №13 предаудита остаётся открытым. Грант после пробы отозван.

**Идемпотентность (`idem.json`):**
- повтор того же `opKey` тем же участником → 201, тот же id;
- чужим участником → 409 `PUB_IDEMPOTENCY_REUSED`;
- изменённое тело → 409;
- viewer → 403 до проверки ключа.

В 41 строке `pub_idempotency_keys` маркеров ПД (email, +380, данные проб) — 0.

## 7. Секреты

Gitleaks в песочнице недоступен: GitHub releases отвечает 403. Вместо него использован собственный сканер в стиле gitleaks `/tmp/ia-d1-scripts/secretscan.py`. Его 19 правил:
- приватные ключи, AWS, GCP, GitHub, Slack, Stripe;
- токен бота Telegram, `sk-ant-`, OpenAI, Google OAuth, SendGrid, Twilio, Vercel Blob/token;
- JWT, service_role, DSN с паролем не на localhost;
- общее присваивание `secret|token|password|api_key=…` с энтропией ≥ 3,3.

**Значения не выводятся** — только файл:строка:правило:отпечаток.

| Где | Результат |
|---|---|
| Дерево без `node_modules`, `.next`, `dist`, `.git`, `live-login-relay` | 64 срабатывания, из них **62 в тестах, фикстурах и документах**. 2 «code» — регулярка-описание в `db-error.ts`, это комментарий `postgresql://user:***@host`. Тестовые TLS-ключи фикстур, фиктивный `sk-ant-…ghijkl` в spec. Реальных секретов нет. |
| История git: 371 коммит, только добавленные строки, без `live-login-relay/` | 64; **отпечатков, которых нет в текущем дереве, — 0** |
| Отслеживаемые файлы окружения | Только `*.env.example`. 6 DSN там — шаблоны (`[region]`, пароль-плейсхолдер), проверено без вывода |
| publisher-site `.next` стенда, собран с `PUBLISHER_REVALIDATE_SECRET` в env | `static` и `server`: 0 срабатываний; 0 вхождений тестового секрета ревалидации, CRON, токена бота и ключа шифрования. Публичный ключ `pp_…` и origin API в `.next/static` — 0, они есть только в серверном HTML и props. Так задумано. |
| assist `vite build` в `/tmp/ia-d1-assist` с маркерами `D1MARKER` в `ASSIST_BOT_TOKEN`, `CRON_SECRET`, `SITES_INTERNAL_SECRET`, `ASSIST_SECRETS_KEY`, `PUBLISHER_REVALIDATE_SECRET`, `BLOB_READ_WRITE_TOKEN` | Маркеров 0, имён серверных переменных 0. Одно срабатывание `private-key` — строковый литерал заголовка PKCS#8 в коде библиотеки jose, не ключ. Имя `BLOB_READ_WRITE_TOKEN` встречается в 1 файле — клиент `@vercel/blob`, Н-6 предаудита сохраняется. |
| Журналы стенда (~1 МБ) | Значения тестовых секретов, `auth_date=`, `hash=`, cookie сессии, `+380`, email проб — 0 вхождений |
| Файл копии стенда | 49 277 байт, gzip не сжимает (шифртекст), маркеров нет |

## 8. Публичный приём и тестовая пометка (`probes-public.json`, сервер без `TRUSTED_PROXY_CIDRS`)

| Проба | Факт | Статус |
|---|---|---|
| P1 Origin | чужой, пустой, `null`, поддомен, `http://` → 403 `PUB_ORIGIN_DENIED` (5/5) | passed |
| P2 лимит | 7 отправок с разными `X-Forwarded-For`/`X-Real-IP`: 5 × 201, затем 429 `PUB_RATE_LIMITED`, `Retry-After: 600`; создано ровно 5 | passed |
| P3 повтор | тот же `submissionKey` → 200 и тот же номер; изменённое тело → 409; Δ заявок 0; ответ не эхоит имя и контакт | passed |
| P4 тело | 9 КБ и 3 МБ → 413; `text/plain` с чужого Origin → 403; ловушка `hp` → 201 со случайным номером, без записи; `elapsedMs=100` → записана с `suspectedSpam=true`; плохой email → 400 `contact/format`; имя 500 символов → 400; `<script>` в полях → 201 как данные (экранирование — сайт и кабинет, Ч предаудита) | passed |
| P4 `__proto__` | валидное тело + `"__proto__":{…}` → 201. Поле игнорируется: валидатор читает поля по белому списку, UTM — по белому списку ключей, загрязнения прототипа нет (Ч). Предаудит видел 400 на теле, где был только `__proto__`. | passed |
| P5 события | чужой и без Origin → 403; свой → 202 | passed |
| P6 | неизвестный ключ → 404; SQL-строка в ключе → 400; `contents` → `public, s-maxage=60`; preflight с чужого Origin → 204, ACAO = этот origin, **без** credentials (Н-3 предаудита) | passed |

**Пометка тестовых заявок (код + T1):**
- Пометка ставится **сервером по виду и режиму продукта** (`public-guard.ts testFlagOf`): `kind≠working` → `test_product`, `mode≠live` → `test_mode`. Посетитель пометку не задаёт: в `LeadBody` нет такого поля.
- Режим `closed`: в представлении `pub_public_products` `formOpen=false` и `allowedOrigins=[]`, приём закрыт.
- Т1 на стенде. Продукт B получил `test_hosts=["https://pubtest.test"]` (предложение и решение владельца B) и `mode=test`. Результат:
  - `site-config`: `mode=test`, `formOpen=true`;
  - заявка 201 → `testFlag=true`, `testReason=test_mode`;
  - снять пометку нельзя: 400 `testFlag/test_mode`;
  - `GET …/leads?test=only` → 1, `?test=exclude` → 0.
- Отчёты: `report-compute.ts` считает `testLeads` отдельно и исключает их из заявок периода. Когорты (`cohorts.ts`) их пропускают. Паспорт трафика и платежи учитывают `testFlag` (Ч).
- Уведомления: для продукта `kind=working` в режиме `test` заявка всё равно ставит `new_lead` и затем `contact_overdue` ответственным через бота помощника. Текст без контактов. `suppressed` только для `kind≠working` (Н-D1-3).

## 9. SSRF и импорт URL (`ssrf.json`)

- **HTTP, `POST …/sources/import-url`, editor, 22 цели.** Все дали 400 `PUB_IMPORT_BLOCKED`, новых источников 0:
  - `ssrf`: `127.0.0.1`, `:4151`, `localhost`, `localhost.`, `[::1]`, `169.254.169.254`, `10.0.0.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `[::ffff:127.0.0.1]`, `[0:0:0:0:0:ffff:7f00:1]`, `user:pass@`, `:8443`, одноуровневое `vm`;
  - `not_https`: `http:`, `file:`, `gopher:`;
  - `reddit_manual_only`: Reddit;
  - `timeout`: неразрешимое имя (`metadata.google.internal`, `pubsite.test`), Н-D1-6.
- **DNS-слой** (`resolveAndCheck` из `dist`): 13 подставленных наборов адресов — loopback v4/v6, 10/8, 169.254, `::ffff:127.0.0.1`, `fd00::1`, `fe80::1`, 100.64/10, 0.0.0.0, 198.18/15, multicast, rebinding `[публичный, частный]`. Результат — 12 × `SsrfBlockedError`, публичный адрес пропущен.
- **Редиректы.** `pinnedFetch` из `dist` против локального TLS-сервера с сертификатом стенда `pubsite.test`, DNS подменён:

| Сценарий | Результат |
|---|---|
| На другой хост, `sameOrigin` (импорт и размещение) | `RedirectOffsiteError` |
| На внутренний хост в режиме robots (`sameOrigin:false`) | `SsrfBlockedError` |
| Понижение до `http:` | `SsrfBlockedError` |
| На IP-литерал | `SsrfBlockedError` |
| На порт | `SsrfBlockedError` |
| На userinfo | `SsrfBlockedError` |
| Свой путь | 200 |
| Свой путь, но DNS второго хопа → 127.0.0.1 | `SsrfBlockedError` |

  Сквозная проба «публичный хост → 302 на внутренний», которая в предаудите была blocked, теперь выполнена в этом виде.

## 10. Заголовки, CORS, кроны, гарды (`prod-mode.json`, `site-headers.txt`)

**Backend, `NODE_ENV=production`:**
- Старт с `PUBLISHER_AI_ALLOW_UNEVALUATED` отклоняется — гард Р-PUB-16.
- `PUBLISHER_STAND_CLOCK` и `PUBLISHER_STAND_BACKUP_DIR` игнорируются с предупреждением.
- Все ответы: `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, без `X-Powered-By`.
- `Cache-Control`: кабинет и внутренний API — `private, no-store`; публичные маршруты — `public, s-maxage=60`.
- Preflight с чужого Origin: кабинет и внутренний API → 403. Свой origin → ACAO и `Allow-Credentials: true`.
- `/__stand/publisher/clock` GET/POST → 404.
- `X-Dev-User-Id` → 401, `web-dev-login` → 404.
- Кроны `publisher-tick|minute|daily`: без секрета, с неверным, с секретом в query и с `x-vercel-cron: 1` → 401 (12/12). Сравнение секрета — `timingSafeEqual` (Ч).

**Сайт** (`next start` стенда, индексация выключена):
- На всех 10 путях: `Content-Security-Policy` (`default-src 'self'; script-src 'self' 'unsafe-inline'; … connect-src 'self' <API> https://backend-iota-ruddy-57.vercel.app; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Robots-Tag: noindex, nofollow`. `X-Powered-By` нет.
- `<meta name="robots" content="noindex, nofollow">`.
- `robots.txt` = `User-Agent: * / Allow: /` без `Sitemap` — по ДИЗ §13.3.
- `sitemap.xml` отдаётся с адресами `SITE_URL`.
- Несуществующий материал → 404.
- `GET /api/revalidate` → 405. `POST` без секрета или с неверным → 401.
- `/.well-known/v4c-verify.txt` без токена → 404 `no-store`.
- **HSTS сайта в конфиге нет** — его ставит Vercel. Проверка — production-шаг §14.

## 11. Перепроверка предаудита (исходные сценарии на 4e644293)

| prev_id | Сценарий | Факт | Новый статус |
|---|---|---|---|
| D1-01 | AI1: источники с командами издателю, правка фрагмента, context-preview | 4/4 команды помечены в API, БД и preview (`ignore-process`, `publish-without-approval`, `role-claim` при обратном порядке слов, `pay-now`); чистый — NULL; правка → `role-claim` | **verified_closed** |
| D1-02 | CG1: активная веб-сессия, раскрытие контакта с чужого сайта | GET → 405 без записи; form-POST и JSON-POST с чужим Origin → 403; без Origin → 403; со своего → 200; журнал +1 только за легитимный; preflight чужого → 403 | **verified_closed** |
| D1-03 | operator `ai/calls?format=csv` | 200 `text/csv`; viewer 403; экспортная матрица без расхождений | **verified_closed** |
| D2-02 | маска телефона в «идентификаторе» | D1: функция `maskContacts` из `dist` маскирует `tel_/phone_/viber_/user…`, `id: +380…`, cuid-образный токен с телефоном. Не маскирует `ID 12345678`, суммы, даты и точные id контекста. Полный путь через шлюз — у D2 | deferred (владелец — D2) |
| D2-03 | очередь после отзыва роли | Ч: `recheckCall` перепроверяет право автора по текущим грантам, `ai_use` и конфигурацию. Пробел для актора `admin:` — IA-D1-03. Динамика — у D2 | deferred (владелец — D2) |

Наблюдения предаудита: Н-1 воспроизведено (F6). Н-2 (`unsafe-inline`), Н-3 (CORS публичных маршрутов), Н-6 (имя переменной `@vercel/blob` в бандле assist) сохраняются. Н-4 (initData 24 ч) и Н-5 (гарды стенда по `NODE_ENV`) — код не менялся, не перепроверялись. Н-7 — подтверждено R2.

## 12. Новые дефекты

Подробно — `D1-defects.csv` (md5 `b38c49d2c0b3a29b7d2f955318cb0962`).

- **IA-D1-01 (S3)** — 405 с кодом `INTERNAL_SERVER_ERROR`. Причина — нет записи `405` в `CODE_BY_STATUS` (`common/filters/http-exception.filter.ts`). Клиент и мониторинг принимают отказ метода за сбой сервера.
- **IA-D1-02 (S3, документ)** — ДИЗ §4.2 «Раскрыть контакт (`GET`…)» расходится с `POST`-контрактом после D1-02.
- **IA-D1-03 (S3, PLAUSIBLE)** — `recheckCall` для `admin:` не перепроверяет, что оператор всё ещё оператор: статус хранится в БД backend и в sites-backend недоступен. Окно — минуты. Последствия — черновик в платформенном продукте и расход в пределах бюджета AI.

## 13. Наблюдения (не дефекты)

- **Н-D1-1.** 401 глобального входа на маршрутах кабинета приходит без `Cache-Control: no-store`: `PubNoStoreGuard` идёт позже. Комментарий в `pub-role.guard.ts` обещает заголовок «и у 401». 401 по умолчанию не кешируется, данных в ответе нет.
- **Н-D1-2.** CSP `connect-src` и `layout.tsx` содержат жёстко заданный origin платформы `https://backend-iota-ruddy-57.vercel.app`: агрегированные визиты лендинга, только при `VERCEL_ENV=production`, без cookie и идентификаторов, без учёта `consentState`. Origin задан в коде, а не в env.
- **Н-D1-3.** Тестовые заявки (`test_mode`) рабочего продукта порождают уведомления `new_lead` и `contact_overdue` команде через бота. Это важно для production-заявки (§14).
- **Н-D1-4.** Сигналы антиспама `hp` и `elapsedMs` приходят от клиента: бот без `elapsedMs` не помечается. Основная защита — Origin и лимит 5/600 с на IP.
- **Н-D1-5.** `AdminSessionGuard` backend пропускает небезопасный запрос без `Origin` (`isOriginAllowed`). Современные браузеры ставят `Origin` на межсайтовый POST. Схема та же, что у остальной Админки.
- **Н-D1-6.** Отказ `metadata.google.internal` и других неразрешимых имён получает причину `timeout`, а не `ssrf`/«имя не резолвится». Это влияет только на текст ошибки; защита срабатывает.
- **Н-D1-8.** Триггер журнала доступа Админки проверяет формат `route`, но не отсутствие id. Гарантию даёт приложение.

## 14. Production `ai-publisher.org` (разрешено владельцем) — для главного агента

**Из песочницы недоступно:** `https://ai-publisher.org/` и `https://www.ai-publisher.org/` → 403 от прокси, `http://` не резолвится. Статус пунктов 26–27 — blocked и not_run. Ниже — готовые шаги для браузера.

### 14.1. Контрольный проход (только чтение)

Ожидания, если продукт в режиме `closed` или не индексируемый, то есть сборка без двух ключей индексации:

| # | URL | Ожидаемо |
|---|---|---|
| 1 | `http://ai-publisher.org/` | 301/308 на `https://ai-publisher.org/` (Vercel) |
| 2 | `https://www.ai-publisher.org/` | редирект на apex или 200 — записать факт; сертификат валиден |
| 3 | `https://ai-publisher.org/` | 200. Заголовки: `Strict-Transport-Security` (Vercel, ≥ `max-age=31536000`), `Content-Security-Policy` как в §10 с `connect-src 'self' <PUBLISHER_API_ORIGIN> https://backend-iota-ruddy-57.vercel.app` (по DEPLOYMENT.md API — `https://assist-api.viral4creators.app`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, **`X-Robots-Tag: noindex, nofollow`**, без `X-Powered-By`. В HTML `<meta name="robots" content="noindex, nofollow">`, canonical `https://ai-publisher.org`, баннер `data-testid="mode-banner"`: «Сайт ще не приймає звернень.» (closed) или «Тестова версія сайту: звернення … позначаються як тестові.» (test) |
| 4 | `/robots.txt` | 200: `User-Agent: *` / `Allow: /`, **без строки `Sitemap`** (при индексации появится `Sitemap: https://ai-publisher.org/sitemap.xml`), `X-Robots-Tag: noindex, nofollow` |
| 5 | `/sitemap.xml` | 200, только `https://ai-publisher.org/…` (`/`, `/materials`, опубликованные материалы); нет `localhost`, `*.vercel.app`, `pubsite.test` |
| 6 | `/materials`, `/contact`, `/privacy` | 200, те же заголовки; `/contact` в closed — «Форма зараз не приймає звернень…» |
| 7 | `/materials/d1-nonexistent-slug`, `/__d1-404` | 404, noindex |
| 8 | `GET /api/revalidate` | 405. `POST /api/revalidate` без авторизации — 401, а при секрете короче 16 символов или без секрета — 404 |
| 9 | `/.well-known/v4c-verify.txt` | 404 (`no-store`), если `PUBLISHER_OWNERSHIP_TOKEN` не задан (рекомендован TXT); иначе 200 с токеном — записать только код |
| 10 | `<API>/public/publisher/v1/site-config?key=<pp_…>&host=ai-publisher.org` | 200 JSON: `mode`, `formOpen`, `indexable` (в closed `formOpen=false`, `indexable=false`), `Cache-Control: public, s-maxage=60…` |

**JS для консоли на `https://ai-publisher.org/` (тот же origin; ничего не отправляет, кроме чтения и одного пустого POST на revalidate):**

```js
(async () => {
  const paths = ['/', '/materials', '/contact', '/privacy', '/robots.txt', '/sitemap.xml',
    '/materials/d1-nonexistent-slug', '/__d1-404', '/api/revalidate', '/.well-known/v4c-verify.txt'];
  const H = ['strict-transport-security', 'content-security-policy', 'x-robots-tag', 'referrer-policy',
    'x-frame-options', 'x-content-type-options', 'permissions-policy', 'cache-control', 'x-powered-by', 'server'];
  const out = { origin: location.origin, protocol: location.protocol };
  for (const p of paths) {
    const r = await fetch(p, { redirect: 'manual', cache: 'no-store', credentials: 'omit' });
    const h = {}; for (const k of H) h[k] = r.headers.get(k);
    const t = r.type === 'opaqueredirect' ? '' : await r.text();
    out[p] = { status: r.status, h,
      metaRobots: (t.match(/<meta name="robots" content="([^"]+)"/) || [])[1] ?? null,
      canonical: (t.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] ?? null,
      banner: (t.match(/data-testid="mode-banner"[^>]*>\s*<span[^>]*>([^<]*)/) || [])[1] ?? null,
      body: /\.(txt|xml)$/.test(p) ? t.slice(0, 800) : undefined };
  }
  out['POST /api/revalidate'] = (await fetch('/api/revalidate', { method: 'POST', credentials: 'omit' })).status;
  const html = await (await fetch('/contact', { cache: 'no-store' })).text();
  const key = (html.match(/pp_[A-Za-z0-9]{24}/) || [])[0];
  const csp = out['/'].h['content-security-policy'] || '';
  const api = (csp.match(/connect-src 'self' (https:\/\/[^\s;]+)/) || [])[1];
  out.publicKeyFound = !!key; out.api = api;
  if (key && api) {
    const sc = await fetch(`${api}/public/publisher/v1/site-config?key=${key}&host=${location.host}`, { credentials: 'omit' });
    const j = await sc.json().catch(() => null);
    out.siteConfig = { status: sc.status, cacheControl: sc.headers.get('cache-control'), mode: j?.data?.mode,
      formOpen: j?.data?.formOpen, indexable: j?.data?.indexable, consentState: j?.data?.consentState,
      dataNoticeApproved: j?.data?.dataNotice?.approved ?? null };
  }
  console.log(JSON.stringify(out, null, 1)); return out;
})();
```

Пункты 1–2 (редиректы `http://` и `www`) проверяются переходом в адресной строке: `fetch` с другого origin их не покажет. Сертификат проверяется по значку замка: issuer и срок.

### 14.2. Синтетическая заявка — порядок и условие

**Механизм тестовой пометки:** клиентского флага нет. `testFlag` ставит сервер:
- `mode=test` → `testReason=test_mode`;
- `kind≠working` → `test_product`.

Снять системную пометку нельзя. Такие заявки исключаются из отчётов, когорт и фильтра `?test=exclude`. Ручная пометка — `POST /publisher/products/:pid/leads/:id/test-flag` с `{testFlag:true, reason, expectedRevision, opKey}`, роли PO/AN/SA. Это пост-фактум, не безопасная пометка при отправке.

**Решение по `siteConfig` из 14.1:**

1. **`mode=closed` или `formOpen=false`** → **заявку НЕ отправлять**: форма закрыта, сервер ответит 403/503 без записи. Пункт 27 — `blocked` с причиной «production в режиме closed: приём закрыт, тестовая заявка невозможна и не требуется». Достаточно доказательства закрытости: текст `/contact`, `formOpen=false`.
2. **`mode=live`** → **заявку НЕ отправлять**: при приёме она станет реальной (`testFlag=false`), попадёт в деловые суммы до ручной пометки и запустит SLA. Безопасной тестовой пометки при отправке в этом режиме нет. Пункт 27 — `blocked`.
3. **`mode=test` и `formOpen=true`** → отправка **одной** заявки безопасна. Предварительно предупредить владельца: ответственный получит в бота `new_lead`, а позже одно `contact_overdue`, без контактов (Н-D1-3). Порядок:
   1. открыть `https://ai-publisher.org/contact` и убедиться, что баннер «Тестова версія сайту…» виден;
   2. заполнить форму синтетикой: имя `AUDIT-D1 synthetic 19.10`; способ — email; контакт `audit-d1-synthetic@example.com` (зарезервированный домен, доставки нет); бизнес — `Internal audit D1`; задача — `Synthetic test lead — ignore`; бюджет не указывать; согласие — как предложит форма. Отправить **один раз**, без повторов;
   3. записать номер обращения (`L-…`) с экрана результата и время по Киеву;
   4. **проверка исключения.** Кто может: владелец кабинета, `product_owner`, `analyst`, `sales` (`lead.read`). Где — кабинет assist → сайт → Publisher → «Заявки» с фильтром «тест: только» или `GET /publisher/products/:pid/leads?test=only`. Ожидается: заявка с пометкой «тест» и причиной `test_mode`. С фильтром `?test=exclude` её нет. Карточка `GET …/leads/:id` — `testFlag=true`, `testReason=test_mode`. Попытка снять пометку → 400 `testFlag/test_mode`, по желанию. В отчёте периода (`POST …/reports` или экран «Отчёты») заявка учитывается только в `testLeads`, в заявках и CPL её нет;
   5. после проверки владелец или sales закрывают заявку статусом с причиной «тестова заявка аудиту» либо оставляют её ретенции на 90 дней. Контакт синтетический.

### 14.3. Production-проход 19.10.2026 — результат

Проход выполнил главный агент в браузере владельца по шагам 14.1. Это динамика на живом сайте, без отправки формы. Сырые данные — в протоколе главного агента; здесь переданы его фактами.

| Проверка | Факт | Статус |
|---|---|---|
| Страницы `/`, `/materials`, `/contact`, `/privacy` | 200; `/privacy` — не черновик | passed |
| HTTPS / HSTS | `Strict-Transport-Security` есть (ставит Vercel) | passed. Пункт 21 «HSTS сайта» закрыт |
| Индексация | `X-Robots-Tag: noindex, nofollow` и `<meta name="robots" content="noindex, nofollow">` | passed |
| Прочие заголовки | XFO `DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, без `X-Powered-By` | passed |
| CSP | `default-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`; в `connect-src` есть origin `backend-iota…`. Это деплой до исправления FX-A, наблюдение Н-D1-2 | passed с наблюдением. Исправление проверено на стенде (§18), на production — после деплоя |
| robots.txt / sitemap.xml | robots без строки `Sitemap`; sitemap — 2 `loc`, только `ai-publisher.org` | passed |
| Несуществующие пути | 404, noindex | passed |
| `/api/revalidate` | GET → 405; POST → 404: `PUBLISHER_REVALIDATE_SECRET` на сайте не задан или короче 16 символов, маршрут закрыт | passed |
| `/.well-known/v4c-verify.txt` | 404 | passed |
| Режим | баннер «Сайт ще не приймає звернень.» → `closed` | — |
| Сеть страницы | beacon `assist-api…/public/publisher/v1/events`, `fetch backend-iota…/api/public/landing-visits` — в режиме `closed`. Подтверждает Н-D1-2 на production: до FX-A счётчик слал визиты при закрытом сайте | наблюдение → исправлено FX-A (§18) |
| **П. 27: синтетическая заявка** | **не отправлялась**: production `closed`, приём закрыт | **blocked** (production closed) |

Итог по п. 26: **passed** — динамика в браузере владельца, без формы. Остаток: CSP и landing-visits на production ещё в старом виде до деплоя FX-A.

## 15. Ограничения и blocked

- **Production** — недоступен из песочницы (§14). Не проверены также HSTS сайта, перезапись XFF платформой Vercel и хранилище копий Blob.
- **Прокси backend** проверен in-process с подменённой БД сессий и upstream. Живой backend с Postgres не поднимался.
- **IA-D1-03** — только чтение кода.
- **D2-02 и D2-03** — полный повтор у D2.
- Живого Telegram нет: подпись initData и Login Widget — тестовым токеном стенда.
- Мутаций кода в этом проходе нет (М1–М8 предаудита не повторялись).
- Существующие jest-наборы (`z-isolation`, `roles.spec`, `admin-reddit*.spec`) D1 не запускал: это зона C и A/B.
- Сам исполнитель не независим (план v2 §1).

## 16. Воспроизведение

```
# стенд
WORK=<новый каталог> PG=postgresql://postgres:postgres@localhost:5432 DB=ia_d1_main PORT=4151 SITE_PORT=3030 \
  KEEP_SERVER=1 BACKEND_ROOT=/tmp/ia-d1-back bash scripts/publisher-e2e.sh --site
. /tmp/ia-d1-scripts/env-rd.sh && /tmp/ia-d1-scripts/start.sh $RD   # Reddit, внутренний секрет, веб-origin
cd /tmp/ia-d1-scripts
node routes.cjs … && node setup.mjs && node matrix.mjs && EXPORT=1 node matrix.mjs
node admin.mjs && node admin2.mjs && node probes.mjs && node probes2.mjs && node f1.mjs && node idem.mjs && node ssrf.mjs
NO_TRUST=1 ./start.sh $RD && node public.mjs
NODE_ENV_OVERRIDE=production ./start.sh $RD -PUBLISHER_AI_ALLOW_UNEVALUATED && node prodmode.mjs
./start.sh WEB_CABINET_ORIGINS=https://cabinet.test && node noflag.mjs
(backend) node -r ts-node/register /tmp/ia-d1-bk/proxy.ts
python3 -I secretscan.py dir|git …
```

md5 доказательств — `/tmp/ia-d1-ev/evidence-md5.txt`, md5 скриптов — `/tmp/ia-d1-ev/scripts-md5.txt`.

## 17. Предварительный внутренний вердикт по шлюзам (§6 внешнего плана; внутренний, commit 4e644293)

Исходный, до E1. Итоговый вердикт — §18.6.

| Шлюз | Вклад D1 |
|---|---|
| Требования пригодны для реализации | вне D1. Сигнал — IA-D1-02: устаревшая строка §4.2 |
| Готов к публичному D0 | **Недостаточно доказательств.** По D1 блокирующих условий нет: доступа к чужим данным нет, утечек контактов и секретов нет, ложного успеха формы нет (D1 в части безопасности приёма). Но production-проход (§14) не выполнен: HSTS, noindex и режим на `ai-publisher.org` не подтверждены |
| Готов к конкретной закупке | вне D1. Права закупок и бюджета в матрице — passed |
| Поставка P0 принята | вне D1. По D1 открыты только S3 |
| Коммерческий результат подтверждён | вне D1 |

## 18. Перепроверка E1 (после исправлений FX-A/B/C)

### 18.1. Проверенная версия

- **Дерево:** `4e644293` плюс незафиксированные исправления. `git diff --stat` — 48 файлов, +1771/−235: `/tmp/ia-d1-e1/diff-stat.txt` (md5 `ffb27a7d22f85561c59e60416b7c3584`), полный diff — `/tmp/ia-d1-e1/diff.patch` (md5 `1c9ed37dd83413dbe9840999e845a458`).
- **Новые неотслеживаемые файлы:** 14, md5 каждого — `/tmp/ia-d1-e1/untracked-md5.txt` (md5 `5498f7e0b997b095ac59acf39d8bddaf`). Среди них `.github/workflows/publisher-ai-eval.yml`, `backend/.../admin-reddit.origin.guard.ts`, `publisher-site/src/lib/landing-visits.ts`, `sites-backend/.../core/admin-attest.ts`, миграция `20261026100000_publisher_reddit_policy_version`.
- **Сборка:** `tsc` в `/tmp/ia-d1-back2` (rc=0).
- **Стенд:** `publisher-e2e.sh --site`, `WORK=/tmp/ia-d1-w2`, `DB=ia_d1_e1`, порты 4151/3030, `PUBLISHER_RELEASE_SHA` = HEAD. Драйвер — **51/51 passed**, rc=0 (`e2e-site-run.log`, md5 `36daf634df290d65394cbe4aa999897a`).
- Доказательства — `/tmp/ia-d1-e1/` (`evidence-md5.txt`), скрипты — `/tmp/ia-d1-scripts/e1/`, `/tmp/ia-d1-scripts/lv.ts`, `/tmp/ia-d1-bk/proxy-e1.ts` (`scripts-md5.txt`).

### 18.2. Исходные сценарии

| ID | Сценарий | Факт на E1 | Глубина | Статус |
|---|---|---|---|---|
| IA-D1-01 | `GET …/leads/:id/contact` и `/notes` при cookie веб-кабинета | 405, `Allow: POST`, код **`METHOD_NOT_ALLOWED`**. Таблица кодов 4xx/5xx явная, незнакомый 4xx → `CLIENT_ERROR` | Д+Ч | **verified_closed** |
| IA-D1-02 | ДИЗ §4.2 и §11 против кода | В таблице `POST …/contact` и `POST …/notes` с `{purpose}`, `GET` → 405. Устаревших `GET` в `doc/ai-publisher` нет | Ч | **verified_closed** |
| IA-D1-03 | Вызов `pub.reddit.draft` актора `admin:` в очереди: строка `running` с истёкшей арендой, затем `/cron/publisher-minute` × 3 | Без строки журнала доступа за 60 с → **`refused PUB_ROLE_REQUIRED`**, стоимость 0. Контроль: актор с запросом к внутреннему API → проверку оператора проходит, дальше `refused PUB_GATE_CLOSED` (гейт `ai_use` платформенного продукта закрыт) — отличает именно новая проверка (`ia-d1-03.json`, md5 `e8a96362…`) | Д | **verified_closed**. Остаток: окно ≤ 60 с (`ADMIN_ATTEST_MS`); подтверждением служит любой пересланный backend-ом запрос того же оператора |
| Н-D1-1 | 401 анонима на `/publisher/*` | `Cache-Control: private, no-store`. В матрице E1 ответов без `no-store` 0 из 3926, в первом проходе было 302 (все — 401 анонима) | Д | закрыто |
| Н-D1-5 | Прокси `/api/admin/reddit/*`, 72 маршрута, оператор без `Origin` | Мутации (40 POST + 6 PATCH) → **403**, не пересылаются; GET (26) → 200. С `Sec-Fetch-Site: cross-site` — так же. С `Sec-Fetch-Site: same-origin` — пропуск: страница чужого сайта этот заголовок подделать не может (`backend-proxy.json`, md5 `1e7d2b00…`) | Д (in-process) | закрыто |
| Н-D1-2 | Счётчик landing-visits и CSP | Сборка стенда без `PUBLISHER_LANDING_VISITS_URL`: CSP `connect-src 'self' <API>` без `backend-iota`; в HTML, `.next/static` и `.next/server` нет `backend-iota` и `landing-visits`. Решение `landingVisitsTarget`: env не задан, превью Vercel, `closed`, `test`, `live`+`unknown`, `live`+`denied` → не шлёт; только `live` + `granted` + env → адрес. Неверный URL (http, порт, userinfo, без пути, query) → ошибка сборки. Тест репозитория `landing-visits.test.ts` — 126 проверок ok (`landing-visits.json`, md5 `0a918c07…`; `site-headers.txt`, md5 `57f2f78f…`) | Д (стенд + функции) | закрыто на стенде; production — после деплоя FX-A |

### 18.3. Регрессия матрицы и безопасности

- **Реестр маршрутов** из нового `dist` — **245**, совпадает с первым проходом. Добавленных и удалённых нет, декораторы и гарды не изменились (`routes.json`).
- **Матрица кабинета: полный повтор** 221 × 13 = 2873 ячейки и экспорт 1053. **Ни одна ячейка не изменилась** по сравнению с первым проходом. Расхождения с документом — только известная F1 (подтверждена пробой: technical 201, editorial 403). 5xx — 0.
- **Внутренний API Админки:** 432 ячейки — те же результаты (401/400/2xx/4xx). Журнал: 72 строки на 72 запроса с актором, без id.
- **Прокси backend:** прежние 5 субъектов × 72 — без изменений. Новые 3 субъекта × 72 добавлены в `D1-role-matrix.csv` (поверхность `backend-proxy`, признак `E1`), расхождений 0.
- **Остальные пробы — passed:**
  - X1–X6, R1/R2, идемпотентность;
  - D1-01, D1-02, D1-03 (регрессия);
  - публичный приём P1–P5;
  - тестовый режим T1;
  - production-режим backend: HSTS, `no-store`, CORS, часы стенда 404, дев-вход, кроны 401;
  - бандл сайта: секретов 0.
- SSRF и бандл assist не повторялись: код в diff не менялся.

### 18.4. Новое после исправлений

**Маска контактов (IA-D2-02) и журнал `pub_ai_calls`.**

- Ч: ответ модели (`output`) проходит `maskDeep`, `rawExcerpt` — `maskContacts`, конверт очереди `pending.input` — `maskDeep`. Сырого текста ошибок провайдера в журнале нет: пишется только вид ошибки.
- Д: функция из нового `dist` маскирует 20 векторов — `[at]/(dot)`, `собака/равлик` с латинской зоной, профили соцсетей, ник после метки, телефоны, полноширинный `＠`. Не трогает `ID 12345678`, даты, суммы, `reddit.com/r/…`, «Instagram: stories and reels».
- В базе стенда в `pub_ai_calls.output/rawExcerpt` (6 строк) и в `meta` аудита `ai_call` контактов 0.
- **Пропускает:** `ivan%40gmail.com`, `ivan&#64;gmail.com`, «по буквам» и кириллическую зону вне списка (`укр.нет`) → **IA-D1-04 (S3)**, владелец маски — D2.

**`launch_evidence_*` и версия кода (`PUBLISHER_RELEASE_SHA`).**

- Версия берётся только из окружения процесса: `PUBLISHER_RELEASE_SHA`, затем `VERCEL_GIT_COMMIT_SHA`, затем `GITHUB_SHA`; принимается только 40 hex. Из запроса она не читается.
- Пробы на стенде (`launch-evidence*.json`):

| Запрос | Результат |
|---|---|
| Попытки прогона на другом commit, без подмены | 409 `qa_run_incomplete` / `code_version` |
| То же с заголовками `X-Release-Sha`, `X-Vercel-Git-Commit-Sha`, `X-Publisher-Release-Sha`, `X-Github-Sha`, `X-Forwarded-Host` | 409 `qa_run_incomplete` / `code_version` |
| То же с `?releaseSha=…&PUBLISHER_RELEASE_SHA=…` | 409 `qa_run_incomplete` / `code_version` |
| `releaseSha`/`codeSha` в значении параметра | 400 (схема) |
| Контроль: тот же commit | 200 |
| Процесс без версии | 409 `code_version_unknown` |

- **Обход извне невозможен.** Остаток (наблюдение Н-E1-1): commit попытки (`deployedSha`/`testSourceSha`) объявляет тот, кто импортирует отчёт в qa-catalog — участник кабинета с правом записи QA. Это доверие к протоколу внутри кабинета, как и сам статус `passed`. Решение по параметру принимает PO.

**Workflow `.github/workflows/publisher-ai-eval.yml`** (К+Ч):

| Требование | Факт |
|---|---|
| Триггер | только `workflow_dispatch`; `pull_request_target` нет ни в одном workflow репозитория |
| Права | `permissions: contents: read` |
| Входы | только через `env` (`IN_*`) и проверяются до расхода: sha256, enum, `AI-NN`, `0–3`, положительные числа и сумма ≤ $3. `${{ }}` в `run:` нет, кроме `if:` и `env:` |
| Выходы шагов | `steps.*.outputs` идут через env; id продукта проверяется регуляркой. `$cap` в `node -e` — вычисленное число `toFixed(2)` |
| Секрет `GEMINI_QA_API_KEY` | только в `env` трёх шагов (проверка наличия и два прогона), в `npm ci` его нет |
| Вывод ключа | CLI ключ не печатает. SDK `@google/genai` шлёт его заголовком `x-goog-api-key`, не в URL. Журнал вызова пишет только вид ошибки |
| Summary и артефакт | конфигурация, версии, параметры, стоимость, коды флагов; ключа нет |
| База | одноразовая база раннера; `ci-eval-product.ts` отказывается работать не с localhost |

Наблюдение Н-E1-2: потолок $3 действует на один запуск, а не на день или месяц. Повторные ручные запуски — у тех, кто имеет право записи в репозиторий; `concurrency` только упорядочивает их.

Наблюдение Н-E1-3: действия закреплены тегами `@v4`, а не sha. Так же устроены остальные workflow.

### 18.5. Итог E1

| ID | Было | Стало |
|---|---|---|
| IA-D1-01 | new | **verified_closed** |
| IA-D1-02 | new | **verified_closed** |
| IA-D1-03 | new | **verified_closed** (остаток — окно ≤ 60 с) |
| D1-01 / D1-02 / D1-03 | verified_closed | verified_closed, регрессия passed |
| D2-02 / D2-03 | deferred → D2 | без изменений; от D1 — IA-D1-04 |
| **IA-D1-04** | — | **new, S3**: кодированный email не маскируется |
| IA-D1-04 (E1-2, после FX-B) | new | **verified_closed**: `%40`, `&#64;`, email «по буквам» и реальные кириллические зоны маскируются; `укр.нет` остаётся без маски, но такой зоны нет. Ложных срабатываний 0/15. Остаток — **IA-D1-05 (S3, new)**: `%2540`, `\u0040`, кириллица «по буквам» (`ia-d1-04-retest.json`, md5 b4930659…) |

Наблюдения Н-D1-1, Н-D1-2 (на стенде) и Н-D1-5 закрыты. Н-1, Н-D1-3/4/6/8 и Н-E1-1/2/3 открыты, в информационном порядке. Production: п. 26 — passed, п. 27 — blocked (production closed).

### 18.6. Итоговый внутренний вердикт D1 (дерево 4e644293 + исправления FX, внутренний)

| Шлюз | Вклад D1 |
|---|---|
| Требования пригодны для реализации | вне D1. IA-D1-02 закрыт |
| Готов к публичному D0 | **По D1 — готов, с условиями.** Доступа к чужим данным, утечек контактов и секретов, ложного успеха формы и обхода версии доказательства нет. Production-проход — passed. Открыт только S3 (IA-D1-04). Условия: (1) задеплоить исправления FX-A/B/C и повторить шаги 14.1 — CSP без `backend-iota`, нет `landing-visits` в `closed`; (2) синтетическая заявка — только после перевода в `test` (§14.2), сейчас blocked; (3) исправления пока не закоммичены — вердикт относится к рабочему дереву, а не к commit |
| Готов к конкретной закупке | вне D1. Права закупок и бюджета в матрице — passed |
| Поставка P0 принята | вне D1. По D1 открыт только S3 |
| Коммерческий результат подтверждён | вне D1 |

Ограничение прежнее: исполнитель — агент той же модели, независимость только внутренняя.
