# FFmpeg: первый VPS, изолированный пилот — 21 октября 2026

Текущее состояние: HTTPS работает, systemd требует смонтированную XFS,
ресурсная проверка Chromium пройдена, 25-часовое наблюдение начато.
Приём в drain; production-маршрутизация платформы не включалась.
Ниже сохранён протокол первого шага; актуальные изменения — в дополнении.

Развёрнут на первом VPS с Dokploy/live-login-relay. Serv02 не затронут.
Исходная ревизия ab1f775 плюс исправление embedded-artwork этого прохода.
Production env платформы, DNS и принятые медиа не менялись. Внешний FFmpeg
остаётся действующим путём; canary API доступен только на 127.0.0.1:18090.

## Найдено и исправлено

- Compose ограничивал workspace, но оставлял outputs на общем Docker volume.
  Теперь путь outputs обязателен и также должен лежать на ограниченной ФС.
- Встроенная обложка MP3 с r_frame_rate=90000 считалась движущимся видео:
  обычный аудиофайл отклонялся по FPS. Диспозиция attached_pic сохраняется;
  у такой картинки пропускается проверка FPS, декодированный объём считается
  для одного кадра. Проверки размеров, количества потоков и пикселей сохранены.
  Три регрессии: нормальная обложка / настоящее видео с чрезмерным FPS /
  слишком большая обложка.

## Фактическая конфигурация

- Node image index: sha256:8cabefbd444809cf0e319b5831c65da1ea202200ca552a5e75fd7938a6f86658.
- FFmpeg Debian: 7:5.1.9-0+deb12u1; capability smoke прошёл при сборке и старте.
- Каталог: /opt/v4c-ffmpeg-canary/ffmpeg-server. Секреты только на VPS,
  отдельные случайные ключи client/ops и шифрования; в репозиторий не входят.
- API: 0.5 CPU, 256 MiB, 128 PID, readonly, cap_drop ALL.
- Executor: 2 CPU, 3 GiB без swap, 128 PID, readonly, network=none,
  non-root 10001:10000, no-new-privileges, init.
- cgroup v2 io.max: /dev/sda read 40 MiB/s, write 20 MiB/s у обоих контейнеров.
  Это проверка установки лимитов; отдельный замер фактического I/O ещё нужен.
- Предвыделенный loop XFS 30 GiB /srv/v4c-ffmpeg-canary.img, общий для
  workspace/outputs. После сборок на / свободно около 29 GiB.
- Canary оставлен в drain. Автоматический рестарт отключён: без проверенного
  постоянного mount нельзя позволять Docker писать в подлежащую корневую ФС.
  После перезагрузки сначала смонтировать образ, проверить mountpoint,
  затем запускать `ffmpeg-server/scripts/start-canary.sh` и явно возобновлять
  приём через ops. Скрипт отказывает без XFS mount и 15 GiB на корневой ФС.

## Проверки

- Сборка обоих образов успешна; readiness: sqlite/migrations/executor/
  capabilities/disk=true. Health=200. Без ключа 401, client→ops 403, ops 200.
- 110 s, H.264/AAC, 1280×720, 25 fps: полный API→downloader→изолированный
  executor→приватное скачивание. На входе публичный файл цифровой тишины
  anars/blank-audio; изображение генерируется фильтром color. Клиентских данных нет.
  Рендер 31.24 s; 852536 байт; SHA-256
  e5f14bb8afc468586c5c105142dcacf97d48278974caeda9363395a3b0bd820f.
  Скачанный результат независимо прочитан ffprobe: format/video/audio=110 s.
- 20 последовательных коротких задач успешны. Каждый POST повторён с тем же
  ключом: ID совпал. Итого в БД 22 операции: 21 успешная и первоначальная
  ошибка обложки; повторные POST новых строк не создали.
- Под нагрузкой executor ~193% CPU и 148 MiB RAM. Relay без рестартов/OOM,
  healthy. 100 health-запросов: baseline p95=5.583 ms, under-load=5.623 ms
  (+0.73%); p50=3.127/2.324 ms. Это health, **не живой Chromium-login**.
- Online backup integrity=ok, 22 jobs/22 idempotency keys. Реальное
  stop→restore→recovery→сверка всех 21 успешной задачи→resume прошло.
- Попытка выделить 31 GiB внутри 30-GiB XFS завершилась ENOSPC. Свободное
  место / изменилось на 4096 байт, relay остался здоров. Пробный файл удалён.
