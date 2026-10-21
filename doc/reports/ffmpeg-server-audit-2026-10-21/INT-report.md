# Аудит пакета INT (интеграция) — FFmpeg-сервер, 21.10.2026

Аудитор: только чтение. Пробы — в `/tmp/ffa-INT/`. Находки — `INT-findings.csv`.

Итог: **S0 — 0, S1 — 2, S2 — 4, S3 — 7** (13 находок).

## S1

### FF-INT-01. Сверка by-key принимает 404 от Traefik за «нет записи», и задача рендерится дважды
`backend/src/modules/postprod/ffmpeg-api.service.ts:810-812`. Любой ответ 404 увеличивает счётчик `absent`, а два таких ответа подряд включают fallback к hosted. API своего сервера стоит за Traefik (`docker-compose.yml:84-94`) и имеет healthcheck. Пока контейнер `starting` или `unhealthy` (деплой, краш), Traefik снимает роутер и сам отвечает `text/plain` «404 page not found». Свой сервер отвечает иначе: `{"error":{"code":"NOT_FOUND"}}` (`ffmpeg-server/src/api/http.ts:184`).

Проба `/tmp/ffa-INT/probe-proxy404.cjs`:
1. POST фиксирует задачу, затем соединение рвётся.
2. На оба запроса by-key Traefik отвечает 404.
3. Backend отправляет задачу к hosted: `selfCommitted=[story-video:r1]`, у hosted `h1`.

После рестарта свой сервер восстановит зафиксированную задачу и выполнит её. Получается двойной рендер и двойная оплата при каждом деплое во время отправки, в том числе у Story.

**Исправление:** считать 404 «нет записи» только при конверте сервера, а лучше при отдельном коде или заголовке. Любой другой 404 — «сверка недоступна».

### FF-INT-02. Провайдер не закреплён за операцией: повтор уходит к hosted в обход сверки
`ffmpeg-api.service.ts:596-601`. `route()` вызывается до любой сверки. Сценарий:
1. Отправка оборвалась после приёма, by-key недоступен, `submit` вернул ошибку. Этот отказ засчитан breaker.
2. Через три таких случая breaker открыт. Повтор той же операции (тот же `operationKey` или тело) сразу уходит к hosted.
3. То же происходит после штатного rollback (`defaultProvider=hosted`).

Проба `/tmp/ffa-INT/probe-routing.cjs`, сценарии «ДВОЙНОЙ РЕНДЕР»: `renders=2`.

Это нарушает ТЗ §11: «восстановление по ключу направляется к провайдеру, выбранному при первой отправке». Нарушено и решение владельца: fallback допустим только при доказанном отказе или после «нет записи».

**Исправление:** хранить связку «операция → провайдер и ключ» до сетевого вызова. Повтор операции с неподтверждённой отправкой своему серверу сначала сверять по by-key, без учёта breaker и настроек маршрутизации.

## S2
- **FF-INT-03.** В режиме recovery POST получает `503 NOT_ACCEPTING`, тот же код, что при drain (`ffmpeg-server/src/queue/service.ts:195`). Backend считает его доказанным отказом и отправляет повтор потерянного ключа к hosted. Это противоречит `docs/OPERATIONS.md` §4 п.7 и §5, а также ТЗ §13.
- **FF-INT-04.** Правила внимания `ffmpeg-not-ready` и `ffmpeg-oom-repeated` на настоящей сводке сервера не срабатывают никогда:
  - правило читает `ready.ok`, а сервер отдаёт `ready.ready` и `reasons[]`;
  - поля с OOM по коду в сводке нет;
  - спека построена на выдуманной форме данных.

  Проба `/tmp/ffa-INT/att/probe-attention.ts` вернула `[]`.
- **FF-INT-05.** Команда водяного знака изменилась и для hosted при выключенном гейте (`watermark.ts:78-84,132`). Перед каждым пробелом теперь стоит 6 обратных слешей. Такое экранирование работает только если hosted разбирает команду как shell, а это никто не проверял. Если не разбирает, слеши будут видны на всех водяных знаках портфолио.
- **FF-INT-06.** После исхода `unknown` мутации, кроме reconcile, больше не сверяются: повтор возвращает записанный `unknown` (`ffmpeg-admin.service.ts:497-517`). Кнопка UI «Сверить ещё раз» ничего не сверяет. В E2E-моке ADM обрыв происходит до записи в журнал, поэтому этот случай не покрыт. ТЗ §13.1 требует «исход подтвердить после сверки».

