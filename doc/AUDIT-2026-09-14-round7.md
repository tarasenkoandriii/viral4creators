# Седьмой сквозной аудит — 14 сентября 2026 (после этапа 80 и правок 14.09)

Шестой аудит (`doc/AUDIT-2026-09-10-round6.md`) дал 20 находок, 8
высоких; все восемь и большинство средних закрыты (этапы 76–77) —
каждая перепроверена в этом раунде по коду, не по документам (см.
«Что проверено и держится»). Этот заход — по прямому запросу владельца
продукта («полный углублённый аудит проекта, устранить все высокие в
одном заходе») — покрывает весь код, включая правки того же дня:
переключатель озвучки на сессии, нативную длительность Grok и
`/v1/videos/extensions`, batch-транспорт Grok для одиночных роликов,
умолчание `voiceover`.

**Методика.** Семь параллельных независимых проходов, только
статическое чтение реального кода (без живого Postgres/сети), с
требованием подкреплять каждое утверждение точным `file:line`.
Домены: (1) деньги и тарифные гейты; (2) ядро видео-пайплайна; (3)
фоновые воркеры и кроны; (4) периметр безопасности и auth; (5)
целостность данных, Prisma, Blob; (6) внешние API-клиенты и их
контракты; (7) клиентские приложения (Mini App, админка, лендинг).
Проход (5) дополнительно применил все 46 миграций на чистый локальный
Postgres 16 и сверил результат со `schema.prisma`. Затем каждая
высокая находка лично перепроверена в коде и устранена в этом же
заходе, с юнит-тестами там, где спека модуля существует.

Ссылки на находки — вида **М-N.K** (М — седьмой аудит, N — домен).
Итого — 43 находки, из них 10 высоких (после дедупликации: пять были
найдены независимо двумя-тремя проходами). **Все 10 высоких устранены
в этом заходе** (раздел «Что исправлено»). Средние и низкие — не
трогались, кроме трёх, чей фикс был однострочным и безопасным (М-4.1,
М-6.4, М-3.8, М-7.8); они помечены.

**Главный вывод.** Три из десяти высоких — не гонки и не деньги, а
самый простой класс дефекта в проекте: «поле пишется, но не читается».
`videoHistory` попал в `DATA_KEYS`, но не в `toSession()` — третий
случай ровно этого класса в ОДНОМ методе (после `librarySourceKey` на
этапе 39 и `locale` на этапе 60); история версий молча усекалась до
одной записи при каждом старте, а файлы прошлых попыток выпадали из
уборки. Второй по значимости результат — контракт xAI: синхронный
image-to-video слал `image_url` (kwarg Python SDK), которого нет в REST
и proto (`image: { url }`); xAI молча игнорирует неизвестные поля (это
уже показал `video_url` утром того же дня), то есть каждый платный
image-to-video через Grok рендерился как text-to-video без товара, без
единой ошибки. Третий — рецидив класса Д-1.1/Е-2.3 («платная внешняя
работа, которую никто не досматривает без открытой вкладки») в
batch-транспорте того же дня: результат живёт у xAI час, TTL сессии —
сутки, дедлайн батча — 26 часов, крона не было.

## Что проверено и держится

- **Все восемь высоких шестого аудита закрыты по коду**: Е-1.1
  (`stars-subscription-reconcile.service.ts:63-89`, условный `updateMany`),
  Е-1.2 (`generation.service.ts:680-690`, `spend-limits.ts:50`,
  `catalog-batch-worker.service.ts:867-874`), Е-2.1 (`WORK_KINDS.export`,
  `postprod.service.ts:519-531, 679-692`, `export.service.ts:208-220,
  376-389`), Е-2.2 (`EXPORT_DEADLINE_MS`, `postprod.service.ts:152-175`),
  Е-2.3 (`findSessionsWithPendingTierBExport`, крон `export-sync-run`),
  Е-4.1 (`isOwnResembleVoice`, `brand-manifest.service.ts:569-580`,
  `project-session.service.ts:186-199`), Е-5.1 (`20261019090000_user_createdat_trgm_indexes`),
  Е-5.2 (`orphan-sweep.ts:63-70`, префикс `users/`). Средние Е-1.3,
  Е-2.4, Е-2.5, Е-3.1, Е-4.2 — тоже на месте.
- **Схема ↔ миграции.** Все 46 миграций применяются на чистый PG16 без
  ошибок; таблицы, колонки, NULL-ability, DEFAULT (включая
  `brand_manifests.voiceMode = 'voiceover'`), индексы, 52 FK, 26 enum
  совпадают со `schema.prisma`. `20260914120000_voiceover_default`
  ссылается на верную таблицу `brand_manifests`.
- **Резерв/возврат кредита** (`credit-ledger.service.ts:96-121`,
  `@@unique([generatedVideoId, reason])`), порядок «замок → гейты →
  inFlight → claimWork → резерв» в `generateVideo`, возврат кредита
  при провале расширения цепочки (`generation.service.ts:1570-1576,
  1698-1704`) — корректны. `aiUsage.record` не задваивается на штатных
  путях.
- **Вебхуки**: WayForPay — `timingSafeEqual`, replay отсечён статусом и
  advisory-замком; Stars — constant-time секрет, HMAC payload с TTL,
  идемпотентность по `charge_id` под замком.