- Локально: typecheck/lint; 178 тестов parser/probe, включая настоящие ffmpeg/
  ffprobe и новые регрессии. Платных вызовов нет.

## Условия после первого шага (обновление ниже)

1. Relay с реальным Chromium-login под FFmpeg-нагрузкой; текущий health-тест
   этого не заменяет.
2. 24-часовое наблюдение TTL/cleanup, off-host backup и постоянный mount с
   fail-closed запуском контейнеров; I/O-замер на loop/backend device.
3. DNS/TLS: ffmpeg.viral4creators.app сейчас указывает не на этот VPS.
   Публичная маршрутизация и backend ключи/флаги не переключались.
4. Подключить существующую вкладку /ffmpeg к canary, проверить права и
   маршрутизацию/fallback на развёрнутом backend. Код вкладки уже существует,
   наличие работающего API не доказывает её production-интеграцию.

Не считать этап C/D полностью принятым по одному синтетическому прогону.


## Дополнение: HTTPS, устойчивый запуск и нагрузка Chromium

- В Vercel DNS добавлена только A-запись `ffmpeg` → первый VPS,
  TTL 60; wildcard, live, sandbox и прочие записи не менялись.
- Traefik выпускает действительный Let's Encrypt сертификат и маршрутизирует
  API по HTTPS. `/metrics` наружу не отдаётся, на роутере rate limit 20/s,
  burst 40. Executor по-прежнему без сети. Клиент/ops ключи не менялись,
  исходные signed URL не попадают в отчёт.
- [HTTPS-проверки](https-checks.json): health/ready=200, без ключа ops=401,
  client→ops=403, ops=200, скачанный MP4 совпадает с SHA-256,
  Range=206/100 байт, файл без токена недоступен.
- API и executor закреплены за локальными image IDs, а не изменяемым тегом:
  [image-ids.json](image-ids.json). В новой короткой тестовой задаче
  `image_digest` совпал с фактическим executor SHA-256. Это отдельная проба
  трассировки, а не повтор ранее принятой операции.
- systemd `v4c-ffmpeg-canary.service` требует
  `srv-v4c\x2dffmpeg\x2dcanary.mount`; compose не управляет mount автоматически.
  Реально выполнены stop контейнеров → unmount только тестовой XFS →
  start service → mount восстановлен → данные и drained-состояние сохранились.
  VPS/relay/Dokploy не перезапускались. Автозапуск обеспечивается systemd,
  Docker restart=no исключает запуск в обход mount-зависимости.
- Настоящий Chromium в существующем контейнере relay, с его штатными
  launch args и egress-filter: 10 навигаций sandbox + проверка снимка в
  каждом проходе. Baseline p95=1166.35 ms, при 110-секундном FFmpeg
  рендере p95=1166.01 ms; ошибок, OOM и рестартов нет. Полный рендер
  завершён успешно. Небольшая выборка — предварительная оценка ресурса,
  не SLA и не проверка всех сценариев авторизации/WS пользователя.
- **Исправлен реальный I/O-пробел:** `io.max` только на /dev/sda не
  ограничивал запись loop-файловой системы: 64 MiB direct write шли
  221.4 MiB/s. Добавлен лимит на фактическое loop-устройство, которое
  стартовый скрипт определяет после mount; повтор — 19.63 MiB/s.
  cgroup v2 содержит обе записи 7:0 и 8:0. [До](io-probe.json),
  [после](io-probe-fixed.json). Файл пробы удалён.
- Online backup после нагрузочной пробы: integrity=ok, 23 jobs/23 keys;
  копия 308 KiB вынесена на Mac владельца с правами 0600 вне Git.
  Это разовая off-host копия; регулярный off-host backup ещё не настроен.
- Read-only systemd timer каждые 5 минут записывает ограниченные
  наблюдения health/readiness/состояний синтетических задач и TTL.
  Максимум 300 строк, без токенов и URL файлов; новых рендеров не создаёт.
  Окно — 25 часов с самовыключением, **до 22.10.2026 21:34 по Киеву**.
  Фактический результат TTL ещё не получен. Логи на VPS:
  `/opt/v4c-ffmpeg-canary/observation.jsonl`; финал — `observation-finished.json`.

### Осталось

