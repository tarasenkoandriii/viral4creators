/**
 * UiSnapshotRunnerService — крон-воркер `ui-snapshot-run` (Часть А ТЗ,
 * §3 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 100 — «Фаза 1»
 * дорожной карты §6.1).
 *
 * Обходит фиксированный список маршрутов TMA (§3.8 ТЗ — MVP: `ru`/
 * `light`, 5 маршрутов) настоящим headless-браузером против фикстурного
 * пользователя, снимает скриншот, маскирует заведомо переменные зоны
 * (`[data-qa-mask]`, см. ниже), считает перцептивный хэш
 * (`perceptual-hash.ts`) и сравнивает с хэшем предыдущего снимка ТОЙ ЖЕ
 * комбинации (routeKey × locale × theme). При расхождении — пишет
 * `UiSnapshot.changed = true` и шлёт тревогу через уже существующий
 * `TelegramNotifyService` (§3.7 ТЗ).
 *
 * ## Явный, сознательный пропуск Фазы 0 (§10, пункт 1 аудита; §6.1 ТЗ)
 *
 * §6.1 дорожной карты и пункт 1 аудита (§10) рекомендуют СНАЧАЛА один
 * ручной/разовый прогон (без крона, без прода) — убедиться, что подход
 * вообще ловит что-то полезное чаще, чем шумит, и только потом заводить
 * постоянный крон. Этот шаг здесь СОЗНАТЕЛЬНО пропущен по прямому
 * указанию владельца продукта («реализовать фазу 1 по ТЗ за один
 * проход») — та же модель принятия решений, что действует во всём этом
 * журнале правок (прямое указание — приоритет над собственными
 * рекомендациями ТЗ, см. `## Сделано (этап 100 — ...)` в
 * `PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`). Практическое следствие:
 * первые несколько прогонов будут больше похожи на ту самую "ручную
 * проверку" (снимки без предыдущей базы для сравнения — `comparedToUrl:
 * null`, `changed: false` по построению, см. `compareToLatest` ниже) —
 * реальная ценность сравнения появится начиная со второго снимка каждого
 * маршрута.
 *
 * ## Общая инфраструктура с Частью Б (§5 ТЗ) — переиспользование, не дублирование
 *
 * `common/headless-chromium.ts` (`launchHeadlessBrowser`/`withTimeout`,
 * этап 95) и `tutorial-runner/route-templates.ts`
 * (`resolveScenarioRoute`/`FixtureRouteContext`, этап 97) — уже готовая,
 * ничем не изменённая здесь общая инфраструктура, ровно то, о чём просит
 * §5 ТЗ («один общий модуль... часть А и часть Б вызывают один и тот же
 * модуль»). Отдельный полноценный «водитель»-модуль (`ui-crawler/`, как
 * дословно предлагает §5) не заведён — вместо этого прямой импорт двух
 * уже существующих чистых функций: не хватает третьей, содержательно
 * общей операции (скриншот-снятие в Части А не нужно Части Б, а
 * интерпретатор шагов `scenario-runner.ts` не нужен Части А), чтобы
 * оправдать отдельный модуль-обёртку поверх них.
 *
 * ## Разрешение фикстуры — сознательное дублирование, не общий сервис
 *
 * Чтение `FIXTURE_TELEGRAM_ID`/`FIXTURE_USER_TOKEN`/`TMA_PUBLIC_URL` и
 * `resolveFixtureContext()` ниже — тот же код, что уже есть в
 * `tutorial-scenario-runner.service.ts`. Не вынесено в общий сервис
 * сознательно: `tutorial-scenario-runner.service.ts` уже отгружен и
 * покрыт полным набором тестов (§5/§6.1 ТЗ, этапы 97/98), рефакторинг
 * его ради переиспользования двадцати строк создал бы риск регресса
 * уже проверенного кода Фазы 2 ради экономии дублирования в новом,
 * независимом от неё коде — тот же принцип "осознанное дублирование, не
 * оплошность", что уже документирует `route-templates.ts` про
 * собственную копию таблицы маршрутов фронтенда.
 *
 * ## Маскирование переменных зон — `data-qa-mask`, не список CSS-селекторов в бэкенде
 *
 * §3.5 ТЗ предлагает "список масок по маршруту" как конфиг на стороне
 * бэкенда; пункт 3 аудита (§10) прямо предупреждает, что такой список
 * незаметно устареет ("маски — это не разовая настройка... такой же
 * пункт чек-листа, как «обнови README»"). Вместо отдельного конфига —
 * единая HTML-разметка `data-qa-mask="<имя>"` прямо на элементах
 * фронтенда, которые реально показывают недетерминированный контент
 * (миниатюра/постер ролика, метка времени — см. `PostprodScreen.tsx`/
 * `VideoPlayer.tsx`, этап 100): перед скриншотом маскируется ВСЁ,
 * подходящее под один универсальный селектор `[data-qa-mask]`, а список
 * того, что именно маскируется, живёт рядом с самим кодом экрана, а не
 * в отдельном файле, который никто не помнит поддерживать.
 *
 * ## §10, пункт 6 аудита — "маршрут не изменился" ≠ "маршрут не удалось проверить"
 *
 * Каждый маршрут обрабатывается в собственном try/catch: сбой навигации/
 * скриншота/Blob-загрузки для ОДНОГО маршрута пишет строку с `error`
 * заполненным и `blobUrl`/`diffScore`/`changed` пустыми/false — НЕ
 * трактуется как "не изменилось" и не прерывает обход остальных
 * маршрутов батча.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ProjectType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { BlobService } from '../storage/blob.service';
import {
  launchHeadlessBrowser,
  withTimeout,
} from '../../common/headless-chromium';
import {
  attachFixtureToken,
  fixtureApiOrigin,
  FixtureTokenPage,
} from '../../common/fixture-token-page';
import {
  FixtureRouteContext,
  resolveScenarioRoute,
} from '../tutorial-runner/route-templates';
import { greetingContext } from '../tutorial-runner/tutorial-scenario-runner.service';
import {
  ChangeSensitivity,
  computeSnapshotHash,
  diffScore,
  hasChanged,
  resolveChangeSensitivity,
} from './perceptual-hash';
import {
  runScenario,
  type ScenarioPage,
} from '../tutorial-runner/scenario-runner';
import { CAPTURE_VIEWPORT } from '../tutorial-runner/tutorial-video-assembly';
import { UI_SNAPSHOT_BLOB_PREFIX } from './ui-snapshot-retention';
import { CLIENT_ROUND_BUDGET_MS } from '../client-site-tutorial/chromium-page-explorer';
import type { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';
import {
  SPA_LOCALE_STORAGE_KEY,
  SPA_SESSION_STORAGE_KEY,
  SPA_THEME_STORAGE_KEY,
} from '../../common/spa-storage-keys';

/** Значения по умолчанию — те же, что были единственно возможными в MVP
 * (§3.8 ТЗ `doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md`). Поля
 * `UiSnapshot.locale/theme` остаются свободной строкой (не enum) именно
 * ради расширения за пределы этой пары, и этап H ТЗ
 * `docs-tz/TZ-Enterprise-Tutorial-Landing.md` им наконец пользуется.
 *
 * ## Что при этом вскрылось: до этапа H это были ЯРЛЫКИ, а не настройки
 *
 * Прогон записывал `locale: 'ru'`, `theme: 'light'` в каждую строку — и
 * НИГДЕ их не применял. Страница открывалась в том виде, в каком её
 * отдаёт фронтенд по умолчанию, а совпадение с ярлыком держалось на
 * том, что `defaultLocale` там тоже `'ru'`, а headless-Chromium по
 * умолчанию светлый. То есть поле говорило правду случайно и перестало
 * бы говорить её в день, когда кто-нибудь поменяет умолчание.
 *
 * Теперь локаль и тема ВЫСТАВЛЯЮТСЯ до загрузки SPA — через те же
 * ключи `localStorage`, что пишет сам продукт (`v4c_locale` в
 * `frontend/src/lib/i18n.ts`, `v4c_theme` в `lib/theme.ts`). Явный выбор
 * человека приоритетнее автоматики и в продукте, и здесь — то есть
 * снимок получается ровно той комбинации, которой подписан. */