- **Admin-периметр**: все 27 методов `admin-panel.controller.ts`,
  `actors`, `blog`, `admin-cron`, `admin-generation-retry`, `library`,
  `publication`, `shared-video` — `assertOperator` первой строкой; новые
  `GET/PATCH /admin/settings/grok-transport` — с `assertOperator`, DTO
  `@IsIn`, глобальный `ValidationPipe` whitelist.
- **Telegram initData / Login Widget** — HMAC по спецификации,
  constant-time, окно `auth_date`; admin-cookie — `httpOnly`, `secure`,
  `SameSite`, TTL 7 дней, `isOperator` перечитывается на каждый запрос.
- **CRON_SECRET** на всех 11 маршрутах `cron.controller.ts`,
  fail-closed, constant-time; `tryAcquireJobLock` в четырёх воркерах.
- **SSRF**: `assertPubliclyRoutableUrl` + ручные редиректы в импорте
  фида; референс-картинки — `isOwnBlobUrl` и в DTO, и у `fetch`.
- **IDOR**: `brand-manifests/*`, `projects/*`, `sessions/:sessionId/*`
  (глобальный `SessionOwnerGuard`), `publications/:requestId`,
  `channels/:id` — владелец проверяется.
- **Паритет словарей** (5 локалей, скрипт): все ключи `en.json` есть в
  `ru/uk/de/es` и наоборот; плейсхолдеры `{{…}}` совпадают.
- **Правки 14.09**: `extendVideo` на `/v1/videos/extensions` с телом
  `{model, prompt, duration, video: {url}}` совпадает с официальной
  страницей; арифметика плана (15 + 10 = 25 с) и границы 2–10 с
  верны; продолжение цепочки выбирает транспорт по факту
  `current.xaiBatchId`, а не по текущей настройке; batch-тело
  (`image: {url}`, `reference_images: [{url}]`, `video: {url}`) по
  proto; разбор результата не завязан на имя oneof-ключа.

## Что исправлено (высокие — все, плюс четыре дешёвых средних)

| ID | Где | Что сделано |
|---|---|---|
| М-2.1 / М-5.1 | `common/session.service.ts`, `common/blob-paths.ts` | `videoHistory` читается в `toSession()`; пути прошлых попыток входят в `sessionBlobPathnames`; тест «каждый ключ `DATA_KEYS` читается обратно» закрывает класс целиком |
| М-6.1 | `generation/grok-video.service.ts` | `image: { url }` вместо `image_url`; тест на форму тела |
| М-2.2 / М-1.3 | `generation/generation.service.ts`, `WORK_KINDS.chain-continue` | продолжение цепочки — под `claimWork('chain-continue')` с перечитыванием сессии под замком; проигравший/опоздавший опрос не стартует платный сегмент; 2 теста |
| М-1.2 / М-2.3 / М-5.2 | `generation.service.ts:runGrokBatchSyncTick`, `session.service.ts:findSessionsWithPendingGrokBatch/touchSessions`, `export.service.ts:runSyncTick` | крон-досмотр одиночных Grok-пачек в том же тике `export-sync-run` (каждые 2 мин), с продлением `lastActivityAt`; текст дедлайна для батча — «26 часов» |
| М-5.3 / М-3.3 | `catalog-batch-worker.service.ts` | опрос пачки продлевает жизнь дочерним сессиям (`touchSessions`) |
| М-3.2 / М-6.2 | `grok-video-batch.service.ts` (`complete` в результатах), `catalog-batch-worker.service.ts` | неполное чтение `/results` (429/5xx/таймаут) → повтор следующим тиком, а не FAILED всей оплаченной партии; текст ошибки xAI попадает в строку; тест |
| М-3.1 | `catalog-batch-worker.service.ts` | расход Grok-партии пишется с `userId: run.userId` — суточный лимит владельца его видит |
| М-1.1 | `billing/billing.service.ts` | перед новым подписочным Stars-инвойсом действующая Stars-подписка отменяется в Telegram; вторая линия — автопродление более дешёвого плана поверх более дорогого не понижает план (время продлевается, оператору — тревога); 2 теста |
| М-7.1 / М-2.6 | `project-session.service.ts`, `frontend/src/hooks/useWorkflow.ts` | смена `voiceMode`/`subtitlesMode` снимка сбрасывает `generationPrompt.approvedAt` тем же UPDATE на сервере; клиент при сбое пересборки возвращает на шаг промпта без старого промпта; 2 теста |
| М-7.2 | `frontend/src/features/generation/GenerationWizard.tsx`, `useWorkflow.ts` | карточка запуска скрыта во время пересборки промпта (показан Busy); смена режима во время рендера запрещена |
| М-4.1 (средняя, попутно) | `telegram-auth/session-owner.guard.ts` | гвард пропускает `/api/admin/*` — у admin свой `AdminSessionGuard`; 2 теста |
| М-6.4 (средняя, попутно) | `grok-video.service.ts` | `expired` и 404/410 — терминальные; `error`-объект разворачивается в `message`; 3 теста |
| М-3.8 (средняя, попутно) | `grok-video-batch.service.ts` | понижение 1080p→720p при `reference_images` и в batch-пути |
| М-7.8 (низкая, попутно) | `useWorkflow.ts` | клик по уже подсвеченному режиму не запускает платную пересборку |

### Второй заход (тот же день) — средние

