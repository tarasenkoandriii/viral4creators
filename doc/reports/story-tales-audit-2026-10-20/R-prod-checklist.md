# Story‑Tales — чек-лист production для работы владельцем (пакет R, 20.10.2026)

Для главного агента. Проверять **только имена и наличие** переменных, значения не читать и не выводить. Пробы — без авторизации и без платных вызовов. Источник требований — код на `5bd9ae0b` (Story‑код не менялся после `4e644293`).

## 1. Версии выпусков (Vercel → Deployments, Production, статус Ready)

| # | Проект | Что проверить | Почему |
|---|---|---|---|
| 1.1 | backend | commit ≥ `4e644293` (лучше `5bd9ae0b`) | WP1–WP5, кроны, миграции |
| 1.2 | backend | в логе сборки `prisma migrate deploy`: применены `20270124180000_story_operator_resolution`, `20270124200000_story_gift_occasion_gift`, `20270124210000_story_video_segments`, `20270124220000_story_narrator_looks`, **`20270124230000_story_tales_pass2_fixes`** (перепроверка 20.10; или «No pending migrations» на более позднем выпуске) | Сборка запускает `scripts/build-prisma-migrations.mjs`, в Preview миграции пропускаются |
| 1.3 | frontend (TMA) | commit ≥ `4e644293` | Ломающее изменение WP3: `giftNote` без `giftNoteEnabled: true` → 400; старый фронт не создаст сказку с репликой |
| 1.4 | admin | commit ≥ `4e644293` | Страница `/story-tales` («Работа с пользователями → Story‑Tales») |
| 1.5 | landing (`viral-landing`) | выпуск с закрытием 17.10 (middleware 404) | `landing/src/middleware.ts:117-119` |

## 2. Переменные окружения backend → Production (только наличие)

| Имя | Ожидание | Последствие отсутствия |
|---|---|---|
| `STORY_TALES_OWNER_TELEGRAM_ID` | **задана** | Все `/api/story-gifts/*` и `/api/brand-manifests/:id/narrator-looks*` → 404 даже владельцу (`story-development.guard.ts:19-20`) |
| `STORY_RETENTION_PURGE_ENABLED` | **отсутствует** (или не `1/true/yes/on`) до решения владельца (TODO 10026) | При наличии `true` ночной крон реально удаляет класс A и сразу — сборки и сегменты удалённых голосов |
| `STORY_RETENTION_READY_PURGE_ENABLED` | **отсутствует** | Вместе с предыдущей удаляет READY/APPROVED сказки старше 180 дней |
| `CRON_SECRET` | задана | Кроны `story-finalize`, `story-retention` отвечают 401 |
| `RESEMBLE_API_KEY` | задана | Нет синтеза Nova и голоса профиля, нет клонирования |
| `RESEMBLE_WEBHOOK_SECRET` | желательно | Без неё вебхук клонирования недоступен (работает опрос) |
| `SONIOX_API_KEY` | задана | Нет QA аудио/видео (`POST …/quality`) |
| `FFMPEG_API_KEY` | задана | Нет сборки видео и `bind-job` |
| `FFMPEG_API_BASE_URL` | необязательна | Есть значение по умолчанию |
| `GEMINI_API_KEY` или `GOOGLE_GEMINI_API_KEY` | одна задана | Нет разбора YouTube-референсов и образов рассказчика |
| `GEMINI_IMAGE_MODEL`, `GEMINI_SKETCH_MODEL` | необязательны; если заданы — модель должна иметь ставку в `backend/src/common/ai-pricing.ts` (сверить имя модели, не публикуя) | Без ставки образ рассказчика `unavailable` / нельзя зарезервировать |
| `YOUTUBE_API_KEY` | задана | Разбор по URL не проверит длительность; поиск YouTube недоступен |
| `YOUTUBE_SEARCH_OFF` | отсутствует или false | Иначе поиск в библиотеке референсов выключен |
| `API_PUBLIC_URL` | необязательна (по умолчанию `https://backend-iota-ruddy-57.vercel.app/api`); если задана — `https`, без логина и query | Сборщик FFmpeg API не заберёт входы `/story-render-input/…` (503 «Публичный адрес сборки не настроен») |
| `TMA_PUBLIC_URL` | необязательна (по умолчанию `https://viral4creators.app`); домен, где опубликован `frontend/public/story-assets/turnip-v1/` | Сборщик не получит `base.mp4`/`cover.png` |
| `DATABASE_URL`, `DIRECT_URL` | заданы | — |
| `STORY_OPERATOR_PG_URL`, `STORY_GIFT_PG_URL`, `STORY_VIDEO_PG_URL`, `STORY_NARRATOR_LOOKS_PG_URL` | **отсутствуют** в Production (только тесты) | Не влияют на рантайм, но им там не место |
| `VERCEL_FORCE_BUILD` | отсутствует (кроме разового выпуска env) | Постоянный флаг собирает каждый деплой |

Важно: изменение только env не даёт Git-диффа, `ignoreCommand` отменит обычный redeploy. Для выпуска новых значений `STORY_*` — разовый `VERCEL_FORCE_BUILD=1` в backend, redeploy, Ready, затем удалить флаг (`doc/DEPLOYMENT.md:4155`). `storyRetentionFlags()` читает env во время выполнения, но новый env попадает в функцию только с новым деплоем.

