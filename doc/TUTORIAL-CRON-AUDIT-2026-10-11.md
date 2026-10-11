# Tutorial: аудит кода и прошедших cron-запусков

Проверка 11.10.2026. Источник истории: read-only запросы public.cron_run_logs за последние 30 дней и авторизованная админка. Отсутствие FAILED в исходном журнале не означает успешную работу.

## Фактические результаты до исправлений

- tutorial-scenario-generate: 36 запусков, 12 с failed>0.
- tutorial-scenario-run: 194 запуска, 174 с failed>0.
- tutorial-assembly-poll: 10059 запусков, один с failed>0.
- ui-snapshot-run: 11515 запусков, 862 с failed>0.
- client-site-retention: 9 запусков, ошибок FAILED и RUNNING не найдено.

Срез счётчиков снят около 12:48–12:50 Europe/Kiev. Повторная read-only проверка исправленного SQL около 13:00 обнаружила уже 863 сбойных обхода снимков: ещё один прошёл во время аудита. SQL выполнился на production без ошибок.

Во всех пяти группах исходный logged_failed=0, running=0, записанных SKIPPED=0. Это количество прогонов со сбойными элементами, не количество ошибочных сценариев и не доказательство отсутствия холостых запусков. Старые строки могли не сохранять outcome. Самые ранние записи: генератор и исполнитель 16.09, опрос сборок 27.09, retention 03.10. Полные 30 суток присутствуют не у каждой задачи.

10.10 расписание отработало: генератор 1/1, исполнитель 15/15, сборки 720/720, снимки 96/96, retention 1/1. 11.10 около 12:43 Europe/Kiev: генератор 1/1, исполнитель 4/4, снимки 51/51; у сборок 382 зарегистрированных при 381 ожидаемом до отсечения последних трёх минут. Разница не доказывает дублирование: окна ожидания и факта различаются.

Сохранённые видео: 21 актив, все complete и с blobUrl; 7 одобрены оператором. Самое раннее — 30.09.2026 22:49:27.487 UTC, последнее — 02.10.2026 10:03:00.830 UTC. Это статус базы, не проверка доступности каждого файла или качества просмотра. После 02.10 новых сохранённых видео в таблице нет.

Связанные задачи хранения за доступные 30 дней: cleanup-sessions — 30 запусков; sweep-orphans — 30; voice-uploads-sweep — 1086; ai-usage-rollup — 3. Для всех исходные FAILED/RUNNING/SKIPPED равны нулю. Это зарегистрированный исход, не независимое доказательство удаления каждого файла; период voice-uploads-sweep начинается 30.09.

## Подтверждённые причины

1. ESM Chromium отвергается production CommonJS-загрузчиком. Сегодня каждый из четырёх браузерных прогонов провалил 15 сценариев; каждый из 51 обхода снимков вернул failed=5. Исправлен fallback на native import при ERR_REQUIRE_ESM с сохранением статических импортов для dependency tracing. Другие ошибки импорта не скрываются.
2. Возвращённый batch result с failed>0 считался SUCCESS. Новые результаты четырёх Tutorial jobs теперь записываются FAILED. Старые строки интерпретируются при чтении истории и сводки; исходный журнал не переписывается. Частичный успех также требует внимания. HTTP ответ batch остаётся прежним: это не повод автоматически повторять платную работу.
3. Причины ошибок ui-snapshot outcomes ранее не попадали в summary из-за отсутствия сценарного ok=false. Добавлена поддержка routeKey/error.
4. Gemini с 09.10 возвращает 402 RESOURCE_EXHAUSTED для ключа приложения. Генератор 09–11.10 создал 0 из 15; повторная проверка 11.10 также дала 15 отказов. На предоставленном скриншоте AI Studio баланс $13.06, поэтому исчерпание средств показанного аккаунта не подтверждено. Требуется сопоставить проект API-ключа приложения с billing-проектом. GEMINI_API_KEY имеет приоритет перед GOOGLE_GEMINI_API_KEY; клиент передаёт выбранный ключ явно. Оплату аудит не выполняет.
5. Ранее генератор отклонял шаги темы 8 с product-photo-card на generate-ready-to-render. Валидатор корректно запрещает неверный экран; ослабление проверки не требуется. Нужна успешная повторная генерация после восстановления провайдера.
6. 30.09 один опрос видеосборки вернул failed=1; исходная summary не содержит причины. Причину нельзя достоверно восстановить из этой строки.

