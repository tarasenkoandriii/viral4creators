/**
 * Приёмка Э2 п.5а (часть W1) и «к Л2»: граница доверия postMessage с обеих
 * сторон, бренд-инъекции — только текстом/умолчанием, iframe вне
 * frame-ancestors не рисуется, подмена нативных методов страницей,
 * `preview` без флага — игнор. Проверено на МОКЕ W2 (заголовок
 * frame-ancestors отдаёт стенд по тем же правилам, что frame-html.ts).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  A,
  OTHER,
  WIDGET,
  WIDGET_MESSAGE_NS,
  WIDGET_PROTOCOL_VERSION,
  ask,
  chat,
  frameEl,
  launcher,
  log,
  mock,
  newPk,
  openChat,
  panel,
  site,
  stand,
  waitAnswer,
} from './fixtures';

const DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/v1'
);

test.beforeEach(async () => {
  await mock('reset');
});

test('5а: загрузчик игнорирует чужой origin, «*» со страницы и чужое окно того же origin', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  // Чужой origin (other.localhost) внутри страницы шлёт команды и загрузчику, и iframe.
  await page.goto(
    stand('example.localhost', { pk, evilFrame: `${OTHER}/evil.html` })
  );
  await openChat(page);
  // Страница сама шлёт себе «как будто от iframe» с '*' — origin страницы ≠ origin виджета.
  await page.evaluate(
    ([ns, v]) => {
      window.postMessage({ ns, v, type: 'ui-state', state: 'closed' }, '*');
      window.postMessage(
        { ns, v, type: 'unavailable', code: 'ORIGIN_DENIED' },
        '*'
      );
    },
    [WIDGET_MESSAGE_NS, WIDGET_PROTOCOL_VERSION] as const
  );
  // Окно ТОГО ЖЕ origin виджета, но не наш iframe (event.source ≠ iframe).
  await page.evaluate((w) => {
    const f = document.createElement('iframe');
    f.src = `${w}/evil-frame.html`;
    document.body.appendChild(f);
  }, WIDGET);
  await page.waitForTimeout(1500);
  await expect(panel(page)).toBeVisible();
  await expect(launcher(page)).toBeVisible();
  // iframe не принял ask из чужого окна: вопроса нет ни в ленте, ни у модели.
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  expect((await log()).modelCalls).toHaveLength(0);
  // Свой канал работает: вопрос посетителя проходит.
  await ask(page, 'Настоящий вопрос');
  await waitAnswer(page);
  expect((await log()).modelCalls.map((c) => c.question)).toEqual([
    'Настоящий вопрос',
  ]);
});

test('5а: iframe чата принимает только window.parent — окно того же origin, что родитель, игнорируется', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  // evil.html с origin САМОЙ страницы (A): origin совпадает, но source — не родитель.
  await page.goto(
    stand('example.localhost', { pk, evilFrame: `${A}/evil.html` })
  );
  await openChat(page);
  await page.waitForTimeout(1500);
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  expect((await log()).modelCalls).toHaveLength(0);
  await expect(panel(page)).toBeVisible();
});

test('5а: iframe шлёт родителю только с точным targetOrigin (никогда «*») — скан сборки', async () => {
  for (const f of ['loader.js', 'chat.js']) {
    const code = fs.readFileSync(path.join(DIST, f), 'utf8');
    // Минифицированный вызов: postMessage(f(e),"*") — ищем «*» вторым аргументом.
    expect(code, f).not.toMatch(
      /postMessage\((?:[^()]|\([^()]*\))*,\s*["'`]\*["'`]\s*\)/
    );
    expect(code, f).not.toMatch(/,\s*["'`]\*["'`]\s*\)/);
  }
});

test('5а: наружу из iframe — только тип события (on), без текста и полей лида', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, queue: true }));
  await page.evaluate(() => {
    const w = window as unknown as {
      __ev: unknown[];
      V4CAssist: (...a: unknown[]) => void;
    };
    w.__ev = [];
    for (const n of ['open', 'close', 'lead', 'handoff'])
      w.V4CAssist('on', n, (e: unknown) => w.__ev.push(e));
  });
  // Всё, что приходит странице от виджета по postMessage, — тоже записываем.
  await page.evaluate((w) => {
    (window as unknown as { __pm: unknown[] }).__pm = [];
    window.addEventListener(
      'message',
      (e) =>
        e.origin === w &&
        (window as unknown as { __pm: unknown[] }).__pm.push(e.data)
    );
  }, WIDGET);
  await openChat(page);
  await ask(page, 'Хочу заказ, мой телефон +380501234567');
  await waitAnswer(page);
  await chat(page).getByRole('button', { name: 'Оставить заявку' }).click();
  await chat(page).locator('input[name=phone]').fill('+380 50 123 45 67');
  await chat(page).locator('input[name=consent]').check();
  await chat(page).locator('form.lead button[type=submit]').click();
  await expect(chat(page).locator('.lead[role=status]')).toBeVisible();
  const ev = await page.evaluate(
    () => (window as unknown as { __ev: Array<Record<string, unknown>> }).__ev
  );
  expect(ev.map((e) => e.type)).toEqual(['open', 'lead']);
  for (const e of ev) expect(Object.keys(e).sort()).toEqual(['at', 'type']);
  const pm = JSON.stringify(
    await page.evaluate(() => (window as unknown as { __pm: unknown[] }).__pm)
  );
  expect(pm).not.toContain('380');
  expect(pm).not.toContain('телефон');
  expect(pm).not.toContain('vt_');
  const lead = (await log()).leads[0];
  expect(lead.consent).toBe(true);
});

test('5а: бренд-инъекции — только текстом/умолчанием', async ({ page }) => {
  const pk = newPk();
  await site(pk, {
    config: {
      brand: {
        primaryColor: 'red;background:url(//evil.example/x)',
        name: '<img src=x onerror=window.__xss=1>',
        launcherIcon: 'logo',
        logoAssetId: '"><script>',
      },
      texts: {
        ru: {
          greeting: '<script>window.__xss=2</script>',
          suggestions: ['<b>жирно</b>'],
        },
      },
    },
  });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  const bg = await launcher(page).evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  expect(bg).toBe('rgb(31, 95, 214)'); // умолчание #1f5fd6
  const nm = chat(page).locator('.nm span').first();
  await expect(nm).toHaveText(
    '<img src=x onerror=window.__xss=1>'.slice(0, 30)
  );
  await expect(chat(page).locator('.hd img')).toHaveCount(0);
  await expect(chat(page).locator('.greet .bub')).toHaveText(
    '<script>window.__xss=2</script>'
  );
  await expect(chat(page).locator('.sugg button')).toHaveText(['<b>жирно</b>']);

  const xss = await page
    .frames()
    .find((f) => f.url().includes('/w/v1/frame'))!
    .evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)
  ).toBeUndefined();
  expect(requests.filter((u) => u.includes('evil.example'))).toEqual([]);
  // Значения, валидные для CSS, но не HEX: именованный цвет и url() (утечка запросом) — тоже умолчание.
  for (const primaryColor of ['red', 'url(//evil.example/c.png)', 'var(--x)']) {
    const pkc = newPk();
    await site(pkc, {
      config: {
        brand: { primaryColor, buttonTextColor: 'url(//evil.example/t.png)' },
      },
    });
    await page.goto(stand('example.localhost', { pk: pkc }));
    await expect(launcher(page)).toBeVisible();
    await page.waitForTimeout(300);
    expect(
      await launcher(page).evaluate(
        (el) => getComputedStyle(el).backgroundColor
      ),
      primaryColor
    ).toBe('rgb(31, 95, 214)');
  }
  expect(requests.filter((u) => u.includes('evil.example'))).toEqual([]);
});

test('5а: ответ модели — враждебный текст: без HTML, чужих ссылок и картинок', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Покажи ссылки');
  await waitAnswer(page);
  const bub = chat(page).locator('.msg.bot').last();
  const hrefs = await bub
    .locator('a')
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) expect(new URL(h).origin).toBe(A);
  await expect(bub.locator('img')).toHaveCount(0);
  await expect(bub).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(bub.getByText('Плохая')).toHaveCount(0); // действие javascript: — не показано
  expect(requests.filter((u) => u.includes('evil.example'))).toEqual([]);
});

test('5а: iframe не рисуется вне frame-ancestors; загрузчик не показывает кнопку на чужом хосте', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk); // разрешены только example.localhost и shop.example.localhost
  const chatJs: string[] = [];
  page.on(
    'request',
    (r) => r.url().includes('/v1/chat.js') && chatJs.push(r.url())
  );
  // Чужой сайт встраивает iframe чата напрямую — браузер не отрисует (frame-ancestors).
  await page.goto(stand('other.localhost', { pk, directFrame: true }));
  await page.waitForTimeout(1500);
  expect(chatJs).toEqual([]);
  expect((await log()).sessions).toEqual([]);
  // Тот же pk с загрузчиком на чужом хосте: hosts из конфига не содержат origin — кнопки нет.
  await page.goto(stand('other.localhost', { pk }));
  await page.waitForTimeout(800);
  await expect(launcher(page)).toBeHidden();
});

test('5а: хост в конфиге есть, но браузер не пустил iframe (отзыв) — кнопка убирается, каркас не висит', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { allowedOrigins: [SHOP_ONLY], hosts: [{ origin: A }] });
  await page.goto(stand('example.localhost', { pk }));
  await launcher(page).click();
  await expect(frameEl(page)).toHaveCount(1);
  await expect(launcher(page)).toBeHidden({ timeout: 8000 });
  expect((await log()).sessions).toEqual([]);
});
const SHOP_ONLY = 'http://shop.example.localhost:5182';

test('сервер ответил ORIGIN_DENIED на сессию — iframe сообщает unavailable, кнопка убрана', async ({
  page,
}) => {
  const pk = newPk();
  // frame-ancestors пускает (льгота), но сессия — отказ: origin не в списке сессии мока.
  await mock('site', {
    pk,
    allowedOrigins: [A],
    hosts: [{ origin: A, pathMasks: [], hideOn: [] }],
  });
  await page.goto(stand('example.localhost', { pk }));
  // Ломаем допуск ПОСЛЕ отрисовки iframe: тот же сайт без A в списке сессии.
  await page.route('**/widget/v1/session', (r) =>
    r.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: { code: 'ORIGIN_DENIED', message: '' },
      }),
    })
  );
  await launcher(page).click();
  await expect(launcher(page)).toBeHidden({ timeout: 8000 });
});

