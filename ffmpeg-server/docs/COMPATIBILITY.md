# Матрица совместимости FFmpeg-сервера с командами платформы

ТЗ: `docs-tz/FFmpeg-server-spec-v1.1-RU.md`, этап A. Документ описывает, какие запросы платформы сервер принимает, что он отвергает и почему. Здесь же требования к шрифтам образа и лицензионные обязательства.

## 1. Источник истины — корпус

Корпус лежит в `ffmpeg-server/test/fixtures/command-corpus.json`. Его строит `backend/src/common/ffmpeg-corpus.ts`, вызывая сами генераторы команд с типичными и крайними параметрами. Крайние случаи:

- кириллица и украинские буквы ґ є і ї;
- кавычки `'` и `"`, двоеточия, `%`, `\`;
- несколько команд и несколько результатов в одной задаче;
- входы без расширения.

URL входов в корпусе заменены синтетическими `https://inputs.test/...`; расширение исходной ссылки сохраняется. Текстовые входы, которые потребитель собирает сам (SRT и ASS), лежат в `textInputs`.

Как корпус защищён от рассинхрона:

| Проверка | Где | Что ловит |
|---|---|---|
| Генераторы → файл корпуса | `backend/src/common/ffmpeg-corpus.spec.ts` | генератор изменили, а корпус не обновили. Обновление: `UPDATE_FFMPEG_CORPUS=1 npx jest src/common/ffmpeg-corpus.spec.ts` |
| Корпус → `parseJob` | `test/command/corpus.spec.ts` | каждая запись разбирается без ручной правки строк |
| Корпус ↔ allowlist | там же | allowlist ровно равен множеству фильтров, опций и кодеков корпуса, без лишнего |
| Корпус → настоящий ffmpeg | `test/executor/corpus-run.spec.ts`, `executor.spec.ts` | каждая запись выполняется на синтетических входах (lavfi testsrc/sine), и все outputs проходят `verifyOutputs` |

Изменили генератор — сначала обновите корпус. Если новая команда не проходит allowlist, расширяйте allowlist осознанно в `src/command/allowlist.ts`, а не ослабляйте sandbox.

## 2. Потребители

Найдено 10 потребителей (13 мест вызова) `FfmpegApiService.submit()`. Поиск шёл по `FfmpegApiService`, по инъекциям (`this.api`, `this.ffmpeg`, `@Optional() ffmpeg`) и по `submit(`.

| Потребитель (`product`) | Место вызова | Генератор | Записей в корпусе |
|---|---|---|---|
| postprod | `postprod.service.ts:start`, `reVoice`, `startExport` | `common/postprod.ts:planPostProduction`, `common/reframe.ts:planBatchReframe` | 7 |
| actors | `actors.service.ts:advanceSubtitleBurn` | `planPostProduction` | 1 |
| audio-track | `publishing/audio-track.service.ts:submitMix` | `common/postprod.ts:planAudioTrackJob` | 3 |
| portfolio | `portfolio-watermark.service.ts:submitJob` | `common/watermark.ts:buildWatermarkPlan` | 3 |
| shared-video | `shared-video-poster.service.ts:capture` | `common/poster-frame.ts:planPosterFrame` | 1 |
| client-site-tutorial | `client-site-tutorial-admin.service.ts:submitAssembly`, `submitVoicedAssembly` | `tutorial-video-assembly.ts:planSlideshow` + `tutorial-captions.ts:buildTutorialCaptionsAss` | 2 |
| tutorial-runner | `tutorial-scenario-runner.service.ts:submitVideoAssembly` | `planSlideshow` | 2 |
| tutorial-video-versions | `postprod/tutorial-video-versions.service.ts:submitVersion` | `planSlideshow` + ASS | 1 |
| story | `story-gifts/story-video.service.ts:create` | `story-video-plan.ts:planStorySegments` / `planStoryVideo` | 3 (одна — будущие стемы, `live: false`) |
| **tutorial-quality** | `tutorial-quality/demo-quality.service.ts:submitSignals` | `demo-quality-frames.ts:frameSignalsJob` | 1 |