## Расписания и защита

UTC: генерация 08:00 ежедневно; браузерные сценарии в :05 часов 09–23; сборки каждые 2 минуты; снимки :10/:25/:40/:55; retention 03:50. Уборка сессий 03:00, orphan sweep 03:30, voice uploads каждые 15 минут; финансовая свёртка по понедельникам 04:00.

Маршруты cron проверяют secret; отдельные TTL locks защищают генератор и браузерный прогон. Замок assembly poll расположен внутри общего метода, используемого обоими вызывающими путями. TTL 11 минут превышает потолок функции 300 секунд. Run logging сохраняет start/finish/duration и расписание; мониторинг отличает пропуск и зависание. Не запускать retention вручную ради диагностики: задачи удаляют истёкшие данные.

## Проверки и границы готовности

До последнего изменения исторической сводки: 64 набора / 2167 тестов прошли. Реальная загрузка обоих ESM пакетов проверена в отдельном процессе, без Jest mocks; 27 тестов загрузчика прошли. После окончательного изменения истории и списка ошибок: 10 наборов / 280 тестов прошли. Линт изменённых файлов и TypeScript с реально сгенерированным Prisma client прошли. CI после исправления форматирования прошёл 10147 тестов в 497 наборах и проверку покрытия. Последний блокер CI — устаревшие счётчики в четырёх документах; числа обновлены. Финальный CI PR #23 прошёл: 38130627550.

Кодовые исправления не равны production acceptance. После деплоя проверить живой обход снимков, браузерный сценарий и отображение старых ошибок. Полный Tutorial RC нельзя объявлять готовым до восстановления Gemini, успешной генерации/исполнения и получения принятого видеорезультата. Репозиторий остаётся public по указанию владельца.

## Production-проверка после исправлений

PR #23 объединён в main: 1d02fd2c04da79407fef9db39f4afa46ca8ccd3f. Финальный CI PR 38130627550 и main 38130885765 успешны. Production deployment dpl_DtpLkd8akWNfLgHdB5BQrhDhUN3Y — Ready; build log подтверждает этот commit и отсутствие ожидающих миграций. Публичный backend alias переключён; health сообщает status=ok, database=up.

Контрольный ui-snapshot-run: total=5, changed=0, failed=0; длительность 57.641 секунды. Админка корректно переинтерпретирует вчерашнюю историю: генератор — 1 ошибка из 1; сценарии — 15 из 15; снимки — 96 из 96; опрос сборок — 0 из 720. Исходные записи не переписывались.

В tutorial_demo_quality_checks нет записей. Автоматический ИИ-контроль качества ещё не подтверждён; 7 операторских одобрений видео не заменяют его. Генерация новых сценариев остаётся заблокирована Gemini 402. Полная приёмка требует проверки проекта и billing используемого ключа, успешной новой генерации, видеосборки и контроля качества. Контрольный прогон сохранённых сценариев завершён: total=15, executed=2, passed=0, failed=2, длительность 295.775 секунды. Сценарии 8/ru и 1/ru превысили лимит 90 секунд; остальные 13 не выполнены. Браузерная инфраструктура восстановлена, но сценарный цикл не прошёл приёмку. Для этих сценариев сохранено 5 и 7 шагов соответственно; общий таймаут не позволяет установить сбойный шаг по этой summary. Требуется пошаговая диагностика; увеличение лимита без причины не считается исправлением.

Подтверждение сохранено в outputs/tutorial-production-proof-2026-10-11.png в рабочем пакете отчёта.


### Контроль после PR #25, 11.10.2026 13:40 Киев

Production 7b01136, deployment dpl_HF1GgbDbAdBB3TAEcMRuYpk5b5Wc: health ok, database up. CI: 10 151 тест, 10 146 passed, 5 skipped. Ручной прогон: total=15, executed=2, passed=0, failed=2, 141.887 секунды. Сценарий 3/ru: шаг 2 click — wizard-step-analysis выключен; сценарий 2/ru всё ещё превысил общий лимит 90 секунд. Полная приёмка не пройдена. Следующее исправление ограничивает подготовку и съёмку каждого кадра отдельным дедлайном; до выпуска и повторного прогона оно не считается подтверждённым исправлением production.


### Контроль после PR #26, 11.10.2026