const DEFAULT_LOCALE = 'ru';
const DEFAULT_THEME: SnapshotTheme = 'light';

/** Пять маршрутов §3.8 ТЗ — те же, что нужны Части Б для сценариев
 * обучающих видео (§4.5 ТЗ), фикстуры и обоснование выбора не
 * дублируются, см. доккомментарий `route-templates.ts`. */
const MVP_ROUTE_KEYS = [
  'generate',
  'projects',
  'manifests',
  'postprod',
  'postprod-video',
] as const;

/** Общий бюджет времени на весь тик — тот же приём, что
 * `CLEANUP_TIME_BUDGET_MS`/`SWEEP_TIME_BUDGET_MS`
 * (`cron-jobs.service.ts`) и `RUN_DEADLINE_MS`
 * (`tutorial-scenario-runner.service.ts`): пять маршрутов — секунды
 * каждый, но общий бюджет всё равно нужен на случай зависшей навигации.
 */
const RUN_TIME_BUDGET_MS = 2 * 60 * 1000;

/** Таймаут одного маршрута (навигация + маскирование + скриншот) — тот
 * же порядок величины, что у шага сценария в `scenario-runner.ts`
 * (`DEFAULT_STEP_TIMEOUT_MS`), не общий таймаут сценария: здесь на
 * маршрут ровно одна операция, не до тридцати шагов. */
const ROUTE_TIMEOUT_MS = 20_000;

/** Вьюпорт — фиксированный размер мобильного экрана: TMA открывается
 * внутри Telegram на телефоне (§0 ТЗ), а сравнение отпечатков имеет
 * смысл только при одинаковом размере кадра между прогонами. */
const VIEWPORT = CAPTURE_VIEWPORT;

/**
 * Потолок на ОДИН съёмочный шаг. Больше умолчания исполнителя
 * сценариев (15 с) осознанно: один из шагов съёмки — клик
 * «Исследовать», за которым сервер поднимает собственный
 * headless-браузер и обходит чужую страницу
 * (`chromium-page-explorer.ts`). Пятнадцати секунд на это мало, и
 * прогон обрывался бы на самом интересном месте — ровно там, где
 * начинаются кадры, ради которых всё и затевалось.
 *
 * ## Почему это ВЫРАЖЕНИЕ, а не 45 секунд
 *
 * Сорок пять здесь стояло числом и совпадало с `ROUND_TIMEOUT_MS`
 * сервера — но сервер отсчитывает свои сорок пять ПОСЛЕ запуска
 * браузера, а наблюдатель ждёт вместе с ним. То есть две границы на
 * одну операцию, и меньшая — у того, кто ждёт: сервер честно
 * доделывал раунд (и тратил слот суточного лимита), а съёмка уже
 * записала шаг провалившимся (аудит собственных правок 29.09.2026).
 *
 * Теперь ожидание выведено из настоящего бюджета раунда, и разойтись
 * им негде.
 */
const CAPTURE_STEP_TIMEOUT_MS = CLIENT_ROUND_BUDGET_MS;

/**
 * Маски ЛИЧНОГО ТЕКСТА — `data-qa-mask="personal-…"` (этап I ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`, §5.3).
 *
 * ## Почему у них отдельный префикс, а не общий `[data-qa-mask]`
 *
 * Общие маски — про ПЕРЕМЕННОЕ (постер ролика, кадр чужого сайта,
 * дата): крону они шум, а снимку для лендинга — весь смысл, поэтому
 * немаскированный прогон их не трогает (`UiSnapshotRunOptions.unmasked`).
 * Имя получателя, личное пожелание, текст сценария — другое: их нельзя
 * показывать НИКОМУ. Правило образца (§5.5 ТЗ лендинга обучалки)
 * запрещает выдуманные имена на маркетинговом кадре, а кадр мастера
 * поздравлений без имён не снять — они в каждом втором поле.
 *
 * Поэтому личные маски действуют в ОБОИХ режимах. Одним списком
 * селекторов в бэкенде это было бы нельзя — он устарел бы при первой
 * правке мастера (см. доккомментарий модуля); префикс живёт на самих
 * полях, а шов во фронтенде (`frontend/scripts/greeting-steps.test.ts`)
 * держит, что поля мастера им помечены и что префикс там тот же.
 *
 * ## Почему размытие, а не `visibility: hidden`
 *
 * Поле с именем — это и рамка поля. Спрятанное целиком, оно оставляет
 * на кадре дыру посреди формы, и «вот здесь пишут имя» пропадает
 * вместе с именем. Прозрачный текст с размытой тенью оставляет рамку и
 * силуэт строки, а буквы прочесть нельзя.
 *
 * Подсказка-плейсхолдер у помеченного поля скрыта ТОЖЕ, и это
 * намеренно (аудит этапа I): `-webkit-text-fill-color` наследуется в
 * `::placeholder`, а у титров плейсхолдер — подсказка, собранная из
 * брифа, то есть с именем получателя. Правила, возвращающего
 * плейсхолдеру цвет или снимающего с него размытие, здесь быть не
 * должно — спек это проверяет.
 */
export const PERSONAL_TEXT_MASK_PREFIX = 'personal-';

export const PERSONAL_TEXT_MASK_CSS =
  `[data-qa-mask^="${PERSONAL_TEXT_MASK_PREFIX}"]` +
  '{color:transparent!important;-webkit-text-fill-color:transparent!important;' +
  'text-shadow:0 0 9px rgba(128,128,128,.9)!important}';

/** Сколько ждать, пока у ролика в кадре появится картинка. Сверх — кадр
 *  снимается как есть: чёрный плеер заметит отбор §3, а ронять прогон
 *  ради медленного Blob незачем. */
