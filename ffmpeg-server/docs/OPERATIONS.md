# ffmpeg-server — эксплуатация

Операторская инструкция к ТЗ `docs-tz/FFmpeg-server-spec-v1.1-RU.md`
(§8, §9, §12, §13). Всё, кроме восстановления из backup, делается через
ops-API без SSH-правки БД. Примеры ниже используют:

```bash
API=https://ffmpeg.viral4creators.app
OPS="Authorization: Bearer $FFMPEG_OPS_KEY"   # ключ роли ops, из secret store
```

## 1. Сборка и фиксация версий

Образ воспроизводим: базовый образ — по дайджесту, ffmpeg — точной версией
пакета. Без обоих значений `docker compose build` падает.

```bash
# дайджест multi-arch индекса node:24-bookworm-slim
docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
# точная версия ffmpeg в bookworm (+security) для этого дайджеста
docker run --rm node:24-bookworm-slim@sha256:<…> \
  sh -c 'apt-get update -qq && apt-cache policy ffmpeg | sed -n 2,3p'
```

Записать в `.env` площадки `FFMPEG_SERVER_NODE_DIGEST=sha256:…` и
`FFMPEG_SERVER_FFMPEG_DEB=7:5.1.…`, после сборки —
`FFMPEG_SERVER_IMAGE_DIGEST` (дайджест образа executor, уходит в
`image_digest` задач). Сборка executor сама выполняет capability smoke:
энкодеры libx264/aac/mjpeg/png/libmp3lame, фильтры корпуса, шрифты с
украинским и рендер libx264 + aac + libass с кириллицей. При старте
executor повторяет полный self-test по allowlist корпуса; итог виден в
`GET /api/ready` и `GET /api/ops/overview` (`capabilities.missing`).

Обновление ffmpeg/базы — только новой парой значений и новой сборкой,
с прогоном корпуса (`npx jest test/executor`) на новом образе.

## 2. Volume'ы и права

| Volume | Контейнер | Содержимое | В backup |
|---|---|---|---|
| `ffmpeg-data:/data` | api | `ffmpeg-server.db` (+wal/shm), `control-state.json` | только через online backup |
| `ffmpeg-backup:/backup` | api | копии SQLite (15 мин, 7 дней) | копировать off-host |
| `ffmpeg-outputs:/outputs` | api | опубликованные результаты (≤24 ч) | нет |
| `ffmpeg-workspace:/workspace` | api + executor | попытки `<job>/<attempt>/{inputs,work,outputs,control}`, `.executor/` | нет |
| `ffmpeg-fonts` (ro) | executor | доп. шрифты | нет |

API работает как uid 1000, executor — uid 10001; общая группа `ffwork`
(gid 10000). Корень workspace на хосте: `chown 1000:10000`, `chmod 2770`
(setgid: новые каталоги наследуют группу). Оба процесса ставят
`umask 007`, поэтому каталоги попытки и файлы ffmpeg — group-rw: API
читает/переносит outputs и удаляет workspace, executor пишет
work/outputs/state. PID 1 executor — init Docker (`init: true`): процессы
ffmpeg после `kill(-pgid)` не остаются зомби. fontconfig —
`FONTCONFIG_FILE=/etc/fonts/ffmpeg-server.conf` из образа (read-only
rootfs; `docker/fonts.conf`): системные DejaVu/Noto, доп. шрифты с
ro-volume `/usr/local/share/fonts/extra`, алиас Arial/Helvetica → DejaVu
Sans, кеш — в tmpfs.
Наружу не публикуется ничего, кроме api через Traefik.

`control-state.json` рядом с БД — маркер режима и «сколько задач видела
БД». Его **не удалять и не копировать вместе с backup**: по нему сервер
понимает, что БД потеряна или откатилась (§5).

### Переменные, которые легко пропустить

| Переменная | Умолчание | Зачем |
|---|---|---|
| `FFMPEG_SERVER_HOST` | `0.0.0.0` | адрес прослушивания внутри контейнера |
| `FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS` | `10000` | позже этого срока от получения POST задача не фиксируется (503 `SUBMIT_DEADLINE`); тайм-аут submit backend должен быть больше — тогда by-key 404 после тайм-аута доказывает «не принято» |
| `FFMPEG_SERVER_DOWNLOAD_CA_FILE` | — | PEM доп. CA для HTTPS-источников; только тесты/стенд, в проде не задавать |
| `FFMPEG_SERVER_ALLOW_HTTP_PUBLIC_URL` | — | `1` разрешает `http://` в публичном адресе; только локальный стенд |

Все ответы сервера несут `X-FFmpeg-Server: 1`; 404/502 без заголовка —
от Traefik (например, роутер снят на время рестарта), а не «записи нет».

