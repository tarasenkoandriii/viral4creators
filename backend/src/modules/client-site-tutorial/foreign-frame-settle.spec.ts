/* eslint-disable @typescript-eslint/no-explicit-any -- поддельный DOM */
/**
 * Стабилизация кадра на чужом сайте (01.10.2026, перенос правок QA TMA).
 *
 * Исходники, уезжающие в страницу строкой, здесь ИСПОЛНЯЮТСЯ — в `vm` с
 * поддельным `document`/`window`. Проверять их текст регулярками значило
 * бы проверять, что мы написали то, что написали; а ошибка в строке
 * (не тот знак, не то свойство) в CI без браузера иначе не видна вовсе.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  DSF_REPAINT_CAP_MS,
  DSF_REPAINT_QUIET_SOURCE,
  FOREIGN_BUSY_PROBE_SOURCE,
  FOREIGN_SETTLE_CEILING_MS,
  FOREIGN_SETTLE_POLL_MS,
  FRAME_FREEZE_SOURCE,
  FRAME_RELEASE_SOURCE,
  ForeignTimeoutError,
  describeReplayTimeout,
  isForeignTimeout,
  parseBusyProbe,
  redirectWarningFor,
  scrollTargetIntoCenterSource,
  settleForeignFrame,
  withForeignTimeout,
} from './foreign-frame-settle';
import { SETTLE_FLOOR_MS } from './chromium-page-explorer';

/** Элемент поддельного DOM: только то, что читают исходники. */
function el(
  attrs: Record<string, string>,
  box: Partial<{
    width: number;
    height: number;
    top: number;
    left: number;
  }> = {},
  style: Partial<{ display: string; visibility: string; opacity: string }> = {},
) {
  const width = box.width ?? 50;
  const height = box.height ?? 50;
  const top = box.top ?? 10;
  const left = box.left ?? 10;
  return {
    tagName: (attrs.tag ?? 'div').toUpperCase(),
    id: attrs.id ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({
      width,
      height,
      top,
      left,
      bottom: top + height,
      right: left + width,
    }),
    style: { display: 'block', visibility: 'visible', opacity: '1', ...style },
  };
}

/**
 * Контекст для зонда: `querySelectorAll` понимает ровно два запроса,
 * которые зонд делает. Признаки aria размечаются явно — разбирать CSS
 * здесь незачем.
 */
function probeContext(opts: { fonts?: string; aria?: any[]; named?: any[] }) {
  const document = {
    fonts: { status: opts.fonts ?? 'loaded' },
    querySelectorAll: (q: string) =>
      q.includes('aria-busy') ? (opts.aria ?? []) : (opts.named ?? []),
  };
  return {
    document,
    window: { innerWidth: 390, innerHeight: 844 },
    getComputedStyle: (e: any) => e.style,
  };
}

function runProbe(ctx: object) {
  // `window.innerWidth` в исходнике — через глобальный `window`.
  return parseBusyProbe(runInNewContext(FOREIGN_BUSY_PROBE_SOURCE, ctx));
}

describe('зонд общих признаков загрузки', () => {
  it('тихая страница — не занята', () => {
    expect(runProbe(probeContext({}))).toEqual({
      fontsLoading: false,
      busy: null,
    });
  });

  it('шрифты ещё грузятся — это видно', () => {
    expect(runProbe(probeContext({ fonts: 'loading' }))?.fontsLoading).toBe(
      true,
    );
  });

  it('видимый [aria-busy]/[role=progressbar] — занята', () => {
    const probe = runProbe(
      probeContext({ aria: [el({ role: 'progressbar', class: 'bar' })] }),
    );
    expect(probe?.busy).toContain('div');
  });

  it('класс по имени (spinner/skeleton/…) — занята', () => {
    const probe = runProbe(
      probeContext({ named: [el({ class: 'card Skeleton-row' })] }),
    );
    expect(probe?.busy).toContain('Skeleton-row');
  });

  it('id тоже считается', () => {
    expect(
      runProbe(probeContext({ named: [el({ id: 'preloader' })] }))?.busy,
    ).toContain('#preloader');
  });

  it('lazyload*-классы картинок — НЕ спиннер', () => {
    // «lazyloading»/«lazyloaded» висят на готовых картинках навсегда;
    // считать их загрузкой — ждать три секунды каждый раунд.
    expect(
      runProbe(
        probeContext({
          named: [
            el({ class: 'lazyload lazyloaded' }),
            el({ class: 'lazyloading' }),
          ],
        }),
      )?.busy,
    ).toBeNull();
  });

  it('поле загрузки файла (uploader) — НЕ спиннер, а uploader-spinner — спиннер', () => {
    // «loader» внутри «uploader» — совпадение букв: поле загрузки файла
    // висит на форме всегда (аудит 01.10.2026).
    expect(
      runProbe(
        probeContext({
          named: [
            el({ class: 'file-uploader' }),
            el({ id: 'avatarUploader' }),
            el({ class: 'Uploader' }),
          ],
        }),
      )?.busy,
    ).toBeNull();
    expect(
      runProbe(probeContext({ named: [el({ class: 'uploader-spinner' })] }))
        ?.busy,
    ).toContain('uploader-spinner');
  });

  it('скрытый или вне окна признак — не держит кадр', () => {
    expect(
      runProbe(
        probeContext({
          named: [
            el({ class: 'loader' }, {}, { display: 'none' }),
            el({ class: 'spinner' }, {}, { opacity: '0' }),
            el({ class: 'spinner' }, { top: 2000 }),
            el({ class: 'spinner' }, { width: 0 }),
          ],
          aria: [el({ 'aria-busy': 'true' }, {}, { visibility: 'hidden' })],
        }),
      )?.busy,
    ).toBeNull();
  });

  it('мусор вместо ответа — «сведений нет», а не «занято»', () => {
    expect(parseBusyProbe(null)).toBeNull();
    expect(parseBusyProbe({ elements: [] })).toBeNull();
    expect(parseBusyProbe({ fontsLoading: false, busy: 5 })).toBeNull();
  });
});