**tutorial-quality отсутствует в списке ТЗ §2.1 и в списке `product` из Р-FF-6.** Это десятый потребитель: детекторы чёрных и замерших кадров, оплачиваемая задача. Пакету BE нужно добавить для него значение `product` (предлагается `tutorial-quality`), иначе он уйдёт без продукта.

`common/subtitles.ts` и `common/greeting-cards.ts` команд не строят. Они собирают SRT- и ASS-файлы, которые ложатся во входы и читаются фильтром `subtitles=`.

## 3. Что использует каждый потребитель

| Потребитель | Фильтры | Кодеки и форматы | Опции CLI | Входы → результат | Шрифты |
|---|---|---|---|---|---|
| postprod | crop, setsar, subtitles (SRT + `force_style`, ASS-карточки), scale, overlay, volume, atrim, apad, adelay, anull, asplit, aformat, sidechaincompress, amix `normalize=0`, loudnorm | libx264 / copy, aac / copy | `-filter_complex -vf -map -c:v -c:a -preset -crf -pix_fmt -b:a -metadata -movflags` | mp4, mp3, wav, png, srt, ass → mp4 | Arial; DejaVu Serif / Sans Condensed / Sans Mono (стили карточек) |
| actors | subtitles | libx264, aac copy | как у postprod | mp4 + srt → mp4 | Arial |
| audio-track | atempo, adelay, atrim, apad, volume, asplit, aformat, sidechaincompress, amix, loudnorm | aac → m4a (muxer ipod) | `-vn -t` | mp4, mp3 → m4a | — |
| portfolio | drawtext (без `fontfile`) | libx264, aac copy | `-vf` | mp4 → mp4 | шрифт fontconfig по умолчанию («Sans»), нужна кириллица |
| shared-video | — | mjpeg (неявно по `.jpg`, muxer image2) | `-ss` до `-i`, `-frames:v 1 -q:v` | mp4 → jpg | — |
| client-site-tutorial | scale, pad, setsar, concat, xfade, aresample, aformat, apad, atrim, asetpts, anullsrc (источник в графе), subtitles (ASS) | libx264, aac | `-framerate -loop 1 -t` (до `-i`), `-r -shortest` | png, mp3, ass → mp4 | Arial (стиль ASS) |
| tutorial-runner | дополнительно color (источник), format, geq, perspective, overlay `enable=` | libx264, aac | как выше | png, mp3 → mp4 | — |
| tutorial-video-versions | дополнительно fps, settb, setpts, tpad, trim, concat `n=2` | libx264, aac | как выше | png, mp3, ass, mp4 → mp4 | Arial |
| story | scale, pad (`color=`), setsar, fps, trim, setpts, aresample, aformat (mono 48 кГц), apad, atrim, asetpts, loudnorm, concat, asplit, sidechaincompress, volume, amix `normalize=0` | libx264, aac, `-ar 48000` | ведущий `ffmpeg`, `-loop 1 -framerate 25`, `-stream_loop -1` | входы без расширения (mp4, аудио, png) → mp4 | — |
| tutorial-quality | blackdetect, freezedetect, metadata `mode=print:file=` | `-f null -` | `-an` | mp4 → txt (результат пишет фильтр) | — |

Итог по allowlist (`src/command/allowlist.ts`):

- **35 фильтров**;
- **энкодеры:** libx264, aac, copy; mjpeg — неявно;
- **muxers:** mp4, ipod (`.m4a`), image2 (`.jpg`), null;
- **расширения результатов:** `.mp4`, `.m4a`, `.jpg`, `.txt` (`.txt` — только через `metadata=…:file=`);
- **демультиплексоры входов:** mov/mp4/m4a, matroska/webm, mp3, wav, aac, flac, ogg, image2, png_pipe, jpeg_pipe, webp_pipe; для ffprobe и фильтра `subtitles` ещё srt и ass.

## 4. Как сервер понимает команду

Строка не исполняется. Порядок разбора (`src/command/`):

1. **Токенизация** — подмножество POSIX sh для одного вызова:
   - `'…'` — буквально;
   - `"…"` — буквально, `\` снимается только перед `\ " $` и обратной кавычкой;
   - без кавычек `\x` → `x`.

   Неоднозначное для shell — 422 `UNSUPPORTED_COMMAND`:
   - `; & | < > ( )`;
   - перевод строки вне кавычек;
   - `$` и обратная кавычка вне одинарных кавычек;
   - `#` или `~` в начале слова;
   - `{a,b}`;
   - NUL и управляющие символы.

   Glob-символы `* ? [` остаются буквальными, как в shlex: корпус содержит `-map 0:a?` без кавычек.
