# Аудит SEC2 — второй проход безопасности `ffmpeg-server/` (21.10.2026)

Код не правился. Все пробы — против реального кода: собранный `dist`, живой API (`createApp`), executor-процесс (`dist/executor/main.js`), настоящий ffmpeg 6.1.1, локальный HTTPS-источник. Пробы — `/tmp/ffa-SEC2/` (`p1`…`p10`, `stack.sh`, `launch.js`, `origin.js`). В API подменены только тестовый resolver, политика адресов и CA — для локального источника; вся остальная логика настоящая.

## Итог
- Находок: **S0: 0, S1: 0, S2: 0, S3: 1** (`FF-SEC2-01`). Детали — `SEC2-findings.csv`.
- FF-SEC-01…03 перепроверены — исправлены.
- Все остальные непроверенные области первого прохода проверены пробами и корректны.

## Перепроверка FF-SEC-01…03 и обходы allowlist
`p1-parse.js`/`p2-exec.js` повторены. `/`-ключ файловой опции теперь отвергается (`parseFilterOptions`+проверка в `processGraph:361`): `drawtext=/text=`, `metadata=…:/file=`, `subtitles=…:/force_style=`, через `-filter_complex` — все 422. `scale=100000:…`, `color=s=30000x30000`, `pad=iw*10:ih*10` — отказ (FF-SEC-02). `-stream_loop -1`, `-loop 1 -t 999999` — отказ (FF-SEC-03).

Новые обходы (`p3-cats.js`) — все отвергнуты: `-filter_complex_script`, `-/vf`, `-/filter_complex`; выражения с `st`/`ld`/`random` (не из `EXPR_IDENTIFIERS`); экранированный и закавыченный `/text` (`\/text`, `'/text'`); неизвестные ключи (`fontsdir`, `enable`), дубли ключей, bad instance `scale@a/b`, `drawtext` с `%` без `expansion=none`, лишние позиционные у `subtitles`.

## SSRF вживую (`p4-ssrf.js`, настоящий `downloadInput`)
- **DNS rebinding:** resolver вызывается один раз; соединение идёт через `pinnedLookup` на уже проверенный адрес — TOCTOU-окна нет.
- **Смесь A-записей** (публичная + частная, IPv4 и IPv6): отказ `FORBIDDEN_SOURCE` — проверяются **все** адреса.
- **Литералы** через настоящую политику: `2130706433`, `0177.0.0.1`, `0.0.0.0`, `127.1`, `::1`, `[::ffff:7f00:1]`, `[::ffff:127.0.0.1]`, `[fd00:ec2::254]`, `169.254.169.254`, `[::]`, NAT64 `[64:ff9b::7f00:1]`, 6to4 `[2002:7f00:1::]` — все отвергнуты; публичные `8.8.8.8`, `2606:4700::1111` — public.
- **Redirect:** на `http://` → отказ (только https); на частный IP → `input host address is not public`; на хост, резолвящийся в частный → отказ; цикл → `too many redirects` (лимит 3).
- **gzip-бомба:** `accept-encoding: identity`, тело не распаковывается, на диск кладётся сжатый размер, лимит на байты провода → распаковочной бомбы через Content-Encoding нет.
- **slowloris/drip:** stall-timeout срабатывает (3003 мс при пороге 1000).
- **Без ответа заголовков:** `no response` по stall-таймеру.
- **Поток без Content-Length сверх лимита** (chunked): `INPUT_TOO_LARGE`, `.part` удалён.
- Враньё Content-Length, непроверенный CA — отвергнуто.

## Executor (`p5-exec.js`, настоящий Executor+ffmpeg, `ps`/`pgrep` под нагрузкой)
- **cancel** и **timeout:** `outcome` canceled/timeout, после — `pgrep ffmpeg` пусто (killGroup по pgid подтверждён).
- **Лимит записи:** `maxWriteBytes=2 MiB` → `too_large`, процесс убит.
- **Отказ второй команды:** первый результат (`a.mp4`) в `outputs` есть, но задача `failed`, `failedStep=1` — на уровне публикации первый результат **не публикуется** (CAS в `validateAndPublish`).

