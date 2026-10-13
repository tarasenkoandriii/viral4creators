> Внутренний предаудит. Не является независимым внешним аудитом по плану v1.1 §1; не заменяет внешнее заключение. Цель — подготовить пакет передачи (Приложение B) и снять очевидные дефекты до внешнего прохода.

# A2. Реестр документов и модулей, карта охвата

Дата снимка этапа A2: 13.10.2026, 10:38 UTC. Обновлено при сборке пакета (13.10.2026, после раундов исправлений P-B2 §10 и Z-2c): реестр документов пересобран по текущему дереву, реестр модулей и пункты, закрытые Z-2c, обновлены.

- **Исполнитель:** Claude-агент — та же команда, что писала код.
- **Глубина:** чтение файлов, sha256, скрипты-сборщики. Динамических прогонов нет.
- **Код не правился.** `live-login-relay/` не открывался, кроме README, Dockerfile и docker-compose: их sha256 есть в реестре.

## Проверяемая версия

- **Дерево:** рабочее, не git. Commit не назначен — назначат после доставки (поле в `README.md`).
- **Манифест sha256:** [`manifest-sha256.txt`](manifest-sha256.txt) — 1 702 файла, sha256 `8114b558d1f2d02cb7eb4ca7a93ea6ce63477b64cef493b1041517805c2b54d0`. Корни: `sites-backend/src`, `sites-backend/prisma`, `assist/src`, `publisher-site/src`, `doc/ai-publisher` (без каталога этого пакета).
- Этап A2 выполнялся на дереве с манифестом `6374e3d0…95c2` (1 696 файлов). Разница — исправления P-B2 §10 и Z-2c (`IMPLEMENTATION-DESIGN.md` §26) и §27 дизайна.
- Реестр документов `A2-registry-docs.csv` пересобран на текущем дереве (sha256 `README.md`, `doc/TODO.md`, `doc/DEPLOYMENT.md`, `doc/CI.md`, дизайна — текущие). Документы этого пакета в реестр не включены (иначе реестр ссылался бы на собственный хеш).

## Файлы

| Файл | Содержание |
|---|---|
| `A2-registry-docs.csv` | 442 документа. Колонки: путь, заголовок, вид, владелец, версия, sha256, размер, mtime, current/historical с основанием, какие модули регулирует, сверка с `source-manifest.json` |
| `A2-registry-modules.csv` | 28 модулей/областей. Колонки: стек, развёртывание, домен/среда с источником, commit, роли, зависимости, внешние сервисы, участие в P0, статус охвата с причиной, владелец, CI-джоба, доказательства, неизвестные |

Собраны скриптами-сборщиками в рабочем каталоге предаудита (данные модулей — вручную по `doc/DEPLOYMENT.md`, `*/vercel.json`, README модулей, `ci.yml`, импортам модуля publisher). Первая строка CSV — комментарий с пометкой о внутреннем предаудите (`comment="#"`).

## Реестр документов — сводка

442 документа: 351 current, 91 historical.

| Вид | Кол-во |
|---|---|
| миграции (backend 132, sites-backend 41) | 175 (с двумя `migration_lock.toml`) |
| требования/ТЗ модулей (`doc/*SPEC*`, `docs-tz/TZ-*`, `specs/`) | 50 |
| аудиты/обзоры (точечные, historical) | 44 |
| комплект Publisher: требования, аудиты, json, архивы, README, design | 20 + 9 + 5 + 3 + 1 + 1 |
| схемы развёртывания/конфиги (`vercel.json`, compose, Dockerfile, Makefile) | 18 |
| API-контракты (`publisher/contracts/*.ts` 16 + `doc/openapi-v1.json`) | 17 |
| контент модулей (база знаний tutorial, docs помощника) | 18 |
| описания модулей (README) | 11 |
| примеры env (без секретов, значения не выписывались) | 10 |
| эксплуатация (DEPLOYMENT, DOCKER, LOCAL-DEV, HETZNER, PRISMA-SUPABASE, relay egress) | 7 |
| CI (ci.yml, sandbox-daily.yml, CI.md, CI-RECOMMENDATIONS, QA_CI_DELIVERY) | 3 + 3 |
| прочее (TODO, legal, отчёт инвестору, сообщения коммитов, скилл агента) | остальные |