Production 413ca4d, deployment dpl_5kbf2MRD5TLAqdwxfjDaMMmKeCVm: health ok, database up. CI: 10 152 теста, 10 147 passed, 5 skipped. Ручной прогон после выпуска: total=15, executed=5, passed=0, failed=5, длительность 223.439 секунды. В видимой summary: 4/ru — кадр шага 1 goto не снят за 15 секунд; 5/ru — выключен wizard-step-analysis; 6/ru — выключен wizard-step-prompt; ещё две причины свернуты. Ограничение кадров подтверждено конкретной production-ошибкой; успешная приёмка сценариев не подтверждена. Отдельный предел измерения указателя подготовлен следующим изменением; до выпуска его нельзя считать production-исправлением.


### 11.10: deadline нативного запроса Chromium

В installed puppeteer-core Connection timeout по умолчанию — 180000 мс. Page.screenshot держит screenshot-lock, а Page.close сначала ждёт освобождения этого lock. Promise.race с лимитом кадра 15000 мс не отменяет CDP-команду: сценарий уже остановлен, но закрытие страницы может ждать нативный timeout. В общую точку запуска браузера добавлен protocolTimeout=30000 мс. Он ограничивает каждую CDP-команду; верхние лимиты сценария и кадра сохранены. Это ограничение освобождает ожидающий запрос и предотвращает трёхминутное ожидание по умолчанию; оно само по себе не доказывает успешную съёмку проблемных экранов.

Проверка реального Connection из установленного Puppeteer с транспортом без ответов и лимитом 25 мс: captureScreenshot завершился timeout через 26 мс, очередь ожидающих команд пуста. Значения production-секретов в тесте не использовались.


### Исправление диагностики и runtime preflight

Прямые проверки с секретом, выгруженным через Vercel CLI, невалидны: production Secret экспортируются как `[SENSITIVE]`. Полученные так 401/403 не доказывают отказ действующего runtime-токена. Экспериментальный PR #32 закрыт; регистрация middleware не менялась. Аналогичный прямой Gemini-запрос с заглушкой не диагностирует billing; исторический 402 из cron остаётся отдельным фактическим результатом.

Исполнитель теперь до запуска Chromium читает фиксированную демо-сессию через собственный API с настоящим runtime-токеном. Запрос ограничен 10 секундами, redirects запрещены, тело ответа и секрет не попадают в историю. HTTP-отказ сохраняется как инфраструктурная причина и останавливает запись. Проверка не ослабляет авторизацию и не подтверждает сама по себе исправность браузерной съёмки.

Промежуточные кадры Tutorial теперь запрашиваются как lossless PNG с optimizeForSpeed=true: меньше времени на сжатие перед последующей видеосборкой, без снижения разрешения. Это оптимизация захвата, а не доказательство устранения зависания Chromium; приёмка определяется production-прогоном.


### Контроль PR #33 и гонка гидратации мастера

PR #33 выпущен: main e8e76a95e2a3ff541cc4a55e60241efd340a5302, deployment dpl_HZnKLsuALJqjx8VDbDuTnG2hZvs1. CI 38139672306 успешен: 10156 passed, 5 skipped, 10161 total / 498 suites. Рабочий backend alias переключён; health status=ok, database=up. Runtime preflight GET демо-сессии получил HTTP 200; запросы браузера к защищённым маршрутам также 200. Авторизация работает.

Контроль 15:41:43: 162.8 сек., total=15, executed=5, passed=0, failed=5. 4/ru — timeout первого кадра; 5/ru и 6/ru — выключенные позиции analysis/prompt. Скоростной PNG не устранил зависание полностью.

Найдена гонка: goto ждёт networkidle2, который разрешает два незавершённых запроса. Следующий click может увидеть степпер раньше завершения загрузки сессии; особенно при намеренно пропущенном кадре goto перед переходом к нужному шагу. Мастер публикует data-workflow-ready после гидратации; исполнитель ждёт этот сигнал перед дальнейшими действиями и съёмкой. Проверка действительно выключенных кнопок сохраняется.


### Биллинг восстановлен; контроль PR #34

Реальный серверный генератор успешно подготовил 15/15 сценариев: failed=0, deferred=0, narrationsDropped=0, costly=1, 138639 мс. Исторический Gemini 402 устранён; платёжные настройки при проверке не менялись.

PR #34 выпущен на main 5865922bac8eda952b02dcc63c52d61a60eb2a34, CI 38140748842 успешен. Backend и frontend Ready; оба рабочих legacy alias явно переключены на этот коммит. Новый деплой сам по себе не гарантирует обновление этих alias — переключение требует проверки при выпуске.

