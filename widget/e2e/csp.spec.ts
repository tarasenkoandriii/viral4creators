/**
 * Приёмка Э2 п.2 (часть W1) + стенд Trusted Types (§4.12, аудит 1.2):
 *  - CSP из инструкции (script/frame/img/connect-src виджета) — работает:
 *    конфиг получен, пинг c=1, чат отвечает, нарушений CSP нет;
 *  - CSP без наших директив — загрузчик не исполняется: ни пинга, ни конфига
 *    (по этому «нет пинга при наличии тега» проверка установки W4 говорит «вероятно, CSP»);
 *  - CSP без connect-src (отступление §4.12, контракт §1 п.6) — пинг c=0,
 *    вид по умолчанию, чат всё равно работает (API зовёт iframe);
 *  - `require-trusted-types-for 'script'; trusted-types 'none'` на странице
 *    заказчика — загрузчик работает без единой политики и нарушения.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  ask,
  chat,
  launcher,
  log,
  mock,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';

const INSTRUCTION =
  "default-src 'self'; script-src 'self' {W}; frame-src {W}; img-src 'self' {W}; connect-src 'self' {W}; style-src 'self'";
const NO_OURS = "default-src 'self'; script-src 'self'; style-src 'self'";
const NO_CONNECT =
  "default-src 'self'; script-src 'self' {W}; frame-src {W}; img-src 'self' {W}; style-src 'self'";
const TT = `${INSTRUCTION}; require-trusted-types-for 'script'; trusted-types 'none'`;

test.beforeEach(async ({ page }) => {
  await mock('reset');
  // Нарушения CSP/Trusted Types — и на странице, и в iframe.
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`)
    );
  });
});

async function violations(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const f of page.frames()) {
    try {
      out.push(
        ...(await f.evaluate(
          () => (window as unknown as { __csp?: string[] }).__csp || []
        ))
      );
    } catch {
      /* кадр без доступа */
    }
  }
  return out;
}

for (const [name, csp] of [
  ['CSP из инструкции', INSTRUCTION],
  ['CSP из инструкции + принудительные Trusted Types', TT],
] as const) {
  test(`${name}: работает — конфиг, пинг c=1, ответ; нарушений нет`, async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk, { config: { brand: { primaryColor: '#aa0000' } } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(
      stand('example.localhost', { pk, csp, queue: true, ownButton: true })
    );
    await expect.poll(async () => (await log()).pings.length).toBe(1);
    const l = await log();
    expect(l.pings[0]).toMatchObject({ pk, c: '1' });
    expect(l.configHits).toContain(pk);
    expect(
      await launcher(page).evaluate((e) => getComputedStyle(e).backgroundColor)
    ).toBe('rgb(170, 0, 0)');
    await openChat(page);
    await ask(page, 'Вопрос под CSP');
    await waitAnswer(page);
    await page.locator('#own').click(); // V4CAssist со страницы под CSP
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('CSP без наших директив: загрузчик заблокирован — нет пинга и конфига', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, csp: NO_OURS }));
  await page.waitForTimeout(1500);
  const l = await log();
  expect(l.pings).toEqual([]);
  expect(l.configHits).toEqual([]);
  await expect(launcher(page)).toHaveCount(0);
  expect((await violations(page)).some((v) => v.startsWith('script-src'))).toBe(
    true
  );
});

test('CSP без connect-src: пинг c=0, вид по умолчанию, чат работает', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { config: { brand: { primaryColor: '#aa0000' } } });
  await page.goto(stand('example.localhost', { pk, csp: NO_CONNECT }));
  await expect.poll(async () => (await log()).pings.length).toBe(1);
  const l = await log();
  expect(l.pings[0].c).toBe('0');
  expect(l.configHits).toEqual([]);
  expect(
    await launcher(page).evaluate((e) => getComputedStyle(e).backgroundColor)
  ).toBe('rgb(31, 95, 214)');
  await openChat(page);
  await ask(page, 'Без connect-src');
  await waitAnswer(page);
  // Вид в iframe — из конфига (iframe ходит к своему origin: connect-src 'self' у него свой).
  await expect(chat(page).locator('.hd')).toHaveCSS(
    'background-color',
    'rgb(170, 0, 0)'
  );
});

test('Э3: Trusted Types — загрузчик, триггер и цели работают; режим выбора цели — честный отказ (О-8)', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
    })
  );
  const warnings: string[] = [];
  const urls: string[] = [];
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
  page.on('request', (r) => urls.push(r.url()));
  const pk = newPk();
  await site(pk, {
    pickerTokens: {
      tok_goal_tt_123456789012345: 'http://example.localhost:5182',
    },
    goals: [
      {
        key: 'call',
        detectors: [{ kind: 'click', config: { auto: 'tel' } }],
        valueMode: 'none',
      },
    ],
    engagement: {
      schema: 1,
      triggers: [
        {
          key: 'tt',
          enabled: true,
          condition: { kind: 'time_on_page', seconds: 10 },
          pathMasks: [],
          text: { ru: 'Помочь?' },
          onAccept: { kind: 'open' },
        },
      ],
      limits: { perVisit: 1, excludedPaths: [], notOnFirstScreenMobile: true },
      scenarios: [],
    },
  });
  await page.goto(
    stand('example.localhost', { pk, csp: TT, goalsKit: true }) +
      '&v4c_goal=tok_goal_tt_123456789012345'
  );
  await expect(launcher(page)).toBeVisible();
  // Токен из адреса убран и без чанка.
  expect(page.url()).not.toContain('v4c_goal');
  await expect(page.locator('[data-v4c-picker]')).toHaveCount(0);
  expect(urls.some((u) => u.includes('/v1/picker.js'))).toBe(false);
  expect(warnings.join('\n')).toContain('Trusted Types');
  // Триггер под TT — пузырь (textContent, без политики).
  await expect(page.locator('[data-v4c] .g')).toHaveCount(1, {
    timeout: 14_000,
  });
  await page.evaluate(() =>
    document
      .getElementById('tel')!
      .addEventListener('click', (e) => e.preventDefault())
  );
  await page.locator('#tel').click();
  await expect
    .poll(async () => (await log()).goals.map((g) => g.goalKey))
    .toEqual(['call']);
  await openChat(page);
  // Нарушения TT от загрузчика нет: picker не вставлялся (сеттер src бросил до вставки).
  expect((await violations(page)).filter((v) => !/picker/.test(v))).toEqual([]);
});
