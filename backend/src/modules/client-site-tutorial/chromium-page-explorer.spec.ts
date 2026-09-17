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

import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChromiumPageExplorer } from './chromium-page-explorer';

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

function setup(over: Record<string, any> = {}) {
  const page = makePage(over);
  const browser = {
    newPage: jest.fn(async () => page),
    close: jest.fn().mockResolvedValue(undefined),
  };
  launchHeadlessBrowserMock.mockResolvedValue({ browser });
  return { explorer: new ChromiumPageExplorer(), page, browser };
}

const REQUEST = {
  url: `${ORIGIN}/cabinet`,
  cookies: [],
  actions: [],
  allowedOrigin: ORIGIN,
};

beforeEach(() => {
  launchHeadlessBrowserMock.mockReset();
});

describe('браузер не поднялся', () => {
  it('503 с причиной, а не «внутренняя ошибка»', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const explorer = new ChromiumPageExplorer();
    await expect(explorer.runRound(REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('причина видна в сообщении — иначе диагностировать нечем', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const explorer = new ChromiumPageExplorer();
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