Ключевые действующие документы. sha256 указаны первыми 16 знаками, полные — в CSV.

| Документ | Версия | sha256 (нач.) | Изменён | Регулирует |
|---|---|---|---|---|
| `README.md` | не указана | `6b0c720b894d82b8` | 13.10 12:42 | весь репозиторий |
| `doc/PRODUCT-PROJECT-SPEC.md` (6 481 строка) | не указана | `e9daa33fdf0f3e73` | 12.10 17:33 | backend, frontend, admin |
| `doc/TODO.md` (9 667 строк) | не указана | `8faa485ee90f1ed6` | 13.10 12:42 | весь репозиторий |
| `doc/CI.md` | не указана | `547da68eb576f152` | 13.10 12:05 | `.github`, все модули |
| `doc/DEPLOYMENT.md` (4 010 строк) | не указана | `ad4516916f97fcc8` | 13.10 12:02 | все развёртываемые модули |
| `doc/API.md`, `doc/openapi-v1.json` | —, v1 | `0eccfb39…`, `75cf7ea5…` | 12.10 / 28.09 | backend (внешний API) |
| `sites-backend/prisma/schema.prisma` | — | `b8aefd44d5bfe52a` | 12.10 20:52 | sites-backend (66 моделей `Pub*`) |
| `backend/prisma/schema.prisma` | — | `a8ff72ba2b656909` | 12.10 12:34 | backend |
| `.github/workflows/ci.yml` | — | см. `A2-registry-docs.csv` | 13.10 (Z-2c: джоба `publisher-stand`) | 16 джоб (включая `changes` и агрегатор `ci`): `sites-backend`, `assist`, `publisher-site`, `secrets` и др. |

Комплект Publisher (`doc/ai-publisher/**`, 39 файлов):

- **Совпадают с `source-manifest.json` побайтно (по sha256):** все 10 файлов действующего комплекта 2.2 — README, ТЗ, именованная копия ТЗ, каталог, приёмка, AI-набор, сквозной аудит и 3 json. С `archive_sha256` манифеста совпадает и ZIP 2.2.
- **Копии:**
  - `pilot-spec-v2.md` ≡ `AI-Publisher-Technical-Specification-v2.2.md` (sha256 `64c24fcf…06b6`);
  - `external-audit-plan-v1.1.md` ≡ `preaudit/plan-v1.1.md`.
- **Historical:** `pilot-spec.md` (1.0), `pilot-audit.md` (1.0), `pilot-audit-v2.md` (2.0), `pilot-final-audit.md` (2.1), ТЗ 2.1 и ZIP 2.1 в корне, все `archive/**` (2.0, 2.1).
- **Вне манифеста и вне README комплекта** (README комплекта не правится — его хеш в `source-manifest.json`; ссылки на дизайн и этот пакет — из `IMPLEMENTATION-DESIGN.md` §27, корневого `README.md` и `doc/TODO.md`):
  - `IMPLEMENTATION-DESIGN.md` v1.4 (owner — команда/координатор);
  - `external-audit-plan-v1.1.md` (owner — Андрей).

  Реестр действующих документов неполон (B1-F-20, `ready_for_retest` — через ссылки из §27).

### Пробелы реестра документов