## S3
- **FF-INT-07.** Breaker без окна по времени и без одиночной пробы: после истечения 5 из 5 параллельных задач ушли к своему серверу. Сбрасывается любым завершённым опросом.
- **FF-INT-08.** Гонки учёта отказов на настоящем PostgreSQL:
  - из 60 одновременных отказов учтено 50, остальные упёрлись в CHECK;
  - повторный опрос тех же задач засчитывается снова (25→30).
- **FF-INT-09.** Окно «медленной фиксации»: два 404 с интервалом около 1 с не доказывают, что задачи нет, если сервер ещё ждёт readiness перед транзакцией.
- **FF-INT-10.** При выключенном гейте у статуса hosted `error` равен `error_code`, когда `error_message` пуст. По пробе 2 расхождения из 78.
- **FF-INT-11.** Худший случай отправки Story теперь около 60 с (25 + 10 + 25) вместо 25.
- **FF-INT-12.** Изменение `command-corpus.json` не запускает CI backend, хотя спека backend читает этот файл.
- **FF-INT-13.** Документы не совпадают с кодом:
  - DEPLOYMENT и API обещают «без двойного рендера» и «пробную» задачу;
  - в `doc/CI.md` нет джобы ffmpeg-server;
  - не описаны `FFMPEG_SERVER_DOWNLOAD_CA_FILE`, `FFMPEG_SERVER_ALLOW_HTTP_PUBLIC_URL`, `FFMPEG_SERVER_HOST`.

## Проверено и корректно
- **Без гейта hosted ведёт себя как раньше.** Проба `/tmp/ffa-INT/probe-gateoff.cjs` гоняет настоящий сервис против origin/main. Совпали 76 из 78 проверок: метод, путь, заголовки (Authorization, Content-Type, Idempotency-Key=sha256 тела), тело, число повторов и паузы (500/1000 мс), 4xx без повтора, Story — одна попытка с таймаутом 25 с, разбор `data`/`succeeded`/`error_message`. Расходится только FF-INT-10. Без гейта и при пустом/false-значении база не читается. `submit` возвращает дополнительное поле `provider`.
- **Доказанные отказы уходят к hosted одним POST, с событием `refused`:** 503 NOT_READY/NOT_ACCEPTING, 429 QUEUE_FULL/CLIENT_QUOTA_EXCEEDED, 413, 422 UNSUPPORTED_COMMAND, 403 FORBIDDEN_SOURCE, ECONNREFUSED, ENOTFOUND.
- **Сервер проверяет ключ раньше квот и readiness** (`service.ts:157-168`).
- **Неизвестный исход:** найденная задача — без hosted; 404×2 — hosted; 500 или 503 RECOVERY при сверке — ошибка; чередование 404/500 — ошибка.
- **Ошибки без fallback:** 400, 401, 409, 403 FORBIDDEN, 422 INVALID_COMMAND.
- **Маршрутизация статуса только по префиксу:** при выключенном гейте, открытом breaker и default=hosted. Canary работает. `FFMPEG_FALLBACK_HOSTED=false` — fallback нет.
- **Задача, упавшая по инфраструктуре (OOM):** `retryOnFallback`, засчитывается один раз. `infra` обрабатывает только tutorial-runner.
- **Story:** ключ `story-video:<id>`, `X-Client-Operation-Id` = `story:…`, у hosted остаётся sha256. Правила оплаты не меняются: usage пишется по тому, кто принял задачу, оценка та же; при неизвестном исходе — UNKNOWN без повтора; bind-job принимает `selfhosted:`.
- **Потребители:** `product` передают все 14 вызовов `submit`. `errorCode` и `error` при не-failed статусе потребители не читают. В `ai_usage.provider` хранится строка, потолков по провайдеру нет.
- **Миграция:**
  - накат 147 миграций psql-циклом на чистую `ffa_int_mig` без ошибок;
  - CHECK работают: singleton, провайдер, canary, UUID операции, reason; UPDATE журнала запрещён триггером, DELETE разрешён;
  - RLS включён, у PUBLIC/anon/authenticated прав нет; default `selfhosted` при выключенном гейте не действует;
  - pg-спека на настоящем PostgreSQL — 10/10;
  - jobId везде `text`, без `@db.VarChar`.
