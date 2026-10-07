// СГЕНЕРИРОВАНО scripts/sync-worker-shared.mjs — не править.
// Источник: backend/src/modules/client-site-tutorial/foreign-frame-settle.ts. Правка — в источнике, затем
// `node scripts/sync-worker-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Стабилизация кадра на ЧУЖОМ сайте — перенос правок QA TMA (§12
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md) на обучалку по сайту
 * заказчика, 01.10.2026.
 *
 * ## Почему отдельный файл, а не ещё методы разведчика
 *
 * Всё, что здесь лежит, уезжает в страницу СТРОКОЙ (`ExplorerPage.evaluate`
 * в узком интерфейсе принимает только строку — аргументом DOM не
 * передать) или считает чистую арифметику. И то и другое проверяется без
 * браузера, а `chromium-page-explorer.ts` остаётся про порядок операций.
 *
 * ## Чем это отличается от стабилизации НАШЕГО лендинга
 *
 * На нашем лендинге мы знаем свои спиннеры поимённо и вправе гасить
 * медиа. Здесь — нет:
 *
 *   - признаки загрузки только ОБЩИЕ (`aria-busy`, `role=progressbar`,
 *     имена классов) — каталога чужих спиннеров не бывает;
 *   - медиа НЕ обрываются (решение координатора 01.10.2026): видео
 *     заказчика — часть его интерфейса, и ролик-обучалка, где вместо
 *     него чёрный прямоугольник, учит не тому сайту;
 *   - всё ожидание МЯГКОЕ и с потолком: потоковое видео или вечный
 *     скелетон не должны держать раунд, за который уже потрачен слот
 *     суточного лимита. Не дождались — снимаем как есть.
 */

/** Потолок мягкого ожидания общих признаков загрузки перед кадром.
 * Три секунды — столько человек и сам подождал бы, глядя на спиннер;
 * дальше это уже не «догружается», а «так и выглядит». */
export const FOREIGN_SETTLE_CEILING_MS = 3_000;

/** Шаг опроса признаков загрузки. Чаще незачем: спиннер не исчезает
 * быстрее кадра анимации, а каждый опрос — обход DOM чужой страницы. */
export const FOREIGN_SETTLE_POLL_MS = 200;

/**
 * Потолок затишья после смены плотности (DSF=2) перед съёмочным кадром.
 *
 * Смена `deviceScaleFactor` заставляет `<img srcset>` выбрать другой
 * кандидат и догрузить его; снимок сразу после — это старая картинка,
 * растянутая вдвое, ровно то мыло, ради которого плотность и поднимали.
 * Потолок короткий: это второй, необязательный кадр.
 */
export const DSF_REPAINT_CAP_MS = 800;

/** Метки в исходниках — по ним тест отличает вызовы `evaluate` друг от
 * друга (мок отдаёт одно и то же на любую строку). */
const PROBE_MARK = '/*v4c:foreign-busy-probe*/';
const FREEZE_MARK = '/*v4c:frame-freeze*/';
const RELEASE_MARK = '/*v4c:frame-release*/';
const SCROLL_MARK = '/*v4c:target-center*/';
const REPAINT_MARK = '/*v4c:dsf-repaint*/';

/**
 * Опрос общих признаков загрузки. Возвращает `{ fontsLoading, busy }`,
 * где `busy` — короткое описание первого найденного видимого признака
 * (для журнала) или `null`.
 *
 * Видимость — обязательна: скрытый `.loader` в подвале, который сайт
 * держит в DOM всегда, не повод ждать три секунды каждый раунд.
 * `lazyload*` исключён: это классы библиотек ленивых картинок
 * (`lazyload`, `lazyloaded`, `lazyloading`), висят на готовых
 * изображениях навсегда, и «loading» в их имени — не спиннер.
 * `uploader` (`file-uploader`, `avatar-uploader`) вырезается из имени
 * ДО проверки: это поле загрузки ФАЙЛА, висящее на форме постоянно, а
 * «loader» в нём — случайное совпадение букв. Вырезается, а не
 * исключает имя целиком: `uploader-spinner` — по-прежнему спиннер
 * (аудит этапа 01.10.2026).
 */