1. Прочитать итог 25-часового наблюдения и подтвердить реальное удаление
   всех истёкших outputs без изменения idempotency history.
2. Настроить регулярный off-host backup и отдельное сохранение ключей
   восстановления: разовая копия БД не защищает от полной потери VPS.
3. Подключить существующую /ffmpeg к backend и проверить canary/fallback.
   Флаги production не переключать до завершения наблюдения.

Сохранены конфигурация без секретов `ffmpeg-server/compose.canary.json`,
стартовый скрипт и systemd units в `ffmpeg-server/deploy`. Путь `.env`
в compose — файл на VPS; его содержимое в Git не входит.

## Дополнение: off-host расписание и проверка backend-клиента

- Установлен пользовательский LaunchAgent на Mac, каждые 900 секунд;
  первый автоматический запуск завершился exit 0. SQLite snapshot:
  331776 байт, integrity=ok, 24 jobs. Повтор запуска не создал новую копию.
  SSH остаётся прежним; ключи и медиа не копируются. Хеш сверяется при
  каждой проверке, повреждённая копия восстанавливается атомарной заменой.
- Код/тесты: `scripts/pull-canary-backup.py`, `test/ops/pull_backup_test.py`.
  8/8 без сетевых вызовов; два реальных запуска с текущим SSH и один
  через launchd успешны. Каталог приватный, семидневное хранение и
  ограничение локального объёма; MAC sleep/offline — известное ограничение.
- Настоящий `FfmpegOpsClient` из backend прочитал `/ops/overview` по HTTPS
  с ключом пилота. `sanitizeOps` не пропустил API-ключи и URL в ответ:
  [результат](live-backend-ops-client.json). Платных запросов/submit не было.
  Это проверка кода клиента на настоящем сервере, не production-админки.
- Production `/ffmpeg` пока отдавал «Страницы нет»: активная админка
  была на 8638da0; сборка 9c81de3 с новым разделом остановлена checks.
  Backend production 29d14e1 включает код интеграции, но в Vercel env
  найден только `FFMPEG_API_KEY`, без `FFMPEG_SELFHOSTED_*`.
- Подготовлено подключение с `FFMPEG_SELFHOSTED_ENABLED=false`: сохранить
  server-side base URL и два ключа client/ops в проекте `viral-backend`,
  выдать доступ только владельцу через `ADMIN_OWNER_TELEGRAM_IDS`.
  Перенос ключей через браузер ожидает отдельного подтверждения владельца.
  Без него значения ключей в Vercel не вводились и не сохранялись.

Для постоянного production backup по-прежнему нужны always-on приёмник
и отдельное восстановление ключей; копия на спящем ноутбуке это не заменяет.


### Админка выложена; секреты ещё не переносились

На зелёном коммите 766c42e сборка production `viral-admin`
`CZh36J15fL7vFjWdvWrJoY4V3jqk` получила Ready и назначила основной домен.
Автопрогон `7aqfg1YEZPNupDAvR5iNJrSx7Zc7` перед этим отменился по
Ignore Build Step; штатный Redeploy выполнен с отключением только
этого условия для одной сборки. Обязательные Deployment Checks сохранены,
неизменённые проекты не пересобирались вручную.

`https://admin-sandy-eight-75.vercel.app/ffmpeg` теперь показывает реальный
раздел, а не 404. Текущая авторизованная сессия владельца —
`@ConscienceUkraine`, telegramId 7427343290. Сервер честно отказывает
`ffmpeg.read`, поскольку owner allowlist и SELFHOSTED env ещё не заданы.
Подготовлена форма **Production проекта viral-backend**: base URL,
`FFMPEG_SELFHOSTED_ENABLED=false`, имена двух ключей client/ops и owner
allowlist. Значения секретов/owner ID не вводились, Save не нажат.
Для их передачи и открытия управления требуется подтверждение пользователя
по правилам управления браузером; другим операторам доступ не планируется.


### Подключение Production после подтверждения владельца

Пользователь отдельно подтвердил сохранение client/ops ключей в Production
`viral-backend` и доступ только своему аккаунту 7427343290. Сохранены
`FFMPEG_SELFHOSTED_KEY`, `FFMPEG_SELFHOSTED_OPS_KEY`, HTTPS base URL,
`FFMPEG_SELFHOSTED_ENABLED=false` и `ADMIN_OWNER_TELEGRAM_IDS=7427343290`.
Существующий ключ hosted-провайдера не менялся. Временная локальная
копия двух ключей удалена после успешного Save; значения в отчёт/Git не попали.