| ID | Где | Что сделано |
|---|---|---|
| М-6.3 | `publishing/tiktok-upload.service.ts`, `publish-worker.service.ts` | HTTP 200 с `error.code !== 'ok'` — ошибка площадки (init и опрос); дедлайн опроса 24 ч от одобрения → `recordFailure` |
| М-6.5 | `tts/elevenlabs.service.ts`, `tts/resemble.service.ts`, `actors/hedra-client.service.ts`, `publishing/youtube-upload.service.ts`, `publishing/tiktok-upload.service.ts`, скачивания результатов в `generation.service.ts`/`catalog-batch-worker.service.ts`/`actors.service.ts`, опрос Veo | таймауты на всех внешних вызовах; Hedra `submit` не повторяется на сетевой ошибке без статуса |
| М-2.4 | `generation.service.ts` | `chainTargetDurationSeconds` пишется всегда при построенном плане — 9–15-секундный Grok больше не «8 с» для субтитров/перерендера/повтора |
| М-2.5 | `video-audit.service.ts`, `WORK_KINDS.audit/sound-check` | замок вокруг платного Gemini-вызова + перечитывание истории перед записью; 2 теста |
| М-3.4 | `catalog-batch.service.ts` | `retry()` Grok-партии сбрасывает `xaiBatchId`, если ни одна строка не считается в xAI — повторённые строки подаются новой пачкой |
| М-3.5 | `catalog-batch-worker.service.ts` | `advanceGenerating()` не берёт Grok-строки (их досматривает опрос пачки) |
| М-3.9 | `cron-jobs.service.ts` | джоб-замок у `blog` и `export-sync-run` |
| М-5.4 | `session.service.ts` | `findSessionsWithPendingTierBExport` сужен по индексированной `generationStatus = 'complete'` |
| М-1.4 | `billing-renewal/wayforpay-renewal.service.ts` | после терминального отказа новая попытка — свой `orderReference` (суффикс по числу отказов), незавершённая (PENDING/промежуточный статус 3DS) переиспользует номер; промежуточные статусы не считаются отказом; 3 теста |
| М-1.5 | там же | `markPastDue`/`giveUp` — условный `updateMany` по снимку `currentPeriodEnd`; при `count === 0` понижение до LITE не делается |
| М-7.3 | `frontend/src/hooks/useWorkflow.ts`, `GenerationWizard.tsx`, словари | клиенту отдаётся `xaiBatchId`; опрос батч-ролика раз в минуту и не в свёрнутой вкладке; отдельная подсказка «до суток, страницу можно закрыть» (5 локалей) |
| М-7.4 | `useWorkflow.ts` | опрос разбора терпит до трёх сбоев подряд, как опрос рендера |
| М-7.5 | `frontend/src/lib/session-step.ts` | непринятый пересобранный промпт сильнее старого готового ролика при восстановлении шага; тест |
| М-8.1 | 5 спек | протухшие моки приведены к коду (`ttsResolver`, `$queryRawUnsafe`, локаль разбора, позиционные аргументы) — полный `npm test` в `backend/`: 2264 зелёных, 0 красных |

Попутно приведены в соответствие с кодом протухшие ожидания в
`catalog-batch-worker.service.spec.ts` и `billing.service.spec.ts`
(см. М-8.1).

### Третий заход (тот же день) — оставшиеся средние/низкие

| ID | Где | Что сделано |
|---|---|---|
| М-1.6 | `admin-panel/admin-billing.service.ts`, `common/prisma-errors.ts` | возврат в одной транзакции сторнирует кредиты пакета (`REFUND`, идемпотентно по `[paymentId, reason]`) и снимает автопродление подписки (+ отмена Stars-подписки в Telegram); 3 теста |
| М-1.8 | `generation.service.ts` | ошибки старта Grok классифицируются: 429/5xx/сетевые → `ServiceUnavailableException` (воркеры ретраят), остальное — `BadRequest` |
| М-6.7 | `grok-video-batch.service.ts` | после `addRequests` сверяется `state.num_requests` с числом поданных — при расхождении (шлюз проигнорировал ключ oneof) ошибка сразу, а не через 26 ч; пустая пачка-сирота отменяется best-effort; 2 теста |
| М-3.10 | `catalog-batch-worker.service.ts` | `assertUserNotBlocked` перед подачей Grok-пачки |
| М-3.6 | `catalog-batch-worker.service.ts` | метка `pending:<ts>` в `xaiBatchId` ставится атомарно ДО вызова xAI (условный `updateMany`), снимается при ответе с ошибкой; при обрыве остаётся — крон не переподаёт (двойная оплата), а через 10 мин зовёт оператора с именем пачки в консоли; 2 теста |
| М-2.7 | `generation.service.ts` | под замком `generate` сессия перечитывается, идущий рендер конкурента возвращается вместо второго старта |
| М-4.3 | `common/filters/http-exception.filter.ts` | в лог и `meta.path` — путь без query (там `?secret=` вебхука Resemble и OAuth `code`) |
| М-4.5 | `shared-video.controller.ts` | `POST /shared-video/:id/fork` — тот же лимит `session-create` 30/мин |
| М-3.12 | `blog-youtube-budget.service.ts`, `youtube-search-usage.service.ts` | `limit <= 0` отсекается до INSERT |
| М-3.13 | `library.service.ts` | `pruneUnused` не трогает записи, на которые ссылаются незавершённые партии/A-B; тест |
| М-5.5 | `schema.prisma`, миграция `20261026090000_finance_restrict_funnel_indexes` | `payments`/`credit_ledger` → `ON DELETE RESTRICT` (финансовая история переживает аккаунт; удаление пользователя = анонимизация); `subscriptions` остаётся CASCADE как текущее состояние |
| М-5.7 | та же миграция | `@@index([workflow, occurredAt])`, `@@index([workflow, entityId])` под запросы воронки/когорты; retention-крон — не добавлен (продуктовое решение о сроке) |
| М-7.7 | `useWorkflow.ts`, словари | `wizardErrors.analysisFailed` / `videoFailed` в 5 локалях вместо строк в коде |