const MEDIA_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Заморозка движения перед снимком СРАВНИВАЕМОГО прогона (разбор
 * «мигания» крона 30.09.2026).
 *
 * ## Что мигало
 *
 * На проде `changed=1` приходил парами через две минуты («экран
 * поменялся» → «вернулся») с интервалом 10–30 минут и в произвольные
 * минуты часа — то есть не по расписанию соседних кронов (обучалка
 * ходит в :00–:05, остальные либо раз в сутки, либо тем же темпом раз в
 * две минуты), а случайно. Пара означает одно промежуточное состояние
 * длиной в один тик — то есть не данные поменялись, а кадр был снят
 * в другой момент жизни страницы.
 *
 * Источник, который виден на КАЖДОМ из пяти маршрутов: словесный знак
 * «Viral4Creators» в шапке (`App.tsx`, класс `.sheen`) — бесконечная
 * анимация градиента (`sheen 6s linear infinite`, tailwind.config.js),
 * от тёмного `#1f2733` до светлого `#8892a6` по буквам. Фаза в кадре =
 * (время от монтирования приложения до снимка) mod 6 с. Обычно это
 * время почти одинаково от тика к тику, и фаза тоже; но стоит одному
 * запросу к API задержаться на секунду-другую (холодный старт функции),
 * фаза уезжает, пять клеток сетки 12×24 в верхней строке меняют
 * яркость больше порога — «изменилось». Следующий тик с обычной
 * задержкой — «вернулось». Тот же механизм у `animate-fadeIn` корня
 * каждого экрана (0,2 с) и у крутящегося `Spinner`.
 *
 * ## Почему заморозка, а не маска
 *
 * Маска на знак убрала бы шапку из-под наблюдения, а сломанную шапку
 * крон как раз должен замечать. `animation: none` ставит элемент в его
 * собственный, неанимированный стиль: знак — в начальную позицию
 * градиента, экран — в полностью проявленный. Кадр от этого перестаёт
 * зависеть от того, КОГДА он снят, и не теряет ничего из того, ЧТО на
 * нём. Правило действует на весь документ, то есть и на анимацию,
 * которую кто-нибудь добавит завтра, — список селекторов в бэкенде
 * здесь устарел бы так же, как устарел бы список масок (см.
 * доккомментарий модуля).
 *
 * Немаскированному прогону (кадры лендинга) заморозка не ставится: он
 * ни с чем не сравнивается, а поведение его кадров здесь не меняется.
 */
export const FREEZE_MOTION_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;' +
  'caret-color:transparent!important}';

/**
 * Оседание сравниваемого кадра — вторая половина того же разбора.
 *
 * `goto(..., networkidle2)` отпускает, когда в полёте НЕ БОЛЕЕ ДВУХ
 * запросов. У оболочки приложения их на старте больше двух: `/me/plan`
 * (от него зависят пилюля режима в шапке, `AccountNotice` и замки
 * `useFeature` — у `postprod-video` это `LockedNote` против
 * `PublishPanel`), `/telegram-login/me`, данные самого экрана, `persona/me`
 * у `manifests`, расчёт цены и готовность у мастера, шрифты Google Fonts
 * с `display=swap` (JetBrains Mono запрашивается только когда
 * отрисовался список со счётчиками). Задержись два из них — кадр
 * снимается со спиннером, без пилюли режима или запасным шрифтом, и это
 * та же пара «изменилось/вернулось».
 *
 * Поэтому перед снимком: полное затишье сети (ноль запросов, а не два),
 * загруженные шрифты и ни одного `Spinner` на экране (`animate-spin` —
 * единственный класс, которым его рисует `components/ui/Spinner.tsx`).
 * Оба ожидания мягкие: экран, который так и не осел, снимается как есть
 * — «висит на загрузке» тоже изменение, о котором крон обязан сказать.
 */
const SETTLE_NETWORK_IDLE_MS = 500;
const SETTLE_TIMEOUT_MS = 5_000;

export type SnapshotTheme = 'light' | 'dark';

export interface UiSnapshotRunOptions {
  /** Код локали продукта (`ru`/`uk`/`en`/…). По умолчанию `ru`. */
  locale?: string;
  /** По умолчанию `light`. */
  theme?: SnapshotTheme;
  /** Подмножество маршрутов. По умолчанию — те же пять, что у крона. */
  routeKeys?: readonly string[];
  /**
   * Снять БЕЗ маскирования `[data-qa-mask]`.
   *
   * Ради этого флага этап H и появился. Один и тот же механизм масок
   * нужен двум потребителям с противоположными желаниями: крону
   * регрессий кадр чужого сайта — чистый шум (он меняется каждый
   * прогон, отпечаток расходился бы всегда, и тревога перестала бы
   * что-либо значить), а снимку для лендинга этот кадр — весь смысл.
   *
   * Немаскированный прогон поэтому **не участвует в сравнении вовсе**:
   * строка `UiSnapshot` не пишется, тревога не шлётся, файл ложится под
   * другой префикс в Blob. Иначе он подменил бы базовый отпечаток, и
   * следующий тик крона честно закричал бы «изменилось» на собственном
   * же снимке. Адрес файла возвращается в `outcomes[].blobUrl` —
   * оператор забирает его оттуда.
   */
  unmasked?: boolean;
  /**
   * Слать ли тревоги в служебный канал. По умолчанию да — так ходит
   * крон, у которого нет человека, читающего результат.
   *
   * Прогон по кнопке оператора ставит `false`, и это правка аудита:
   * первая редакция этапа H рассуждала, что «молчание — худший ответ»,
   * и слала тревогу в общий канал даже при ручном вызове. Молчания там
   * нет — вызывающий получает весь результат синхронно, в ответе HTTP.
   * А вот канал засорялся сообщениями о сбоях, которые человек уже
   * видит и уже чинит.
   */
  alerts?: boolean;
  /**
   * Плотность пикселей кадра (CSS-пиксель → сколько растровых). По
   * умолчанию 1 — так ходит крон.
   *
   * Понадобилось на проде в этапе I: вьюпорт здесь 390×844 CSS-пикселей,
   * и при плотности 1 файл выходит ровно 390×844 растровых. Лендингу
   * нужен кадр шириной 780 — то есть тот же экран, снятый плотностью 2.
   * Растянуть 390 до 780 постобработкой нельзя: это не резкость, а её
   * имитация, и `scripts/tutorial-frames-process.mjs` такой вход
   * отклоняет.
   *
   * **Только вместе с `unmasked`.** Плотность меняет размер кадра, а
   * размер кадра меняет отпечаток: маскированный прогон с плотностью 2
   * записал бы в базу строку, не сравнимую ни с одной прежней, и
   * следующий тик крона честно закричал бы «изменилось». Поэтому
   * сочетание отвергается, а не молча исправляется — молчаливое
   * исправление вернуло бы оператору кадр 390px, который он заметит
   * только на шаге обработки.
   */
  deviceScaleFactor?: number;
  /**
   * Довести экран до нужного состояния ПЕРЕД съёмкой, снимая кадр
   * после каждого шага.
   *
   * Заведено 27.09.2026, когда выяснилось, чем этап I на самом деле
   * упирался. Две из четырёх карточек лендинга («вставили ссылку»,
   * «заполнили и нажали») — это МГНОВЕННЫЕ состояния браузера: текст в
   * поле до отправки живёт только в React, в базе его нет. Прогон,
   * который просто открывает маршрут, снимал вместо них пустую форму,
   * и `doc/TUTORIAL-FRAMES-CAPTURE.md` сделал из этого вывод «нужны
   * руки человека на всех четырёх».
   *
   * Вывод был неверен. Такие состояния снимаются — просто не открытием
   * маршрута, а действиями на нём. Словарь шагов и исполнитель уже
   * существуют в соседнем модуле (`scenario-runner.ts`, из его кадров
   * собираются обучающие ролики): он снимает кадр после КАЖДОГО
   * успешного шага, то есть «ссылка вставлена, но не отправлена» —
   * это кадр между `fill` и `click`.
   *
   * Здесь же, в отличие от исполнителя сценариев, правильный вьюпорт
   * (390×844) и плотность — ровно то, чего лендингу не хватало.
   *
   * **Только вместе с `unmasked`,** по той же причине, что и
   * плотность, и по ещё одной, более важной: шаги МЕНЯЮТ состояние
   * продукта (создают черновик, отправляют формы). Прогону, который
   * пишет отпечаток в базу и сравнивает, действовать нельзя вовсе.
   *
   * `goto` внутри шагов запрещён: маршрут уже открыт этим прогоном, а
   * второй переход увёл бы кадр с маршрута, которым он подписан.
   */
  steps?: readonly ScenarioStep[];
  /**
   * Прокрутить экран к секции перед итоговым кадром (этап I ТЗ
   * Greeting 2.0, §5.3).
   *
   * Мастер поздравления — одна длинная лента из девяти карточек, а кадр
   * — это окно 390×844. «Характер ролика», сценарий и готовый ролик
   * лежат ниже первого экрана, и открытие маршрута снимало бы бриф
   * каждый раз. Степпер мастера тоже прокручивает, но плавно, и кадр
   * после клика ловил бы середину прокрутки.
   *
   * Селектор ждётся видимым (тот же предел, что у шага), затем экран
   * мгновенно ставится так, чтобы секция начиналась под липкой шапкой
   * приложения. Не нашлась — это ошибка маршрута, а не кадр верха
   * страницы под чужой подписью. Ролик в кадре дожидается картинки
   * (best-effort, `MEDIA_SETTLE_TIMEOUT_MS`).
   *
   * **Только вместе с `unmasked` и ровно с одним маршрутом** — по тем же
   * причинам, что `steps`: прокрученный экран даёт иной отпечаток, а
   * селектор пишется под конкретный экран.
   */
  scrollTo?: string;
}