Backend deployment `5icu6buPKy87hs2nfX8VX7HZakA3` (b4bc10a) получил Ready
и основной production-домен. Для применения изменившегося окружения
штатно снят только Ignore Build Step на эту сборку; обязательные checks
не отключались. Другие проекты вручную не пересобирались.

Живая production-админка `/ffmpeg` под @ConscienceUkraine показывает
права ffmpeg.read/operate/configure/media.read, ready, drain, 24 тестовые
задачи, 0 активных/ожидающих и прежнюю ошибку MP3-artwork до исправления.
Без авторизации `/api/admin/ffmpeg/overview` возвращает 401. Просмотр
не создал задач или операторских операций. Реальный маршрут — hosted,
canary allowlist пуст; сохранённый default selfhosted перекрыт выключенным
env-гейтом. Его включение требует отдельного решения после приёмки.

25-часовое наблюдение TTL до 22.10 21:34 по Киеву остаётся незавершённым.
Nova, принятые сборки и реальные медиа не изменялись; платных вызовов не было.

### Проход усиления и подготовка переключения (21.10, лимит $1)

Владелец разрешил переключиться после тестов, не ожидая 24 часов: пользователей ещё нет. Это разрешение на запуск не закрывает фактическую проверку TTL; наблюдение до 22.10 21:34 Киев остаётся отдельным пунктом.

Исправления:
- Перед публикацией результата проверяются фактические размеры с SAR/поворотом, FPS, профиль ресурсов, MIME, конечная положительная длительность MP4/M4A и согласованность размера/формата SHA-256. Лимит длительности одного входа не применяется ошибочно к результату concat.
- В карточке собственной задачи — бесплатный advisory-черновик manifest. Только свежие метаданные VPS, SHA-256 видеоисходника и MP4-результата, неистёкшая завершённая задача и явно выбранные разрешённые рекомендации. Произвольные команды и стили запрещены. При недоступном VPS — 503 без утечки провайдерского ответа; stale-cache не используется. Экспорт не рендерит, не одобряет медиа и не вызывает Gemini. Если обработка не нужна, `plan: null`; повторное перекодирование не предлагается.
- Офлайн-компилятор титров отвергает повёрнутый/анаморфный исходник до явной нормализации: его пиксельная раскладка не должна молча расходиться с отображаемым кадром.
- Fixtures поворота совместимы с закреплённым FFmpeg 5.1 и локальным FFmpeg 9; семантические проверки матрицы поворота сохранены.

Проверено: новые backend compiler/owner/CSRF/свежесть/недоступность — 49/49; admin transport, типы backend/admin/ffmpeg-server, профильный lint и sync-shared. Полный локальный backend: 11305 тестов / 553 набора, 11213 pass, 82 skip без БД, прежние 10 watermark-отказов из-за отсутствующего drawtext на Mac. Полный серверный набор проверяется в Linux-образе рабочего executor (5.1.9), не подменяется результатами Mac.

Усиленный валидатор отдельно прочитал 4 существующих MP4 предыдущего postprod-эксперимента в изолированном Linux-контейнере: все 55.76 с / 1394 кадра, MIME video/mp4, прежние SHA-256. Это техническая проверка формата; намеренно плохой crop не становится визуально одобренным. Исходник, Nova и принятые сборки не менялись. Новых платных вызовов на этом этапе: 0, расход $0 из разрешённого $1.

Незакрытые улучшения: persisted approval/CAS и привязка советов к конкретному запуску Gemini, доказательная оценка голоса/синхронизации/многосценового монтажа на реальных исходниках и постоянно доступный внешний получатель backup. Advisory-экспорт не выдаётся за эти функции.

Полный Linux-прогон на закреплённом FFmpeg 5.1.9 завершён: **391/391, 15/15 наборов**, включая тяжёлый корпус. Обновлён только API image `sha256:0c21ca52804ff1bc67945152491f63f85596b14bebfd7e54466363828a8b7a9b`; executor digest прежний. Конфигурация/образ сохранены для отката. Исправлен оставшийся от canary allowlist источников: GitHub + точный backend `backend-iota-ruddy-57.vercel.app` + `*.public.blob.vercel-storage.com`; запреты private IP/redirect/DNS rebinding не ослаблены. Неизвестные источники получают доказанный отказ до приёма, разрешающий прежний fallback.