describe('мягкое ожидание оседания', () => {
  function clock() {
    const c = {
      t: 0,
      slept: [] as number[],
      now: () => c.t,
      sleep: (ms: number) => {
        c.slept.push(ms);
        c.t += ms;
        return Promise.resolve();
      },
    };
    return c;
  }
  const QUIET = { fontsLoading: false, busy: null };
  const BUSY = { fontsLoading: false, busy: 'div.spinner' };

  it('тихая страница — ни одной лишней паузы', async () => {
    const c = clock();
    const out = await settleForeignFrame(async () => QUIET, c);
    expect(out.settled).toBe(true);
    expect(c.slept).toEqual([]);
  });

  it('спиннер исчез — ждали ровно столько, сколько он висел', async () => {
    const c = clock();
    let calls = 0;
    const out = await settleForeignFrame(
      async () => (++calls <= 3 ? BUSY : QUIET),
      c,
    );
    expect(out.settled).toBe(true);
    expect(c.slept).toEqual([
      FOREIGN_SETTLE_POLL_MS,
      FOREIGN_SETTLE_POLL_MS,
      FOREIGN_SETTLE_POLL_MS,
    ]);
  });

  it('вечный спиннер — потолок, а не зависание; кадр снимается как есть', async () => {
    const c = clock();
    const out = await settleForeignFrame(async () => BUSY, c);
    expect(out).toEqual({ settled: false, holdingBy: 'div.spinner' });
    const total = c.slept.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(FOREIGN_SETTLE_CEILING_MS);
    expect(total).toBeGreaterThan(
      FOREIGN_SETTLE_CEILING_MS - FOREIGN_SETTLE_POLL_MS,
    );
  });

  it('шрифты называются причиной', async () => {
    const c = clock();
    const out = await settleForeignFrame(
      async () => ({ fontsLoading: true, busy: null }),
      c,
    );
    expect(out.holdingBy).toMatch(/шрифты/);
  });

  it('упавший опрос не держит кадр', async () => {
    const c = clock();
    const out = await settleForeignFrame(
      () => Promise.reject(new Error('Execution context was destroyed')),
      c,
    );
    expect(out.settled).toBe(true);
    expect(c.slept).toEqual([]);
  });
});

/** Поддельная анимация Web Animations API. */
function anim(
  over: Partial<{
    playState: string;
    endTime: number;
    iterations: number;
    timeline: unknown;
  }> = {},
) {
  const a: any = {
    playState: over.playState ?? 'running',
    timeline: over.timeline,
    effect: {
      getComputedTiming: () => ({
        endTime: over.endTime ?? 600,
        iterations: over.iterations ?? 1,
      }),
    },
    finish: jest.fn(),
    pause: jest.fn(),
    play: jest.fn(),
  };
  return a;
}

/** Конструируемый лист — ровно то, что трогает исходник заморозки. */
class FakeSheet {
  css = '';
  replaceSync(text: string) {
    this.css = text;
  }
}