/** Кадр, снятый ПОСЛЕ съёмочного шага `stepIndex` (0-based). */
export interface UiSnapshotStepShot {
  stepIndex: number;
  url: string;
}

export interface UiSnapshotRouteOutcome {
  routeKey: string;
  changed: boolean;
  error?: string;
  /** Заполняется у немаскированных прогонов: строки в БД нет, и это
   *  единственный способ добраться до файла. */
  blobUrl?: string;
  /**
   * Кадры съёмочных шагов — по одному после каждого УСПЕШНОГО шага, в
   * порядке шагов, каждый со своим номером шага.
   *
   * Номер шага, а не позиция в массиве, — правка аудита этапа A ТЗ
   * `docs-tz/TZ-Tutorial-Video-Voiced.md`. До неё здесь лежал плоский
   * `string[]`, и потребитель (`tutorial-frames-capture.service.ts`)
   * брал кадр по позиции. Скриншот снимается best-effort: единичный
   * сбой глотается, чтобы не ронять прогон, — и тогда массив
   * становился короче, все последующие кадры съезжали на позицию
   * назад, а карточка лендинга подписывалась ЧУЖИМ экраном. Молча:
   * кадр есть, он правдоподобен, просто не тот.
   *
   * Итогового кадра всей страницы здесь НЕТ — он в `blobUrl`. Раньше
   * он дописывался в конец этого же массива, и «последний элемент»
   * значил то итоговый кадр, то последний шаговый (на оборванном
   * прогоне), смотря как закончилось.
   */
  shots?: UiSnapshotStepShot[];
  /**
   * Сколько шагов выполнено. Меньше, чем просили, — значит сценарий
   * оборвался; причина в `error`. Без этого числа «кадров меньше, чем
   * шагов» пришлось бы толковать на глаз.
   */
  stepsDone?: number;
}

export interface UiSnapshotRunResult {
  /** Заполнено, если прогон пропущен целиком (фикстура не настроена/не
   * заведена, браузер недоступен) — тот же приём, что
   * `TutorialScenarioRunResult.skipped`. */
  skipped?: string;
  total: number;
  changed: number;
  failed: number;
  outcomes: UiSnapshotRouteOutcome[];
  /**
   * Сколько маршрутов не успели снять: общий бюджет времени кончился
   * раньше. У крона это норма (доснимет следующий тик), у ручного
   * прогона — объяснение, почему `outcomes` короче, чем просили. Без
   * этого поля обрезка была молчаливой: `total` говорил одно, длина
   * списка другое, и разбираться приходилось глазами.
   */
  deferred?: number;
}

@Injectable()
export class UiSnapshotRunnerService {
  private readonly logger = new Logger(UiSnapshotRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
    private readonly blob: BlobService,
  ) {}