test('нативные методы, подменённые страницей ПОСЛЕ старта, виджет не ломают', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await page.evaluate(() => {
    const noop = () => {
      throw new Error('подменено страницей');
    };
    EventTarget.prototype.addEventListener = noop as never;
    window.fetch = noop as never;
    history.pushState = noop as never;
    Element.prototype.attachShadow = noop as never;
    Document.prototype.createElement = noop as never;
  });
  await openChat(page);
  await ask(page, 'После подмены');
  await waitAnswer(page);
});

test('«к Л2»: preview без allowClientPreview — игнор; с флагом — те же проверки HEX/enum', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { allowClientPreview: false });
  await page.goto(stand('example.localhost', { pk, queue: true }));
  await page.evaluate(() =>
    (window as unknown as { V4CAssist: (...a: unknown[]) => void }).V4CAssist(
      'preview',
      { brand: { primaryColor: '#ff0000' } }
    )
  );
  await page.waitForTimeout(500);
  expect(
    await launcher(page).evaluate((el) => getComputedStyle(el).backgroundColor)
  ).toBe('rgb(31, 95, 214)');

  const pk2 = newPk();
  await site(pk2, { allowClientPreview: true });
  await page.goto(stand('example.localhost', { pk: pk2, queue: true }));
  await page.evaluate(() => {
    const V = (window as unknown as { V4CAssist: (...a: unknown[]) => void })
      .V4CAssist;
    V('preview', { brand: { primaryColor: '#ff0000' } });
  });
  await expect
    .poll(() =>
      launcher(page).evaluate((el) => getComputedStyle(el).backgroundColor)
    )
    .toBe('rgb(255, 0, 0)');
  await page.evaluate(() => {
    const V = (window as unknown as { V4CAssist: (...a: unknown[]) => void })
      .V4CAssist;
    V('preview', {
      brand: { primaryColor: 'blue;background:url(//evil.example/x)' },
      layout: { position: 'nowhere' },
    });
  });
  await page.waitForTimeout(300);
  // Инъекция не прошла: цвет — опубликованный (умолчание), угол — прежний.
  expect(
    await launcher(page).evaluate((el) => getComputedStyle(el).backgroundColor)
  ).toBe('rgb(31, 95, 214)');
  const box = await launcher(page).boundingBox();
  expect(box!.x).toBeGreaterThan(600);
});
