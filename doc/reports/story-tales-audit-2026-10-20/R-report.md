# Story‑Tales, аудит прохода 2 — пакет R: готовность, TODO, документация, данные (20.10.2026)

Коммит `5bd9ae0b` (= origin/main). После `4e644293` Story‑код, миграции, `backend/vercel.json`, ассеты и middleware лендинга не менялись (`git log 4e644293..HEAD -- <пути Story>` пуст). Код не правился. Пробы и скрипты лежат в `/tmp/sta2-R/`. Платных вызовов не было.

Файлы пакета:
- `R-todo-matrix.csv` — 68 строк TODO (32 `[x]`, 36 `[ ]`): факт, доказательство (файл:строка, тест), расхождение. Если в доказательстве указано голое имя `story-*.ts`, это `backend/src/modules/story-gifts/`, `narrator-looks*` — это `backend/src/modules/brand-manifest/`, `cron*` — это `backend/src/modules/cron/`.
- `R-routes.csv` — 64 маршрута Story, собранные из декораторов (`/tmp/sta2-R/routes.py`): метод, путь, файл:строка, гарды, есть ли маршрут в API.md.
- `R-findings.csv` — находки ST2-R-01…06.
- `R-prod-checklist.md` — что проверить в Vercel, БД и пробами (только имена переменных).

## Итог

S0 — 0, S1 — 0, S2 — 0, S3 — 6. Кодовые пункты Story‑Tales, отмеченные `[x]`, есть в коде и покрыты тестами. Исключений два:
- запрет `POST /story-gifts/:id/share` реализован, но тестом не закреплён (ST2-R-02);
- заголовок TODO 9998 отмечен `[x]`, хотя включает невыполненную часть «точные редакции UK» (ST2-R-06).

Ни один пункт `[ ]` не оказался «сделанным, но не отмеченным». Все они — решения, приёмки или контент, либо кода по ним действительно нет: story-capabilities, ST-P4, действие «снять блок основной речи».

Схема Prisma и SQL миграций совпадают без расхождений. Строки прод-данных 16–17.10 проходят новые CHECK, и логика чтения их поддерживает. Единственный риск выкладки — дубли `jobId`: он задокументирован и вынесен в чек-лист.

## 1. Готовность по TODO

Прогнаны тесты:
- backend jest `--runInBand`: `story-gifts/**`, `brand-manifest/narrator-looks*`, `user-voices.service.spec`, `cron/**`, `ai-pricing.spec`. Итог: **29 наборов, 783 теста, все PASS**. Pg-спеки (`story-operator-journal`, `story-gift-occasion`, `story-video-segments`, `narrator-looks`) выполнялись на своей БД `sta2_r_pg` и не пропущены.
- frontend: `narrator-looks`, `story-errors`, `story-library`, `story-video-plan`, `story-wizard` — все ok.
- admin: `nav.test` (35 страниц) — ok.
- landing: `stories-copy`, `stories-noindex` (404 для поддомена, маршрутов и медиа), `stories-page`, `stories-release` — все ok.
- `node scripts/check-docs.mjs --no-jest`: все счётчики документов совпадают (144 миграции / 94 таблицы, 690 маршрутов / 103 контроллера, 284 env описаны).

Расхождения по матрице:
- **9998 `[x]`** — заголовок обещает «проверенные точные редакции UK и других языков». В реестре на UK есть только адаптация `mitten-uk-short-v1` (ST2-R-06).
- **10016 `[x]`** — пункт «создание новых ссылок запрещено» верен: проба `/tmp/sta2-R/probes/share-probe.spec.ts` показала, что контроллер отвечает `NotFoundException` и не вызывает сервис. Но тестов в репозитории на это нет, а `StoryGiftsService.share()` по-прежнему выдаёт токен (ST2-R-02).
- Пункты 69–72, 88, 90 (прод-прогоны) и 10005/10007 (живые выпуски) подтверждены только отчётами в `doc/reports/`; на production в этом пакете не проверялись.
- Пункт 67: замеры LCP/CLS/INP невозможны, пока лендинг отдаёт 404. Формулировка устарела, но это не код.

## 2. Документы против кода