Все 47 миграций (с новой) применены на чистый PG16 подряд, ограничения и индексы проверены `\d`.

### Четвёртый заход (тот же день) — технический остаток без продуктовых вопросов

| ID | Где | Что сделано |
|---|---|---|
| М-6.6 / М-1.7 / М-2.8 | `grok-video.service.ts` (`effectiveGrokResolution`), `generation.service.ts` | в учёт расхода и в оценку цепочки идёт ФАКТИЧЕСКОЕ разрешение Grok: с референсами и у расширений 1080p понижается до 720p, как это делает сам API; раньше списывалось по запрошенному |
| М-3.2б | `grok/grok-batch.service.ts` (`getBatchResultsDetailed` → `complete`), `blog-translation.service.ts` | перевод блога применяется только при полном наборе результатов; неполная страница пачки больше не пишет «переведено» по части языков |
| М-3.7 (частично) | `schema.prisma` (`CronJobLock.ownerToken`), миграция (та же, `ALTER TABLE cron_job_locks ADD COLUMN "ownerToken"`), `common/cron-job-lock.ts`, 6 вызывающих | `tryAcquireJobLock` возвращает токен владельца, `releaseJobLock` снимает замок только своим токеном — просроченный и перехваченный замок не снимается «чужим» finally; спеки обновлены. Построчный claim в опросе пачек и бюджет тика — не сделаны (отдельная задача) |
| М-4.4 | `main.ts` | **ОТКАЧЕНО в тот же день.** Прослойка снимала `Access-Control-Allow-Credentials` для wildcard-origin'ов, но мини-апп шлёт все запросы с `withCredentials: true` — браузер отверг ответы прод-фронта на `*.vercel.app` (на сервере 200, в приложении «нет связи с сервером»). Фикс возможен только в паре с фронтом: `withCredentials` условно (когда есть cookie-логин) + прод-origin точной строкой в `CORS_ORIGIN` |
| М-5.8 | `common/blob-paths.ts` | пути текст-карточек (`cardPathname` из `generationPrompt.onScreenTextMoments`) учитываются при обходе blob'ов сессии — иначе чистка считала их сиротами; тест |
| М-7.6 | `frontend/.../ui/Pills.tsx` | `role="radiogroup"` + `aria-label`, каждая пилюля — `role="radio"` с `aria-checked`; скринридер читает выбранный вариант |
| М-7.9 | `admin/.../settings/page.tsx`, `admin-auth-context.tsx` | у четырёх карточек настроек и у страницы env — «Повторить» при ошибке загрузки; редирект на `/login` только при 401, 5xx показывается как «сервис ответил ошибкой N» с «Повторить» |

Проверка: полный набор бэкенда 159 спек / 2272 теста зелёный; `tsc` admin и frontend без ошибок; все 47 миграций повторно применены на чистый PG16, колонка `cron_job_locks.ownerToken` на месте; eslint по изменённым файлам — без новых ошибок относительно базы.

**Сознательно НЕ исправлено (с обоснованием):**
- **М-4.2 (OAuth state fixation).** Предложенный фикс (nonce в
  httpOnly-cookie) здесь неприменим: TMA открывает OAuth через
  `openLink` в СИСТЕМНОМ браузере (`ChannelsScreen.tsx:112`), cookie
  выставленная webview Mini App'а туда не попадает — легитимный поток
  сломался бы целиком. Корректная защита — шаг подтверждения из
  аутентифицированного TMA, где владельцем становится ПОДТВЕРЖДАЮЩИЙ
  аккаунт (а не `userId` из `state`); это отдельная фича со схемой
  (`ChannelStatus.PENDING_CONFIRM`, токен подтверждения) и UX возврата в
  приложение. Остаётся открытой средней.
- **М-4.4** — снятие credentials для wildcard-origin'ов ломает мини-апп,
  пока `withCredentials: true` стоит на всех запросах; нужна парная
  правка фронта (см. таблицу четвёртого захода).
- **М-3.8б, М-5.6, М-1.9, М-1.10, М-3.11, М-5.9, М-5.10** — требуют
  продуктовых решений (умолчание озвучки без манифеста, гейт Grok 1080p,
  retention событий, бренд-референсы в каталог-партиях); описаны с
  предложенными правками ниже. Остальное из прежнего списка закрыто в
  четвёртом заходе.

## 1. Деньги и тарифные гейты

### М-1.1 (высокая, ИСПРАВЛЕНО). Повторная покупка подписки Stars (апгрейд) создавала вторую автопродляемую подписку в Telegram; старая не отменялась, и её продление откатывало план

`billing.service.ts:startSubscriptionCheckout` для `STARS` не смотрел
на существующую `Subscription`; `applySuccessfulPayment` при
`is_recurring` брал план из payload инвойса; `notifyTelegramCancellation`
отменял только `charge_id` последнего платежа. Сценарий: STANDARD →
PREMIUM, через 30 дней автопродление старой подписки списывает 1000 XTR
и ставит STANDARD пользователю, платящему 3500 XTR/мес.