- **Админка:**
  - права: без сессии 401; QA viewer и обычный пользователь — 403 на каждую мутацию, без обращения к серверу; пустой `ADMIN_OWNER_TELEGRAM_IDS` — запрет;
  - CSRF: чужой Origin — 403;
  - журнал: строки «до» и «после», unique(operationId, phase), повтор не дублирует действие, retention 90 дней в кроне;
  - CAS: stale revision → 409;
  - VPS offline → stale/error; секретов в ответах нет (sanitizeOps);
  - Playwright на собранной админке (`/tmp/ff-ADM/e2e.cjs` против `next start`): 26/26, axe — 0 нарушений на 320/1280 × light/dark. Мок соответствует реальной форме ops overview.
- **CI:**
  - `ci-changes --self-test`: 176 случаев ok;
  - ручная проверка путей: `ffmpeg-server/**` → только ffmpeg_server; `ffmpeg-api.service.ts` и `ffmpeg-ops.client.ts` → backend, frontend, ffmpeg_server;
  - агрегирующая `ci` ждёт `ffmpeg-server`;
  - `check-vercel-ignore` ok, у ffmpeg-server нет Vercel-проекта;
  - TLS-ключ фикстуры попадает под существующий allowlist `fixtures/` (только правила private-key и generic-api-key), `.gitleaks.toml` не расширялся.
- **CORE e2e (настоящий клиент против настоящего сервера) зелёные:** статусы, `error_code`, `INPUT_EXPIRED`, `OUTPUT_EXPIRED`, повтор ключа, ops-поля, коды. Режимы control сервера совпадают с UI.
- **`check-docs --no-jest`:** только числовые счётчики (миграции, таблицы, маршруты).
- **Тесты, по два прогона каждый, флаков нет:**
  - backend: 457 passed (pg-спека отдельно 10/10);
  - ffmpeg-server: 326/326;
  - admin: `npm test` ok, `next build` ok (`/ffmpeg` 30.7 kB).
- **Compose:** executor с `network_mode: none`, cpus 2, 3g, pids 128, tmpfs. Отговорок «сделает этап C» в коде пакета INT нет.

## Не проверено
- Как hosted разбирает команду (FF-INT-05): нужен платный вызов.
- Реальное поведение Traefik и Dokploy: этап C. FF-INT-01 опирается на документированное поведение docker-провайдера Traefik и проверен на моке.
- `maxDuration` функций Vercel для Story.
- Полный jest backend: по правилам брифа не запускался.
- gitleaks не запускался, бинарника нет; allowlist проверен по регулярным выражениям.

## Перепроверка 21.10.2026 (после исправлений BE/CORE/EXEC)

Миграция `20270126090000` накатана заново на чистую `ffa_int_mig` (147 миграций, 0 ошибок; новые `ffmpeg_submissions`, `ffmpeg_breaker_jobs` — CHECK, RLS, REVOKE, уборка 30 дней в кроне). Пробы повторены: `probe-gateoff.cjs`, новая `probe-routing2.cjs` (настоящий сервис + настоящий PostgreSQL + mock HTTP с `X-FFmpeg-Server`), `att/probe-attention2.ts`, `att/wm2.ts`, `probe-gateoff-db.cjs`, `ci-paths.mjs`. Колонка `recheck_2026-10-21` в CSV.

**Итог по старым:** исправлено 10 из 13 полностью (01, 02, 03, 04, 07, 08, 10, 11, 12; 06 — с новой оговоркой FF-INT-16), частично — 05 (обычный текст байт-в-байт как origin/main, 36/36; тексты с `' % $ \` \ :` по-прежнему с непроверенным на hosted экранированием — остаток S3), 09 (остаток: сервер отсчитывает дедлайн от прихода заголовков, клиент — от начала fetch; запас 2 с покрывает установку соединения лишь при нормальной сети), 13 (DEPLOYMENT.md всё ещё обещает повтор портфолио после infra-провала — см. FF-INT-14).