export const FOREIGN_BUSY_PROBE_SOURCE = `${PROBE_MARK}(function () {
  var fontsLoading = !!(document.fonts && document.fonts.status === 'loading');
  var BUSY = /spinner|loader|loading|preloader|skeleton|shimmer/i;
  var LAZY = /^lazyload/i;
  var UPLOADER = /uploader/gi;
  var vw = window.innerWidth, vh = window.innerHeight;
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01;
  }
  function describe(el) {
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.getAttribute('class') ? '.' + String(el.getAttribute('class')).trim().split(/\\s+/).join('.') : '');
  }
  var aria = document.querySelectorAll('[aria-busy="true"], [role="progressbar"]:not([aria-valuenow])');
  for (var i = 0; i < aria.length; i++) {
    if (visible(aria[i])) return { fontsLoading: fontsLoading, busy: describe(aria[i]).slice(0, 120) };
  }
  var named = document.querySelectorAll('[class], [id]');
  var limit = Math.min(named.length, 5000);
  for (var j = 0; j < limit; j++) {
    var el = named[j];
    var tokens = String(el.getAttribute('class') || '').split(/\\s+/);
    if (el.id) tokens.push(el.id);
    var hit = false;
    for (var k = 0; k < tokens.length; k++) {
      if (tokens[k] && !LAZY.test(tokens[k]) && BUSY.test(tokens[k].replace(UPLOADER, ''))) { hit = true; break; }
    }
    if (hit && visible(el)) return { fontsLoading: fontsLoading, busy: describe(el).slice(0, 120) };
  }
  return { fontsLoading: fontsLoading, busy: null };
})()`;

export interface BusyProbe {
  fontsLoading: boolean;
  busy: string | null;
}

/** Разбор ответа опроса. Всё, что не похоже на ответ, — `null`, то есть
 * «сведений нет», а не «занято»: страница могла уйти в редирект прямо во
 * время опроса, и держать из-за этого кадр незачем. */
export function parseBusyProbe(raw: unknown): BusyProbe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.fontsLoading !== 'boolean') return null;
  if (r.busy !== null && typeof r.busy !== 'string') return null;
  return { fontsLoading: r.fontsLoading, busy: r.busy };
}

export interface SettleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ForeignSettleOutcome {
  /** `false` — потолок вышел, а признак загрузки так и висел. */
  settled: boolean;
  /** Что держало кадр последним — для журнала; при `settled` пусто. */
  holdingBy?: string;
}

/**
 * Мягко дождаться, пока на чужой странице догрузятся шрифты и исчезнут
 * видимые общие признаки загрузки. Не дождались за потолок — НЕ ошибка:
 * кадр снимается как есть, вызывающий лишь пишет в журнал, что держало.
 */
export async function settleForeignFrame(
  evaluate: (source: string) => Promise<unknown>,
  clock: SettleClock,
  ceilingMs: number = FOREIGN_SETTLE_CEILING_MS,
  pollMs: number = FOREIGN_SETTLE_POLL_MS,
): Promise<ForeignSettleOutcome> {
  const startedAt = clock.now();
  for (;;) {
    const probe = parseBusyProbe(
      await evaluate(FOREIGN_BUSY_PROBE_SOURCE).catch(() => null),
    );
    if (!probe || (!probe.fontsLoading && probe.busy === null)) {
      return { settled: true };
    }
    const holdingBy = probe.fontsLoading
      ? `шрифты ещё грузятся${probe.busy ? `, ${probe.busy}` : ''}`
      : (probe.busy as string);
    // Следующий опрос вышел бы за потолок — значит и ждать его незачем.
    if (clock.now() - startedAt + pollMs > ceilingMs) {
      return { settled: false, holdingBy };
    }
    await clock.sleep(pollMs);
  }
}

/**
 * Заморозка ТОЛЬКО на время снимка.
 *
 * - конечные анимации — `finish()`: fade-in доезжает до конечного
 *   состояния. Именно `finish`, а НЕ `animation:none`: блок с
 *   `opacity:0` в первом ключевом кадре при `animation:none` остался бы
 *   невидимым навсегда — кадр потерял бы содержимое, а не дрожь;
 * - бесконечные — `pause()` (спиннер, бегущая строка): у них нет
 *   «конечного состояния», есть только «не смазаться в кадре»;
 * - анимации не на таймлайне документа (scroll-driven) и уже
 *   поставленные на паузу самим сайтом не трогаются — их состояние
 *   задумано сайтом;
 * - `transition:none` и прозрачная каретка — конструируемым листом
 *   (`new CSSStyleSheet` + `replaceSync` → `adoptedStyleSheets`), а не
 *   `<style>`: чужой сайт с CSP `style-src` без `'unsafe-inline'`
 *   заблокирует вставленный `<style>` и ещё отправит заказчику отчёт о
 *   нарушении — «ваш сайт атакуют» от нашей же обучалки (аудит
 *   01.10.2026). `<style>` — только запасной путь для движка без
 *   конструируемых листов. `FRAME_RELEASE_SOURCE` снимает лист: сессия
 *   на сайте продолжается (переигровка, следующий шаг раунда), и сайт
 *   после снимка обязан вести себя как прежде.
 *
 * Повторный вызов безопасен и нужен: после смены плотности могли
 * стартовать новые анимации (картинка догрузилась и «проявляется») —
 * второй проход доводит и их, стиль не дублируется.
 */