**Правка.** `cancelExistingStarsSubscription()` перед выпуском нового
подписочного инвойса; в `applySuccessfulPayment` — `isRecurring` и
`PLAN_RANK`: автопродление более дешёвого плана поверх более дорогого
продлевает срок, но не понижает план, с `logger.error` для оператора.

### М-1.2 (высокая, ИСПРАВЛЕНО — см. М-2.3/М-5.2). Batch-транспорт одиночного ролика: оплаченный рендер терялся при задержке xAI

### М-1.3 (высокая, ИСПРАВЛЕНО — см. М-2.2). Продолжение цепочки без замка — два платных вызова за один сегмент

### М-1.4 (средняя, ИСПРАВЛЕНО во втором заходе). Ретрай продления WayForPay после Declined идёт с тем же `orderReference`
`wayforpay-renewal.service.ts:136` — `sub:<id>:<periodEnd>`; после
терминального FAILED `currentPeriodEnd` не меняется, следующий тик
формирует тот же `orderReference`. Если WayForPay дедуплицирует (как
утверждает комментарий `:32-35`), три «попытки грейса» получают ответ
первого отказа. Плюс `chargeRecToken` (`wayforpay.service.ts:214-216`)
считает успехом только `Approved`; `InProcessing`/`Pending` помечаются
FAILED. **Фикс:** суффикс попытки после терминального FAILED;
не-терминальные статусы — оставлять PENDING.

### М-1.5 (средняя, ИСПРАВЛЕНО во втором заходе). `giveUp`/`markPastDue` пишут статус безусловно; `giveUp` без recToken — до claim
`wayforpay-renewal.service.ts:82-87, 176-193, 218-231` — тот же класс,
что Е-1.1. Между `findMany` воркера и записью вебхук новой покупки ставит
ACTIVE и тут же затирается. **Фикс:** `updateMany` с условием на
`currentPeriodEnd`/`status:'RENEWING'`, `applyPurchasedPlan('LITE')` только
при `count===1`.

### М-1.6 (средняя, ИСПРАВЛЕНО в третьем заходе). Админский возврат не откатывает кредиты и не отменяет подписку
`admin-billing.service.ts:124-164` — после `refundStarPayment` только
`payment.status='REFUNDED'`. **Фикс:** для CREDIT_PACK — отрицательная
строка `CreditLedger` в той же транзакции; для SUBSCRIPTION —
`cancelAtPeriodEnd` + `cancelSubscription` в Telegram.

### М-1.7 (низкая, ИСПРАВЛЕНО в четвёртом заходе). Расход Grok пишется по запрошенному, а не по фактическому разрешению
`generation.service.ts` (`record` с `resolution`) при понижении
1080p→720p в reference-режиме и у расширения (выход ≤720p). Батч-путь
понижения не делал (закрыто М-3.8). **Фикс:** возвращать фактическое
разрешение из клиента и писать его.

### М-1.8 (низкая, ИСПРАВЛЕНО в третьем заходе). Grok-путь не получил фиксов Е-1.2/Е-1.4
`generation.service.ts` — любая ошибка старта Grok → `BadRequestException`
(non-retryable для воркеров); при таймауте `addRequests` после
успешного `createBatch` пачка может стартовать, `xaiBatchId` известен и
выбрасывается. **Фикс:** классификация по `status`; при ошибке без
ответа после `createBatch` — `VeoOperationOrphanedError(xaiBatchId)`.

### М-1.9 (низкая, сознательный выбор). Гейт `fullQualityVideo` не распространяется на Grok 1080p
`generation.service.ts:270-276` — только для `provider==='veo'`; Grok
1080p ($0.25/с) дороже Veo Lite ($0.15/с). Ограничен суточным потолком.

### М-1.10 (низкая). `adjustCredit` без идемпотентности и потолка дельты
`admin-users.service.ts:466-486`. **Фикс:** `idempotencyKey` или
подтверждение в UI + `Max`.

## 2. Ядро видео-пайплайна

### М-2.1 (высокая, ИСПРАВЛЕНО). `videoHistory` в `DATA_KEYS`, но не в `toSession()` — история версий усекалась до одной записи, файлы прошлых попыток — вне уборки
`session.service.ts:91` vs `toSession()`; `generation.service.ts:765,
979`, `catalog-batch-worker.service.ts:715` — `[previous, ...(undefined ??
[])]`; `blob-paths.ts` не перечислял `videoHistory[]`. Третий случай
класса Б-2.2 в одном методе.

### М-2.2 (высокая, ИСПРАВЛЕНО). Продолжение цепочки Veo/Grok запускалось из хот-пути опроса без замка
`getVideoStatus`/`pollGrokStatus` → `continueVeoChain`/`continueGrokChain`
без `claimWork`; конкурентные опросы (две вкладки, таймер админки, крон
экспорта дочерней сессии) стартовали каждый свой сегмент.

### М-2.3 (высокая, ИСПРАВЛЕНО). Одиночный ролик через Batch API xAI не досматривался никем, кроме открытой вкладки; результат живёт час; TTL сессии 24 ч < дедлайн 26 ч