## 3. Backup SQLite

API сам снимает консистентную копию через SQLite online backup API
каждые 15 минут (`FFMPEG_SERVER_BACKUP_INTERVAL_SEC=900`) в `/backup`,
проверяет её `PRAGMA integrity_check` и хранит 7 дней
(`FFMPEG_SERVER_BACKUP_RETENTION_DAYS=7`). Копирование `.db` в WAL-режиме
backup'ом **не является**.

- Метрики: `ffmpeg_backup_total{result="ok|error"}`,
  `ffmpeg_backup_age_seconds` (алерт > 1800).
- Off-host: площадка копирует `/backup` (rsync/restic) не реже раза в
  15 минут. Медиа в backup не входят.
- Ключи шифрования/HMAC в backup **не входят**: они в secret store,
  восстанавливаются отдельно, доступ ограничен.
- Разовая копия вручную:
  `docker compose exec api node dist/ops/cli.js backup /backup`.
- Проверка копии:
  `docker compose exec api node dist/ops/cli.js verify /backup/ffmpeg-server-<ts>.db`
  (integrity, версия схемы, число задач и ключей идемпотентности).

Цели: RPO ≤ 15 минут, RTO ≤ 2 часа (проектные; подтверждаются drill §4).

## 4. Restore drill

Проводится на canary до production и далее раз в квартал. Фиксировать
время начала/конца (RTO) и возраст копии (RPO).

1. `POST $API/api/control/drain` — новые задачи не принимаются.
2. Дождаться `active: null` в `GET $API/api/ops/overview` (или отменить
   активную `POST /api/ops/jobs/<id>/cancel`).
3. `docker compose stop api` (executor можно не трогать: он доработает
   попытку, сервер подхватит её при старте).
4. Выбрать копию, проверить: `node dist/ops/cli.js verify <файл>`.
5. Восстановить (api остановлен):
   `docker compose run --rm api node dist/ops/cli.js restore /backup/<файл>`.
   Команда подменяет БД атомарно, удаляет старые `-wal/-shm` и ставит
   режим `recovery`.
6. `docker compose up -d api`. Режим — `recovery`: приём и выдача задач
   заблокированы, чтение/status/cancel/purge работают.
7. Сверка (ТЗ §13): задачи, принятые после момента копии, в БД
   отсутствуют. По продуктовой БД backend найти операции с provider
   `selfhosted`, созданные после времени копии, и для каждой —
   `GET /api/jobs/by-key/<ключ>`: 404 означает «ответ потерян вместе с
   БД»; такие операции помечаются UNKNOWN и разбираются вручную, их
   **нельзя** автоматически отправлять повторно или к hosted.
   Активные попытки executor сверяются автоматически (`recovery.found` в
   карточке задачи).
8. После сверки: `POST $API/api/control/resume` с телом
   `{"reconciled": true, "reason": "restore drill <дата>: сверено N операций"}`.

Гарантии exactly-once при потере БД нет — только обнаружение и ручная
сверка.

## 5. Режим recovery

Сервер сам переходит в `recovery` при старте, если:

| `reason` | Что значит |
|---|---|
| `db_recreated` | файла БД нет (создан пустой), а маркер есть — БД потеряна |
| `db_replaced` | instance id БД ≠ маркеру — подложен чужой файл |
| `db_behind_jobs` / `db_behind_control` | БД старее маркера — восстановлена из копии |
| `restored_from_backup` | выполнена команда `restore` |

В `recovery`: `POST /api/ffmpeg` нового ключа → 503 `RECOVERY` (не
`NOT_ACCEPTING`: это не доказанный отказ, backend не уводит к hosted), диспетчер не
берёт задачи; отсутствие записи (`GET /api/jobs/by-key/…`,
`GET /api/jobs/:id`, карточка ops) → 503 `RECOVERY`, а не 404: потерянная
БД ничего не доказывает, backend не должен считать операцию «не принятой»
и отправлять её к hosted; `pause`/`drain` → 409; `resume` без `reconciled: true` →
409 `NOT_RECONCILED`; resume также требует `ready`. Режим переживает
рестарт.

## 6. Ключи: генерация и ротация

Никогда не печатать ключи в лог/чат; в env попадают только хеши ключей
клиентов.

```bash
# ключ клиента (backend) или ops: ≥32 случайных байт
KEY=$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48)
printf %s "$KEY" | sha256sum | cut -d' ' -f1      # → keySha256 в FFMPEG_SERVER_CLIENTS
# ключ payload / HMAC: ровно 32 байта base64
openssl rand -base64 32
```