Контроль 15:58:06: 167.936 сек., executed=4/15, passed=0, failed=4. Зафиксированы timeout кадров 10/ru и greeting-references/ru; greeting-brief/ru не нашёл greetingProjectId. Tutorial ещё не принят.

Открытие тестового проекта создаёт сессию, а повторный пересев её не убирал. Подготовка теперь мягко удаляет только нерендерившиеся сессии конкретного fixture-проекта и пользователя, восстанавливает deletedAt проекта. Сессии с generationStatus сохраняются. 25 проверок fixture-seed и TypeScript прошли; production-подтверждение этого исправления ещё требуется.


### Неподвижные кадры Tutorial

Во время захвата PNG CSS-анимации и переходы временно отключаются; после захвата, включая отказ screenshot, стиль удаляется до следующего действия. Контент, видео и разрешение не скрываются и не меняются. Это снижает работу compositor при съёмке статичных кадров; устранение production-зависаний пока не доказано. 52 проверки исполнителя прошли, включая восстановление движения при успешной и неуспешной съёмке.


### Выпуск PR №35 и контроль 16:20

PR №35 выпущен на main 654a1ffb97b2e58dec08d1d20d811bbc956aa0d6, deployment dpl_6SZJcPLuTm32Z6GKEtEDXtw1VLeW; рабочий backend alias переключён. CI 38142231624: 10160 passed, 5 skipped, 10165 total / 498 suites. Runtime preflight HTTP 200, health/database up.

Контроль 16:20:24: executed=4/15, passed=0, failed=4, 167.653 сек. Кадры 2/ru и 4/ru всё ещё зависают, 3/ru получает выключенную кнопку анализа. Остановка CSS motion не устранила проблему Chromium; бриф в этом batch не выполнялся и пока не подтверждён production-проверкой.

Read-only SQL показал: у самой новой готовой сессии fixture-аккаунта анализ отсутствует, в фиксированных рекламных сессиях он complete. Выбор самого свежего рендера без проверки анализа открывает неподходящее состояние мастера. Резолвер теперь требует data.videoAnalysis.status=complete, сохраняя рамку владельца, типа проекта и готового рендера. 236 проверок исполнителя прошли. Скриншотный блокер остаётся открытым.


### PR №36: первый успешный production-проход

PR №36 выпущен на main f3ed9a15d3261a1e55e292fc175c5d13b096d920. CI 38143329118: 10160 passed, 5 skipped, 10165 total / 498 suites. Первый deployment остановился до build-логов; повторный dpl_7KgufzV4DSdmxqdtJwzcrD9WFHfc Ready, источник f3ed9a1 подтверждён, рабочий alias переключён.

Контроль 16:37:47: executed=4/15, passed=2, failed=2, 185.359 сек.; framesMissed=0, withoutFrames=0, assemblyTimeouts=0. SQL подтвердил ok у 6/ru и 9/ru; 7/ru — Target.createTarget timeout, 10/ru — screenshot timeout. Восстановление пустого брифа подтверждено SQL: active_brief_sessions=0. Полная приёмка пока не завершена.

Следующее исправление запускает отдельный процесс Chromium для каждого TMA-сценария. Закрытие страницы ограничено 5 секундами; закрытие браузера — 5 секундами с завершением только собственного дочернего процесса при зависании. После провалившегося сценария метаданные сборки/темы у страницы не запрашиваются. Неудачный повторный запуск браузера записывается как failed, поэтому частичный batch не становится ложно зелёным. 241 целевая проверка прошла; production-результат этого изменения ещё ожидается.


### Контроль PR №37 и выключенная ИИ-проверка качества

PR №37 выпущен на main 7ed4775389584c584a76ef2dfc960ad3ef8bf16e; CI 38144537678: 10165 passed, 5 skipped, 10170 total / 499 suites. Контроль 16:55:05: executed=3/15, passed=1, failed=2, 141.833 сек. Бриф открылся и дошёл до fill (шаг 4), затем timeout кадра; greeting-references — timeout первого кадра. Создание вкладок в этом batch не падало, но screenshot-блокер не снят.