## 3. База данных (только чтение; значения не выводить)

1. До деплоя (если миграции ещё не накатаны): `SELECT "jobId" FROM story_video_renders WHERE "jobId" IS NOT NULL GROUP BY 1 HAVING count(*)>1;` → 0 строк. Проба R: при дубле `20270124210000` падает на `story_video_renders_jobId_key`; при построчном применении (psql -f, SQL-редактор по частям) остаются `story_video_segments` **без RLS** и колонка `segments` — не применять миграцию вручную по частям; при сбое — `prisma migrate resolve --rolled-back` после проверки состояния.
2. `SELECT migration_name, finished_at IS NOT NULL, rolled_back_at IS NULL FROM _prisma_migrations WHERE migration_name LIKE '20270124%' ORDER BY 1;` — Story-миграции WP и `20270124230000_story_tales_pass2_fixes` завершены, незавершённых/откатанных нет. Для 230000 нужен `gen_random_uuid()` (PostgreSQL 13+).
3. `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('story_gifts','story_video_renders','story_video_segments','story_operator_actions','story_narrator_looks','story_narrator_look_calls');` — везде `t`; `SELECT tgname FROM pg_trigger WHERE tgname='story_operator_actions_append_only';` — 1 строка.
4. Владелец существует: `SELECT count(*) FROM users WHERE "telegramId" = '<значение env>';` → 1 (значение подставить, не печатать).
5. Тариф владельца разрешает расходы (`plans.assertCanSpendUser`): иначе платные действия (синтез, сборка, образ) отказывают на этапе `spend`.
6. Прод-данные 16–17.10 после миграций (ожидание): у подарков с репликой `giftNoteEnabled = true`, у остальных `false`; `occasionKind/occasionTheme/narrationLayout` = NULL (тема и раскладка вычисляются на лету); у сборок `segments` = NULL (старая раскладка, тот же configHash v1).
7. После 230000: `SELECT (SELECT count(*) FROM story_narrator_looks) = (SELECT count(*) FROM story_narrator_look_calls c JOIN story_narrator_looks l ON l.id = c."lookId");` → `t` (перенос образов в журнал квоты); `SELECT count(*) FROM story_video_renders WHERE status='UNKNOWN' AND "mainDuration" IS NOT NULL;` → ожидается 0 (у таких старых сборок `paidSpeechChars = 0`, закрытие с `releaseReserve` освободило бы и резерв сохранённой речи — разобрать вручную).

## 4. Кроны (backend → Settings → Cron Jobs; админка → «Кроны»)

| Путь | Расписание | Проверить |
|---|---|---|
| `/api/cron/story-finalize` | `*/5 * * * *` | есть и включён; свежие прогоны в журнале без `failed/blocked/unknown` |
| `/api/cron/story-retention` | `57 3 * * *` (03:57 UTC) | есть и включён; в журнале `dryRun: true`, `errors: 0`; предпросмотр «Работа с пользователями → Story‑Tales» (`GET /api/admin/story-tales/retention`) |

Всего в `backend/vercel.json` 28 кронов.

## 5. Ассеты `turnip-v1` (публичные, без авторизации)

| URL | Ожидание |
|---|---|
| `https://viral4creators.app/story-assets/turnip-v1/base.mp4` | 200, 653 095 байт, sha256 `a3a6ee4b67f9f33b5b665d5230316ffce3b98394bc434a500a2b4369e19e8b46`, `X-Robots-Tag: noindex, nofollow, noarchive` |
| `…/turnip-v1/cover.png` | 200, 62 898 байт, sha256 `e59074639e22abc408129e532d39a74bbc7cad4b4b2d897f788475a85ab17a0a` |
| `…/turnip-v1/manifest.json` | 200, `baseSha256`/`coverSha256`/`textSha256 39207ca8…aeb7` как в `backend/src/modules/story-gifts/story-video-base.ts` |

(Если `TMA_PUBLIC_URL` задана — проверять на её домене.)

## 6. Пробы закрытого режима (без авторизации, без затрат)

| Запрос | Ожидание |
|---|---|
| `GET <backend>/api/story-gifts/catalog` без initData/cookie | 401 (TelegramIdentityGuard) |
| `GET <backend>/api/story-gift/<любой токен>` и `/audio`, `/video`, `/photo` | 404 |
| `GET <backend>/api/story-render-input/<случайный>/base` | 404 JSON от приложения (не страница защиты Vercel) — адрес достижим для сборщика |
| `GET <backend>/api/cron/story-retention` без `Authorization` | 401 |
| `GET <backend>/api/admin/story-tales/queue` без cookie админки | 401 |
| `GET https://story-tales.viral4creators.app/ru` и `https://welcome…/ru/stories` | 404 с `X-Robots-Tag` noindex |
| Владелец в TMA → `#/stories` | каталог виден; не владелец — «Раздел в закрытой разработке» |

## 7. Настройки вне репозитория

- backend → Settings → Functions: Max Duration достаточна для `POST /story-gifts/:id/render` и `POST /story-gifts/:id/video` (в репозитории `maxDuration` не задан; живые прогоны 16–17.10 прошли).
- Deployment Protection не закрывает production-домен backend, указанный в `API_PUBLIC_URL` (иначе сборщик получит 401 на входах).