`FFMPEG_SERVER_CLIENTS`:
`[{"clientId":"backend","role":"client","keySha256":["<hex>"]},{"clientId":"backend-ops","role":"ops","keySha256":["<hex>"]}]`.

- **Ротация ключа клиента** (без простоя): добавить второй хеш в
  `keySha256` → деплой → переключить backend на новый ключ → убедиться по
  логам `http` (`client_id`), что старый не используется → убрать старый
  хеш → деплой. Задачи принадлежат `clientId` и остаются доступны.
- **Ротация ключа payload**: добавить новый `{id: key}` в
  `FFMPEG_SERVER_PAYLOAD_KEYS`, сменить `..._ACTIVE`. Старый ключ держать,
  пока есть нетерминальные задачи с его `payload_key_id` (payload
  терминальных задач стирается).
- **Ротация ключа HMAC**: добавить новый, сменить `..._ACTIVE`. Старый
  держать **90 дней** (срок ключей идемпотентности): повтор старого
  ключа сверяется тем HMAC-ключом, которым снят fingerprint. Удалённый
  раньше времени ключ даёт 503 на повторе (лог `idempotency.hmac_key_missing`).
- Ключи payload/HMAC хранить отдельно от backup БД (§3).

## 7. Квота диска (loop xfs)

Пороги в коде: свободно < 15 GiB — новые задачи не принимаются (503,
`ready=false`, `disk_low`); workspaces ≤ 15 GiB и outputs ≤ 10 GiB —
диспетчер не берёт задачу, пока резерв `maxWorkspaceBytes` (4 GiB) не
помещается (`ffmpeg_dispatch_blocked_total`); запись ffmpeg ограничена
`maxWriteBytes` executor. Жёсткая граница — отдельная ФС фиксированного
размера под workspace, чтобы заполнение не задело relay и Dokploy:

```bash
# Общее ограниченное хранилище: workspace + опубликованные результаты.
# До создания проверить: после резервирования остаётся >15 GiB на /.
sudo fallocate -l 30G /srv/ffmpeg-quota.img
sudo mkfs.xfs -m reflink=0 /srv/ffmpeg-quota.img
sudo mkdir -p /srv/ffmpeg-quota
# Сначала пробный mount; fstab добавлять после успешной приёмки.
sudo mount -o loop,noatime,nodev,nosuid,noexec /srv/ffmpeg-quota.img /srv/ffmpeg-quota
sudo mkdir -p /srv/ffmpeg-quota/{workspace,outputs}
sudo chown 1000:10000 /srv/ffmpeg-quota/{workspace,outputs}
sudo chmod 2770 /srv/ffmpeg-quota/workspace
sudo chmod 0750 /srv/ffmpeg-quota/outputs
```

Задать обе переменные: `FFMPEG_SERVER_WORKSPACE_HOST_DIR` и
`FFMPEG_SERVER_OUTPUTS_HOST_DIR`. Результаты на общем неограниченном Docker
volume не допускаются. При общем томе 30 GiB порог minFree=15 GiB
консервативно останавливает приём раньше суммарных квот 15+10 GiB;
не снижать порог ради заполнения тома. Том data остаётся на корневой ФС,
поэтому `DiskMonitor` проверяет свободное место также на хостовом диске.
Перед каждым стартом проверить `mountpoint -q /srv/ffmpeg-quota`:
при отсутствующем mount нельзя писать в одноимённый каталог корневой ФС.

Проверка этапа C: заполнение ограниченного тома до ENOSPC не меняет
свободное место `/` (loop-файл заранее выделен), relay остаётся здоров.
I/O-лимиты (`blkio_config`) проверить в cgroup v2 `io.max`, включая
фактическое устройство loop и лежащий под ним диск. Наличие полей
в compose само по себе не подтверждает ограничение.

## 8. Pause / drain / cancel / purge / rollback

```bash
curl -sS -X POST -H "$OPS" -H 'Content-Type: application/json' \
  -d '{"reason":"…","expected_revision":12}' $API/api/control/pause   # worker не берёт новые; приём есть
curl … $API/api/control/drain    # приёма нет; активная доработает
curl … $API/api/control/resume   # только при ready=true
curl -sS -X POST -H "$OPS" $API/api/ops/jobs/<id>/cancel
curl -sS -X POST -H "$OPS" $API/api/ops/jobs/<id>/purge       # 202 — останавливается, 200 — удалено
curl -sS -H "$OPS" "$API/api/ops/jobs?state=failed&period=24h"
curl -sS -H "$OPS" $API/api/ops/jobs/<id>                     # timeline, attempts, stderr ≤64 KiB
```

Режим хранится на диске (SQLite + маркер) и переживает рестарт.
`expected_revision` — защита от устаревшего экрана (409).