1. **Нет инструкции восстановления БД — закрыто Z-2c (до внешней проверки).**
   - В `DEPLOYMENT.md`, `PRISMA-SUPABASE.md`, `DATABASE-AUDIT.md` нет регламента резервного копирования и восстановления Supabase. Поиск по «backup», «бэкап», «восстановлен», «PITR», «pg_dump» ничего не дал.
   - Для Publisher есть только прикладной экспорт и восстановление в новый продукт (design §15.4, Р-PUB-10/11). Строка «аварийное восстановление базы — копии Supabase» (Р-PUB-10) регламентом не подкреплена.
   - План §3 требует резервную копию и восстановление на стенде. Риск для A1/C: S2.
   - **После Z-2c:** в `doc/DEPLOYMENT.md` добавлен раздел «AI Publisher: резервные копии и восстановление» — копии продукта и дамп Supabase, проверка и восстановление с повторным применением удалений и отзывов. На production регламент не проверялся (стенд — локальное хранилище копий, E2E-04).
2. **`doc/TODO.md` не отражал этапы реализации Publisher — закрыто Z-2c.** В TODO добавлен блок «Этапы реализации Publisher (программный режим P0)» со сделанным и ждущим владельца; при сборке пакета туда добавлена ссылка на пакет. Исходное замечание: Изменён 12.10 18:38. Пункт «Выполнить десять P0-функций…» открыт. Итоги P-A0…Z-2b (числа, переданные координатору в отчётах) не внесены. Пункт «Разработку оценить отдельно от 80 часов» открыт — это подтверждает B1-F-02.
3. **У 165 документов нет явной версии.** Версионируются датой и mtime. Для них версия = sha256 из реестра.
4. **Владельцы определены эвристикой по виду документа:**
   - требования — «Андрей утверждает / команда пишет»;
   - эксплуатация, CI, контракты — «команда»;
   - комплект Publisher — Андрей, источник по `source-manifest` — внешний ChatGPT-проект.

   Владельцем не подтверждено. Это неизвестное №1 ниже.
5. **Модули для трёх документов `docs-tz/` не определены:**
   - `AUDIT-Landing-Live-2026-09-22.md`;
   - `SECURITY-PROPOSALS-2026-10-02.md`;
   - `TZ-Rabota-s-Testirovshchikom.md`.

## Реестр модулей — карта охвата

28 областей: **in_scope 14, deferred 14, excluded 0**. Ни один публичный production-компонент не исключён молча. Все вне P0 помечены deferred с причиной и предложенным отдельным пакетом работ.

| Модуль | Домен/среда | Участие в P0 | Статус | Причина |
|---|---|---|---|---|
| M01 sites-backend/publisher | assist-api.viral4creators.app (Vercel Pro) | прямое, все 10 функций | in_scope | ядро P0 |
| M02 sites-backend: site-core, site-ai, site-crawl, telegram-auth, assist-knowledge-core, common/shared | то же | косвенное: авторизация, tenant, AI-шлюз, SSRF-загрузка, шифр | in_scope | общие механизмы (план §2) |
| M03 qa-catalog | то же | носитель AT-протоколов | in_scope | доказательства гейтов |
| M04 прочие модули sites-backend (assist-*, browser-jobs, internal-sites, billing, voice…) | то же + виджет | нет | deferred | production помощника/QA; отдельный WP |
| M05 assist: экраны Publisher | assist-app.viral4creators.app | прямое (ТЗ §8.4) | in_scope | интерфейс P0 |
| M06 assist: остальное | то же | нет | deferred | production кабинета |
| M07 publisher-site | ai-publisher.org (не подтверждён); Vercel-проект не создан | прямое | in_scope | публичный контур P0 |
| M08 site-tma-kit | синхронизация | косвенное | in_scope | кит экранов |
| M09 backend (генератор) | домен в DEPLOYMENT не зафиксирован | косвенное: источник `telegram-init-data` | deferred | production; WP «платформа» |
| M10 frontend, M11 admin, M12 landing | домены не зафиксированы | нет | deferred | production; admin — привилегированный контур |
| M13 marketplace | неизвестно (проект в DEPLOYMENT не описан) | нет | deferred | состояние развёртывания неизвестно |
| M14 widget | assist-w / assist-wa / assist-we.viral4creators.app | нет | deferred | публичный iframe на сайтах клиентов |
| M15 sites-landing | assist.viral4creators.app | нет | deferred | публичная форма пилота с ПД |
| M16 browser-worker | VPS, без публичного порта | нет (импорт URL Publisher идёт через site-crawl) | deferred | QA/Tutorial (P1) |
| M17 live-login-relay | Dokploy, relay.<домен> | нет | deferred | по rules.md не трогается; пароли пользователей → обязательный WP безопасности |
| M18 sandbox | sandbox.viral4creators.app | нет | deferred | фикстура QA, низкий риск |
| M19 assist-integrations | дистрибуция (GTM, WP, npm) | нет | deferred | вне P0 |
| M20 scripts, M21 .github, M22 локальный стенд | CI/локально | косвенное | in_scope | воспроизведение CI и стенда |
| M23 Supabase, M24 Vercel Blob/Cron, M25 Telegram-боты, M26 аналитика/SC/CRM | внешние сервисы | прямое | in_scope | хранение, копии, кроны, уведомления, измерение |
| M27 документация (doc, docs-tz, specs, Claude outputs, `_stage`, `.claude`) | — | doc/ai-publisher — прямое | in_scope | реестр документов |
| M28 tutorial-runner, голос (F05/F07/F21) | backend / assist-api | P1/P2 | deferred | не признаются готовыми автоматически |