**Маршруты.** Из декораторов собрано 64 маршрута:
- `StoryGiftsController` — 30;
- `StoryReferenceLibraryController` — 5;
- `PublicStoryGiftController` — 4, всегда 404;
- `StoryRenderInputController` — 1;
- `AdminStoryTalesController` — 12;
- `NarratorLooksController` — 10;
- кроны — 2.

Все 64 описаны в API.md. Методы, пути, DTO и лимиты сверены с кодом:
- тела запросов (`CreateStoryDto`/`PreviewStoryDto`/`StoryPhotoDto`, `StoryVideoDto`/`StoryRecordingDto`, `StoryOperatorDto`/`NoCharge`/`BindJob`/`CloseRender`, `StoryReference*`, `CreateNarratorLookDto`/`Restyle`/`Consent`);
- части render-input: base, cover, main, intro, note, outro, photo, narrator;
- поля ответа `story-retention`;
- коды `NARRATOR_LOOK_*` (сборные коды проблем из `narrator-looks.rules.ts:345`);
- отдельный JSON-лимит 1 450 000 для `photo|video/recording` (`app.setup.ts:156-158`);
- конфликтов маршрутов нет: `story-gifts/references/*` и `:id`, `brand-manifests/:manifestId/*` в `BrandManifestController`, `subtitles.vtt` проверен в path-to-regexp v8.

Расхождения:
- ST2-R-01 — `GET /api/brand-manifests/:manifestId/narrator-looks` отдаётся без `no-store`/noindex, хотя API.md:2431 это обещает.
- ST2-R-03 — раздел аудиопилота в API.md (2361, 2364–2366) описывает `share` и публичную выдачу как действующие.
- ST2-R-04 — `journal` отдаёт ≤100 записей, а не ≤200; этап очереди `unknown` и код 409 `NARRATOR_IMAGE_MISSING` не описаны.

**ТЗ §22.6, §23.2–23.7, §24.** Сверено с кодом без расхождений:
- пресеты, строка неизменности, `useNarratorImage`;
- лимиты: 14 симв/с, 8–240 с, ≤110 с, MP4 ≤3 МиБ, образ ≤4 МиБ в CHECK;
- квоты 6/40 и 3/сутки;
- сроки 30/180/3 дня, по умолчанию dry-run;
- 10 мин до UNKNOWN у синтеза (§23.3, `story-gifts.service.ts:135-151`);
- причина 3–500 символов и `requestId`.

**DEPLOYMENT.**
- `STORY_TALES_OWNER_TELEGRAM_ID`, `STORY_RETENTION_PURGE_ENABLED` и `STORY_RETENTION_READY_PURGE_ENABLED` описаны и совпадают с `story-retention.service.ts:36-43,85`.
- Порядок миграций и SQL для проверки дублей верны.
- Кроны верны: `story-finalize */5`, `story-retention 57 3 * * *`, всего 28 в `backend/vercel.json`.
- Ручной запуск в debug — dry-run (`admin-cron.service.ts:916`, тест `admin-cron.service.spec.ts:350`).

**Черновик правил.** В п.6.6 не указана обработка фото рассказчика моделью изображений Gemini (ST2-R-05).

## 3. Данные: schema.prisma ↔ миграции

Все 144 папки `backend/prisma/migrations` применены по порядку через `psql -v ON_ERROR_STOP=1` на чистую БД `sta2_r_mig` (Postgres 16 + pgvector): ошибок нет, 94 таблицы. Скрипт `/tmp/sta2-R/cmp.py` сравнил 8 моделей — StoryGift, StoryVideoRender, StoryVideoSegment, StoryOperatorAction, StoryNarratorLook, BrandManifest, UserVoice, BrandCharacter — по столбцам, типам, nullability, наличию и значениям DEFAULT, `@unique`/`@@unique`/`@@index` и лишним индексам. **Расхождений 0.**

Дополнительно проверено:
- все `timestamp` имеют точность 3;
- FK названы по соглашению Prisma, ON DELETE совпадает: Cascade, а `narratorLookId` — SetNull;
- RLS включён на пяти таблицах `story_*`, прав у PUBLIC нет;
- триггер append-only `story_operator_actions_append_only` на месте;
- набор значений в CHECK совпадает с кодом: `SKETCH_STYLES`, действия журнала, статусы, пресеты, `story-parent-image-v1`;
- лимиты CHECK не мягче кода: сегмент ≤400 символов (`story-video.service.ts:520`), запись ≤1 МиБ при коде 1 000 000 байт, образ ≤4 МиБ при коде 4 000 000 байт.