### М-2.4 (средняя, ИСПРАВЛЕНО во втором заходе). Длительность одиночного (без расширения) Grok-ролика 9–15 с нигде не сохраняется
`generation.service.ts` пишет `chainTargetDurationSeconds` только при
`totalCalls > 1`; `postprod.service.ts:820` (тайминг субтитров),
`export.service.ts:285`, `admin-generation-retry.controller.ts:122-124`
считают 8 с. **Фикс:** писать `chainTargetDurationSeconds` всегда при
построенном плане.

### М-2.5 (средняя, ИСПРАВЛЕНО во втором заходе). `VideoAuditService.run()` и `runSoundCheck()` без замка
`video-audit.service.ts:109-212, 221-276` — рецидив Е-3.1: двойной клик
= две оплаты Gemini, одна запись истории теряется. **Фикс:**
`claimWork('audit')`.

### М-2.6 (низкая-средняя, ИСПРАВЛЕНО — см. М-7.1). Смена режима озвучки не сбрасывала одобрение промпта на сервере

### М-2.7 (низкая, ИСПРАВЛЕНО в третьем заходе). `generateVideo` проверяет «рендер уже идёт» по снимку, прочитанному до `claimWork`
`generation.service.ts:277-305, 386, 398`. **Фикс:** перечитать сессию
после захвата замка.

### М-2.8 (низкая, ИСПРАВЛЕНО в четвёртом заходе). Оценка и учёт расширения Grok при базе 1080p — по ставке 1080p, хотя выход ≤720p

## 3. Фоновые воркеры и кроны

### М-3.1 (высокая, ИСПРАВЛЕНО). Расход Grok-партии писался анонимным — суточный лимит владельца его не видел
`catalog-batch-worker.service.ts:564-569` — `sessionId: run.id` (id
партии), `AiUsageService` не находил сессию → `userId = null`.

### М-3.2 (высокая, ИСПРАВЛЕНО). Транзиентный сбой `GET /batches/{id}/results` помечал все строки партии FAILED навсегда
`grok-video-batch.service.ts:390-395, 422-426` возвращали пустую карту
без признака «не смог прочитать»; воркер безусловно ставил FAILED.
Тот же класс остаётся в блоге (`blog-translation.service.ts:288-313`,
`grok-batch.service.ts:260-264`) — **не исправлено** (средняя, М-3.2б).

### М-3.3 (средняя-высокая, ИСПРАВЛЕНО — см. М-5.3). TTL дочерних сессий партии короче обработки пачки

### М-3.4 (средняя, ИСПРАВЛЕНО во втором заходе). `retry()` для Grok-партии — тупик
`catalog-batch.service.ts:510-519` → BATCH_QUEUED, но
`submitReadyGrokBatches` берёт только `xaiBatchId: null`
(`catalog-batch-worker.service.ts:433-436`). **Фикс:** разрешить
повторную подачу при отсутствии GENERATING-строк.

### М-3.5 (средняя, ИСПРАВЛЕНО во втором заходе). `advanceGenerating()` опрашивает Grok-строки без `generatedVideo` и вытесняет ими Veo-строки
`catalog-batch-worker.service.ts:320-330` — `take: 10` без фильтра по
провайдеру. **Фикс:** `where: { batch: { provider: { not: 'grok' } } }`.

### М-3.6 (средняя, ИСПРАВЛЕНО в третьем заходе). Окно между подачей пачки и записью `xaiBatchId` — повторная подача всей партии
`catalog-batch-worker.service.ts:546-578`. **Фикс:** метка «подача
начата» до вызова или поиск пачки по имени перед созданием.

### М-3.7 (средняя, ИСПРАВЛЕНО частично в четвёртом заходе — токен владельца замка). `pollInFlightGrokBatches` без построчного claim и бюджета времени; `releaseJobLock` снимает чужой замок
`catalog-batch-worker.service.ts:594-661`, `cron-job-lock.ts:88-98`.
**Фикс:** токен владельца замка (сделано, см. четвёртый заход);
`AbortSignal.timeout` на скачивании (сделано ранее, `DOWNLOAD_TIMEOUT_MS`);
построчный claim `lockedUntil` внутри опроса — не сделан: опрос уже идёт
под общим `catalog-batch-run` замком с токеном, а ставить claim на
строку без бюджета времени на весь тик даёт ту же гонку в другом месте —
отдельная задача вместе с бюджетом тика.

### М-3.8 (средняя, ИСПРАВЛЕНО частично). Понижение 1080p→720p при референсах не применялось в batch-транспорте
Понижение добавлено в `submitBatch`. Вторая половина — партия по
каталогу не строит `referenceImageUrls` вовсе (персонажи бренда
игнорируются) — **не исправлена**.

### М-3.9 (низкая-средняя, ИСПРАВЛЕНО во втором заходе). `blog` и `export-sync-run` без джоб-замка
`cron-jobs.service.ts:265-266`, `export.service.ts:428-446`.

### М-3.10 (низкая, ИСПРАВЛЕНО в третьем заходе). Grok-партия обходит `assertUserNotBlocked`
`catalog-batch-worker.service.ts:525-527`. **Фикс:** `assertCanSpendUser`.

### М-3.11 (низкая). Остаток Е-1.2: сетевые ошибки Veo без `status` → non-retryable

### М-3.12 (низкая, ИСПРАВЛЕНО в третьем заходе). Первый вызов за сутки обходит нулевой лимит YouTube-бюджета
`blog-youtube-budget.service.ts:51-58`, `youtube-search-usage.service.ts:69-73`.