2. Снимается только ведущий `ffmpeg` (он есть у Story).
3. **Опции CLI** разбираются по таблице: область действия, арность, допустимые stream specifier и проверка значения. Неизвестная опция — отказ. Входная опция перед выходом, выходная перед `-i` и висящие опции — тоже отказ.
4. **Фильтрграфы** (`-vf`, `-filter_complex`) разбираются по алгоритму libavfilter 6.1 с двумя уровнями экранирования. Проверяется:
   - имя фильтра по allowlist;
   - **ключи опций и позиционные значения — по allowlist конкретного фильтра** (`FILTER_SPECS`), ровно из корпуса. Тип значения задан для каждой опции: файл manifest, число в диапазоне, сторона или размер кадра, частота, длительность, выражение, enum или текст;
   - ключ с префиксом `/` (в FFmpeg 6.1 так значение опции читается из файла) отвергается всегда (аудит FF-SEC-01);
   - размеры кадров `scale`, `pad` и `color s=` — числом, в пределах профиля: длинная сторона ≤ 1920, короткая ≤ 1080, ≤ 24 MP; `-2` и `-1` допустимы как «по пропорции» (FF-SEC-02);
   - частоты (`fps`, `color r=`, `-r`, `-framerate`) ≤ `maxFps`;
   - длительности (`atrim`, `trim`, `apad`, `tpad`, `xfade`, `-t`, `-ss`) ≤ `maxInputDurationSec`;
   - выражения состоят только из идентификаторов корпуса (`EXPR_IDENTIFIERS`): `st`, `ld`, `while` и прочие не проходят;
   - `drawtext` принимается только с `expansion=none`;
   - бесконечные источники (`anullsrc`, `color`, `apad` без границы) ограничены своей опцией или следующим в цепочке `atrim`/`trim` (FF-SEC-03);
   - зацикленный вход (`-loop 1`, `-stream_loop`) принимается только с `-t` у входа или с `-t`/`-frames:v` у каждого выхода (FF-SEC-03);
   - файловые опции: `subtitles` (позиционная) читает, `metadata … file=` пишет только `.txt` и только при `mode=print`.

   Плейсхолдер вне файловой опции или «спрятанный» экранированием — отказ.
5. **Подстановка путей** — только в разобранных аргументах, в известных контекстах: `-i`, позиция выхода, файловые опции фильтров.

   | Ссылка | Путь в workspace |
   |---|---|
   | `{{ключ}}`, `inputs/ключ` | `inputs/<ключ>[.ext]` |
   | `{{имя}}` объявленного результата, `outputs/имя` | `outputs/<имя>` |
   | любой другой `{{имя}}` в позиции записи | промежуточный `work/<имя>` |

   Следующие команды цепочки могут читать результаты предыдущих. Двойная запись, чтение своего же результата и запись во вход — отказ. Объявленный, но не созданный результат — 400.
6. **Принудительные опции** добавляются без конфликта с заданными:
   - `-nostdin -hide_banner -y`;
   - `-filter_threads` и `-filter_complex_threads` ≤ `maxThreads`;
   - перед каждым `-i`: `-threads`, `-protocol_whitelist file,pipe`, `-format_whitelist <демультиплексоры входов>`;
   - перед каждым выходом: `-threads`, `-protocol_whitelist file,pipe`.

   Заданный клиентом `-threads` выше лимита урезается до лимита. `-y` не дублируется.
7. Executor добавляет `-progress pipe:1 -nostats` и независимо от `parseJob` ещё раз проверяет argv:
   - нет абсолютных путей и URL, `-i` указывает только внутрь попытки, threads не выше `maxThreads`;
   - в фильтрграфах нет `/`-ключей и запрещённых фильтров (`movie`, `sendcmd` и др.), файловые опции указывают только внутрь попытки;
   - нет CLI-опций, читающих файлы (`-filter_complex_script`, `-/opt` и др.).

### Что отвергается и почему