Владельцы: код — «команда»; аккаунты (Vercel, Supabase, BotFather, домен, VPS) и решения об охвате — Андрей. Колонка `owner` в CSV.

### Предлагаемые пакеты работ для deferred (на согласование владельцу, план A2)

| WP | Охват | Почему отдельно |
|---|---|---|
| WP-PLAT-1 | backend + frontend + admin + landing (генератор) | основной production; платежи (WayForPay, Stars), OAuth-публикации, 26 кронов |
| WP-PLAT-2 | sites-backend (assist-*), assist (остальное), widget, sites-landing, assist-integrations | клиентские сайты; публичный виджет, ПД посетителей, биллинг |
| WP-PLAT-3 | live-login-relay, browser-worker, sandbox | чужие сессии, пароли, egress; D1 «browser-worker и голосовые модули» |
| WP-PLAT-4 | marketplace | сначала установить, развёрнут ли он |
| WP-PLAT-5 | эксплуатация: резервное копирование и восстановление Supabase, мониторинг, ротация секретов | инструкций в репозитории нет |

## Список неизвестных (на уточнение владельцем)

1. Владельцы документов (определены эвристикой) и кто утверждает `docs-tz/*` и `doc/*SPEC*`.
2. Production-домены backend, frontend, admin, landing: в DEPLOYMENT только плейсхолдеры `<…>.vercel.app`.
3. Развёрнут ли marketplace и на каком домене.
4. Домен ai-publisher.org: регистрация и владение. Vercel-проект publisher-site не создан.
5. Выкачены ли миграции `20261016090000_publisher_core`, `…092000_publisher_budget_fn`, `…093000_publisher_leads_fn` на production Supabase. По отчётам — «не выкачена». Создана ли логин-роль `publisher_public`.
6. Развёртывание browser-worker (вариант 1 «отдельный VPS» или 2 «тот же Hetzner») и live-login-relay (домен relay).
7. Последний зелёный прогон CI для текущего дерева. Commit отсутствует.
8. Инструменты веб-аналитики, CRM и Search Console не выбраны.
9. ~~Регламент резервного копирования и восстановления Supabase~~ — описан Z-2c в `doc/DEPLOYMENT.md`; проверка на production — неизвестна.
10. Назначение каталога `_stage/` (список файлов и md5 — артефакт доставки).
11. Фактическое число пользователей и клиентов production-модулей — нужно для приоритета WP-PLAT-1…5.
12. Модули для трёх документов `docs-tz` (см. пробел 5 выше).

## Завершение A2 по плану §9

Каждой обнаруженной области назначены статус и владелец: 28 из 28. Пакеты работ для deferred предложены, но не согласованы — это шаг владельца. Полный аудит платформы потребует закрытия WP-PLAT-1…5. Проверка P0 Publisher не является аудитом всей платформы (план §2).
