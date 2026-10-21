# Пакет EXEC — отчёт

## Решения
- Р-FF-EXEC-1. Корпус строится вызовом генераторов: `backend/src/common/ffmpeg-corpus.ts` → `ffmpeg-server/test/fixtures/command-corpus.json` (24 записи, 10 потребителей; URL — `https://inputs.test/...`; SRT/ASS — в `textInputs`). `backend/src/common/ffmpeg-corpus.spec.ts` сравнивает по содержимому, а не по тексту: prettier не валит CI, изменение команды — валит. Обновление: `UPDATE_FFMPEG_CORPUS=1`.
- Р-FF-EXEC-2. Токенизатор реализует подмножество POSIX sh. Отвергаются: `$` и обратные кавычки вне одинарных кавычек, `; & | < > ( )`, перевод строки вне кавычек, `{a,b}`, `#`/`~` в начале слова, NUL. Glob-символы остаются буквальными, потому что в корпусе есть `-map 0:a?`.
- Р-FF-EXEC-3. Allowlist ровно равен корпусу, тест это проверяет. Фильтр `null` (недостижимая ветка `stickerScale=null`) не включён.
- Р-FF-EXEC-4. Пути: `inputs/<ключ>[.ext из пути URL]`; объявленные результаты → `outputs/`; незаявленные `{{имя}}` в позиции записи → `work/` (промежуточные файлы).
- Р-FF-EXEC-5. Принудительные опции:
  - перед каждым `-i`: `-threads`, `-protocol_whitelist file,pipe`, `-format_whitelist <демультиплексоры>`;
  - перед каждым выходом: `-threads`, `-protocol_whitelist`;
  - глобально: `-filter_threads` и `-filter_complex_threads`;
  - значения выше лимита урезаются.
- Р-FF-EXEC-6. ffprobe недоверенных медиа выполняется в executor: `control/probe-request.json` → `probe-result.json`, `ExecutorClient.probe`; sha256 считается на стороне API.
- Р-FF-EXEC-7. Захват попытки — `control/claim` (wx). Доказательство завершения после рестарта — `control/abandoned.json`: группа процессов убита, отсутствие процессов подтверждено. `isAlive=false` — только «heartbeat устарел».
- Р-FF-EXEC-8. `oom` = SIGKILL, который послали не мы, плюс один из признаков: рост `oom_kill` в cgroup v2 `memory.events` или ENOMEM в stderr. SIGKILL без признаков → `failed`.
- Р-FF-EXEC-9. Лимит записи: мониторинг `work/`+`outputs/` каждые 200 мс и финальная проверка; жёсткая граница — квота volume (этап C).
- Р-FF-EXEC-10. Разрешение не зависит от ориентации: длинная сторона ≤ 1920, короткая ≤ 1080. SAR растягивает ширину, поворот 90/270 меняет стороны местами.
- Р-FF-EXEC-11. Скачивание. Коды ошибок: FORBIDDEN_SOURCE, INPUT_EXPIRED (401/403/410), INPUT_TOO_LARGE, INPUT_DOWNLOAD_FAILED, TIMEOUT (общий дедлайн pipeline), CANCELED (signal). В сообщениях только хост. Порт по умолчанию 443.
- Р-FF-EXEC-12. Пустой `.txt`-результат валиден (signals.txt без находок), пустое медиа — нет.

## Пробелы контрактов (contracts.ts не менял)
- В ProbeStream нет SAR/pix_fmt/nb_frames → добавлен `ProbeStreamEx` (probe/probe.ts).
- В ExecutorDone нет interrupted/abandoned → `control/abandoned.json` и `ExecutorPoll.kind='abandoned'`.
- В ExecutorState добавлены поля `executorInstance` и `procStartTime` (лишние поля в JSON).
- Канала для probe нет → ProbeRequest/ProbeResponse в executor/protocol.ts.
- Heartbeat и capability self-test → `.executor/heartbeat.json`, `.executor/capabilities.json`.
