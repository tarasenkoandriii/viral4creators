# Отчёт пакета CORE (ffmpeg-server)

## Решения
- Р-FF-CORE-1. Порты EXEC — `src/queue/ports.ts` (структурно = ExecutorClient/parseJob/checkSourceUrl/downloadInput/checkInputLimits/verifyOutputs); реальные — `src/queue/adapters.ts`, фейки — `test/core/helpers.ts`.
- Р-FF-CORE-2. Детект потери/отката БД: файл-маркер `control-state.json` рядом с БД (instance_id, ревизия режима, max seq задач). БД новая/чужая/старее маркера → режим `recovery`; выход — только `resume {reconciled:true}` при ready.
- Р-FF-CORE-3. Отмена — CAS по статусу: активная задача сразу `canceled`, публикация делает CAS `WHERE status='processing'`; слот и workspace освобождаются только после done/abandoned executor. Purge активной → 202, завершённой → 200.
- Р-FF-CORE-4. После TTL/purge: `status=failed`, `error_code=OUTPUT_EXPIRED|OUTPUT_PURGED`, `execution_status=succeeded`, ссылки → 410; ключ идемпотентности живёт ≥ истории (90 дней) и удаляется вместе с задачей.
- Р-FF-CORE-5. Повторная попытка — только по доказательству (poll `abandoned`, или `unknown` при истёкшем lease прежнего API); входы прежней попытки переносятся без скачивания; ≤2 попыток; oom/too_large/COMMAND_FAILED не повторяются. Recover идёт в фоне, выдача новых задач — после него.
- Р-FF-CORE-6. Сквозной тест backend-клиента: файл `backend/src/modules/postprod/ffmpeg-api.service.ts` транспилируется как есть (`ts.transpileModule`), подменяются только `@nestjs/common` и PrismaService. Не нужен backend/node_modules в джобе; правило ci-changes добавляет этот файл в триггеры ffmpeg_server.
- Р-FF-CORE-7. Ready: heartbeat executor + `capabilities.ok` (self-test EXEC по allowlist корпуса + смоук). Доп. фильтры/энкодеры — опционально через env (по умолчанию пусто).
- Р-FF-CORE-8. Backup — в процессе API: SQLite online backup API каждые 15 мин в /backup, integrity_check, journal DELETE, retention 7 дней; CLI `dist/ops/cli.js backup|verify|restore` (restore ставит recovery).
- Р-FF-CORE-9. Dockerfile: дайджест базы и версия Debian-пакета ffmpeg — обязательные build-args (сети до registry в песочнице нет, значения не выдуманы; заполняются на этапе C).
- Р-FF-CORE-10. Коды HTTP-отказов вне ErrorCode: IDEMPOTENCY_CONFLICT (409), QUEUE_FULL/CLIENT_QUOTA_EXCEEDED (429), NOT_ACCEPTING/NOT_READY (503), PAYLOAD_TOO_LARGE (413).
- Р-FF-CORE-11. 404 — только «записи нет в доверенной БД». В recovery → 503 `RECOVERY` (Retry-After 60), при недоступной БД → 503 `UNAVAILABLE`: by-key, GET job, cancel/purge, карточка ops.
- Р-FF-CORE-12. CPU/RAM executor в overview — из state.json активной попытки (cpuMs/rssKb/peakRssKb/sampledAt от EXEC), cpu_percent — по двум замерам.
- Р-FF-CORE-13. Права workspace: umask 007 у API и executor, setgid 2770 на корне, init: true у executor, FONTCONFIG_FILE из образа (docker/fonts.conf, алиас Arial → DejaVu Sans).
- Р-FF-CORE-14. Контракт ops сверен тестом с настоящим ffmpeg-ops.client.ts; Idempotency-Key на мутациях ops сервер не хранит (мутации идемпотентны по состоянию/CAS), X-Correlation-Id — в access log.
- Р-FF-CORE-15 (FF-INT-03). В recovery POST нового ключа → 503 `RECOVERY` (не NOT_ACCEPTING).
- Р-FF-CORE-16 (FF-INT-09). Дедлайн фиксации `FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS` (10000) от получения запроса; проверка в транзакции перед INSERT → 503 `SUBMIT_DEADLINE`, ничего не создано.
- Р-FF-CORE-17 (FF-INT-01). Все ответы сервера — заголовок `X-FFmpeg-Server: 1`.
- Р-FF-CORE-18 (FF-INT-04). overview.queue.errors_24h {code: n}, oom_24h; форма ready описана в README.