export const FRAME_FREEZE_SOURCE = `${FREEZE_MARK}(function () {
  var KEY = '__v4cFrameFreeze';
  var state = window[KEY];
  if (!state) {
    var css = '*, *::before, *::after { transition: none !important; caret-color: transparent !important; }';
    state = { sheet: null, style: null, paused: [] };
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = Array.prototype.concat.call([], document.adoptedStyleSheets || [], [sheet]);
      state.sheet = sheet;
    } catch (e) {
      try {
        var style = document.createElement('style');
        style.setAttribute('data-v4c-frame-freeze', '');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        state.style = style;
      } catch (e2) { /* без стиля — переходы и каретка останутся, кадр всё равно снимется */ }
    }
    window[KEY] = state;
  }
  var list = [];
  try { list = document.getAnimations ? document.getAnimations() : []; } catch (e) { list = []; }
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    try {
      if (a.timeline && a.timeline !== document.timeline) continue;
      if (a.playState !== 'running') continue;
      var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      var infinite = !t || t.endTime === Infinity || t.iterations === Infinity;
      if (infinite) { a.pause(); state.paused.push(a); }
      else { a.finish(); }
    } catch (e) { /* чужая анимация в странном состоянии — не повод ронять кадр */ }
  }
  return true;
})()`;

/** Снять заморозку: убрать стиль, вернуть в ход то, что ставили на
 * паузу МЫ (и только это). Доведённые `finish()` анимации не
 * откатываются — они и так завершились бы за доли секунды. */
export const FRAME_RELEASE_SOURCE = `${RELEASE_MARK}(function () {
  var KEY = '__v4cFrameFreeze';
  var state = window[KEY];
  if (!state) return false;
  try {
    if (state.sheet) {
      var sheet = state.sheet;
      document.adoptedStyleSheets = Array.prototype.filter.call(document.adoptedStyleSheets || [], function (x) { return x !== sheet; });
    }
  } catch (e) {}
  try { if (state.style && state.style.parentNode) state.style.parentNode.removeChild(state.style); } catch (e) {}
  for (var i = 0; i < state.paused.length; i++) {
    try { state.paused[i].play(); } catch (e) {}
  }
  try { delete window[KEY]; } catch (e) { window[KEY] = undefined; }
  return true;
})()`;

/**
 * Довернуть цель раунда в центр окна. `behavior: 'instant'` — явно:
 * у сайта может стоять `scroll-behavior: smooth`, и тогда кадр снялся
 * бы посреди прокрутки. Селектор мог стать невалидным для
 * `querySelector` (псевдоселекторы puppeteer вроде `::-p-text`) — это
 * «не нашли», а не ошибка.
 */
export function scrollTargetIntoCenterSource(selector: string): string {
  return `${SCROLL_MARK}(function (sel) {
  var el = null;
  try { el = document.querySelector(sel); } catch (e) { return false; }
  if (!el || !el.isConnected) return false;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  return true;
})(${JSON.stringify(selector)})`;
}

/**
 * Короткое затишье после смены плотности: два кадра отрисовки (новый
 * `srcset` выбран) и, если в окне есть недогруженные картинки, — их
 * `load`/`error`. Потолок — внутри страницы; вызывающий дополнительно
 * держит свой, на случай если страница не отвечает вовсе.
 */
export const DSF_REPAINT_QUIET_SOURCE = `${REPAINT_MARK}new Promise(function (resolve) {
  var done = false;
  function finish(v) { if (!done) { done = true; resolve(v); } }
  setTimeout(function () { finish('cap'); }, ${DSF_REPAINT_CAP_MS});
  requestAnimationFrame(function () { requestAnimationFrame(function () {
    var vh = window.innerHeight;
    var pending = Array.prototype.filter.call(document.images, function (img) {
      if (img.complete) return false;
      var r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.width > 0 && r.height > 0;
    });
    if (pending.length === 0) return finish('quiet');
    var left = pending.length;
    pending.forEach(function (img) {
      var one = function () { left -= 1; if (left === 0) finish('images'); };
      img.addEventListener('load', one, { once: true });
      img.addEventListener('error', one, { once: true });
    });
  }); });
})`;