| Конструкция | Причина |
|---|---|
| URL или протокол в `-i` (`http:`, `file:`, `concat:`, `pipe:`) | executor читает только файлы задачи; сети у него нет |
| `-f` перед `-i` (`concat`, `lavfi`, `hls` и т.д.) | concat-демуксер и lavfi открывают произвольные файлы и источники |
| `movie=`, `amovie=`, `sendcmd`, `zmq`, `lv2`, `ladspa`, `frei0r` и любой фильтр вне корпуса | чтение файлов, сеть, загрузка плагинов |
| `drawtext fontfile=/textfile=`, `subtitles fontsdir=` | чтение произвольных файлов |
| абсолютные пути, `..`, `/dev/*` | выход за workspace |
| входы-плейлисты (m3u8, ffconcat) даже под видом `.srt` | ffprobe с `-format_whitelist` не открывает их → `INPUT_INVALID_MEDIA` до запуска |
| `.webm`, `.wav`, `.png`, `.gif` как результат; энкодеры VP9, x265, mp3 | в корпусе нет. ТЗ §3 п.5 называет WebM/VP9, но ни один генератор их не использует; кодеки без потребителя не включаются |
| `-n` (не перезаписывать) | конфликтует с обязательным `-y` |

## 5. Найденные несовместимости и замечания к генераторам

1. **Водяной знак: экранирование `'` и `%` (portfolio).** `escapeDrawtext` экранирует `'` как `\'` внутри `text='…'`. На уровне фильтрграфа `'` закрывает кавычку раньше, и текст ломается: ffmpeg пишет «Stray %», надпись искажается. Hosted-провайдер ведёт себя так же, потому что это свойство ffmpeg. Запись `portfolio/watermark-strong-escapes` проходит разбор и исполнение с тем же искажением, поведение не меняется. Исправлять — в генераторе платформы, отдельной задачей.
2. **`$` и обратная кавычка в пользовательском тексте водяного знака** (`watermarkMode = CUSTOM`). Такая команда отвергается (422): в shell это подстановка, и смысл строки зависит от исполнителя. `escapeDrawtext` их не экранирует. Рекомендация для платформы — экранировать (`\$`) или запрещать эти символы на вводе.
3. **tutorial-quality** — потребитель вне списка `product` (см. §2).
4. **Ветка `stickerScale = null` → фильтр `null`** в `planPostProduction` в корпус не попала: живые вызовы всегда передают масштаб. Фильтр `null` поэтому не в allowlist. Если ветка станет живой, добавьте запись в корпус и фильтр в allowlist.
5. **Story-стемы** (`music`, `effects`, ducking) — ветка генератора, которую сегодняшний вызов не включает (`live: false`). Она проверена на синтетике.
6. **Результат `metadata=print`** может быть пустым файлом (детекторы ничего не нашли). `verifyOutputs` принимает пустой `.txt`, но не пустое медиа.

## 6. Шрифты образа executor

Что запрашивают генераторы:

- `subtitles … force_style='FontName=Arial'` — SRT-субтитры всех тем;
- `Style: …,Arial,…` в ASS — подписи обучалок, карточки по умолчанию;
- `DejaVu Serif`, `DejaVu Sans Condensed`, `DejaVu Sans Mono` — `CARD_FONTS` карточек;
- `drawtext` без `fontfile` → шрифт fontconfig по умолчанию («Sans»).

Требования к образу:

1. **Обязательно `fonts-dejavu-core`** (или полный `fonts-dejavu`), чтобы были Condensed и Mono. DejaVu покрывает кириллицу, включая украинские ґ є і ї, и латиницу.
2. **fontconfig и алиасы:** `Arial` и `sans-serif` → `DejaVu Sans`. Либо поставить `fonts-liberation2`: Liberation Sans метрически совместим с Arial, и fontconfig подставляет его сам через `30-metric-aliases.conf`.

   Если Arial не найден и алиаса нет, libass пишет `fontselect: failed to find any fallback`, а `drawtext` падает с `Cannot find a valid font`.
