/* eslint-disable @typescript-eslint/no-explicit-any -- поддельный браузер */
/**
 * Браузерная часть визарда (§5.1 ТЗ, этап 112).
 *
 * Chromium здесь поддельный — тот же приём и та же причина, что в
 * `tutorial-scenario-runner.service.spec.ts`: в CI этого проекта
 * настоящий браузер не поднимается (`doc/CI.md`). Проверяется то, что
 * puppeteer за нас не проверит, — ПОРЯДОК и ГРАНИЦЫ:
 *
 * - куки укладываются ДО `goto` (иначе jar приедет не на тот домен);
 * - доменный замок стоит ДО первого действия (иначе пароль от кабинета
 *   заказчика уедет на сайт, куда нас увёл редирект);
 * - браузер закрывается ВСЕГДА, включая путь с исключением (незакрытый
 *   Chromium держит память инстанса до его смерти).
 */

const launchHeadlessBrowserMock = jest.fn();
jest.mock('../../common/headless-chromium', () => ({
  launchHeadlessBrowser: (...args: unknown[]) =>
    launchHeadlessBrowserMock(...args),
  // Настоящий `withTimeout` — он дешёвый и участвует в проверяемом пути.
  withTimeout: jest.requireActual('../../common/headless-chromium').withTimeout,
}));

// Прокси — поддельный: настоящий поднимает сокет, а здесь проверяется
// только то, что раунд ЕГО использует и всегда закрывает (Ш0.3).
const proxyCloseMock = jest.fn().mockResolvedValue(undefined);
const startEgressFilterProxyMock = jest.fn();
jest.mock('../../common/egress-filter-proxy', () => ({
  ...jest.requireActual('../../common/egress-filter-proxy'),
  startEgressFilterProxy: (...args: unknown[]) =>
    startEgressFilterProxyMock(...args),
}));

import {
  BadRequestException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ChromiumPageExplorer,
  SETTLE_FLOOR_MS,
} from './chromium-page-explorer';
import { FRAME_SOURCE_MARKS } from './foreign-frame-settle';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'https://shop.example.com';

const COLLECTED = {
  currentUrl: `${ORIGIN}/cabinet`,
  elements: [
    { selector: '#pay', tag: 'button', visibleText: 'Оплатить' },
    { selector: '#next', tag: 'button', visibleText: 'Далее' },
  ],
  looksLikeLogin: false,
};

function makePage(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const cdp = {
    send: jest.fn().mockResolvedValue({
      cookies: [
        {
          name: 'sid',
          value: 'abc',
          domain: 'shop.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: -1,
        },
        { name: '', value: 'мусор', domain: 'x' },
      ],
    }),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  const locator: any = {
    setTimeout: jest.fn(() => locator),
    fill: jest.fn(async () => calls.push('fill')),
    click: jest.fn(async () => calls.push('click')),
  };
  const page: any = {
    calls,
    locator: jest.fn(() => locator),
    locatorObject: locator,
    setViewport: jest.fn(async () => {
      calls.push('viewport');
    }),
    setCookie: jest.fn(async () => {
      calls.push('setCookie');
    }),
    goto: jest.fn(async () => {
      calls.push('goto');
    }),
    url: jest.fn(() => `${ORIGIN}/cabinet`),
    waitForNavigation: jest.fn(() => Promise.resolve(null)),
    waitForNetworkIdle: jest.fn(() => Promise.resolve(null)),
    evaluate: jest.fn(async () => {
      calls.push('evaluate');
      return COLLECTED;
    }),
    screenshot: jest.fn(async () => {
      calls.push('screenshot');
      return 'Ykhk';
    }),
    createCDPSession: jest.fn(async () => cdp),
    cdp,
    ...over,
  };
  return page;
}

/**
 * Разведчик с ручными часами. `SETTLE_FLOOR_MS` — полторы секунды на
 * каждый переход: по-настоящему их ждать значило бы платить минутой
 * прогона за проверку, которая к времени отношения не имеет. Часы
 * подменяются, а не отключаются — сколько именно проспано, спек
 * проверяет отдельно.
 */
class TestExplorer extends ChromiumPageExplorer {
  slept: number[] = [];
  clock = 0;
  protected now(): number {
    return this.clock;
  }
  protected sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.clock += ms;
    return Promise.resolve();
  }
}