Живой API smoke — публичная тестовая MP4-фикстура (не клиентский/принятый ролик), job `eedc5c6b-21ac-4aab-a088-63fca5c7236b`: повтор Idempotency-Key вернул тот же id; результат succeeded, 2.000 с video + 2.000 с audio, 640×360, 24 fps, 121081 байт, SHA-256 `2bb84410f05151d3179e7d3cdf8f56b9294131ea3dad76d4921dcff70ddab22c`. Worker возобновлён через owner-админку, операция записана в журнал. Production `FFMPEG_SELFHOSTED_ENABLED=true` сохранён; применяется ближайшей сборкой изменённого backend, без ручных повторных деплоев других проектов.

### Production-проверка после полуночи 22.10

CI `8fb5201` — [success](https://github.com/tarasenkoandriii/viral4creators/actions/runs/39674804513). Изменённые backend `uRyBsvyZtezB7dNQjzUTwV48ffU6` и admin `BAuxDegiAfRZWUa3YMGg3NrHL5qk` получили Ready и успешно прошли checks. Живая owner-админка подтверждает: **основной — свой сервер, запасной — внешний**, ready, приём открыт, breaker 0/3, очередь пуста. Ключи/права/согласия не расширялись. Лендинг и frontend Vercel отменил штатным Ignore Build Step как неизменённые; они вручную не пересобирались, обязательные checks не отключались.

Установленная systemd-служба приведена к уже исправленному файлу из репозитория: ExecStop останавливает только два именованных FFmpeg-контейнера и больше не требует loop-переменной для интерполяции compose. `systemd-analyze verify` и `daemon-reload` прошли; контейнеры не перезапускались. Проверено совпадение SHA-256 исполняемого `dist/probe/outputs.js` с проверенной сборкой. Relay здоров, root свободно около 29 GiB.

Продовая проверка экспортера обнаружила потерю имени входа: общий sanitizer обоснованно удалял поле `key`, но старый UI связывал метаданные только по нему. Исправление сохраняет ограниченный логический alias как `name` исключительно внутри `inputs_metadata`; API-ключи, токены, URL и глобальное правило для `key` остаются закрытыми. Нормализатор поддерживает новый `name` и прежний `key`. Регрессии проверяют реальный GET-контракт, повторную очистку и UI-разбор; профильные backend-тесты **60/60**, admin transport/typecheck/lint проходят. Дополнительных рендеров или платных вызовов это исправление не создаёт.

### Реальные автоматические задачи и дробные секунды (22.10)

После включения основной схемы три штатные задачи `tutorial-runner` получили доказанный `422 UNSUPPORTED_COMMAND` до приёма. Fallback завершил все три на hosted; это не второй рендер на VPS и не повтор принятых выпусков. По `ai_usage`: 3 вызова `tutorial-video-assembly`, расчёт $0.03 (не подтверждённый счёт провайдера). Мои ручные проверки и Gemini не создавали платных вызовов; общий расчёт остаётся ниже лимита $1.

Причина воспроизведена локально на числовой структуре трёх manifest (4/3/9 кадров), без URL, речи, картинок или повторной отправки: `gridSeconds()` выдаёт корректные IEEE-754 секунды `2.2666666666666666`, а CLI-валидатор допускал лишь 6 знаков, фильтры — 9. Код теперь принимает ограниченную дробную часть до 17 знаков; максимальная длительность, размеры, FPS, длина команды и запрет выражений в числовых полях сохранены. Все три структуры проходят тот же parser без округления монтажного плана. Корпус дополнен настоящим вызовом генератора с дробными кадрами, голосом, указателем и ASS; превышение 600 с даже малой дробью и чрезмерная точность остаются запрещены.

Также `UNSUPPORTED_COMMAND`/`FORBIDDEN_SOURCE` больше не увеличивают счётчик неисправности всего сервера: это отказ конкретной задачи, безопасный fallback для неё сохраняется. Отказы доступности, сети, очереди и терминальные ошибки по-прежнему учитываются breaker. История трёх старых событий не удаляется.

Продовый advisory exporter уже проверен на `2e540d8`: правильный SHA → детерминированный manifest; нулевой подменённый SHA → явный 400; после восстановления правильного документа скачан JSON и локально пересчитан `manifestSha256` — совпадает. Повторные проверки и экспорт не увеличили число FFmpeg-задач. Приватный player воспроизвёл двухсекундный smoke до конца (readyState 4, 640×360, error null); прямой URL того же файла без подписи — 401.

### Final precision verification — 22 October

Pinned Linux regression: **396/396 tests, 15/15 suites**, including the generated fractional-frame Tutorial corpus rendered by the real executor. API updated to `sha256:679ad6ed9e231a469ca15c9d2b5a1de7ef988560830dee6ea37acba840d89408`; executor unchanged. Owner-journaled drain/resume completed with an empty queue.

Live original-source test `17534fb3-743d-4bdb-a0b0-db4674e788cc` accepted both `-t 2.2666666666666666` and matching `atrim`; succeeded once. Repeating the same idempotency key returned the same job. MP4: 141509 bytes, SHA-256 `fa3c7512a35fc64438a6440425bbdc3f8d99f93467e7f083109c9ad6de592cdf`, H.264 640×360/24 fps, video 2.291667 s, AAC 2.266984 s (within one video frame). No external paid call was made by this smoke test. Own server remains primary; hosted fallback remains enabled. The three earlier completed hosted jobs were not resubmitted. Their aggregate platform-ledger estimate is $0.03 of the $1 budget, not a verified provider invoice.

The owner waived the pre-switch 24-hour waiting period; TTL observation and always-on off-host backup remain separate operational follow-ups, not prerequisites that silently disable primary routing.

### TTL observation verdict — 22 October

The read-only observer now emits public-expiry `passed/waiting/failed` after a five-minute cleanup grace. It requires retained HTTP 200 history, OUTPUT_EXPIRED, successful execution history, and zero public output links. Missing history, malformed expiry, retained links, and empty samples cannot produce a pass. Physical deletion and idempotency tombstones remain explicitly unverified by this public-API observation.

13 Python ops tests passed (5 observer + 8 backup tests). Updated script installed in place without restarting API/executor or changing the observation deadline. Live result: health 200, ready/active, 23 waiting, 0 failed; no paid calls or new renders. Existing backup restored into an isolated local SQLite database with integrity OK, 30 jobs and 30 idempotency records; production database untouched.

### Итог TTL и сверка резервной копии — 27.10.2026

Сохранённый `observation-finished.json` на VPS подтверждает завершение
окна через 25.026 ч: publicExpiry=passed, 23 passed, 0 waiting, 0 failed.
Read-only запрос SQLite и проверка файловой системы 27.10 дополнили
наблюдатель: у всех 23 задач сохранено успешное execution history,
выставлены OUTPUT_EXPIRED/purged_at и tombstone ключа идемпотентности.
Все 23 ключа и записи задач существуют; файлов результатов, каталогов
outputs и рабочих каталогов этих задач нет. Новые рендеры не создавались,
API/executor/relay не перезапускались.

Квитанция без ключей, URL и содержимого задач:
[ttl-final-audit-20261027.json](ttl-final-audit-20261027.json).
Она закрывает прежнее ограничение public-only наблюдателя и старую
отметку waiting выше; проверка 90-дневного истечения истории не выполнялась.

LaunchAgent на Mac зарегистрирован, LastExitStatus=0. Свежая off-host
копия проверена отдельным восстановлением во временный каталог:
integrity=ok, 176 jobs, 176 idempotency keys, 2715648 байт.
[Квитанция](restore-check-20261027.json). Временная восстановленная БД
удалена, production БД не изменялась; секреты не копировались и
расшифровка payload в этой проверке не выполнялась.

TTL и SQLite restore сами по себе не закрывают постоянно доступный
off-host backup и восстановление секретов. После этой сверки владелец
выбрал private Vercel Blob для постоянных копий; результат ниже.

### Постоянный private Blob backup — 27.10.2026

Владелец разрешил до $10/месяц на Vercel Blob. Создан один отдельный
store `ffmpeg-private-backups` / `store_IzZ0UT8GyC5msPyu`, private, fra1.
Public store с видео не изменён. Scoped token хранится root-only на первом
VPS; отдельная переменная Production `FFMPEG_BACKUP_READ_WRITE_TOKEN`
viral-backend обеспечивает доступ вне VPS. Другие credentials не заменены;
payload/HMAC ключи не экспортировались. Временные локальные env/token
файлы настройки удалены.

Первый live upload/readback: 2715648 байт, SHA-256 совпал, integrity=ok,
181 jobs / 181 idempotency keys, анонимный запрос 403.
[Квитанция](blob-backup-20261027/first-upload.json). Это SQLite-копия,
не медиа и не расшифрованные исходные URL/команды. Платных генераций нет.

Контейнер uploader `830942885cc1` получает только snapshot, state и token
этого store: read-only root, cap-drop ALL, 0.5 CPU / 128 MiB / 64 PIDs.
API `6ecebb6ee029`, executor `408abb147f9a` и relay не перезапускались.
После зелёного [CI 40467845259](https://github.com/tarasenkoandriii/viral4creators/actions/runs/40467845259)
(437 тестов / 17 suites + 13 backup-проверок) включён systemd timer:
проверка каждые 5 минут; первый автоматический запуск exit 0, тот же
snapshot распознан как replay без новой загрузки.

Ограничения: snapshot ≤8 MiB, store ≤6 GiB, хранение 7 дней, ≤3200
попыток/месяц и ≤12 GiB месячного резерва. Дополнительная консервативная
модель расходов останавливается выше $8, оставляя запас до разрешённых
$10. Это ограничения uploader, не hard cap счёта Vercel. При текущем
объёме расчётный расход порядка $1–2/месяц; источник тарифов и регламент
в [OPERATIONS.md](../../../ffmpeg-server/docs/OPERATIONS.md).

Новая команда verify-keys и 16 профильных тестов проверяют readonly
совместимость payload/HMAC. Live helper нашёл 181 историческую запись,
все нужные HMAC key IDs доступны, но encryptedPayloads=0: ни одного
сохранённого payload для живой расшифровки нет. Поэтому это не доказательство
восстановления секретов; [квитанция](blob-backup-20261027/key-compatibility.json).

Открыто: отдельная off-host копия payload/HMAC ключей и полноценный secret
restore; внешний alert о сбое/устаревшей копии; целевой RPO ≤15 минут.
Первоначальная расчётная давность: API snapshot раз в 15 минут + обнаружение до
5 минут + передача; ниже зафиксировано обновление до 10+2 минут.
Не объявляется полная приёмка disaster recovery.
Ни один из этих пунктов не отключает уже работающий fallback.

### Gzip и сокращение окна backup — 27.10.2026

Коммит `75eb51e2`, [CI 40470040889](https://github.com/tarasenkoandriii/viral4creators/actions/runs/40470040889)
success: 439 FFmpeg tests / 17 suites + 13 backup checks.
Предел попыток увеличен до 4800/месяц для snapshot раз в 10 минут;
месячная квота 12 GiB и консервативный резерв $8 относятся теперь к
сжатым байтам. Для недельной истории 1008 копий поддержаны две страницы
list с общим пределом 1200; прежние `.db` продолжают распознаваться,
новые `.db.gz` не перезаписываются. При тайм-ауте wrapper удаляет только
свой одноразовый контейнер передачи по уникальному имени.

На пустой очереди выполнены CAS pause, SQLite backup, изменение только
`FFMPEG_SERVER_BACKUP_INTERVAL_SEC=600`, существующий start guard,
readiness и resume. API image сохранён `6ecebb6ee029`; executor
`408abb147f9a` и relay сохранили прежний StartedAt. Профиль renderer,
ресурсные лимиты и принятые активы не менялись. Копия compose для отката:
`compose.canary.json.before-backup600-20261027`.

Uploader image `dd9f7f177f25`, timer poll 120 с, deadline 150 с.
Автоматический live прогон: SQLite 2715648 байт → gzip 625388 байт
(4.342× меньше), скачивание, оба SHA-256, bounded gunzip,
integrity/counts (181/181) и анонимный HTTP 403 прошли.
Snapshot подтверждён через 16.818 с после создания.
[Выкладка](blob-rpo-20261027/deployment.json),
[квитанция](blob-rpo-20261027/acceptance.json).

Штатная схема 10+2 минуты + передача настроена под цель RPO ≤15 минут.
Один live прогон не доказывает непрерывное соблюдение SLO при нагрузке,
сетевых ошибках или отказе сервера. Внешний канал предупреждений и сейф
для отдельной копии ключей запрошены у владельца; отправки не включены,
ключи на новый сервис не переносились. Nova/принятые ролики не менялись;
платных генераций нет, Blob работает в согласованном бюджете.