**Регрессия «без гейта»:** `probe-gateoff.cjs` — **78/78** (было 76/78).

**Новые находки:**
- **FF-INT-14 (S2).** `retryOnFallback` не работает для потребителей с ключом = sha256 тела (портфолио, ручной повтор postprod): повтор после OOM возвращает ту же упавшую `selfhosted:s1` (из `ffmpeg_submissions`; без неё — по Idempotency-Key сервера), hosted 0 даже при открытом breaker. Портфолио исчерпает попытки без нового рендера → FAILED навсегда.
- **FF-INT-15 (S3).** Гейт выключен, но адрес/ключ своего сервера заданы (шаг 1 порядка включения): каждый hosted submit читает/пишет `ffmpeg_submissions`; ошибка чтения БД роняет отправку, которую origin/main выполнял.
- **FF-INT-16 (S3).** Админка: сверка при повторе срабатывает и в фазе `requested` — дубль запроса, пока первый в работе, выполняет действие ещё раз; для limits/routing второй получает ложный 409, в журнале у одной операции и `succeeded`, и `failed`.
- **FF-INT-17 (S3).** Флак `ffmpeg-server/test/core/files.spec.ts` (purge сразу после succeeded → 202 вместо 200, т.к. слот ещё занят): 1 из 7 прогонов.

**Тесты:**
- ffmpeg-server `npx jest --runInBand`: 376/377 (падение — флак FF-INT-17; повтор файла 5/6 зелёных);
- backend затронутые спеки (postprod, ffmpeg-admin, admin-attention, watermark, ffmpeg-corpus, portfolio, cron-jobs, story-video): 616 passed, 12 skipped; pg-спека на PostgreSQL — 12/12;
- admin `npm test` — ok (исходники admin после прошлой сборки не менялись, Playwright 26/26 не перезапускался);
- `ci-changes --self-test` — 177 ok; `check-vercel-ignore` ok; `check-docs --no-jest` — только числовые счётчики.

Итог по классам после перепроверки (открытые): S1 — 0; S2 — 1 (FF-INT-14); S3 — 6 (остатки 05, 09, 13; новые 15, 16, 17).

## Перепроверка 2 (Р-FF-BE-25…28, правки CORE)

- **FF-INT-14 — закрыто.** Повтор после OOM при открытом breaker → hosted (новый рендер); OUTPUT_EXPIRED/OUTPUT_PURGED → прежний jobId; COMMAND_FAILED → попытка `…:r1`; сервер недоступен при проверке → прежний jobId, hosted 0 (`probe-routing2.cjs`, `probe-14b.cjs`).
- **FF-INT-15 — закрыто.** Без гейта: 0 записей в `ffmpeg_submissions`, сбой БД → отправка к hosted как в origin/main (`probe-gateoff-db.cjs`).
- **FF-INT-16 — закрыто.** Дубль в `requested` моложе 20 с → 202 `in_progress` без выполнения; e2e backend зелёные.
- **FF-INT-17 — закрыто.** `files.spec` 8/8, полный ffmpeg-server 381/381.
- **Остатки 09 и 13 — закрыты** (запас 5 с описан; DEPLOYMENT про `:r<n>` и портфолио верен; `check-docs --no-jest` — 0 FAIL). Остаток 05 (спецсимволы водяного знака на hosted не проверены) — S3, открыт.
- Регрессия без гейта: **78/78**. Остальные пробы `probe-routing2.cjs` — OK (кроме сценария 01c, это артефакт моей пробы: by-key там отвечает сам сервер, fallback правомерен).
- Тесты: backend затронутые спеки 628 passed / 12 skipped, pg-спека 12/12, admin `npm test` ok, миграции 147/0 ошибок.

**Итог (открытые): S0 — 0, S1 — 0, S2 — 0, S3 — 1 (FF-INT-05, остаток).**