SQL подтвердил complete-сборки 6/ru и 9/ru: по 4 кадра, 16367 и 21100 мс, reviewed=false. Cron опроса: polled=2, pending=0, failed=0. Записей quality для них нет: production-флаг был отсутствующим, проверка по умолчанию выключена. Добавлены quality-enabled и лимиты $0.25/день, 5 минут видео/день; их redeploy был отменён Ignored Build Step, поэтому runtime-включение ещё не подтверждено.

Скрипт теперь поддерживает временный VERCEL_FORCE_BUILD=1 для env-only выпуска. После Ready флаг следует удалить. Четыре проверки скрипта прошли; quality-проверка и полноценная запись всех сценариев остаются открытыми до фактического результата.


## Реальный quality-аудит и несоответствие greeting-video

Production quality включён на d5dbcd2: $0.25 и 5 минут в сутки именно для проверки видео; режим наблюдения, ручное одобрение сохраняется. 11.10 в 17:10 Киев база подтвердила complete/ok для 6, 8 и greeting-settings; complete/warn для greeting-video. Ошибок провайдера нет, reviewed=false. Предупреждение: 6.8–12.667 секунды озвучка описывает экспорт, экран показывает кнопку генерации (stepMatch 60).

Фикстурная сессия greeting-done имеет status=created, generationStatus=NULL. Готового поздравления нет. Исправление каталога отделяет карточку запуска от результата, даёт маршрут done и хук результата только для завершённого рендера. Валидатор темы greeting-video требует goto done и assertVisible результата, поэтому неверные сохранённые сценарии тоже будут отклонены при выполнении. Настоящий результат не подменяется заглушкой; нужны реальный рендер, регенерация сценария и повторная запись/quality-аудит.

Диагностика deadline теперь различает снимок и восстановление анимаций. Это уточнение причины, а не подтверждение устранения Chromium timeout. 186 целевых тестов прошли; полная production-приёмка остаётся открытой.


## Контроль 17:36 и программная отрисовка TMA

PR39 выпущен на 856a422, оба production Ready, legacy aliases переключены. CI 38147260300 успешен: 10 168 passed, 5 skipped, 10 173 total. Новый контроль: executed=2/15, passed=1 (2/ru), failed=1 (1/ru, screenshot шага 7), 144.369 секунды. Диагностика подтвердила фазу снимка, не восстановление CSS.

Следующее исправление отключает in-process SwiftShader GPU только для браузеров регресс-сценариев TMA; остальная browser-инфраструктура сохраняет свой профиль. Размер viewport, DPI, PNG, тема, локаль и ограничения платных действий не меняются. Это проверяемая гипотеза устранения native capture hang, а не подтверждённая причина. Требуется production-контроль после выпуска. fromSurface=false не используется: upstream Puppeteer исключает этот тест для chrome-headless-shell, поэтому такой обход не принят.

