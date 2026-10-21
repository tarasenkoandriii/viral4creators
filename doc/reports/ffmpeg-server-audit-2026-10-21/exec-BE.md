# Пакет BE — отчёт

## Решения
- Р-FF-BE-1: продукт `tutorial-quality` добавлен в FFMPEG_PRODUCTS — инвентаризация по инъекциям нашла `demo-quality.service.ts` (поле `ffmpeg?`, вызов `(this.ffmpeg as FfmpegApiService).submit`), не входивший в перечень ТЗ/брифа.
- Р-FF-BE-2: `operationKey` только там, где одна строка БД = одна попытка: story (`story-video:<renderId>`), tutorial-runner и client-site-tutorial (`tutorial-asset:<assetId>`), tutorial-video-versions (`tutorial-video-version:<id>:<attempts>`). У postprod/actors/audio-track/portfolio/shared-video/tutorial-quality строки переиспользуются с другим телом → тот же ключ дал бы 409 у своего сервера; там только `product`, ключ — прежний sha256.
- Р-FF-BE-3: `X-Client-Operation-Id = <product>:<operationKey | sha256[0..32]>` — продукт виден вкладке и фильтру.
- Р-FF-BE-4: usage — `provider: FFMPEG_SELFHOSTED` только для задач `selfhosted:`; модель `ffmpeg-api` и оценка те же (списания/потолки не меняются); hosted-строки без изменений; в AI_PROVIDERS (балансы) не добавлен.
- Р-FF-BE-5: гейт включён, но адрес/ключ своего сервера не заданы → новые задачи к hosted (выбор до отправки, не fallback).
- Р-FF-BE-6: новый env `FFMPEG_SELFHOSTED_OPS_KEY` (роль ops для /api/ops, /api/control); cancel/purge/status/by-key — ключом клиента (задача принадлежит client_id backend).
- Р-FF-BE-7: владельца/superadmin в admin-auth нет → права = isOperator ∧ telegramId ∈ ADMIN_OWNER_TELEGRAM_IDS; пусто — запрет.
- Р-FF-BE-8: журнал append-only → запрос и исход — две строки, unique(operationId, phase); повтор operationId возвращает записанный исход; уборка 90 дней в кроне cleanup-sessions.
- Р-FF-BE-9: в маршрутах админки задачи своего сервера адресуются `selfhosted:<id>`; id без префикса — hosted (карточка/сверка статуса; cancel/purge/link — 400).
- Р-FF-BE-10: фильтр по продукту — сужение страницы на backend (в ops-API его нет).
- Р-FF-BE-11: индексы по 5 колонкам jobId для поиска владельца (миграция).
- Р-FF-BE-12: кэш «последних удачных» для stale — в памяти инстанса (холодный инстанс Vercel покажет error, не stale).

## Решение владельца 21.10.2026: selfhosted — основной, fallback к hosted
- Р-FF-BE-13: default `selfhosted` (миграция), без гейта — hosted; непустой canary — ограничитель (только эти продукты к своему серверу).
- Р-FF-BE-14: fallback (`FFMPEG_FALLBACK_HOSTED`, по умолчанию true, нужен FFMPEG_API_KEY): доказанный отказ → hosted тем же телом; неизвестный исход → by-key (≤10 с, «нет записи» — только дважды подряд с паузой) → найдено/hosted/ошибка; 400/401/409 и прочие 4xx — без fallback. Тайм-аут POST к своему серверу 30 с (Story 25 с).
- Р-FF-BE-15: breaker в `ffmpeg_routing` (failures, openUntil, countedJobs ≤20 — один провал задачи учитывается раз); порог 3, `FFMPEG_SELFHOSTED_BREAKER_MINUTES`=10; сброс — только завершённой задачей своего сервера (принятый submit не сброс: иначе чередование «принято/OOM» не открыло бы breaker); при выключенном fallback breaker не перенаправляет.
- Р-FF-BE-16: учёт fallback — таблица `ffmpeg_fallback_events` (30 дней), `fallbacks24h` в overview; usage — как hosted.
- Р-FF-BE-17: `retryOnFallback` использован только там, где повтор уже есть: tutorial-runner (и сборки client-site через тот же опрос) → `infra` (попытка содержимого не тратится, следующая ночь пересоберёт); portfolio — крон и так повторяет FAILED. Без автоповтора: postprod (основная/переозвучка/экспорт), actors, audio-track, shared-video, tutorial-video-versions, tutorial-quality, Story.
- Р-FF-BE-18: watermark — `expansion=none` + двойной av-escape ASCII-пунктуации + sh-dq-escape; проверено рендером против textfile. Литерал `{{имя}}` в тексте знака свой сервер всё равно отвергает (EXEC: placeholder вне файловой опции).

## Аудит INT (FF-INT-01…13)
- Р-FF-BE-19: «нет записи» — только 404 с X-FFmpeg-Server: 1 и error.code NOT_FOUND, и только после sentAt + FFMPEG_SELFHOSTED_COMMIT_DEADLINE_MS (10 с) + 2 с; ответы без заголовка (кроме 413) — неизвестный исход; RECOVERY — без fallback, SUBMIT_DEADLINE — отказ.
- Р-FF-BE-20: ffmpeg_submissions (ключ = operationKey|sha256, bodyHash, provider, state, jobId, fallbackReason, sentAt), ведётся только при настроенном своём сервере (до настройки — ни одного запроса к БД); запись до сети обязательна для selfhosted (не записалась — не отправляем); принятая своим сервером — прежний jobId; принятая hosted — повтор к hosted (как до перехода).
- Р-FF-BE-21: breaker — окно 15 мин, атомарные UPDATE, ffmpeg_breaker_jobs (unique), half-open аренда probeUntil (2 мин до приёма / 20 мин после), закрытие — завершением пробы (или любой задачей при закрытом breaker).
- Р-FF-BE-22: Story — бюджет 25 с: своя отправка 13 с (дедлайн+3 с), сверка, hosted с остатком; < 8 с — ошибка.
- Р-FF-BE-23: watermark — обычный текст байт в байт как origin/main; новое экранирование только при ' % $ ` \ :.
- Р-FF-BE-24: FF-INT-06 — verify перед повтором: control.mode, статус задачи, ревизия лимитов/маршрутизации; purge/download-link/reconcile — идемпотентный повтор.

## Перепроверка INT (FF-INT-14…16, 09, 13)
- Р-FF-BE-25: попытки — `ffmpeg_submissions.attempt`, ключ `<ключ>:r<n>` (длинный ключ → sha256 + суффикс); новая попытка — только если принятая своим сервером задача терминально failed/canceled по статусу у сервера (ошибка связи → прежний jobId).
- Р-FF-BE-26: без гейта — ни одной записи; одно защищённое чтение строки операции (ради прежней selfhosted-отправки), его сбой → hosted.
- Р-FF-BE-27: дубль мутации при `requested` моложе 20 с → 202 in_progress; старше — сверка.
- Р-FF-BE-28: запас сверки `FFMPEG_SELFHOSTED_COMMIT_MARGIN_MS` = 5 с; Story: своя отправка 16 с, на hosted ≥ 8 с.