function freezeContext(
  animations: any[],
  opts: { constructable?: boolean } = {},
) {
  const appended: any[] = [];
  const documentTimeline = {};
  for (const a of animations) {
    if (a.timeline === undefined) a.timeline = documentTimeline;
  }
  const head = {
    appendChild: (node: any) => {
      node.parentNode = head;
      appended.push(node);
    },
    removeChild: (node: any) => {
      appended.splice(appended.indexOf(node), 1);
      node.parentNode = null;
    },
  };
  const siteSheet = { site: true };
  const document: any = {
    adoptedStyleSheets: [siteSheet],
    timeline: documentTimeline,
    head,
    getAnimations: () => animations,
    createElement: () => ({
      setAttribute: jest.fn(),
      textContent: '',
      parentNode: null as unknown,
    }),
  };
  const window: any = {};
  // Без `CSSStyleSheet` в контексте исходник обязан уйти на запасной
  // путь `<style>` — так проверяются оба.
  const ctx: any = { document, window };
  if (opts.constructable) ctx.CSSStyleSheet = FakeSheet;
  return { ctx, appended, document, siteSheet };
}

describe('заморозка на время снимка', () => {
  it('конечные — finish (fade-in доезжает), бесконечные — pause', () => {
    const fade = anim({ endTime: 4000 });
    const spin = anim({ endTime: Infinity, iterations: Infinity });
    const { ctx } = freezeContext([fade, spin]);
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    expect(fade.finish).toHaveBeenCalled();
    expect(fade.pause).not.toHaveBeenCalled();
    expect(spin.pause).toHaveBeenCalled();
    expect(spin.finish).not.toHaveBeenCalled();
  });

  it('анимации на чужом таймлайне и поставленные на паузу сайтом — не трогаются', () => {
    const scrollDriven = anim({ timeline: { scroll: true } });
    const sitePaused = anim({ playState: 'paused' });
    const { ctx } = freezeContext([scrollDriven, sitePaused]);
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    for (const a of [scrollDriven, sitePaused]) {
      expect(a.finish).not.toHaveBeenCalled();
      expect(a.pause).not.toHaveBeenCalled();
    }
  });

  it('CSP: стиль — конструируемым листом в adoptedStyleSheets, без <style>, один при повторе', () => {
    // `<style>` на сайте с `style-src` без 'unsafe-inline' заблокирован
    // и шлёт заказчику отчёт о нарушении (аудит 01.10.2026).
    const { ctx, appended, document, siteSheet } = freezeContext([], {
      constructable: true,
    });
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    expect(appended).toHaveLength(0);
    expect(document.adoptedStyleSheets).toHaveLength(2);
    expect(document.adoptedStyleSheets[0]).toBe(siteSheet);
    const ours = document.adoptedStyleSheets[1];
    expect(ours).toBeInstanceOf(FakeSheet);
    expect(ours.css).toContain('transition: none');
    expect(ours.css).toContain('caret-color: transparent');
    expect(ours.css).not.toMatch(/animation\s*:/);
  });

  it('снятие убирает из adoptedStyleSheets только наш лист', () => {
    const { ctx, document, siteSheet } = freezeContext([], {
      constructable: true,
    });
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    runInNewContext(FRAME_RELEASE_SOURCE, ctx);
    expect(document.adoptedStyleSheets).toEqual([siteSheet]);
  });

  it('запасной путь (нет конструируемых листов): <style>, ровно один при повторе', () => {
    const { ctx, appended } = freezeContext([]);
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toContain('transition: none');
    expect(appended[0].textContent).toContain('caret-color: transparent');
    // НЕ `animation: none`: fade-in с opacity:0 остался бы невидимым.
    expect(appended[0].textContent).not.toMatch(/animation\s*:/);
  });

  it('снятие: стиль убран, в ход возвращено только то, что ставили на паузу мы', () => {
    const spin = anim({ endTime: Infinity, iterations: Infinity });
    const sitePaused = anim({ playState: 'paused', endTime: Infinity });
    const { ctx, appended } = freezeContext([spin, sitePaused]);
    runInNewContext(FRAME_FREEZE_SOURCE, ctx);
    expect(runInNewContext(FRAME_RELEASE_SOURCE, ctx)).toBe(true);
    expect(appended).toHaveLength(0);
    expect(spin.play).toHaveBeenCalled();
    expect(sitePaused.play).not.toHaveBeenCalled();
    // Повторное снятие — без последствий.
    expect(runInNewContext(FRAME_RELEASE_SOURCE, ctx)).toBe(false);
  });

  it('странная анимация, бросающая на finish, не роняет заморозку', () => {
    const broken = anim();
    broken.finish.mockImplementation(() => {
      throw new Error('InvalidStateError');
    });
    const spin = anim({ endTime: Infinity });
    const { ctx } = freezeContext([broken, spin]);
    expect(runInNewContext(FRAME_FREEZE_SOURCE, ctx)).toBe(true);
    expect(spin.pause).toHaveBeenCalled();
  });
});