function setup(over: Record<string, any> = {}) {
  const page = makePage(over);
  const browser = {
    newPage: jest.fn(async () => page),
    close: jest.fn().mockResolvedValue(undefined),
  };
  launchHeadlessBrowserMock.mockResolvedValue({ browser });
  const explorer = new TestExplorer();
  return { explorer, page, browser };
}

const REQUEST = {
  url: `${ORIGIN}/cabinet`,
  cookies: [],
  actions: [],
  allowedOrigin: ORIGIN,
};

beforeEach(() => {
  launchHeadlessBrowserMock.mockReset();
  proxyCloseMock.mockClear();
  startEgressFilterProxyMock.mockReset();
  startEgressFilterProxyMock.mockResolvedValue({
    url: 'http://127.0.0.1:41000',
    port: 41000,
    stats: () => ({ 'blocked-address': 0 }),
    close: proxyCloseMock,
  });
});

describe('фильтрующий прокси (Ш0.3, К-3)', () => {
  it('браузер раунда идёт ТОЛЬКО через прокси и без флагов, ослабляющих SOP', async () => {
    const { explorer } = setup();
    await explorer.runRound(REQUEST);
    expect(startEgressFilterProxyMock).toHaveBeenCalledTimes(1);
    expect(launchHeadlessBrowserMock).toHaveBeenCalledWith({
      untrustedContent: true,
      extraArgs: [
        '--proxy-server=http://127.0.0.1:41000',
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-quic',
      ],
    });
  });

  it('прокси закрывается после раунда — и после закрытия браузера', async () => {
    const { explorer, browser } = setup();
    await explorer.runRound(REQUEST);
    expect(proxyCloseMock).toHaveBeenCalledTimes(1);
    expect(browser.close.mock.invocationCallOrder[0]).toBeLessThan(
      proxyCloseMock.mock.invocationCallOrder[0],
    );
  });

  it('браузер не поднялся — прокси всё равно закрыт', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const explorer = new TestExplorer();
    await expect(explorer.runRound(REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(proxyCloseMock).toHaveBeenCalledTimes(1);
  });
});

describe('браузер не поднялся', () => {
  it('503 с причиной, а не «внутренняя ошибка»', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const explorer = new TestExplorer();
    await expect(explorer.runRound(REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('причина видна в сообщении — иначе диагностировать нечем', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const explorer = new TestExplorer();
    await expect(explorer.runRound(REQUEST)).rejects.toThrow(/нет памяти/);
  });
});

describe('порядок операций', () => {
  it('куки укладываются ДО goto, а не после', async () => {
    const { explorer, page } = setup();
    await explorer.runRound({
      ...REQUEST,
      cookies: [
        {
          name: 'sid',
          value: 'v',
          domain: 'shop.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: -1,
        },
      ],
    });
    expect(page.calls.indexOf('setCookie')).toBeGreaterThan(-1);
    expect(page.calls.indexOf('setCookie')).toBeLessThan(
      page.calls.indexOf('goto'),
    );
  });

  it('пустой jar — setCookie не зовётся вовсе', async () => {
    const { explorer, page } = setup();
    await explorer.runRound(REQUEST);
    expect(page.setCookie).not.toHaveBeenCalled();
  });

  it('сессионная кука уезжает БЕЗ expires (иначе CDP считает её истёкшей в 1969)', async () => {
    const { explorer, page } = setup();
    await explorer.runRound({
      ...REQUEST,
      cookies: [
        {
          name: 'sid',
          value: 'v',
          domain: 'shop.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: -1,
        },
      ],
    });
    const sent = page.setCookie.mock.calls[0][0];
    expect(sent).not.toHaveProperty('expires');
  });

  it('действия выполняются в переданном порядке, клик — последним', async () => {
    const { explorer, page } = setup();
    await explorer.runRound({
      ...REQUEST,
      actions: [
        { kind: 'fill', selector: '#a', value: '1' },
        { kind: 'fill', selector: '#b', value: '2' },
        { kind: 'click', selector: '#next' },
      ],
    });
    expect(
      page.calls.filter((c: string) => c === 'fill' || c === 'click'),
    ).toEqual(['fill', 'fill', 'click']);
  });

  it('таймаут действия задаётся ВОЗВРАЩЁННЫМ локатором, а не выброшенным', async () => {
    // Локаторы puppeteer неизменяемы: `setTimeout` отдаёт новый объект.
    const { explorer, page } = setup();
    await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'click', selector: '#next' }],
    });
    expect(page.locatorObject.setTimeout).toHaveBeenCalled();
    const returned = page.locatorObject.setTimeout.mock.results[0].value;
    expect(returned.click).toBe(page.locatorObject.click);
  });
});