3. Шрифты кладутся на **read-only volume** (`/usr/share/fonts/...` или отдельный каталог). `FONTCONFIG_FILE` указывает на конфиг с `<dir>` этого каталога, а `<cachedir>` — на tmpfs. Executor передаёт ffmpeg переменные `FONTCONFIG_FILE` и `FONTCONFIG_PATH`, HOME и `XDG_CACHE_HOME` указывают на `EXECUTOR_TMP_DIR`.
4. Microsoft Arial (`ttf-mscorefonts-installer`) **не ставить**: EULA запрещает распространение в составе образа.

Проверено тестом `executor.spec.ts › только DejaVu`: fontconfig видит только `/usr/share/fonts/truetype/dejavu` и алиас Arial → DejaVu Sans. На этом наборе SRT-, ASS- и drawtext-рендеры корпуса с кириллицей и украинскими буквами проходят без предупреждений о глифах. Capability smoke executor рендерит SRT с «Привіт, ґанок!» при каждом старте.

## 7. Лицензии

| Компонент | Лицензия | Комментарий |
|---|---|---|
| FFmpeg, собранный с `--enable-gpl` и libx264 | **GPL v2+** для всего бинарника | libx264 — GPL v2+. Без `--enable-gpl` libx264 не подключается |
| x264 | GPL v2+ | коммерческая лицензия x264 LLC нужна только для закрытого распространения |
| libass | ISC | |
| FreeType | FTL или GPL v2 (на выбор) | |
| HarfBuzz | MIT | |
| FriBidi | LGPL 2.1+ | |
| fontconfig | MIT-подобная | |
| встроенный энкодер aac | LGPL (часть FFmpeg) | **не использовать `libfdk_aac`**: «nonfree», с GPL-сборкой несовместим и нераспространяем |
| DejaVu | Bitstream Vera License + public domain | свободное распространение, можно в образе |
| Liberation 2.x | SIL OFL 1.1 | свободное распространение, можно в образе |
| Arial (Microsoft) | проприетарная (EULA) | в образ не включать |
| код ffmpeg-server | UNLICENSED (наш) | ffmpeg запускается отдельным процессом по argv, не линкуется, поэтому GPL на код сервиса не распространяется |

### Обязательства при распространении образа

- **Пока образ собирается и запускается только на нашем VPS, распространения нет.** Обязательства GPL v2/v3 возникают при передаче бинарников третьим лицам. AGPL у компонентов нет. Внутренний деплой через Dokploy, где образ доступен только нам, распространением не является.
- **Образ передаётся** — публичный или чужой registry, заказчик, подрядчик, вынос на сервер чужой организации. Тогда для FFmpeg, x264 и других GPL/LGPL-компонентов нужно:
  1. приложить тексты лицензий (GPL v2, LGPL 2.1, OFL 1.1, Bitstream Vera);
  2. предоставить полный соответствующий исходный код использованных версий, включая наши патчи и скрипты сборки (`configure`-флаги), или письменное предложение на 3 года (GPL v2 §3b);
  3. сохранить уведомления об авторских правах.
- **Пакеты дистрибутива** (`apt install ffmpeg` в Debian/Ubuntu-базе). Тексты лежат в `/usr/share/doc/<пакет>/copyright`, исходники доступны в архиве дистрибутива той же версии. В образе нужно сохранить `/usr/share/doc/*/copyright`, не удалять при «похудении». При передаче образа приложить ссылку на `apt-get source` той же версии.
- **Собственная сборка FFmpeg** (рекомендуется для фиксации digest и минимального набора). Минимум: `--enable-gpl --enable-libx264 --enable-libass --enable-libfreetype --enable-libfontconfig --enable-libfribidi --enable-libharfbuzz`, демультиплексоры и muxers из §3, без `--enable-nonfree`. Хранить tarball исходников и флаги рядом с Dockerfile или по ссылке на тег. Digest и `buildConfiguration` из capability self-test фиксируются в `capabilities.json`.
- Эталонная сборка тестов — FFmpeg 6.1.1 из Ubuntu 24.04: `6.1.1-3ubuntu5`, libass 0.17.1, x264 0.164.3108, fontconfig 2.15.0. В ней включено много лишнего: libx265, OpenCL, сетевые протоколы (srt, rist, ssh, zmq). Для production лучше минимальная сборка: меньше поверхность атаки и меньше компонентов с собственными лицензиями.

Решение о распространении образа и юридическая проверка — отдельно у владельца (ТЗ §14).