describe('цель раунда — в центр окна', () => {
  function ctxWith(found: any, throws = false) {
    return {
      document: {
        querySelector: () => {
          if (throws) throw new Error('SyntaxError');
          return found;
        },
      },
    };
  }

  it('живой элемент — scrollIntoView по центру и мгновенно', () => {
    const target = { isConnected: true, scrollIntoView: jest.fn() };
    expect(
      runInNewContext(scrollTargetIntoCenterSource('#go'), ctxWith(target)),
    ).toBe(true);
    // `instant` — иначе `scroll-behavior: smooth` сайта снял бы кадр
    // посреди прокрутки.
    expect(target.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center', behavior: 'instant' }),
    );
  });

  it('элемента нет или он отцеплен — ничего не крутим', () => {
    expect(
      runInNewContext(scrollTargetIntoCenterSource('#go'), ctxWith(null)),
    ).toBe(false);
    const detached = { isConnected: false, scrollIntoView: jest.fn() };
    runInNewContext(scrollTargetIntoCenterSource('#go'), ctxWith(detached));
    expect(detached.scrollIntoView).not.toHaveBeenCalled();
  });

  it('селектор, непонятный querySelector, — «не нашли», а не ошибка', () => {
    expect(
      runInNewContext(
        scrollTargetIntoCenterSource("::-p-text('Далее')"),
        ctxWith(null, true),
      ),
    ).toBe(false);
  });

  it('кавычки в селекторе не ломают исходник', () => {
    const target = { isConnected: true, scrollIntoView: jest.fn() };
    const seen: string[] = [];
    runInNewContext(scrollTargetIntoCenterSource(`a[title="x'y"]`), {
      document: {
        querySelector: (s: string) => {
          seen.push(s);
          return target;
        },
      },
    });
    expect(seen).toEqual([`a[title="x'y"]`]);
  });
});

describe('затишье после смены плотности', () => {
  function repaintContext(images: any[]) {
    const timers: Array<() => void> = [];
    return {
      timers,
      ctx: {
        Promise,
        window: { innerHeight: 844 },
        document: { images },
        setTimeout: (fn: () => void) => timers.push(fn),
        requestAnimationFrame: (fn: () => void) => fn(),
      },
    };
  }

  it('картинок в ожидании нет — отпускает сразу', async () => {
    const { ctx } = repaintContext([{ complete: true }]);
    await expect(runInNewContext(DSF_REPAINT_QUIET_SOURCE, ctx)).resolves.toBe(
      'quiet',
    );
  });

  it('ждёт догрузки видимой картинки', async () => {
    const listeners: Record<string, () => void> = {};
    const img = {
      complete: false,
      getBoundingClientRect: () => ({
        top: 10,
        bottom: 100,
        width: 50,
        height: 50,
      }),
      addEventListener: (ev: string, fn: () => void) => (listeners[ev] = fn),
    };
    const { ctx } = repaintContext([img]);
    const p = runInNewContext(DSF_REPAINT_QUIET_SOURCE, ctx);
    listeners.load();
    await expect(p).resolves.toBe('images');
  });

  it('не догрузилась — отпускает по потолку', async () => {
    const img = {
      complete: false,
      getBoundingClientRect: () => ({
        top: 10,
        bottom: 100,
        width: 50,
        height: 50,
      }),
      addEventListener: () => undefined,
    };
    const { ctx, timers } = repaintContext([img]);
    const p = runInNewContext(DSF_REPAINT_QUIET_SOURCE, ctx);
    timers.forEach((t) => t());
    await expect(p).resolves.toBe('cap');
    expect(DSF_REPAINT_CAP_MS).toBeLessThan(FOREIGN_SETTLE_CEILING_MS);
  });
});