  async run(options: UiSnapshotRunOptions = {}): Promise<UiSnapshotRunResult> {
    const locale = options.locale?.trim() || DEFAULT_LOCALE;
    const theme = options.theme ?? DEFAULT_THEME;
    const unmasked = options.unmasked === true;
    const alerts = options.alerts !== false;
    const deviceScaleFactor = options.deviceScaleFactor ?? 1;
    if (deviceScaleFactor !== 1 && !unmasked) {
      // См. `UiSnapshotRunOptions.deviceScaleFactor`: иной размер кадра —
      // иной отпечаток, и маскированный прогон испортил бы базу сравнения.
      throw new Error(
        'deviceScaleFactor > 1 допустим только вместе с unmasked: иначе прогон подменит базовый отпечаток крона',
      );
    }
    const routeKeys =
      options.routeKeys && options.routeKeys.length > 0
        ? [...options.routeKeys]
        : [...MVP_ROUTE_KEYS];

    const steps = options.steps ?? [];
    if (steps.length > 0 && !unmasked) {
      // Причина строже, чем у плотности: шаги МЕНЯЮТ состояние
      // продукта (создают черновик, отправляют формы). Прогону,
      // который пишет отпечаток и сравнивает, действовать нельзя.
      throw new Error(
        'steps допустимы только вместе с unmasked: шаги меняют состояние продукта, а сравниваемый прогон обязан быть наблюдателем',
      );
    }
    const scrollTo = options.scrollTo?.trim() || undefined;
    if (scrollTo && !unmasked) {
      throw new Error(
        'scrollTo допустим только вместе с unmasked: прокрученный экран подменил бы базовый отпечаток крона',
      );
    }
    if (scrollTo && routeKeys.length !== 1) {
      throw new Error(
        'scrollTo требует ровно одного маршрута в routeKeys: селектор секции пишется под конкретный экран',
      );
    }
    if (steps.length > 0 && routeKeys.length !== 1) {
      // Шаги написаны под конкретный экран. Прогнать их по пяти
      // маршрутам значит выполнить их на четырёх чужих — где селекторы
      // либо не найдутся (и прогон встанет), либо, хуже, найдутся не
      // те. Требуем ровно один маршрут, а не берём первый молча.
      throw new Error(
        'steps требуют ровно одного маршрута в routeKeys: шаги пишутся под конкретный экран',
      );
    }

    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    const token = process.env.FIXTURE_USER_TOKEN?.trim();
    const tmaBaseUrl = process.env.TMA_PUBLIC_URL?.trim();
    if (!telegramId || !token) {
      this.logger.warn(
        'FIXTURE_USER_TOKEN/FIXTURE_TELEGRAM_ID не настроены — пропуск (см. .env.example)',
      );
      return this.skip('фикстурный вход не настроен');
    }
    if (!tmaBaseUrl) {
      this.logger.warn('TMA_PUBLIC_URL не настроен — пропуск');
      return this.skip('TMA_PUBLIC_URL не настроен');
    }
    // Токен — только на origin своего API (`fixture-token-page.ts`,
    // этап I ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md). Этот прогон ходит
    // каждые две минуты, и до правки каждый раз отдавал токен Google
    // Fonts и telegram.org.
    const apiOrigin = fixtureApiOrigin();
    if (!apiOrigin) {
      this.logger.warn(
        'API_PUBLIC_URL не настроен или не разбирается — пропуск: без него фикстурный токен ушёл бы и сторонним сайтам',
      );
      return this.skip('API_PUBLIC_URL не настроен');
    }

    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      this.logger.warn(
        `фикстурный пользователь telegramId=${telegramId} не найден — запустите npm run seed:fixture-user`,
      );
      return this.skip('фикстурный пользователь не заведён');
    }

    const ctx = await this.resolveFixtureContext(user.id);
    // Служебная сессия нужна ровно одному маршруту — мастеру
    // (`generate`), который без неё создаёт новую на каждом
    // монтировании. Прогон, в который этот маршрут не входит, её не
    // трогает: иначе разовый снимок одного экрана заводил бы
    // пользователю строку в `Session` ни за чем (правка аудита).
    const wizardSessionId = routeKeys.includes('generate')
      ? await this.ensureWizardSession(user.id)
      : undefined;

    const launched = await launchHeadlessBrowser();
    if ('error' in launched) {
      this.logger.warn(`headless-браузер недоступен: ${launched.error}`);
      if (alerts) {
        await this.notify.alert(
          'ui-snapshot-run:browser',
          `Крон-обход UI-снимков: браузер не запустился. ${launched.error}`,
        );
      }
      return {
        total: routeKeys.length,
        changed: 0,
        failed: routeKeys.length,
        outcomes: routeKeys.map((routeKey) => ({
          routeKey,
          changed: false,
          error: launched.error,
        })),
      };
    }