describe('доменный замок (§8.1)', () => {
  it('редирект на чужой сайт обрывает раунд ДО первого действия', async () => {
    const { explorer, page } = setup({
      url: jest.fn(() => 'https://evil.example.net/phish'),
    });
    await expect(
      explorer.runRound({
        ...REQUEST,
        actions: [{ kind: 'fill', selector: '#pwd', value: 'секрет' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Самое важное: пароль НЕ введён на чужом сайте.
    expect(page.locatorObject.fill).not.toHaveBeenCalled();
  });

  it('уход за пределы сайта ПОСЛЕ клика тоже обрывает раунд', async () => {
    let current = `${ORIGIN}/cabinet`;
    const { explorer } = setup({
      url: jest.fn(() => current),
      locator: jest.fn(() => ({
        setTimeout: jest.fn(function (this: unknown) {
          return this;
        }),
        fill: jest.fn(),
        click: jest.fn(async () => {
          current = 'https://sso.example.org/login';
        }),
      })),
    });
    await expect(
      explorer.runRound({
        ...REQUEST,
        actions: [{ kind: 'click', selector: '#go' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('результат раунда', () => {
  it('кадр отдаётся data-URL, а не голым base64', async () => {
    const { explorer } = setup();
    const { exploration } = await explorer.runRound(REQUEST);
    expect(exploration.screenshotDataUrl).toBe('data:image/jpeg;base64,Ykhk');
  });

  it('кадр снимается в JPEG — он едет в JSON и в колонку БД (§6.3)', async () => {
    const { explorer, page } = setup();
    await explorer.runRound(REQUEST);
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jpeg', encoding: 'base64' }),
    );
  });

  it('опасные кнопки помечаются в списке элементов — до того, как их нажмут', async () => {
    const { explorer } = setup();
    const { exploration } = await explorer.runRound(REQUEST);
    const pay = exploration.elements.find((e) => e.selector === '#pay');
    const next = exploration.elements.find((e) => e.selector === '#next');
    expect(pay?.danger).toBeDefined();
    expect(next?.danger).toBeUndefined();
  });

  it('нажатие опасной кнопки отмечается в раунде — для оператора при модерации', async () => {
    const { explorer } = setup();
    const { exploration } = await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'click', selector: '#pay' }],
    });
    expect(exploration.dangerWarning).toBeDefined();
  });

  it('обычный раунд предупреждения не несёт', async () => {
    const { explorer } = setup();
    const { exploration } = await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'click', selector: '#next' }],
    });
    expect(exploration.dangerWarning).toBeUndefined();
  });

  it('снимается ВЕСЬ jar браузера, а не куки текущей страницы', async () => {
    // Сессия могла частично жить на домене стороннего SSO (§7.4.5) —
    // `page.cookies()` этого не отдаёт, только CDP.
    const { explorer, page } = setup();
    await explorer.runRound(REQUEST);
    expect(page.cdp.send).toHaveBeenCalledWith('Network.getAllCookies');
  });

  it('мусор в снятых куках отбрасывается поштучно, а не роняет раунд', async () => {
    const { explorer } = setup();
    const { cookies } = await explorer.runRound(REQUEST);
    expect(cookies.map((c) => c.name)).toEqual(['sid']);
  });

  it('сбой снятия кук не теряет уже выполненный шаг', async () => {
    const { explorer } = setup({
      createCDPSession: jest.fn().mockRejectedValue(new Error('CDP закрылся')),
    });
    const { cookies, exploration } = await explorer.runRound(REQUEST);
    expect(cookies).toEqual([]);
    expect(exploration.screenshotDataUrl).toContain('data:image/jpeg');
  });

  it('страница, ушедшая в редирект прямо во время съёма, не роняет раунд', async () => {
    const { explorer } = setup({ evaluate: jest.fn().mockResolvedValue(null) });
    const { exploration } = await explorer.runRound(REQUEST);
    expect(exploration.elements).toEqual([]);
    expect(exploration.looksLikeLogin).toBe(false);
  });
});

describe('браузер закрывается всегда', () => {
  it('после успешного раунда', async () => {
    const { explorer, browser } = setup();
    await explorer.runRound(REQUEST);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('после исключения внутри раунда', async () => {
    // Незакрытый Chromium на serverless держит память инстанса до его
    // смерти — это не утечка «на один запрос», это утечка навсегда.
    const { explorer, browser } = setup({
      goto: jest.fn().mockRejectedValue(new Error('сайт не отвечает')),
    });
    await expect(explorer.runRound(REQUEST)).rejects.toThrow(
      'сайт не отвечает',
    );
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('и когда сам close падает — это не подменяет настоящую ошибку', async () => {
    const { explorer, browser } = setup({
      goto: jest.fn().mockRejectedValue(new Error('сайт не отвечает')),
    });
    browser.close.mockRejectedValue(new Error('не закрылся'));
    await expect(explorer.runRound(REQUEST)).rejects.toThrow(
      'сайт не отвечает',
    );
  });
});

describe('переигровка сценария (§5.2 /undo, этап 113)', () => {
  const STEPS = [
    { kind: 'goto' as const, route: `${ORIGIN}/login` },
    { kind: 'fill' as const, selector: '#email', value: 'a@b.c' },
    { kind: 'fill' as const, selector: '#pass', value: '' },
    { kind: 'click' as const, selector: '#submit' },
  ];

  it('куки НЕ восстанавливаются — сессия зарабатывается шагами заново', async () => {
    // В этом и смысл переигровки: состояния «на раунд раньше» взять
    // неоткуда, а старый jar привёл бы к тому, что шаги входа
    // выполнялись бы поверх уже живой сессии.
    const { explorer, page } = setup();
    await explorer.replay({
      steps: STEPS,
      secrets: { '#pass': 'п' },
      allowedOrigin: ORIGIN,
    });
    expect(page.setCookie).not.toHaveBeenCalled();
  });

  it('пустое значение шага заполняется сохранённым кредом (§7.3)', async () => {
    const { explorer, page } = setup();
    await explorer.replay({
      steps: STEPS,
      secrets: { '#pass': 'настоящий-пароль' },
      allowedOrigin: ORIGIN,
    });
    expect(page.locatorObject.fill).toHaveBeenCalledWith('a@b.c');
    expect(page.locatorObject.fill).toHaveBeenCalledWith('настоящий-пароль');
  });

  it('потерянный кред — внятный отказ, а не молчаливый вход пустой строкой', async () => {
    const { explorer } = setup();
    await expect(
      explorer.replay({ steps: STEPS, secrets: {}, allowedOrigin: ORIGIN }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('сценарий без ведущего goto — отказ, а не переигровка ниоткуда', async () => {
    const { explorer } = setup();
    await expect(
      explorer.replay({
        steps: [{ kind: 'click', selector: '#a' }],
        secrets: {},
        allowedOrigin: ORIGIN,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('чужие виды шагов пропускаются, а не роняют работу пользователя', async () => {
    // `waitFor`/`assertVisible` визард не пишет — но черновик мог
    // написать другой версии код, и терять из-за этого запись незачем.
    const { explorer, page } = setup();
    await explorer.replay({
      steps: [
        { kind: 'goto', route: `${ORIGIN}/a` },
        { kind: 'waitFor', selector: '#x' },
        { kind: 'click', selector: '#next' },
      ] as never,
      secrets: {},
      allowedOrigin: ORIGIN,
    });
    expect(page.locatorObject.click).toHaveBeenCalledTimes(1);
  });

  it('браузер закрывается и здесь', async () => {
    const { explorer, browser } = setup();
    await explorer.replay({
      steps: STEPS,
      secrets: { '#pass': 'п' },
      allowedOrigin: ORIGIN,
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('уход за пределы сайта во время переигровки обрывает её', async () => {
    const { explorer } = setup({
      url: jest.fn(() => 'https://evil.example.net/'),
    });
    await expect(
      explorer.replay({
        steps: STEPS,
        secrets: { '#pass': 'п' },
        allowedOrigin: ORIGIN,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Потолок функции против суммы границ раунда (29.09.2026).
 *
 * Тот же счёт, что у тика обучалки, и заведён он потому, что запуск
 * браузера жил СНАРУЖИ обоих таймаутов: `inFreshBrowser` поднимает
 * браузер до `withTimeout`, а сам `puppeteer.launch` не был ограничен
 * ничем.
 */
describe('бюджет раунда против потолка функции', () => {
  const src = readFileSync(
    join(__dirname, 'chromium-page-explorer.ts'),
    'utf8',
  );
  const chromium = readFileSync(
    join(__dirname, '..', '..', 'common', 'headless-chromium.ts'),
    'utf8',
  );
  const num = (text: string, name: string) =>
    Number(
      (
        new RegExp(`(?:export )?const ${name} = ([0-9_]+);`).exec(text)?.[1] ??
        '0'
      ).replace(/_/g, ''),
    );
  /** Потолок функции Vercel — тот же, что у тика обучалки. */
  const CEILING_MS = 300_000;

  it('раунд и переигровка вместе с запуском браузера помещаются под потолок', () => {
    const launch = num(chromium, 'LAUNCH_TIMEOUT_MS');
    const download = num(chromium, 'CHROMIUM_DOWNLOAD_TIMEOUT_MS');
    expect(launch).toBeGreaterThan(0);
    for (const name of ['ROUND_TIMEOUT_MS', 'REPLAY_TIMEOUT_MS']) {
      // Худший случай: качаем Chromium, поднимаем браузер, работаем всё
      // отведённое время. Скачивание и запуск идут последовательно, и
      // оба — ДО `withTimeout` вокруг самой работы.
      expect(download + launch + num(src, name)).toBeLessThanOrEqual(
        CEILING_MS,
      );
    }
  });

  it('ожидающий раунда ждёт НЕ МЕНЬШЕ, чем сервер себе разрешает', () => {
    // Две границы на одну операцию, и меньшая была у наблюдателя:
    // съёмка карточек лендинга ждала клик «Исследовать» 45 с, а
    // сервер отсчитывает свои 45 ПОСЛЕ запуска браузера. Сервер
    // честно доделывал раунд и тратил слот суточного лимита, а съёмка
    // уже записала шаг провалившимся.
    const snapshot = readFileSync(
      join(__dirname, '..', 'ui-snapshot', 'ui-snapshot-runner.service.ts'),
      'utf8',
    );
    expect(snapshot).toContain(
      'const CAPTURE_STEP_TIMEOUT_MS = CLIENT_ROUND_BUDGET_MS;',
    );
    // Сам бюджет обязан ВКЛЮЧАТЬ запуск браузера. Первая версия
    // этого теста складывала слагаемые сама и пережила мутацию
    // «убрать запуск из суммы»: она проверяла свою арифметику, а не
    // решение в коде. Тот же промах, что у первой проверки запаса
    // хвоста тика.
    expect(src).toContain(
      'CLIENT_ROUND_BUDGET_MS = LAUNCH_TIMEOUT_MS + ROUND_TIMEOUT_MS',
    );
    // И само ожидание обязано помещаться в бюджет тика съёмки —
    // иначе шаг не успеет даже начаться.
    const tickBudget = num(snapshot, 'RUN_TIME_BUDGET_MS');
    const roundBudget =
      num(chromium, 'LAUNCH_TIMEOUT_MS') + num(src, 'ROUND_TIMEOUT_MS');
    expect(roundBudget).toBeLessThanOrEqual(
      tickBudget > 0 ? tickBudget : 2 * 60 * 1000,
    );
  });

  it('запуск браузера ограничен — иначе счёт выше считает не всё', () => {
    expect(chromium).toMatch(/withTimeout\(\s*launching,\s*LAUNCH_TIMEOUT_MS,/);
  });
});

/**
 * Оседание страницы (29.09.2026, замер на полигоне).
 *
 * До этой правки первый кадр снимался на 57-й миллисекунде:
 * `domcontentloaded` — и сразу съёмка, а ожидание сети включалось
 * только ПОСЛЕ клика. Здесь проверяется, что оба пути оседают
 * одинаково и что кадр не бывает моложе пола.
 */
describe('оседание перед кадром', () => {
  it('первое открытие ждёт затишья сети, а не только DOMContentLoaded', async () => {
    const { explorer, page } = setup();
    await explorer.runRound(REQUEST);
    // Именно на ПЕРВОМ открытии: кликов в REQUEST нет вовсе.
    expect(page.waitForNetworkIdle).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(
      `${ORIGIN}/cabinet`,
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });

  it('кадр не бывает моложе пола', async () => {
    const { explorer } = setup();
    await explorer.runRound(REQUEST);
    // Часы теста стоят, значит досидеть нужно весь пол целиком.
    expect(explorer.slept).toEqual([SETTLE_FLOOR_MS]);
  });

  it('пол применяется и после клика — там кадр тоже снимают', async () => {
    const { explorer } = setup();
    await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'click', selector: '#go' }],
    });
    // Два перехода — два пола: открытие страницы и клик.
    expect(explorer.slept).toEqual([SETTLE_FLOOR_MS, SETTLE_FLOOR_MS]);
  });

  it('медленная страница не досиживает сверх пола', async () => {
    // Затишье наступило позже пола — ждать ещё раз незачем: кадру уже
    // больше, чем пол требует. Иначе каждый медленный сайт платил бы
    // полторы секунды сверху ни за что.
    const { explorer, page } = setup({
      waitForNetworkIdle: jest.fn(
        () =>
          new Promise((resolve) => {
            (explorer as any).clock += SETTLE_FLOOR_MS + 1;
            resolve(null);
          }),
      ),
    });
    void page;
    await explorer.runRound(REQUEST);
    expect(explorer.slept).toEqual([]);
  });
});

/**
 * Стабилизация кадра чужого сайта (01.10.2026, перенос правок QA TMA
 * §12). Сами исходники, уезжающие в страницу, проверены исполнением в
 * `foreign-frame-settle.spec.ts`; здесь — ПОРЯДОК: что и когда
 * разведчик вызывает вокруг снимков.
 */
describe('стабилизация кадра чужого сайта', () => {
  /** Страница, которая журналирует, КАКОЙ исходник ей прислали. */
  function marked(over: Record<string, any> = {}) {
    const ctx = setup(over);
    const page = ctx.page;
    const tag = (src: string) =>
      (Object.entries(FRAME_SOURCE_MARKS).find(([, m]) =>
        src.startsWith(m),
      )?.[0] ?? 'collect') as string;
    page.evaluate = jest.fn(async (src: string) => {
      const t = tag(src);
      page.calls.push(`eval:${t}`);
      return over.answer
        ? over.answer(t, src)
        : t === 'collect'
          ? COLLECTED
          : true;
    });
    page.setViewport = jest.fn(async (v: any) => {
      page.calls.push(`viewport:${v.deviceScaleFactor ?? 'none'}`);
    });
    page.screenshot = jest.fn(async (o: any) => {
      page.calls.push(`shot:${o.type}`);
      if (over.failShot === o.type) throw new Error('снимок упал');
      return 'Ykhk';
    });
    return ctx;
  }
  const after = (calls: string[], from: string) =>
    calls.slice(calls.lastIndexOf(from));

  it('заморозка до снимков, снятие — после обоих; затишье DSF — между DSF=2 и PNG', async () => {
    const { explorer, page } = marked();
    await explorer.runRound(REQUEST);
    const tail = after(page.calls, 'eval:collect');
    expect(tail).toEqual([
      'eval:collect',
      'eval:freeze',
      'shot:jpeg',
      'viewport:2',
      'eval:repaint',
      'eval:freeze',
      'shot:png',
      'viewport:1',
      'eval:release',
    ]);
  });

  it('оседание опрашивается ДО сбора элементов и снимка', async () => {
    const { explorer, page } = marked();
    await explorer.runRound(REQUEST);
    expect(page.calls.indexOf('eval:probe')).toBeGreaterThan(-1);
    expect(page.calls.indexOf('eval:probe')).toBeLessThan(
      page.calls.indexOf('eval:collect'),
    );
  });

  it('заморозка снимается, даже если лёгкий снимок упал', async () => {
    // Страница живёт дальше — оставить ей transition:none нельзя.
    const { explorer, page } = marked({ failShot: 'jpeg' });
    await expect(explorer.runRound(REQUEST)).rejects.toThrow('снимок упал');
    expect(page.calls).toContain('eval:release');
  });

  it('спиннер держит кадр мягко: ждём, пока не исчезнет, и снимаем', async () => {
    let probes = 0;
    const { explorer } = marked({
      answer: (t: string) =>
        t === 'probe'
          ? { fontsLoading: false, busy: ++probes <= 2 ? 'div.spinner' : null }
          : t === 'collect'
            ? COLLECTED
            : true,
    });
    const { exploration } = await explorer.runRound(REQUEST);
    // Пол открытия + две паузы опроса.
    expect(explorer.slept).toEqual([SETTLE_FLOOR_MS, 200, 200]);
    expect(exploration.screenshotDataUrl).toContain('data:image/jpeg');
  });

  it('вечный спиннер не держит раунд дольше потолка', async () => {
    const { explorer } = marked({
      answer: (t: string) =>
        t === 'probe'
          ? { fontsLoading: false, busy: 'div.skeleton' }
          : t === 'collect'
            ? COLLECTED
            : true,
    });
    const { exploration } = await explorer.runRound(REQUEST);
    const waited = explorer.slept.slice(1).reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(3_000);
    expect(exploration.screenshotDataUrl).toBeDefined();
  });

  it('клик без перехода — цель в центр окна ДО оседания', async () => {
    const { explorer, page } = marked();
    await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'click', selector: '#below' }],
    });
    const scroll = page.calls.indexOf('eval:scroll');
    expect(scroll).toBeGreaterThan(page.calls.indexOf('click'));
    expect(scroll).toBeLessThan(page.calls.indexOf('eval:probe'));
    const src = page.evaluate.mock.calls.find(([s]: [string]) =>
      s.startsWith(FRAME_SOURCE_MARKS.scroll),
    )[0];
    expect(src).toContain('"#below"');
  });

  it('целью считается последний fill, если клика не было', async () => {
    const { explorer, page } = marked();
    await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'fill', selector: '#comment', value: 'x' }],
    });
    const src = page.evaluate.mock.calls.find(([s]: [string]) =>
      s.startsWith(FRAME_SOURCE_MARKS.scroll),
    )?.[0];
    expect(src).toContain('"#comment"');
  });

  it('после перехода окно НЕ крутится — смысл кадра в верхе нового экрана', async () => {
    let current = `${ORIGIN}/cabinet`;
    const { explorer, page } = marked({
      url: jest.fn(() => current),
      locator: jest.fn(() => ({
        fill: jest.fn(),
        click: jest.fn(async () => {
          current = `${ORIGIN}/orders`;
        }),
      })),
    });
    await explorer.runRound({
      ...REQUEST,
      actions: [{ kind: 'click', selector: '#orders' }],
    });
    expect(page.calls).not.toContain('eval:scroll');
  });

  it('раунд без действий окно не крутит', async () => {
    const { explorer, page } = marked();
    await explorer.runRound(REQUEST);
    expect(page.calls).not.toContain('eval:scroll');
  });

  it('мало времени до конца раунда — оседание и затишье DSF не ждут, кадр снимается', async () => {
    // Аудит 01.10.2026: новые ожидания берут только ОСТАТОК бюджета
    // раунда (45 с), а не добавляются к худшему случаю сверху.
    const { explorer, page } = marked({
      answer: (t: string) =>
        t === 'probe'
          ? { fontsLoading: false, busy: 'div.spinner' }
          : t === 'collect'
            ? COLLECTED
            : true,
    });
    // Медленный сайт: открытие съело почти весь раунд.
    page.goto = jest.fn(async () => {
      page.calls.push('goto');
      explorer.clock += 43_000;
    });
    const { exploration } = await explorer.runRound(REQUEST);
    expect(page.calls).not.toContain('eval:probe');
    expect(page.calls).not.toContain('eval:repaint');
    // Пол открытия уже пройден часами goto — ни одной паузы.
    expect(explorer.slept).toEqual([]);
    expect(exploration.screenshotDataUrl).toContain('data:image/jpeg');
    expect(exploration.videoFrameDataUrl).toBeDefined();
  });

  it('остаток меньше потолка — оседание ждёт не дольше остатка', async () => {
    const { explorer, page } = marked({
      answer: (t: string) =>
        t === 'probe'
          ? { fontsLoading: false, busy: 'div.spinner' }
          : t === 'collect'
            ? COLLECTED
            : true,
    });
    // Остаётся 45 000 − 41 500 − резерв 2 000 = 1 500 мс на оседание.
    page.goto = jest.fn(async () => {
      explorer.clock += 41_500;
    });
    await explorer.runRound(REQUEST);
    const waited = explorer.slept.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(1_500);
  });

  it('переигровка доворачивает к последнему шагу, если он не увёл', async () => {
    const { explorer, page } = marked();
    await explorer.replay({
      steps: [
        { kind: 'goto', route: `${ORIGIN}/cabinet` },
        { kind: 'click', selector: '#below' },
      ],
      secrets: {},
      allowedOrigin: ORIGIN,
    });
    expect(page.calls).toContain('eval:scroll');
  });
});

describe('предупреждение о редиректе (01.10.2026)', () => {
  it('просили /cabinet, открылся /login — предупреждение, кадр отдаётся', async () => {
    const { explorer } = setup({ url: jest.fn(() => `${ORIGIN}/login`) });
    const { exploration } = await explorer.runRound(REQUEST);
    expect(exploration.redirectWarning).toContain('/login');
    expect(exploration.redirectWarning).toContain('/cabinet');
    expect(exploration.screenshotDataUrl).toContain('data:image/jpeg');
  });

  it('тот же экран — предупреждения нет', async () => {
    const { explorer } = setup();
    const { exploration } = await explorer.runRound(REQUEST);
    expect(exploration.redirectWarning).toBeUndefined();
  });

  it('переигровка: важен экран последнего перехода, а не промежуточный', async () => {
    const { explorer } = setup({ url: jest.fn(() => `${ORIGIN}/cabinet`) });
    const { exploration } = await explorer.replay({
      steps: [
        { kind: 'goto', route: `${ORIGIN}/login` },
        { kind: 'goto', route: `${ORIGIN}/cabinet` },
      ],
      secrets: {},
      allowedOrigin: ORIGIN,
    });
    expect(exploration.redirectWarning).toBeUndefined();
  });
});

describe('таймаут переигровки назван по-человечески (01.10.2026)', () => {
  function timeoutError() {
    const e = new Error('Waiting for selector `#submit` failed');
    e.name = 'TimeoutError';
    return e;
  }

  it('таймаут на шаге — 504 с шлюзом и номером шага, не голое «не уложилась»', async () => {
    const { explorer } = setup({
      locator: jest.fn(() => ({
        fill: jest.fn(),
        click: jest.fn().mockRejectedValue(timeoutError()),
      })),
    });
    const err = await explorer
      .replay({
        steps: [
          { kind: 'goto', route: `${ORIGIN}/login` },
          { kind: 'fill', selector: '#email', value: 'a@b.c' },
          { kind: 'click', selector: '#submit' },
        ],
        secrets: {},
        allowedOrigin: ORIGIN,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayTimeoutException);
    expect(err.message).toContain(
      'шлюз (куки/возраст/гео) или изменение сайта',
    );
    expect(err.message).toContain('шаге 3 из 3');
  });

  it('не-таймауты переигровки не переименовываются', async () => {
    // Потерянный кред уже назван точно — «шлюз» здесь был бы враньём.
    const { explorer } = setup();
    const err = await explorer
      .replay({
        steps: [
          { kind: 'goto', route: `${ORIGIN}/login` },
          { kind: 'fill', selector: '#pass', value: '' },
        ],
        secrets: {},
        allowedOrigin: ORIGIN,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it('обычный раунд таймаут не переименовывает', async () => {
    const { explorer } = setup({
      locator: jest.fn(() => ({
        fill: jest.fn(),
        click: jest.fn().mockRejectedValue(timeoutError()),
      })),
    });
    const err = await explorer
      .runRound({ ...REQUEST, actions: [{ kind: 'click', selector: '#x' }] })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(GatewayTimeoutException);
    expect(err.name).toBe('TimeoutError');
  });
});