### М-3.13 (низкая, ИСПРАВЛЕНО в третьем заходе). `pruneUnused` может удалить разбор, на который ссылается необработанная партия
`library.service.ts:658-680`; FK на `libraryEntryId` нет.

## 4. Периметр безопасности и auth

### М-4.1 (средняя, ИСПРАВЛЕНО). Глобальный `SessionOwnerGuard` перехватывал `/admin/actors/:sessionId/*`
`session-owner.guard.ts:73-77` + `actors.controller.ts:34,42,64,73,82`
— оператор получал 403 на любой сессии с владельцем; ничья сессия могла
привязаться к оператору. Гвард пропускает `/api/admin/*`.

### М-4.2 (средняя, НЕ исправлено — см. обоснование выше). OAuth-`state` подключения канала не привязан к браузеру — state fixation
`oauth-state.util.ts:30-43`, `publishing-channel.service.ts:112-149` —
злоумышленник подсовывает жертве свой `state`; канал жертвы создаётся
с `userId` злоумышленника. **Фикс:** nonce в httpOnly-cookie + в
`state`, сверка в callback.

### М-4.3 (низкая, ИСПРАВЛЕНО в третьем заходе). `HttpExceptionFilter` логирует полный `request.url` — включая `?secret=` вебхука Resemble
`http-exception.filter.ts:122-147`. **Фикс:** `request.path` или `redact()`.

### М-4.4 (низкая, попытка фикса откачена — см. четвёртый заход). CORS с `credentials: true` для wildcard `*.vercel.app`
`main.ts:60-83`. **Фикс:** credentials только для точных совпадений.

### М-4.5 (низкая, ИСПРАВЛЕНО в третьем заходе). `POST /shared-video/:id/fork` создаёт сессию в обход лимита `session-create`
`shared-video.controller.ts:129-135`. **Фикс:** `RateLimitGuard`.

## 5. Целостность данных и Vercel Blob

### М-5.1 (высокая, ИСПРАВЛЕНО — см. М-2.1)

### М-5.2 (высокая, ИСПРАВЛЕНО — см. М-2.3)

### М-5.3 (высокая, ИСПРАВЛЕНО). Дочерние сессии Grok-партии удалялись TTL, пока пачка считалась в xAI
`session.service.ts:483-509` + `catalog-batch-worker.service.ts:677-678`
(`Session not found` → FAILED после списания расхода). Опрос пачки
продлевает `lastActivityAt`. Дедлайн для `pollInFlightGrokBatches` —
**не добавлен** (низкая).

### М-5.4 (средняя, ИСПРАВЛЕНО во втором заходе). `findSessionsWithPendingTierBExport` — полный JSONB-скан таблицы каждые 2 минуты
`session.service.ts:444-453`. **Фикс:** `AND "generationStatus" = 'complete'`
(новый `findSessionsWithPendingGrokBatch` уже сужен по колонке).

### М-5.5 (средняя, ИСПРАВЛЕНО в третьем заходе — `Restrict`, не `SetNull`). `Payment`/`Subscription`/`CreditLedger` — `onDelete: Cascade` от `users`, хотя «финансовая история не удаляется»
`schema.prisma:1312-1320, 1373-1376, 1412-1415`. **Фикс:** `SetNull`.

### М-5.6 (средняя). Умолчание `voiceover` не доходит до сессий без манифеста бренда
`normalizeVoiceMode(undefined)` → `LEGACY 'veo'`; снимок создаётся
только при манифесте; переключатель показывается только при снимке.
Осознанное решение 14.09 (legacy-снимки не должны платить за синтез),
но для быстрой генерации без проекта режим — всегда голос модели.
**Фикс:** `data.voiceMode` на уровне сессии с умолчанием
`DEFAULT_VOICE_MODE`.

### М-5.7 (средняя, индексы ИСПРАВЛЕНЫ в третьем заходе; retention открыт). `workflow_stage_events` — append-only без уборки, запросы воронки не покрыты индексами
`admin-panel.service.ts:504-686`. **Фикс:** `@@index([workflow, occurredAt])`,
retention-крон.

### М-5.8 (низкая, ИСПРАВЛЕНО в четвёртом заходе). `text-card-*.png` и `character-preview-*` вне `sessionBlobPathnames`

### М-5.9 (низкая). `SharedVideoPage.price Float` при `ProductItem.price Decimal(12,2)`

### М-5.10 (низкая). Вечные выборки: Grok-партии с полностью FAILED строками; мёртвый `deleteSession`

## 6. Внешние API-клиенты

### М-6.1 (высокая, ИСПРАВЛЕНО). Синхронный image-to-video Grok слал `image_url`, которого нет в контракте — рендерился text-to-video без товара
`grok-video.service.ts:202`; docs.x.ai image-to-video и proto
`GenerateVideoRequest.image: ImageUrlContent` — `image: { url }`.

### М-6.2 (средняя, ИСПРАВЛЕНО — см. М-3.2)

### М-6.3 (средняя, ИСПРАВЛЕНО во втором заходе). TikTok `pollStatus` считает HTTP 200 с `error.code != 'ok'` состоянием «ещё обрабатывается»
`tiktok-upload.service.ts:137-166`; `publish-worker.service.ts:247-261`
— вечный «в процессе». **Фикс:** проверять `error.code`; дедлайн на poll.

### М-6.4 (средняя, ИСПРАВЛЕНО). `getStatus` не знал терминального `expired`; 404/410 трактовались как транзиентные