**Rollback.**
- *Маршрутизации* (основной путь): в админке/`ffmpeg_routing` вернуть
  `defaultProvider=hosted` или выключить `FFMPEG_SELFHOSTED_ENABLED` на
  backend. Касается только новых задач; уже принятые selfhosted
  дорабатывает этот сервер — **не выключать его**, пока
  `GET /api/ops/overview` показывает очередь/активную задачу.
- *Образа*: `drain` → дождаться пустой очереди → предыдущий тег образа →
  `up -d` → `resume`. Схема БД, новее кода, приводит к отказу старта
  («схема БД новее кода»): откат образа через миграцию не делать —
  восстановить копию §4 или вернуть новый образ.
- Hosted-ключ и адрес не удалять до завершения старых hosted-задач.

## 9. Метрики, логи, алерты

`GET /metrics` (только ops; Traefik наружу не маршрутизирует).
Основные ряды: `ffmpeg_queue_length{status}`,
`ffmpeg_queue_oldest_age_seconds`, `ffmpeg_slots_busy`,
`ffmpeg_jobs_finished_total{status,code}`, `ffmpeg_oom_total`,
`ffmpeg_timeouts_total{code}`, `ffmpeg_queue_delay_seconds`,
`ffmpeg_pipeline_seconds`, `ffmpeg_executor_wall_seconds`,
`ffmpeg_disk_bytes{kind}`, `ffmpeg_cleanup_errors_total{step}`,
`ffmpeg_recovered_jobs_total`, `ffmpeg_orphan_executor_total`,
`ffmpeg_control_mode{mode}`, `ffmpeg_backup_age_seconds`.

Логи — JSON-строки в stdout; без ключей, токенов, URL (включая query),
команд и текстов; access log — путь без query, `by-key` и имя файла
скрыты. Поля задачи по ТЗ §12: `job_id`, `client_id`, `operation_id`,
`queue_delay_ms`, `wall_ms`, `cpu_ms`, `peak_rss_kb`, `input_bytes`,
`output_bytes`, `attempts`, `exit_code`, `image_digest`, `code`.

Текущие CPU/RAM executor — `GET /api/ops/overview` →
`executor.resources` (`cpu_ms`, `cpu_percent` — % одного ядра между
двумя замерами, лимит 200%; `rss_kb`, `peak_rss_kb`, `sampled_at`,
`stale`); в простое — `idle: true`.

Алерты: `/api/ready` = 503 > 2 мин; `ffmpeg_disk_bytes{kind="free"}` <
20 GiB; `ffmpeg_queue_oldest_age_seconds` > 600 при `slots_busy=0`
(очередь без прогресса); рост `ffmpeg_oom_total` ≥ 2 за час;
`ffmpeg_orphan_executor_total` растёт; `ffmpeg_cleanup_errors_total`
растёт; `ffmpeg_backup_age_seconds` > 1800; `control_mode{mode="recovery"}=1`.

## 10. Чек-лист canary этапа C

Production default остаётся `hosted` на всём этапе.

- [ ] DNS `ffmpeg.viral4creators.app` и владение подтверждены; TLS от Traefik.
- [ ] `.env`: дайджест базы, версия ffmpeg, ключи сгенерированы (§6), allowlist входов сверен с реальными хранилищами.
- [ ] Loop xfs под workspace смонтирован (§7), заполнение не задевает хост.
- [ ] `docker inspect` executor: `NetworkMode=none`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`, `Memory=3g`, `NanoCpus=2e9`, `PidsLimit=128`, uid 10001; api — 256m. Лимиты реально применены (cgroup v2: `cat /sys/fs/cgroup/.../memory.max`).
- [ ] Из executor нет сети (`getent hosts example.com` падает); из api есть только исходящий HTTPS.
- [ ] `GET /api/ready` = 200; `capabilities.ok`, `missing=[]`.
- [ ] Корпус команд и функциональная матрица §13 на синтетике; 20 задач подряд разных профилей; все попытки учтены (`/api/ops/jobs`).
- [ ] Relay: baseline p95 до нагрузки и во время; рост ≤ 20%, без рестартов/OOM relay.
- [ ] Fault injection: `docker kill` api во время downloading/running/publishing → задача доведена или INTERRUPTED, второй executor не стартовал; `docker restart executor` → не более одной повторной попытки.
- [ ] Отмена во время публикации, purge отзывает ссылку (410), pause/drain переживают рестарт.
- [ ] Restore drill §4 пройден, RTO/RPO записаны.
- [ ] 24 часа canary: cleanup TTL отработал, orphan-workspaces нет, `/` хоста не растёт.
- [ ] Замеры wall/CPU/RAM/диск записаны в отчёт этапа C; решение о переходе — владелец.