## API и идемпотентность (`p6-api.js`, живой сервер)
- **50 параллельных POST** одним ключом → один job, 49 с `Idempotent-Replayed: true`.
- **Разный порядок ключей JSON** и `\uXXXX`/пробельные варианты → тот же job (канонизация тела HMAC-fingerprint).
- **Отличное тело тем же ключом** → **409 IDEMPOTENCY_CONFLICT**.
- **Тот же ключ от другого клиента** → новый job (ключ скоупится по client_id).
- **Чужой job**: GET/cancel → 404; **by-key** своего → 200, чужого своего клиента → 200, отсутствующего → 404.
- Отсутствие ключа → 400; тело >512 KiB → 413; `X-FFmpeg-Server: 1` на всех ответах, включая 401/404.
- **SUBMIT_DEADLINE** и путь приёма проверены по коду (`service.ts:251`).

## Файлы (`p7-files.js`)
Токен — sha256 в БД, TTL 1800 с (не продлевается), повторный status выдаёт новый токен, старый жив до TTL. Range: `0-99`, `-50`, `10-` → 206 с корректным Content-Range; некорректные (`100-10`, `abc`, `-0`, `222251-`, мульти `0-0,5-9`) → 416. HEAD → заголовки без тела. Path traversal (`..%2f`, `%2e%2e`, лишний сегмент) → 404/401; жёсткие заголовки (nosniff, CSP sandbox, no-store, Content-Disposition attachment, ETag). Отзыв через purge → 410. Нет токена → 401, подделка токена/чужой файл/чужой job → 404.

## Логи и крипто
Access-log и логи executor: ни query, ни ключей, ни команд, ни URL (`grep SECRETSIG` = 0; `safeLogPath` маскирует by-key и имя файла; `sanitizeValue` режет опасные ключи и URL). **payload в SQLite зашифрован** (заглянул в `.db`+WAL): поле `payload_enc` = `v1.<base64>` AES-256-GCM с AAD `keyId\n…`; `SECRETSIG`, `://a.test`, `ffmpeg -i`, `drawtext`, `{{v}}` в БД как plaintext **отсутствуют** (видны только зашифрованный блок, sha256 входов, output-метаданные). HMAC-fingerprint канонического тела хранится с `fingerprint_key_id`. **Ротация ключей:** per-row `payload_key_id`/`fingerprint_key_id` → старые записи открываются своим ключом (до двух активных, `parseKeyRing`). `stderr_tail` очищен (0 строк с `://`).

## Recovery (`p8`,`p10`, живой kill/рестарт)
- **Kill API на running:** ffmpeg остаётся у executor, после рестарта `recovery.job executor:"running"` — привязка к живой попытке, **второго executor не запускается** (`pgrep` = 1), задача продолжается.
- **Kill на downloading:** `recovery` видит `executor:"unknown"` → `retry_scheduled after=api_restart` (загрузка шла в мёртвом API).
- **Потеря БД:** свежая БД → `control.recovery reason=db_recreated`; by-key → **503 RECOVERY** (не 404), submit → 503; `/api/ready` в mode `recovery`.
- **orphan executor** (`cancelOrphans`) и orphan-workspace (`cleanupAfter`) — по коду корректны. **Атомарность публикации:** tmp→fsync→rename→CAS-UPDATE; при проигрыше CAS (cancel/purge) готовый `finalDir` удаляется, `publish.discarded`.

## Лимиты §9 (`p9-limits.js`, по одному тесту)
inputs>20, commands>10, outputs>10 → 400; duration>600 → `INPUT_LIMIT_EXCEEDED`; разрешение 2560x1440 и SAR-растяжение (1920x1080 sar=2 → 3840) → отказ; png 8000x8000 (64 MP) → `frame is larger than 24000000 pixels`; лимит записи/`too_large` — см. executor. **Разрешение с поворотом — см. `FF-SEC2-01`.**

## Лицензии (`docs/COMPATIBILITY.md`)
По существу корректно: GPL v2+ распространяется на весь бинарник из-за libx264; `libfdk_aac` (nonfree) исключён, используется встроенный LGPL-aac; AGPL-компонентов нет; DejaVu/Liberation (OFL) — можно в образ, Arial (EULA) — нельзя; обязательства при передаче образа (тексты лицензий, исходники/offer, `/usr/share/doc/*/copyright`) перечислены верно. Dockerfile сохраняет copyright, USER non-root. Stage-C лимиты заданы в compose/Dockerfile (network_mode none, read_only, cap_drop ALL, no-new-privileges, mem/memswap/cpus/pids_limit, init, tmpfs) — отговорки «это сделает этап C» в коде, где ТЗ требует код, не встретил.

## Замечание (не находка)
`parseRange` на неизвестную единицу (`items=0-9`) возвращает 416 вместо игнорирования заголовка и 200 (RFC 7233). Fail-safe, не уязвимость; минимальный interop-нюанс.