/** Какой вызов `evaluate` — для тестов и только для них. */
export const FRAME_SOURCE_MARKS = {
  probe: PROBE_MARK,
  freeze: FREEZE_MARK,
  release: RELEASE_MARK,
  scroll: SCROLL_MARK,
  repaint: REPAINT_MARK,
} as const;

/**
 * Предупреждение о редиректе: открыли не тот экран, который просили.
 *
 * Сравнивается ПУТЬ, а не адрес целиком: метки в query (`utm_*`,
 * `?from=`) и якорь сайт переписывает постоянно, и предупреждать о них
 * значило бы приучить оператора не читать предупреждения. Завершающий
 * слэш тоже не в счёт (`/cabinet` и `/cabinet/` — один экран).
 *
 * Кадр при этом отдаётся всё равно: редирект внутри сайта — не
 * нарушение замка (§8.1 держит origin отдельно), а сведения для
 * человека — «вас отправили на вход, сессия, похоже, кончилась».
 */
export function redirectWarningFor(
  requestedUrl: string,
  actualUrl: string,
): string | undefined {
  const requested = pathOf(requestedUrl);
  const actual = pathOf(actualUrl);
  if (requested === null || actual === null || requested === actual) {
    return undefined;
  }
  // `/` → `/ru/`, `/cabinet` → `/en-us/cabinet` и обратно — сайт лишь
  // выбрал язык, экран тот же. Предупреждать об этом на каждом
  // многоязычном сайте значило бы приучить оператора не читать
  // предупреждения. Цена: двухбуквенный путь (`/go`) неотличим от
  // префикса языка — редирект `/` → `/go` пройдёт молча.
  if (withoutLocale(requested) === withoutLocale(actual)) return undefined;
  return (
    `Сайт открыл другой экран: запрошен ${requested}, открылся ${actual} ` +
    '(вероятно, редирект на вход или в кабинет). Кадр снят с того, что открылось — ' +
    'проверьте, что это нужный шаг.'
  );
}

/** Путь без ведущего языкового префикса `/xx` или `/xx-yy`. */
function withoutLocale(path: string): string {
  const rest = path.replace(/^\/[a-z]{2}(?:[-_][a-z]{2,4})?(?=\/|$)/i, '');
  return rest === '' ? '/' : rest;
}

function pathOf(url: string): string | null {
  try {
    const p = new URL(url).pathname;
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
  } catch {
    return null;
  }
}

/**
 * Таймаут переигровки — отдельным классом, чтобы `/undo` мог назвать
 * вероятную причину, а не отдать голое «не уложилась в 20с». Наследует
 * `Error` с прежним текстом: для обычного раунда ничего не меняется.
 */
export class ForeignTimeoutError extends Error {
  readonly name = 'ForeignTimeoutError';
}

/** То же, что `withTimeout` из `common/headless-chromium`, но отказ по
 * таймауту отличим от отказа самой операции. */
export function withForeignTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ForeignTimeoutError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Таймаут — наш или собственный puppeteer (`TimeoutError` локатора и
 * `goto`). Остальное (замок, потерянный кред) таймаутом не считается и
 * переименовываться не должно — у тех причина уже названа точно. */
export function isForeignTimeout(err: unknown): boolean {
  return (
    err instanceof ForeignTimeoutError ||
    (err instanceof Error && err.name === 'TimeoutError')
  );
}

/** Человеческая причина упавшей по таймауту переигровки (`/undo`). */
export function describeReplayTimeout(
  detail: string,
  progress: { done: number; total: number },
): string {
  return (
    // `min`: таймаут мог случиться уже ПОСЛЕ последнего шага — на
    // оседании или съёмке; «шаг 5 из 4» читалось бы как баг.
    `Повтор сценария после отмены остановился на шаге ${Math.min(progress.done + 1, progress.total)} из ${progress.total}: ${detail}. ` +
    'Вероятен шлюз (куки/возраст/гео) или изменение сайта — откройте сайт вручную ' +
    'и проверьте, что шаги сценария на нём всё ещё есть.'
  );
}