describe('предупреждение о редиректе', () => {
  const B = 'https://shop.example.com';

  it('тот же экран — молчим (query, якорь, завершающий слэш не в счёт)', () => {
    expect(
      redirectWarningFor(`${B}/cabinet`, `${B}/cabinet/?utm=1#top`),
    ).toBeUndefined();
    expect(redirectWarningFor(`${B}/`, `${B}`)).toBeUndefined();
  });

  it('увели на вход — предупреждение с обоими путями', () => {
    const w = redirectWarningFor(`${B}/cabinet`, `${B}/login?next=/cabinet`);
    expect(w).toContain('/cabinet');
    expect(w).toContain('/login');
  });

  it('сайт лишь выбрал язык (/ → /ru/, /cabinet → /en-us/cabinet и обратно) — молчим', () => {
    expect(redirectWarningFor(`${B}/`, `${B}/ru/`)).toBeUndefined();
    expect(redirectWarningFor(`${B}`, `${B}/ru`)).toBeUndefined();
    expect(
      redirectWarningFor(`${B}/cabinet`, `${B}/en-us/cabinet`),
    ).toBeUndefined();
    expect(
      redirectWarningFor(`${B}/uk/cabinet`, `${B}/cabinet`),
    ).toBeUndefined();
  });

  it('язык выбран И экран другой — предупреждение остаётся', () => {
    expect(redirectWarningFor(`${B}/cabinet`, `${B}/ru/login`)).toContain(
      '/ru/login',
    );
    // Трёхбуквенный сегмент — не язык.
    expect(redirectWarningFor(`${B}/`, `${B}/app/`)).toBeDefined();
  });

  it('нечитаемый адрес — не повод для ложной тревоги', () => {
    expect(redirectWarningFor('не адрес', `${B}/x`)).toBeUndefined();
  });
});

describe('таймаут переигровки называется по-человечески', () => {
  it('наш таймаут отличим от отказа самой операции', async () => {
    const never = new Promise<never>(() => undefined);
    const err = await withForeignTimeout(never, 5, 'не открылась').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ForeignTimeoutError);
    expect(err.message).toBe('не открылась');
    expect(isForeignTimeout(err)).toBe(true);

    const own = await withForeignTimeout(
      Promise.reject(new Error('замок')),
      1000,
      'x',
    ).catch((e) => e);
    expect(isForeignTimeout(own)).toBe(false);
  });

  it('TimeoutError самого puppeteer — тоже таймаут', () => {
    const e = new Error('Waiting failed');
    e.name = 'TimeoutError';
    expect(isForeignTimeout(e)).toBe(true);
  });

  it('текст называет шлюз и шаг, а шаг не выходит за число шагов', () => {
    const text = describeReplayTimeout('страница не открылась за 20с', {
      done: 4,
      total: 4,
    });
    expect(text).toContain('шлюз (куки/возраст/гео) или изменение сайта');
    expect(text).toContain('шаге 4 из 4');
  });
});

/**
 * Полигон держит то, что здесь проверяется (01.10.2026). Шов
 * `check-docs` сверяет хуки каталога со страницей; числа задержек
 * сверяются здесь — шов в `scripts/` не наш, а без этих проверок блоки
 * полигона молча перестали бы проверять оседание.
 */
describe('полигон проверяет оседание, а не обходит его', () => {
  const page = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'landing',
      'src',
      'app',
      'qa',
      'site-sandbox',
      'SandboxClient.tsx',
    ),
    'utf8',
  );
  const catalog = readFileSync(join(__dirname, 'sandbox-catalog.ts'), 'utf8');
  const num = (src: string, name: string) =>
    Number(
      (new RegExp(`${name} = ([0-9_]+)`).exec(src)?.[1] ?? 'NaN').replace(
        /_/g,
        '',
      ),
    );

  it('спиннер висит ДОЛЬШЕ пола и МЕНЬШЕ потолка оседания', () => {
    // Ниже пола — его «пережидает» пол, и опрос признаков не проверяется
    // вовсе; выше потолка — кадр со спиннером становится нормой.
    const spinner = num(page, 'SANDBOX_SPINNER_MS');
    expect(spinner).toBeGreaterThan(SETTLE_FLOOR_MS);
    expect(spinner).toBeLessThan(FOREIGN_SETTLE_CEILING_MS);
    expect(num(catalog, 'SANDBOX_SPINNER_MS')).toBe(spinner);
  });

  it('fade-in длится дольше потолка — без finish() кадр поймал бы его на полпути', () => {
    const fade = num(page, 'SANDBOX_FADE_MS');
    expect(fade).toBeGreaterThan(SETTLE_FLOOR_MS + FOREIGN_SETTLE_CEILING_MS);
    expect(num(catalog, 'SANDBOX_FADE_MS')).toBe(fade);
  });

  it('спиннер полигона распознаётся общими признаками, а не по имени хука', () => {
    expect(page).toMatch(/role="progressbar"/);
    expect(page).toMatch(/className="sandbox-spinner"/);
  });
});