`prisma migrate diff` в этом окружении недоступен (нет schema-engine), поэтому сравнение сделано своим скриптом по `information_schema` и `pg_indexes`.

**Совместимость с прод-данными 16–17.10.** Проба: БД собрана до `…170000`, засеяны строки по образцу продакшена, затем накатаны 180000–220000. Строки:
- «Рукавичка» APPROVED с репликой, `shareHash` и `occasion`;
- «Репка» Nova APPROVED;
- удалённый подарок;
- сборка Nova READY с `jobId`;
- две частные родительские сборки READY с `parentNarrationKey`/`userVoiceId`/согласием.

Все миграции прошли. Что происходит со строками:

- **`story_gifts`.**
  - У подарков с репликой `giftNoteEnabled := true`, у остальных `false`.
  - `occasionKind`, `occasionTheme`, `narrationLayout`, `giftPhotoDescription` остаются NULL. Тема вычисляется на лету (`story-gifts.service.ts:197`), смета — через `storyText(catalogId)` с откатом на главы (`story-draft.ts:248-270`), раскладка — через legacy-ветку `storyNarrationParts` (`story-gift-note.ts:152-172`, тест `story-gift-occasion.spec.ts:491`).
  - Старый `occasion` читается как подпись `other`.
  - id каталога не изменились: все 6 есть в `story-editions.ts` со статусом approved. Хеш «Репки» `39207ca8…` закреплён тестом `story-editions.spec.ts:30`.
- **Публичность.** `shareHash` старых подарков остаётся, но любые `/story-gift/*` отвечают 404. Отзыв `DELETE :id/share` работает.
- **`story_video_renders`.**
  - `segments = NULL` означает старую раскладку. configHash v1 побайтно прежний (тест `story-video.spec.ts:878`), поэтому повторный POST той же конфигурации вернёт существующую сборку.
  - Ключ основной речи родителя: раньше в нём было `text: g.text`, теперь `parts.main`. Для «Репки» без реплики это одно и то же (legacy-ветка), поэтому сохранённая MP3 17.10 переиспользуется без нового синтеза.
  - Уникальный `jobId`: при дубле миграция 210000 падает. Проба показала: если файл выполнить как одну строку, откатывается целиком; если построчно, остаются `story_video_segments` без RLS и колонка `segments`.
- **Retention.** По умолчанию dry-run, ничего не удаляется.
  - Класс A: черновики, FAILED/UNKNOWN 16–17.10 и сборки FAILED/UNKNOWN станут кандидатами с ~15–16.11.2026.
  - Сборки и сегменты голоса, удалённого из профиля, — кандидаты сразу (`revokedVoiceRenders`/`revokedVoiceSegments`).
  - Готовые «Рукавичка» и «Репка» (класс B) — кандидаты с ~апреля 2027 и только при `STORY_RETENTION_READY_PURGE_ENABLED`.
  - Перед включением удаления сверить предпросмотр `GET /api/admin/story-tales/retention`.
- **Референсы в `platform_settings`** (например, `Z7FgMniveRI` complete). Новых полей в старых записях нет; применяются значения по умолчанию: `editionId: null`, `attempts: 1` (`story-references.service.ts:222-224`). `expiresAt` = updatedAt + 180 дней.
- **`brand_manifests`.** Пять новых nullable-колонок; CHECK согласия (обе NULL) проходит.

## 4. Находки

| id | класс | суть |
|---|---|---|
| ST2-R-01 | S3 | `GET /api/brand-manifests/:manifestId/narrator-looks` без `Cache-Control: private, no-store` и `X-Robots-Tag` (narrator-looks.controller.ts:63), хотя API.md:2431 это обещает |
| ST2-R-02 | S3 | 404 на `POST /story-gifts/:id/share` не закреплён тестом; `service.share()` по-прежнему выдаёт токен |
| ST2-R-03 | S3 | API.md (аудиопилот) описывает share и публичные `/story-gift/:token*` как действующие |
| ST2-R-04 | S3 | API.md: журнал «≤200», в коде ≤100; этап `unknown` и 409 `NARRATOR_IMAGE_MISSING` не описаны |
| ST2-R-05 | S3 | Черновик правил п.6.6 не называет Gemini как обработчика фото рассказчика |
| ST2-R-06 | S3 | TODO 9998 `[x]` включает невыполненное «точные редакции UK» |