    const { browser } = launched;
    const outcomes: UiSnapshotRouteOutcome[] = [];
    let deferred = 0;
    const deadline = Date.now() + RUN_TIME_BUDGET_MS;
    try {
      for (const routeKey of routeKeys) {
        if (Date.now() >= deadline) {
          deferred = routeKeys.length - outcomes.length;
          this.logger.warn(
            `тик исчерпал бюджет времени — ${deferred} маршрутов отложено до следующего прогона`,
          );
          break;
        }
        const outcome = await this.captureOne(
          browser,
          routeKey,
          ctx,
          token,
          apiOrigin,
          tmaBaseUrl,
          wizardSessionId,
          { locale, theme, unmasked, deviceScaleFactor, steps, scrollTo },
        );
        outcomes.push(outcome);
        // Сбой снять НАДО сообщить в любом прогоне: немаскированный
        // прогон запускает человек, и «ничего не пришло» без объяснения
        // — худший ответ.
        if (!alerts) {
          // Ручной прогон: вызывающий уже держит `outcomes` в руках.
        } else if (outcome.error) {
          await this.notify.alert(
            `ui-snapshot-run:${routeKey}:error`,
            `Крон-обход UI-снимков: маршрут «${routeKey}» не удалось проверить: ${outcome.error}`,
          );
        } else if (outcome.changed) {
          // А вот «изменилось» у немаскированного прогона не бывает по
          // построению: он ни с чем не сравнивается (см.
          // `UiSnapshotRunOptions.unmasked`).
          await this.notify.alert(
            `ui-snapshot-run:${routeKey}:changed`,
            `Крон-обход UI-снимков: внешний вид маршрута «${routeKey}» изменился (locale=${locale}, theme=${theme}).`,
          );
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    return {
      total: routeKeys.length,
      changed: outcomes.filter((o) => o.changed).length,
      failed: outcomes.filter((o) => o.error).length,
      outcomes,
      ...(deferred > 0 ? { deferred } : {}),
    };
  }

  private async captureOne(
    browser: import('puppeteer-core').Browser,
    routeKey: string,
    ctx: FixtureRouteContext,
    token: string,
    /** Origin API — единственный адресат токена. */
    apiOrigin: string,
    tmaBaseUrl: string,
    wizardSessionId: string | undefined,
    view: {
      locale: string;
      theme: SnapshotTheme;
      unmasked: boolean;
      deviceScaleFactor: number;
      steps: readonly ScenarioStep[];
      scrollTo?: string;
    },
  ): Promise<UiSnapshotRouteOutcome> {
    let page: import('puppeteer-core').Page | undefined;
    try {
      const resolved = resolveScenarioRoute(routeKey, ctx);
      if (!resolved.ok) {
        return this.recordFailure(routeKey, resolved.reason, view);
      }

      page = await browser.newPage();
      await page.setViewport({
        ...VIEWPORT,
        deviceScaleFactor: view.deviceScaleFactor,
      });
      // Тот же приём, что `TutorialScenarioRunnerService.runOne`: токен
      // получает каждый XHR SPA к API бэкенда — и больше никто. Прежний
      // `setExtraHTTPHeaders` прикладывал его ко всем запросам страницы.
      await attachFixtureToken(
        page as unknown as FixtureTokenPage,
        token,
        apiOrigin,
      );
      // Мастер (`useWorkflow`) при пустом `localStorage['sessionId']`
      // создаёт НОВУЮ сессию на каждом монтировании. У свежего
      // headless-браузера хранилище всегда пустое, поэтому каждый тик
      // крона (раз в 2 минуты) оставлял у фикстурного пользователя
      // пустую сессию `created` — в админке это выглядело как поток
      // фейковых сессий. Подкладываем одну постоянную служебную сессию
      // ДО загрузки SPA: мастер её восстанавливает и ничего не создаёт.
      //
      // Тот же ключ подсевает и `TutorialScenarioRunnerService` — ради
      // другого: открыть мастер на ПРОЙДЕННОЙ сессии (маршрут
      // `generate-ready`). Приём здесь появился раньше и работал, но
      // сценарный раннер его не перенял, и шесть сценариев из девяти
      // молча открывали пустой мастер до 29.09.2026. Константа общая
      // (`SPA_SESSION_STORAGE_KEY`) именно поэтому: литерал в двух
      // местах уже однажды означал, что второе место про первое не
      // знает.
      if (wizardSessionId) {
        await page.evaluateOnNewDocument(
          (id: string, key: string) => {
            try {
              window.localStorage.setItem(key, id);
            } catch {
              // хранилище недоступно — мастер создаст сессию, как раньше
            }
          },
          wizardSessionId,
          SPA_SESSION_STORAGE_KEY,
        );
      }

      // Локаль и тема — ТЕМИ ЖЕ ключами, что пишет сам продукт
      // (`v4c_locale` в frontend/src/lib/i18n.ts, `v4c_theme` в
      // lib/theme.ts), и до загрузки SPA. В продукте явный выбор
      // человека приоритетнее и языка из initData, и системной темы —
      // значит снимок получается ровно той комбинации, которой
      // подписан, а не «какой отдал фронтенд по умолчанию» (см.
      // доккомментарий к DEFAULT_LOCALE выше: до этапа H поля были
      // ярлыками).
      await page.evaluateOnNewDocument(
        (
          locale: string,
          theme: string,
          localeKey: string,
          themeKey: string,
        ) => {
          try {
            window.localStorage.setItem(localeKey, locale);
            window.localStorage.setItem(themeKey, theme);
          } catch {
            // хранилище недоступно — страница откроется в умолчаниях,
            // и снимок будет подписан не тем; сбоем это не считаем,
            // ровно как и выше с сессией.
          }
        },
        view.locale,
        view.theme,
        SPA_LOCALE_STORAGE_KEY,
        SPA_THEME_STORAGE_KEY,
      );

      const base = tmaBaseUrl.replace(/\/+$/, '');
      const url = `${base}/#${resolved.path}`;

      await withTimeout(
        page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: ROUTE_TIMEOUT_MS,
        }),
        ROUTE_TIMEOUT_MS,
        `навигация не уложилась в ${Math.round(ROUTE_TIMEOUT_MS / 1000)}с`,
      );

      // Личный текст — сразу после загрузки, ДО шагов и в любом режиме:
      // шаговые кадры снимаются внутри `runScenario`, и вставить маску
      // между шагом и его снимком иначе нечем. Стиль, а не правка
      // элементов: SPA перерисовывает поля, а правило документа
      // действует и на новые (см. `PERSONAL_TEXT_MASK_PREFIX`).
      await page.addStyleTag({ content: PERSONAL_TEXT_MASK_CSS });

      // Шаги — ПОСЛЕ навигации и ДО съёмки. Кадр после каждого:
      // ровно так снимаются мгновенные состояния, которых нет в базе
      // (см. `UiSnapshotRunOptions.steps`).
      const shots: UiSnapshotStepShot[] = [];
      let stepsDone = 0;
      let stepsError: string | undefined;
      if (view.steps.length > 0) {
        const result = await runScenario(
          page as unknown as ScenarioPage,
          view.steps as ScenarioStep[],
          // Маршрут уже открыт этим прогоном. Второй переход увёл бы
          // кадр с маршрута, которым он подписан, поэтому `goto`
          // отвергается здесь, а не молча выполняется.
          () => ({
            ok: false as const,
            reason:
              'шаг goto в съёмочном сценарии запрещён — маршрут задаётся routeKeys',
          }),
          CAPTURE_STEP_TIMEOUT_MS,
          true,
        );
        stepsDone = result.steps.filter((r) => r.ok).length;
        if (!result.ok) {
          stepsError =
            result.steps.find((r) => !r.ok)?.error ?? 'шаг не выполнился';
        }
        // Номер шага едет С КАДРОМ, а не выводится из позиции в
        // массиве (этап A ТЗ `TZ-Tutorial-Video-Voiced.md`): кадр
        // может пропасть молча (см. `ScenarioFrame`), и потребитель,
        // считающий по позиции, подписал бы карточку чужим экраном.
        //
        // В имени файла номер шага — 1-based («третий шаг» читается
        // человеком в консоли хранилища и в `doc/TUTORIAL-FRAMES-
        // CAPTURE.md`), в `shots[].stepIndex` — 0-based, как индекс
        // шага в массиве. Разница на единицу нарочная и здесь
        // единственное место, где обе нумерации встречаются.
        for (const frame of result.frames) {
          const { url } = await this.blob.uploadBuffer(
            `qa-shots/${routeKey}/${view.locale}/${view.theme}/${Date.now()}-${
              frame.stepIndex + 1
            }.png`,
            Buffer.from(frame.bytes),
            'image/png',
          );
          shots.push({ stepIndex: frame.stepIndex, url });
        }
        // Оборвавшийся сценарий — не повод выбросить уже снятое:
        // кадры до обрыва годные, и оператору нужны и они, и причина.
        if (stepsError) {
          return {
            routeKey,
            changed: false,
            error: stepsError,
            shots,
            stepsDone,
            // Итогового кадра у оборванного прогона нет — до него не
            // дошли. `blobUrl` тогда указывает на последний снятый
            // шаговый кадр: оператору нужно хоть что-то видеть.
            ...(shots.length > 0
              ? { blobUrl: shots[shots.length - 1].url }
              : {}),
          };
        }
      }

      if (view.scrollTo) {
        await scrollToSection(page, view.scrollTo);
      }

      // Маскирование заведомо переменных зон (см. доккомментарий модуля)
      // ПЕРЕД скриншотом — `visibility: hidden`, не `display: none`,
      // чтобы не сдвигать раскладку остального экрана (иначе маскирование
      // само стало бы источником ложных "изменилось").
      //
      // Немаскированный прогон пропускает этот шаг целиком — см.
      // `UiSnapshotRunOptions.unmasked`: ему кадр нужен именно такой,
      // какой есть, и в сравнении он не участвует.
      if (!view.unmasked) {
        // Сначала дождаться, пока экран осядет, затем замаскировать и
        // заморозить движение — см. `SETTLE_TIMEOUT_MS` и
        // `FREEZE_MOTION_CSS`: без этого кадр зависел от того, КОГДА
        // он снят, и крон «мигал» парами.
        await settleForComparison(page);
        await page.evaluate(maskAndFreezeInPage, FREEZE_MOTION_CSS);
      }

      const screenshot = await page.screenshot({ type: 'png' });
      const buffer = Buffer.from(screenshot);

      // Немаскированный снимок — «на показ», а не «на сравнение».
      // Отдельный префикс в Blob, чтобы его нельзя было спутать с
      // базовым, ни глазами в консоли хранилища, ни скриптом.
      if (view.unmasked) {
        const shotPath = `qa-shots/${routeKey}/${view.locale}/${view.theme}/${Date.now()}.png`;
        const { url } = await this.blob.uploadBuffer(
          shotPath,
          buffer,
          'image/png',
        );
        return {
          routeKey,
          changed: false,
          blobUrl: url,
          // Итоговый кадр — в `blobUrl` и только там: в `shots`
          // каждый элемент обязан иметь номер шага, а у итогового
          // кадра шага нет.
          ...(view.steps.length > 0 ? { shots, stepsDone } : {}),
        };
      }

      // Составной отпечаток (dHash + сетка яркостей): голый dHash не видел
      // появления целого блока контента — см. `computeSnapshotHash`.
      const hash = computeSnapshotHash(buffer);

      const previous = await this.prisma.uiSnapshot.findFirst({
        where: {
          routeKey,
          locale: view.locale,
          theme: view.theme,
          error: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Префикс — общий с уборкой по сроку хранения
      // (`ui-snapshot-retention.ts`): она удаляет только файлы под ним.
      const pathname = `${UI_SNAPSHOT_BLOB_PREFIX}${routeKey}/${view.locale}/${view.theme}/${Date.now()}.png`;
      const { url: blobUrl } = await this.blob.uploadBuffer(
        pathname,
        buffer,
        'image/png',
      );

      const sensitivity = this.changeSensitivity();
      const changed = previous
        ? this.compareToLatest(hash, previous, sensitivity)
        : false;
      const score =
        previous?.diffHash != null
          ? diffScore(hash, previous.diffHash, sensitivity)
          : null;

      await this.prisma.uiSnapshot.create({
        data: {
          routeKey,
          locale: view.locale,
          theme: view.theme,
          blobUrl,
          comparedToUrl: previous?.blobUrl ?? null,
          diffScore: score,
          changed,
          diffHash: hash,
        },
      });

      return { routeKey, changed };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.recordFailure(routeKey, error, view);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  private compareToLatest(
    hash: string,
    previous: { diffHash: string | null },
    sensitivity: ChangeSensitivity,
  ): boolean {
    if (!previous.diffHash) return false;
    return hasChanged(hash, previous.diffHash, sensitivity);
  }

  /**
   * Чувствительность «экран изменился» — из окружения на КАЖДЫЙ снимок,
   * а не один раз в конструкторе: владелец подкручивает её переменной
   * окружения, и на serverless это вступает в силу без знания о том,
   * когда был собран экземпляр сервиса. Неверное значение не роняет
   * обход, но и не проходит молча — иначе владелец думал бы, что
   * загрубил сравнение, а работали бы умолчания.
   */
  private changeSensitivity(): ChangeSensitivity {
    const { sensitivity, invalid } = resolveChangeSensitivity(process.env);
    for (const name of invalid) {
      this.logger.warn(
        `${name}="${process.env[name]}" — не целое в допустимом диапазоне, взято умолчание`,
      );
    }
    return sensitivity;
  }

  /**
   * Строка со сбоем пишется в ТУ ЖЕ комбинацию, в которой снимали:
   * иначе неудача украинского прогона легла бы в историю русского и
   * оператор искал бы её не там. Немаскированный прогон строк не пишет
   * вовсе — у него и успешных нет (см. `UiSnapshotRunOptions.unmasked`),
   * поэтому сбой возвращается только в результате вызова.
   */
  private async recordFailure(
    routeKey: string,
    error: string,
    view: { locale: string; theme: SnapshotTheme; unmasked: boolean },
  ): Promise<UiSnapshotRouteOutcome> {
    this.logger.warn(`маршрут ${routeKey}: ${error}`);
    if (!view.unmasked) {
      await this.prisma.uiSnapshot
        .create({
          data: {
            routeKey,
            locale: view.locale,
            theme: view.theme,
            error,
          },
        })
        .catch(() => undefined);
    }
    return { routeKey, changed: false, error };
  }

  /**
   * ID фикстурных данных (§3.3 ТЗ) — та же логика, что
   * `TutorialScenarioRunnerService.resolveFixtureContext`, сознательно
   * продублированная (см. доккомментарий модуля).
   */
  /**
   * Публичный, а не приватный: тем же разрешением пользуется
   * `TutorialFramesCaptureService` — ему нужен `clientSiteProjectId`,
   * чтобы сбросить черновик перед съёмкой. Вторая копия этих запросов
   * рядом разъехалась бы с этой на первой же правке фикстуры (ровно
   * это уже случалось с близнецом в `tutorial-scenario-runner`, см.
   * доккомментарий ниже).
   */
  async resolveFixtureContext(userId: string): Promise<FixtureRouteContext> {
    /**
     * Тип проекта в `where` — обязателен с этапа G ТЗ
     * `docs-tz/TZ-Enterprise-Tutorial-Landing.md`. Раньше брался «самый
     * свежий проект пользователя»; как только фикстура завела второй
     * проект (`CLIENT_SITE` для мастера обучалки), он стал самым свежим
     * — и все пять MVP-маршрутов рекламного пайплайна начали бы строить
     * путь к товару внутри проекта, у которого товаров нет по
     * построению. Крон снимал бы «не найдено» и сравнивал бы отпечатки
     * экрана ошибки, ничего при этом не заметив. Та же правка внесена в
     * близнеца в `tutorial-scenario-runner.service.ts`.
     */
    const AD_TYPES = [ProjectType.SINGLE, ProjectType.LINE];
    const [
      project,
      clientSiteProject,
      item,
      manifest,
      session,
      greetingProjects,
    ] = await Promise.all([
      this.prisma.project.findFirst({
        where: { userId, deletedAt: null, type: { in: AD_TYPES } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.project.findFirst({
        where: { userId, deletedAt: null, type: ProjectType.CLIENT_SITE },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.productItem.findFirst({
        where: {
          project: { userId, type: { in: AD_TYPES } },
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.brandManifest.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      // Экрану готового ролика нужен ГОТОВЫЙ ролик: «последняя сессия
      // пользователя» раньше почти всегда оказывалась пустой, созданной
      // этим же кроном, и снимок `postprod-video` был бессмысленным.
      this.prisma.session.findFirst({
        where: { userId, deletedAt: null, status: 'video_complete' },
        orderBy: { createdAt: 'desc' },
      }),
      // Проекты-поздравления с последней сессией — тот же запрос и то
      // же решение (`greetingContext`), что у близнеца в
      // `tutorial-scenario-runner`. До этапа I ТЗ Greeting 2.0 здесь
      // их не было вовсе: маршруты `greeting-video*` в этом прогоне
      // отказывали «нет фикстурных данных», хотя фикстура их заводила,
      // — снять кадры мастера поздравлений было нечем.
      this.prisma.project.findMany({
        where: { userId, deletedAt: null, type: ProjectType.GREETING_VIDEO },
        orderBy: { createdAt: 'desc' },
        include: {
          sessions: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, generationStatus: true },
          },
        },
      }),
    ]);
    return {
      projectId: project?.id,
      itemId: item?.id,
      manifestId: manifest?.id,
      sessionId: session?.id,
      clientSiteProjectId: clientSiteProject?.id,
      ...greetingContext(greetingProjects),
    };
  }

  /**
   * Одна постоянная служебная сессия для снимка мастера (см. комментарий в
   * `captureOne`). Помечена `data.qaFixture`, чтобы переиспользоваться
   * между тиками; если её удалит `cleanup-sessions` по TTL — заводится
   * заново, то есть не чаще одной за срок жизни сессии, а не 720 в сутки.
   * Сбой здесь не роняет прогон: без неё будет прежнее поведение.
   */
  private async ensureWizardSession(
    userId: string,
  ): Promise<string | undefined> {
    try {
      const existing = await this.prisma.session.findFirst({
        where: {
          userId,
          deletedAt: null,
          data: { path: ['qaFixture'], equals: true },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) return existing.id;
      const created = await this.prisma.session.create({
        data: {
          userId,
          status: 'created',
          // `DEFAULT_LOCALE`, а не локаль прогона, и это известное
          // ограничение, а не недосмотр: сессия одна и переиспользуется
          // всеми прогонами, переписывать её под каждый значило бы
          // дёргать общую строку туда-обратно. Затрагивает только
          // маршрут `generate` (остальные служебную сессию не читают);
          // если понадобится снимать мастер в другой локали, сессию
          // придётся заводить по одной на локаль.
          data: { locale: DEFAULT_LOCALE, qaFixture: true },
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      this.logger.warn(
        `служебная сессия мастера не заведена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Фикстурный пользователь по `FIXTURE_TELEGRAM_ID`. `null` — не
   * настроен или не заведён; отличать эти два случая вызывающему не
   * нужно, оба означают «снимать нечем».
   */
  async findFixtureUser(): Promise<{ id: string } | null> {
    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    if (!telegramId) return null;
    const user = (await this.prisma.user.findUnique({
      where: { telegramId },
      select: { id: true },
    })) as { id: string } | null;
    return user;
  }

  private skip(reason: string): UiSnapshotRunResult {
    return { skipped: reason, total: 0, changed: 0, failed: 0, outcomes: [] };
  }
}

/** Подмножество puppeteer `Page`, нужное прокрутке к секции. */
interface ScrollPage {
  waitForSelector(
    selector: string,
    options: { visible: boolean; timeout: number },
  ): Promise<unknown>;
  evaluate(fn: (selector: string) => void, selector: string): Promise<unknown>;
  waitForFunction(
    fn: () => boolean,
    options: { timeout: number },
  ): Promise<unknown>;
}

/**
 * Поставить экран так, чтобы секция начиналась сразу под липкой шапкой
 * приложения, и дождаться картинки у ролика в кадре
 * (`UiSnapshotRunOptions.scrollTo`).
 *
 * Экспортирована ради спека: прокрутка исполняется в браузере, и
 * проверить её расчёт можно только вызвав на поддельном документе.
 */
export async function scrollToSection(
  page: ScrollPage,
  selector: string,
): Promise<void> {
  // Не нашлась — бросаем: `captureOne` запишет это ошибкой маршрута.
  // Снять верх страницы и подписать его «сценарием» — хуже, чем не снять.
  await page.waitForSelector(selector, {
    visible: true,
    timeout: CAPTURE_STEP_TIMEOUT_MS,
  });
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return;
    // Шапка приложения липкая (`App.tsx`): секция, поставленная к самому
    // верху окна, уехала бы под неё заголовком — ровно той строкой,
    // которая говорит, что на кадре.
    let offset = 0;
    document.querySelectorAll('header').forEach((h) => {
      const position = window.getComputedStyle(h).position;
      if (position === 'sticky' || position === 'fixed') {
        offset = Math.max(offset, h.getBoundingClientRect().bottom);
      }
    });
    const top = el.getBoundingClientRect().top + window.scrollY - offset - 8;
    // `instant`, а не умолчание: у страницы может стоять
    // `scroll-behavior: smooth`, и кадр поймал бы середину прокрутки.
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    // Ролик без `preload` показывает чёрный прямоугольник, пока не
    // загрузит кадр. Просим загрузить и встать на секунду вперёд:
    // первый кадр у сгенерированных роликов часто затемнён.
    document.querySelectorAll('video').forEach((v) => {
      if (!v.currentSrc && !v.getAttribute('src')) return;
      v.preload = 'auto';
      if (v.currentTime === 0) {
        const seek = () => {
          if (Number.isFinite(v.duration) && v.duration > 2) v.currentTime = 1;
        };
        if (v.readyState >= 1) seek();
        else v.addEventListener('loadedmetadata', seek, { once: true });
      }
    });
  }, selector);
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('video')).every(
          (v) =>
            (!v.currentSrc && !v.getAttribute('src')) ||
            (v.readyState >= 2 && !v.seeking),
        ),
      { timeout: MEDIA_SETTLE_TIMEOUT_MS },
    )
    .catch(() => undefined);
}

/**
 * Маскирование переменных зон и заморозка движения — исполняется В
 * СТРАНИЦЕ (`page.evaluate`), одним вызовом перед снимком
 * сравниваемого прогона. Самодостаточна: puppeteer передаёт её в
 * браузер текстом, внешних имён в теле быть не должно.
 *
 * Экспортирована ради спека — проверить, что стиль заморозки реально
 * попадает в документ, можно только вызвав её на поддельном документе.
 */
export function maskAndFreezeInPage(freezeCss: string): void {
  document.querySelectorAll('[data-qa-mask]').forEach((el) => {
    (el as HTMLElement).style.visibility = 'hidden';
  });
  const style = document.createElement('style');
  style.setAttribute('data-qa-freeze', '');
  style.textContent = freezeCss;
  document.head.appendChild(style);
}

/** Подмножество puppeteer `Page`, нужное оседанию кадра. */
interface SettlePage {
  waitForNetworkIdle(options: {
    idleTime: number;
    timeout: number;
  }): Promise<unknown>;
  waitForFunction(
    fn: () => boolean,
    options: { timeout: number },
  ): Promise<unknown>;
}

/**
 * Дождаться, пока сравниваемый кадр осядет: полное затишье сети,
 * загруженные шрифты, ни одного спиннера (см. `SETTLE_TIMEOUT_MS`).
 * Оба ожидания мягкие — не осевший экран снимается как есть.
 */
export async function settleForComparison(page: SettlePage): Promise<void> {
  await page
    .waitForNetworkIdle({
      idleTime: SETTLE_NETWORK_IDLE_MS,
      timeout: SETTLE_TIMEOUT_MS,
    })
    .catch(() => undefined);
  await page
    .waitForFunction(
      () =>
        document.fonts.status === 'loaded' &&
        document.querySelector('.animate-spin') === null,
      { timeout: SETTLE_TIMEOUT_MS },
    )
    .catch(() => undefined);
}