Основание для отказа от view-capture: [upstream TestExpectations Puppeteer](https://github.com/puppeteer/puppeteer/blob/main/test/TestExpectations.json). 266 целевых тестов прошли; TypeScript и lint также проверены.


## Native screenshot timeout follow-up

PR40 production batch passed 8/8. A second batch passed 5 and failed 2: the outdated greeting-video script was correctly rejected, and subject 1/ru timed out on fill after a skipped screenshot. Software rendering is therefore not a confirmed complete fix.

Native Puppeteer timeout errors previously took the nonfatal missing-frame path. The runner now treats a native capture timeout as fatal, names the capture phase and stops before the next action, allowing the service to dispose of that scenario browser. Ordinary transient screenshot failures retain their existing behavior. This fixes continuation on a potentially unhealthy CDP page; it does not establish the original cause of native hangs.

Validation: 56 runner tests passed, including three native timeout variants and no subsequent fill; backend TypeScript passed. Missing real completed greeting fixture remains an acceptance blocker.


Production log follow-up: deployment dpl_D8sgjwZPMSdhNUT6NpCo5Ueug8ws recorded subject 1/ru frame 3 failing with `Attempted to use detached Frame`, followed by fill timeout. Native timeout handling alone would not catch this actual loss of page. Fatal capture classification now also covers detached frame, target/session/connection closure, including failures during capture preparation/motion evaluation. A failed browser is disposed by the existing service isolation; restoration is not attempted after a fatal screenshot failure. No automatic retry or false success is introduced. 59 runner tests, backend TypeScript and targeted ESLint pass.


## Bounded production batch experiment

PR42 full CI passed (10175 backend tests, 3669 database tests). Released main fed6ea8, alias switched. Actual production control at 15:48 UTC: 9 executed, 5 passed, 4 failed, no missing frames. Failures now retain fatal capture cause (Target closed / detached Frame) rather than later fill timeouts. Browser stability remains unaccepted.

Add optional TUTORIAL_SCENARIO_RUN_MAX_PER_TICK (integer 1..30; default 30) for TMA planning only. Production trial uses 3. Existing theme/last-run rotation retains unselected scenarios for subsequent hourly ticks (09:05–23:05 UTC). This limits launches per invocation without changing paid-action guards, approval or marking deferred cases successful. This is a load mitigation experiment, not a proven explanation of the crashes. At a cap of 3, daily capacity is at most 45 selected scenario/theme runs before failures or other time limits; do not claim full daily coverage of all languages/themes.


## Real greeting and process-exit control (17:00 UTC)

The operator fixture render now completed through the real Gemini/Grok and voice pipeline. Final recorded cost: $2.12; voiced media loads in the browser (720x1280, 21.9s) and contains a non-silent AAC track. No generationStatus was fabricated. The ru greeting-video scenario was edited through the admin UI to goto greeting-video-done and assert greeting-video-result, with reviewed narration; it is now manual, preserving the corrected steps from generation. The first actual control at 17:01:31–17:02:02 UTC passed 1/1.

The 15 current ru cases were deliberately requeued by clearing only lastRunStatus; historical cron logs were preserved. First bounded batch 17:04:28–17:05:28 passed 3/3. Next batch 17:05:50–17:07:23 failed: 1 passed, 2 failed, framesMissed=1; 8/ru and 2/ru lost Target during capture. Thus cap=3 does not prove browser stability.

The owned browser cleanup previously sent SIGKILL without waiting for process exit, and exitCode=null also occurs on signal termination. Cleanup now checks signalCode, waits up to 2s for the owned child exit after killing, and rejects when exit cannot be confirmed, preventing the next launch in that invocation. Six focused cleanup tests cover normal exit, hanging CDP, close error, pending signal exit, already signal-terminated child and missing exit confirmation. This closes a resource-lifecycle gap; production root-cause resolution still requires control after release.


## Post-release acceptance of the current ru set

PR45 merged as 75d7b27. Scoped CI 38158695528 and broad CI 38158691392 succeeded (10191 backend tests passed, 5 skipped, 10196 total / 500 suites). Production viral-backend-j67cl2iyc built from that commit; legacy alias switched, health ok/database up.

Five consecutive manual invocations of the same cron handler after release: 17:24:46–17:25:48, 17:27:26–17:28:00, 17:28:47–17:29:47, 17:30:28–17:31:15, 17:32:27–17:33:24 UTC. Each executed and passed three scenarios, failed zero. All five have zero framesMissed, withoutFrames, assemblyTimeouts and themeMismatches. Fourth batch safely skipped one paid click; it does not certify that paid action. DB count confirms all 15 current ru cases lastRunStatus=ok after release, errors=0, including greeting-video.

Current ru TMA baseline accepted for this controlled series. Schedule remains daily 5 9-23 UTC, cap three. Other locales, complete coverage of both themes, long-term availability and client-site worker acceptance remain distinct checks. Earlier failed cron records remain intact. This result supports the lifecycle fix but does not establish it as the sole root cause of every historical Chromium failure.


## Follow-up: themes and real quality results (17:54 UTC)

An additional control passed 2/2, with one paid click safely skipped and no frame/browser errors. Persisted ru theme records are light 15/15 ok and dark 15/15 ok; these records include earlier controls, not thirty new post-release executions. Broad CI 38160389057 completed successfully. SQL now confirms 15 complete quality checks, all verdict=ok, total recorded cost 77185 microUSD; another 15 remain pending and are not accepted. Other locales, pending quality work and multi-day scheduled stability remain open.


### F.19. Очередь анализа качества и суточный лимит

SQL-проверка 11.10.2026 подтвердила 15 завершённых анализов с verdict=ok; суммарная учтённая стоимость $0.077185. Ещё 15 проверок остаются pending в фазе upload, attempts=0. Причина ожидания: «суточный лимит 5 мин видео выбран». nextAttemptAt для всех — 12.10.2026 00:00 UTC (03:00 по Киеву). Это штатная отсрочка по бюджету, а не отказ обработчика; лимит не увеличивался, успешные результаты не подменялись. После открытия следующего суточного окна требуется проверить фактическое завершение очереди.