Подробности — в `R-findings.csv`.

## 5. Проверено и корректно

- Гарды: `StoryDevelopmentGuard` закрыт без env и без совпадения (Premium и оператор не исключение); `StoryPublicDisabledGuard` закрывает всё; кабинет оператора — `AdminSessionGuard` + `assertOperator`; кроны — `CRON_SECRET`.
- Хеши и размеры ассетов `turnip-v1` (base.mp4 653 095 байт `a3a6ee4b…8b46`, cover.png 62 898 байт `e5907463…7a0a`) совпадают с `story-video-base.ts` и `manifest.json`. Файлы в git, путь не игнорируется; заголовки `/story-assets/*` в `frontend/vercel.json`: noindex, immutable.
- Лендинг: host, `/<locale>/stories` и `/stories-media/*` → 404 с noindex (`landing/src/middleware.ts:117-119`, тест прошёл).
- Миграции в проде накатываются при сборке и пропускаются в Preview (`scripts/build-prisma-migrations.mjs`).
- Все env Story описаны (check-docs); значений по умолчанию для `API_PUBLIC_URL`/`TMA_PUBLIC_URL` достаточно.
- `segments/:id/close`, `reopen`, `qa-reset` без `providerChargeConfirmedAbsent: true` → 400 (DTO `@Equals(true)`); `renders/:id/close` требует `releaseReserve`.
- Удаление голоса стирает речевые сегменты (`user-voices.service.ts:525`, тест `user-voices.service.spec.ts:381`).

## 6. Не проверено

- Production: фактические env, кроны, выпуски, состояние `_prisma_migrations`, наличие дублей `jobId`, ассеты на домене — вынесено в `R-prod-checklist.md`.
- Как именно `prisma migrate deploy` применяет файл миграции — одной транзакцией или построчно (schema-engine недоступен).
- Поведение HTTP-конвейера целиком (Nest bootstrap) для Story-маршрутов: проверены метаданные, сервисы и e2e оператора, но не весь `app.setup`.
- Живые прогоны провайдеров, качество, приёмка владельцем — по правилам брифа.
- Frontend/admin UI в браузере не открывался (это пакеты других аудиторов).

## Перепроверка (20.10.2026, дерево с исправлениями BE/UI/DOC, ≠ `5bd9ae0b`)

Повторены исходные сценарии ST2-R-01…06 — **все шесть FIXED** (статусы и доказательства — колонка `retest_2026-10-20` в `R-findings.csv`):
- R-01: проба `share-probe.spec.ts` — у `NarratorLooksController.view` теперь `Cache-Control: private, no-store` и `X-Robots-Tag`; тест `narrator-looks.service.spec.ts:1042`.
- R-02: тест `story-development.guard.spec.ts:68` (контроллер → 404, сервис не вызван); `StoryGiftsService.share()` сам отвечает 404 без токена и записи `shareHash` (`story-gifts.service.ts:485`, `story-gifts.service.spec.ts:172-177`).
- R-03: в API.md раздел аудиопилота помечает share и все `/story-gift/:token*` как «закрыто 17.10.2026: 404».
- R-04: `GET /admin/story-tales/journal?limit=` 1–200 (по умолчанию 100, вне диапазона 400); этап `unknown` и 409 `NARRATOR_IMAGE_MISSING` описаны.
- R-05: правила п.6.6 и вопрос 9.5 называют модель изображений Gemini для образа по фото взрослого.
- R-06: TODO 9998/9999 переформулированы.