### М-6.5 (средняя, ИСПРАВЛЕНО во втором заходе). Внешние `fetch`/`axios` без таймаута у ElevenLabs, Resemble, Hedra, YouTube, TikTok и загрузчиков результатов
`elevenlabs.service.ts:99,237`, `resemble.service.ts:125-409`,
`hedra-client.service.ts:93`, `youtube-upload.service.ts:78-179`,
`tiktok-upload.service.ts:46-126`, `generation.service.ts` (fetch),
`catalog-batch-worker.service.ts:680`, `actors.service.ts:1047`. Hedra
`withRetry` повторяет POST submit на сетевой ошибке — второй платный job.
**Фикс:** `AbortSignal.timeout`; не ретраить submit без статуса.

### М-6.6 (низкая, ИСПРАВЛЕНО в четвёртом заходе). Ставка Grok — по запрошенному разрешению (см. М-1.7); `usage.cost_in_usd_ticks` из ответа xAI игнорируется

### М-6.7 (низкая, ИСПРАВЛЕНО в третьем заходе). Пустые пачки-сироты на стороне xAI при ошибке `addRequests`; неверифицированные oneof-ключи
Рекомендация: после `addRequests` сверять `state.num_requests ===
items.length`; в `catch` — best-effort `DELETE /batches/{id}`.

## 7. Клиентские приложения

### М-7.1 (высокая, ИСПРАВЛЕНО). Сбой пересборки промпта после смены режима оставлял одобренный промпт под старый режим

### М-7.2 (высокая, ИСПРАВЛЕНО). Карточка запуска не блокировалась во время пересборки промпта

### М-7.3 (средняя, ИСПРАВЛЕНО во втором заходе). Опрос батч-ролика: 4 с × до 26 ч без бэкоффа и без подсказки «может занять часы»
`useWorkflow.ts:1106,1166`; тип `GeneratedVideo` фронта не содержит
`xaiBatchId`. **Фикс:** отдавать транспорт клиенту, интервал 60 с +
пауза при `document.hidden`, отдельная подсказка.

### М-7.4 (средняя, ИСПРАВЛЕНО во втором заходе). Одна ошибка сети в опросе разбора выбрасывает на шаг «Видео»
`useWorkflow.ts:515-528`. **Фикс:** счётчик подряд идущих сбоев, как у
видео-опроса.

### М-7.5 (средняя, ИСПРАВЛЕНО во втором заходе). После смены режима/`startRevision` перезагрузка возвращает на экран старого ролика
`lib/session-step.ts:71` проверяет `generatedVideo.status === 'complete'`
раньше `status === 'prompt_generated'`. **Фикс:** порядок проверок.

### М-7.6 (низкая, ИСПРАВЛЕНО в четвёртом заходе). Pills без `role`/`aria-checked`

### М-7.7 (низкая, ИСПРАВЛЕНО в третьем заходе). Две строки мимо словаря в `useWorkflow.ts` (`:512`, `:1133`)

### М-7.8 (низкая, ИСПРАВЛЕНО). Клик по подсвеченному режиму запускал платную пересборку

### М-7.9 (низкая, ИСПРАВЛЕНО в четвёртом заходе). Карточки настроек админки без «Повторить»; `admin-auth-context` редиректит на `/login` при любом `ApiRequestError`

## 8. Инфраструктура тестов

### М-8.1 (низкая, ИСПРАВЛЕНО во втором заходе). 40 тестов в 5 спеках отстали от кода и падают на `main`
`postprod.service.spec.ts` (мок без `ttsResolver.resolve`, 17),
`admin-users.service.spec.ts` (`$queryRawUnsafe`, 12),
`analysis.service.spec.ts` (число вызовов), `ab-test-worker.service.spec.ts`
и `plan.controller.spec.ts` (лишний позиционный аргумент). Ещё 7
(`catalog-batch-worker`) и 6 (`billing.service`) поправлены попутно в
этом заходе. **Вывод:** CI не гейтит `npm test` в `backend/` (или гейтит
не весь набор) — иначе это было бы видно. Рекомендация: включить полный
прогон в CI и починить оставшиеся пять спек.

## Не проверено эмпирически (честная оговорка)

- Живые контракты xAI: имена oneof-ключей REST-пачки
  (`video_generate_video`/`video_extend_video`) выведены по аналогии с
  подтверждённым `chat_get_completion`; при первой пачке — сверить
  (переопределяются `GROK_BATCH_VIDEO_REQUEST_KEY`/`…_EXTEND_KEY`).
- Планы запросов на продовых объёмах (М-5.4, М-5.7) — по форме запроса
  и наличию индексов, не по `EXPLAIN`.
- Замок `chain-continue` и крон-досмотр пачек проверены юнит-тестами с
  моками `SessionService`; интеграционный прогон с Postgres не делался.
- Полный `npm test` в `backend/` в этом окружении прогнан через стаб
  Prisma-клиента (движок недоступен): после третьего захода — 159
  спек, 2271 тест, все зелёные (до правок: 40 красных, все на базовом
  коммите — М-8.1).

## Источники

- `doc/AUDIT-2026-09-10-round6.md`, `doc/AUDIT-2026-09-09-round5.md`
- `github.com/xai-org/xai-proto` — `proto/xai/api/v1/{batch,video}.proto`
- docs.x.ai — Video Generation, Video Extension, REST API Reference (videos, batches)
