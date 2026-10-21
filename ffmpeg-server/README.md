# ffmpeg-server

Собственный FFmpeg API для Viral4Creators, совместимый с используемым
платформой протоколом Very Good FFmpeg. ТЗ:
[`docs-tz/FFmpeg-server-spec-v1.1-RU.md`](../docs-tz/FFmpeg-server-spec-v1.1-RU.md).
Эксплуатация (backup/restore, recovery, pause/drain/rollback, ключи, квота
диска, canary этапа C): [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
Совместимость команд: [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

Деплой — Dokploy на VPS (этап C), **не Vercel**. Production по умолчанию
остаётся `hosted`; включение маршрутизации — отдельный проход.

## Устройство

```
backend ──HTTPS──▶ Traefik ──▶ api (Node 24, node:http, node:sqlite)
                                 │  приём, идемпотентность, очередь (1 слот),
                                 │  downloader (HTTPS, allowlist, SSRF-защита),
                                 │  проверка outputs, приватная выдача, очистка
                                 │
                       volume workspace (файловый протокол src/contracts.ts)
                                 │
                               executor (network_mode none, read_only,
                                 cap_drop ALL, uid 10001, 2 CPU / 3 GiB / 128 PIDs)
                                 ffmpeg/ffprobe через spawn(argv), kill(-pgid)
```

- Без runtime-зависимостей: HTTP — `node:http`, БД — `node:sqlite` (WAL,
  `busy_timeout`, миграции по `PRAGMA user_version`), крипто — `node:crypto`.
- Один pipeline за раз; очередь до 20 задач на сервер и 10 на клиента,
  round-robin между клиентами, FIFO внутри клиента. Очередь не скачивает
  входы заранее.
- Payload (URL входов и команды) хранится только зашифрованным
  (AES-256-GCM, `key_id`, AAD = id задачи) и стирается у терминальных
  задач; после скачивания URL из него удаляются. Fingerprint — HMAC-SHA-256
  канонического тела. Idempotency key и токены ссылок — sha256.
- Код: `src/api` (маршруты), `src/queue` (приём, диспетчер, порты EXEC),
  `src/db` (схема), `src/control` (режим, лимиты, readiness),
  `src/files` (публикация и выдача), `src/cleanup`, `src/crypto`,
  `src/metrics`, `src/ops` (ops-API, backup/CLI). Пакет EXEC:
  `src/command`, `src/download`, `src/probe`, `src/executor`.

## API v1

Все ответы — конверт `{"data":{…}}`; ошибки — `{"error":{"code","message"}}`.
Авторизация — `Authorization: Bearer <ключ>`; задача принадлежит `client_id`
(ротация ключа клиента не теряет доступ). Роль `ops` видит задачи всех
клиентов.

| Метод и путь | Доступ | Ответы |
|---|---|---|
| `POST /api/ffmpeg` | клиент | 202 `{id,status:"queued",error_message:""}`; 400, 401, 403 `FORBIDDEN_SOURCE`, 409 `IDEMPOTENCY_CONFLICT`, 413, 422 `UNSUPPORTED_COMMAND`, 429 + `Retry-After`, 503 + `Retry-After` |
| `GET /api/jobs/:id` | клиент | 200 `{id,status,stage,progress,error_code,error_message,output_files,execution_status,…}`; 404 (чужая = неизвестная) |
| `GET /api/jobs/by-key/:key` | клиент | 200 / 404 — сверка потерянного ответа, без создания задачи. 404 — только «записи нет в доверенной БД»; в `recovery` или при недоступной БД — 503 `RECOVERY`/`UNAVAILABLE` + `Retry-After` (то же для `GET /api/jobs/:id`, cancel, purge, карточки ops) |
| `POST /api/jobs/:id/cancel` | клиент | 200; CAS: готовая задача не становится `canceled` |
| `DELETE /api/jobs/:id/artifacts` | клиент | 202 (останавливается) / 200 (удалено); ссылки отзываются сразу |
| `GET /api/capabilities` | клиент | версия, кодеки, фильтры, профиль лимитов |
| `GET\|HEAD /api/files/:jobId/:name?token=` | bearer-ссылка | 200/206 (Range), 401, 404, 410 (истекла/отозвана/удалено), 416 |
| `GET /api/health` | — | 200 liveness |
| `GET /api/ready` | — | 200 / 503: SQLite, миграции, heartbeat executor, capability self-test, диск |
| `POST /api/control/pause\|drain\|resume` | ops | 200; 409 stale revision / недопустимый переход / нет сверки |
| `GET /metrics` | ops | Prometheus text |
| `/api/ops/*` | ops | `overview`, `jobs`, `jobs/:id`, `limits` (GET/POST), `jobs/:id/download-link`, `jobs/:id/cancel`, `jobs/:id/purge` |

Заголовки POST: `Idempotency-Key` (обязателен, 1–128 печатных ASCII),
`X-Client-Operation-Id` (необязателен, ≤128 ASCII; хранится в задаче и не
влияет на fingerprint). Мутации ops принимают `X-Actor-Id` для журнала;
`X-Correlation-Id` (≤128 `[A-Za-z0-9._:-]`) пишется в access log.
Контракт ops сверен с настоящим `backend/src/modules/ffmpeg-admin/ffmpeg-ops.client.ts`
(`test/core/ops-client.spec.ts`).

Порядок проверок POST (ТЗ §5.2): авторизация → размер тела → поиск ключа →
сравнение fingerprint → прежняя задача (даже при полной очереди, drain,
неготовности и истёкших входах); только для новой задачи — синтаксис (400),
команды (422), источники (403), режим/readiness/диск (503), квоты (429).
Приём — одна транзакция `BEGIN IMMEDIATE`: 50 параллельных POST с одним
ключом дают одну задачу.

Публичные статусы: `queued`, `processing` (`stage`: `downloading`,
`probing`, `running`, `validating`, `publishing`), `succeeded`, `failed`,
`canceled`. После TTL файлов (24 ч от завершения) или purge: HTTP 200,
`status: failed`, `error_code: OUTPUT_EXPIRED | OUTPUT_PURGED`, пустой
`output_files`, `execution_status: succeeded`; сама ссылка отвечает 410.

Коды ошибок задачи: `INVALID_REQUEST`, `UNSUPPORTED_COMMAND`,
`FORBIDDEN_SOURCE`, `INPUT_DOWNLOAD_FAILED`, `INPUT_EXPIRED`,
`INPUT_TOO_LARGE`, `INPUT_INVALID_MEDIA`, `INPUT_LIMIT_EXCEEDED`,
`COMMAND_FAILED`, `OUTPUT_MISSING`, `OUTPUT_TOO_LARGE`,
`OUTPUT_INVALID_MEDIA`, `TIMEOUT`, `QUEUE_TIMEOUT`, `OOM`, `CANCELED`,
`INTERRUPTED`, `OUTPUT_EXPIRED`, `OUTPUT_PURGED`, `INTERNAL`.

### Форма ответов для backend

Каждый ответ самого сервера (включая 401/404/410/413/503) несёт заголовок
`X-FFmpeg-Server: 1` — 404/502 без него пришли от прокси (Traefik) и не
означают «записи нет».

Отказы POST, которые **не** являются доказанным отказом до приёма:
503 `RECOVERY` (БД восстановлена/потеряна — исход повтора не доказуем),
503 `SUBMIT_DEADLINE` (с момента получения прошло больше
`FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS`, по умолчанию 10 с; задача не
создана — после клиентского тайм-аута больше дедлайна by-key 404
доказательный). `NOT_ACCEPTING` (drain), `NOT_READY`, `QUEUE_FULL`,
`CLIENT_QUOTA_EXCEEDED` — задача не создана.

`GET /api/ready` (и `ready` в overview) — точная форма:

```json
{"data":{"ready":false,
  "checks":{"sqlite":true,"migrations":true,"executor":false,"capabilities":true,"disk":true},
  "reasons":["executor_heartbeat_stale"],
  "mode":"active"}}
```

`reasons`: `sqlite_unavailable`, `migrations_pending`,
`executor_no_heartbeat`, `executor_heartbeat_stale`,
`executor_status_error`, `capabilities_not_checked`,
`capabilities_failed`, `capabilities_missing`, `capabilities_error`,
`disk_low`, `disk_unknown`. В `GET /api/ops/overview` то же лежит в
`data.ready = {ready, checks, reasons, checked_at}` (без `mode`, режим —
`data.control.mode`); ошибки за 24 ч — `data.queue.errors_24h`
(`{"OOM":2,"TIMEOUT":1,…}` по `error_code`), `data.queue.oom_24h`,
`data.queue.failed_24h`; CPU/RAM executor — `data.executor.resources`.

## Конфигурация

Все переменные — [`.env.example`](.env.example). Плохая конфигурация —
отказ старта (код 78) с причиной, без значений секретов. Верхние границы
лимитов — `FFMPEG_SERVER_LIMIT_*` (по умолчанию ТЗ §9); ops меняет
эффективный профиль только ниже них, с ревизией и историей.

Отдельно: `FFMPEG_SERVER_HOST` (адрес прослушивания, `0.0.0.0`),
`FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS` (дедлайн фиксации POST, 10000),
`FFMPEG_SERVER_DOWNLOAD_CA_FILE` (PEM доп. CA для HTTPS-источников —
только тесты/стенд), `FFMPEG_SERVER_ALLOW_HTTP_PUBLIC_URL=1` (разрешить
`http://` в `FFMPEG_SERVER_PUBLIC_BASE_URL` — только локальный стенд).

## Разработка

```bash
npm ci
npx tsc -p tsconfig.eslint.json --noEmit
npx eslint "src/**/*.ts" "test/**/*.ts" --max-warnings 0
npx jest --runInBand          # нужен ffmpeg/ffprobe в PATH (сквозные тесты)
npm run build
```

Или из корня монорепо: `make ci-ffmpeg-server`.

Сквозные тесты (`test/core/e2e.spec.ts`): локальный HTTPS-источник с
самоподписанным CA → настоящий downloader → executor отдельным процессом
(собирается `tsc` во временный каталог) с настоящим ffmpeg → `GET` →
скачивание файла; второй тест гоняет **настоящий** backend-клиент
`backend/src/modules/postprod/ffmpeg-api.service.ts` (файл транспилируется
как есть, подменяются только `@nestjs/common` и PrismaService — см.
`test/core/backend-client.ts`). Тем же способом `test/core/ops-client.spec.ts`
гоняет настоящий ops-клиент вкладки «FFmpeg».

## Лицензии

FFmpeg из Debian bookworm собран с GPL-компонентами (libx264 и др.),
шрифты — DejaVu (Bitstream Vera/DejaVu license) и Noto (SIL OFL 1.1).
Тексты лицензий лежат в образе executor: `/usr/share/doc/ffmpeg*/copyright`,
`/usr/share/doc/libx264-*/copyright`, `/usr/share/doc/fonts-*/copyright`.
Сервис используется внутри платформы и не распространяется третьим лицам;
обязательства при распространении образа — проверить отдельно (ТЗ §14).