**Миграция `20270124230000_story_tales_pass2_fixes`.** Все 145 миграций применены по порядку на чистую `sta2_r_mig2` — без ошибок, 95 таблиц. `cmp.py` (модели + `StoryNarratorLookCall`, `User`): по Story-моделям расхождений 0.
- `story_video_renders.paidSpeechChars` INTEGER NOT NULL DEFAULT 0, CHECK ≥ 0 = Prisma `Int @default(0)`.
- `story_narrator_look_calls`: 5 столбцов, `lookId` UNIQUE, индекс (`userId`, `createdAt`), FK на `users` ON DELETE CASCADE, RLS включён, CHECK `imageCalls` 0–2 = модель `StoryNarratorLookCall`.
- `story_narrator_looks.story_narrator_look_calls` расширен до 0–2.
- Журнал: `actorKind` допускает `owner` (без `actorUserId`), действие `owner.recording-delete`. Код пишет его с `targetType: 'segment'` (`story-video.service.ts:1623-1626`) — проходит `story_operator_target`.
- Для `User` скрипт показывает только ложные срабатывания самого скрипта (массивы `roles`/`freeScenarios` он пропускает, trigram-индексы описаны через `ops:`). Это не Story.

**Прод-подобные данные.** Копия `sta2_r_legacy` → `sta2_r_legacy2`; засеяны три образа: READY (1 вызов), UNKNOWN (2 вызова), DELETED (1). После миграции:
- в `story_narrator_look_calls` три строки с теми же `userId`, `imageCalls` и `createdAt`;
- повтор INSERT — 0 строк (`ON CONFLICT DO NOTHING`);
- удаление брендбука каскадно убирает образы (0), но не журнал вызовов (3) — квота не возвращается, как и задумано;
- старые сборки получили `paidSpeechChars = 0`.

Наблюдение, не находка: у сборки UNKNOWN, созданной до миграции, `paidSpeechChars = 0`. Если оператор закроет её с `releaseReserve` (после платного этапа это требует `providerChargeConfirmedAbsent: true`), освободится весь резерв, даже если речь была сохранена. На проде таких строк быть не должно: очередь UNKNOWN 17.10 была пуста (`scanned=0`); проверить запросом из чек-листа п.3.7.

**Документы против кода по изменениям BE.** Совпадают с кодом:
- `keptUsd`/`releasedUsd` у `renders/:id/close` (`story-operator.service.ts:620-621`);
- `staleSegments` (`story-retention.service.ts:71,170-227,412`: текст UNKNOWN/PENDING синтеза старше 30 дней стирается, ключ остаётся заблокирован);
- `segmentsErased`/`rendersDeleted` у `DELETE …/recording/:id` (`story-video.service.ts:1570-1639`);
- `shortId` = 8 знаков id сегмента (`story-operator.service.ts:258`);
- `analysis{estimateMicroUsd, reserveMicroUsd, maxSeconds, model}` в quota (`story-references.service.ts:300-319`);
- `qaEstimateMicroUsd` (`story-video.service.ts:396,911`);
- 409 `NARRATOR_CHARACTER_CHANGED` (`narrator-looks.service.ts:1158`) и 409 `NARRATOR_LOOK_TOO_LARGE` (`:841`) — API.md:2484;
- DEPLOYMENT:4260 описывает миграцию 230000, включая `gen_random_uuid()` (PG 13+).

Новые находки:
- **ST2-R-07 (S3, но CI красный):** `check-docs.mjs --no-jest` — 9 FAIL: счётчики 144/94 миграций/таблиц и 94 unit-скрипта не обновлены до 145/95 и 97 (ACCEPTANCE-CHECKLIST, CI.md, README, PRODUCT-PROJECT-IMPLEMENTATION-PLAN, TELEGRAM-ADMIN).
- **ST2-R-08 (S3):** строка крона `story-retention` в API.md:237 не перечисляет `staleSegments` и класс «текст неподтверждённой озвучки — 30 дней».

Тесты на этом дереве:
- backend jest (`story-gifts/**`, включая новый `story-tales-pass2.pg.spec`, `narrator-looks*`, `user-voices.service`, `cron/**`, `common/filters`) — 30 наборов, 758 тестов, PASS; pg-спеки на `sta2_r_pg2`;
- frontend `story-confirm`, `story-photo-fit`, `story-ui-guards`, `narrator-looks` — ok;
- landing `stories-closed`, `stories-noindex` — ok.

Итог перепроверки: S0–S2 — 0, S3 — 2 новые (R-07, R-08), R-01…06 закрыты.
