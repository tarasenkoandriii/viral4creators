/**
 * Остальное из зоны W1 (контракт Э2 §4): `?v4c_preview=` (одноразовый
 * обмен, параметр убран replaceState, черновой вид только в этой вкладке),
 * `data-preview-token` (конфигуратор TMA), тема и шрифт «как на сайте»,
 * свои шрифты — только с нашего origin, статусы `lead_only`/`off`,
 * `context`/`identify`, JSON-запасной путь чата. На МОКЕ W2.
 */
import { test, expect } from '@playwright/test';
import {
  A,
  WIDGET,
  WIDGET_STORAGE_PREFIX,
  ask,
  chat,
  frameEl,
  launcher,
  log,
  mock,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';

test.beforeEach(async () => {
  await mock('reset');
});

const DRAFT = { brand: { primaryColor: '#7a1fa2', name: 'Черновик' } };
const TOKEN = 'pt_e2e_preview_token_1234';

test('?v4c_preview=: параметр убран из адреса, токен обменян один раз, черновой вид — только в этой вкладке', async ({
  page,
  context,
}) => {
  const pk = newPk();
  await site(pk, { previewTokens: { [TOKEN]: DRAFT } });
  const url = stand('example.localhost', { pk }) + `&v4c_preview=${TOKEN}`;
  await page.goto(url);
  await expect(launcher(page)).toBeVisible();
  expect(page.url()).not.toContain('v4c_preview');
  expect(page.url()).toContain('/page?s=');
  await openChat(page);
  expect(await frameEl(page).getAttribute('src')).toMatch(/[?&]pv=1$/);
  await expect(chat(page).locator('.nm span').first()).toHaveText('Черновик');
  await expect(chat(page).locator('.hd')).toHaveCSS(
    'background-color',
    'rgb(122, 31, 162)'
  );
  expect((await log()).sessions.at(-1)).toBeTruthy();
  // Перезагрузка вкладки: сессия предпросмотра — из sessionStorage iframe, не повторный обмен.
  await page.reload();
  await openChat(page);
  await expect(chat(page).locator('.nm span').first()).toHaveText('Черновик');
  const exchanges = (await log()).requests.filter(
    (r) => r.path === '/widget/v1/preview/exchange'
  );
  expect(exchanges).toHaveLength(1);
  // Другая вкладка без параметра — опубликованный вид.
  const other = await context.newPage();
  await other.goto(stand('example.localhost', { pk }));
  await openChat(other);
  await expect(chat(other).locator('.nm span').first()).toHaveText('Помощник');
  // Повтор утёкшего токена (Referer/аналитика) — отказ, чат недоступен в этой вкладке.
  const third = await context.newPage();
  await third.goto(url);
  await launcher(third).click();
  await expect(launcher(third)).toBeHidden({ timeout: 8000 });
});

test('data-preview-token (конфигуратор TMA) — тот же обмен', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { previewTokens: { [TOKEN]: DRAFT } });
  await page.goto(
    stand('example.localhost', { pk, attrs: { 'data-preview-token': TOKEN } })
  );
  await openChat(page);
  await expect(chat(page).locator('.nm span').first()).toHaveText('Черновик');
});

test('тема «как на сайте»: data-theme на <html> — и при смене на лету (MutationObserver)', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { config: { brand: { theme: 'site' } } });
  await page.goto(stand('example.localhost', { pk, theme: 'dark' }));
  await openChat(page);
  await expect(chat(page).locator('.v4c-chat')).toHaveClass(/dark/);
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'light')
  );
  await expect(chat(page).locator('.v4c-chat')).not.toHaveClass(/dark/);
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark')
  );
  await expect(chat(page).locator('.v4c-chat')).toHaveClass(/dark/);
});

test('шрифт «как на сайте» — вычисленный font-family body; свои шрифты — только с origin виджета, по открытию', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { config: { brand: { font: 'site' } } });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  const ff = await chat(page)
    .locator('.v4c-chat')
    .evaluate((e) => getComputedStyle(e).fontFamily);
  expect(ff).toContain('Georgia');

  const pk2 = newPk();
  await site(pk2, { config: { brand: { font: 'inter' } } });
  const fonts: string[] = [];
  page.on('request', (r) => r.resourceType() === 'font' && fonts.push(r.url()));
  await page.goto(stand('example.localhost', { pk: pk2 }));
  await page.waitForTimeout(500);
  expect(fonts).toEqual([]); // до открытия — ничего
  await openChat(page);
  const ff2 = await chat(page)
    .locator('.v4c-chat')
    .evaluate((e) => getComputedStyle(e).fontFamily);
  expect(ff2).toContain('v4c-inter');
  await expect.poll(() => fonts.length).toBeGreaterThan(0);
  for (const f of fonts) expect(f.startsWith(`${WIDGET}/v1/fonts/`)).toBe(true);
});

test('status lead_only — только форма заявки; status off — кнопки нет', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { status: 'lead_only' });
  await page.goto(stand('example.localhost', { pk }));
  await launcher(page).click();
  await expect(chat(page).locator('form.lead')).toBeVisible();
  await expect(chat(page).locator('.cmp')).toHaveCount(0);
  await expect(
    chat(page).getByText('Помощник сейчас не отвечает', { exact: false })
  ).toBeVisible();

  const pk2 = newPk();
  await site(pk2, { status: 'off' });
  await page.goto(stand('example.localhost', { pk: pk2 }));
  await page.waitForTimeout(800);
  await expect(launcher(page)).toBeHidden();
});

test('context и identify: контекст уходит с вопросом как данные; identify — только предзаполнение формы лида', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, queue: true }));
  await page.evaluate(() => {
    const V = (window as unknown as { V4CAssist: (...a: unknown[]) => void })
      .V4CAssist;
    V('context', { page: 'product', sku: 'A-12', price: 100 });
    V('context', { evil: { nested: true } }); // не строка/число — игнор
    V('identify', { name: 'Олена', email: 'olena@example.com' });
  });
  await openChat(page);
  await ask(page, 'Есть размер M?');
  await waitAnswer(page);
  const call = (await log()).modelCalls[0];
  expect(call.context).toEqual({ page: 'product', sku: 'A-12', price: 100 });
  expect(call.uiLang).toBe('ru');
  await chat(page).getByRole('button', { name: 'Оставить заявку' }).click();
  await expect(chat(page).locator('input[name=name]')).toHaveValue('Олена');
  // identify сам по себе на сервер не уходит (К-3): в запросах нет e-mail.
  const reqs = JSON.stringify((await log()).requests);
  expect(reqs).not.toContain('olena@example.com');
});

test('JSON-запасной путь чата (Accept: application/json / ответ JSON)', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await page.route(`${WIDGET}/widget/v1/chat`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          conversationId: 'c_json',
          messageId: 'm_json',
          text: 'Ответ одним куском. [Ссылка](' + A + '/x)',
          sources: [],
          actions: [],
          refused: false,
          streaming: false,
        },
      }),
    })
  );
  await ask(page, 'Через JSON');
  await expect(chat(page).locator('.msg.bot').last()).toContainText(
    'Ответ одним куском.'
  );
  await expect(
    chat(page).locator('.msg.bot').last().locator('a')
  ).toHaveAttribute('href', `${A}/x`);
  await expect(chat(page).locator('.msg.bot .fb')).toHaveCount(1);
});

test('истёкший visitor-token — сессия пересоздаётся по указателю без потери диалога', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'До истечения');
  await waitAnswer(page);
  await mock('set', { clock: 25 * 3600e3 }); // токен 24 ч истёк на сервере
  await ask(page, 'После истечения');
  await waitAnswer(page, 2);
  const l = await log();
  expect(l.convs).toHaveLength(1);
  expect(l.sessions.at(-1)!.resumed).toBe(true);
  void WIDGET_STORAGE_PREFIX;
});

/**
 * Конфигуратор TMA (W4 `WidgetPreview.tsx`): макет страницы — пустой iframe
 * (about:blank, origin кабинета), тег загрузчика вставлен DOM API с
 * `data-preview-token`. Опубликованные хосты сайта origin кабинета не
 * содержат — кнопку это прятать не должно; адрес страницы about:blank не
 * должен ронять init (иначе чат навсегда «загружается»).
 */
test('конфигуратор TMA: макет about:blank + тег через DOM — кнопка есть, чат стартует с черновым видом', async ({
  page,
}) => {
  const pk = newPk();
  // Предки предпросмотра (A) допускают обмен; опубликованный хост — только SHOP.
  await site(pk, {
    allowedOrigins: [A],
    hosts: [{ origin: 'https://shop.example.invalid' }],
    previewTokens: { [TOKEN]: DRAFT },
  });
  await page.goto(stand('example.localhost', { pk, noWidget: true }));
  await page.evaluate(
    ({ src, pk, token }) => {
      const f = document.createElement('iframe');
      f.id = 'mock';
      f.style.cssText =
        'position:fixed;top:0;left:0;width:800px;height:700px;z-index:9';
      document.body.appendChild(f);
      const doc = f.contentDocument as Document;
      const s = doc.createElement('script');
      s.async = true;
      s.src = src;
      s.setAttribute('data-site', pk);
      s.setAttribute('data-preview-token', token);
      doc.body.replaceChildren(s);
    },
    { src: `${WIDGET}/v1/loader.js`, pk, token: TOKEN }
  );
  const mockPage = page.frameLocator('#mock');
  const btn = mockPage.locator('[data-v4c] button.l');
  await expect.poll(async () => (await log()).pings.length).toBe(1);
  await expect(btn).toBeVisible();
  await btn.click();
  const c = mockPage.frameLocator('[data-v4c] iframe');
  await expect(c.locator('.cmp textarea')).toBeEnabled();
  await expect(c.locator('.nm span').first()).toHaveText('Черновик');
  expect((await log()).sessions.at(-1)?.parentOrigin).toBe(A);
});

test('ключ неизвестен или вид не опубликован — кнопки нет (пинг c=1: конфиг дошёл); черновик в предпросмотре — есть', async ({
  page,
}) => {
  const unknown = newPk(); // в моке не заведён → WIDGET_UNKNOWN_KEY
  await page.goto(stand('example.localhost', { pk: unknown }));
  await expect.poll(async () => (await log()).pings.length).toBe(1);
  await expect(launcher(page)).toBeHidden();
  expect((await log()).pings[0].c).toBe('1');

  const draft = newPk();
  await site(draft, { unpublished: true, previewTokens: { [TOKEN]: DRAFT } });
  await page.goto(stand('example.localhost', { pk: draft }));
  await expect.poll(async () => (await log()).pings.length).toBe(2);
  await expect(launcher(page)).toBeHidden();

  // Тот же неопубликованный сайт с токеном предпросмотра — кнопка и чат есть.
  await page.goto(
    stand('example.localhost', {
      pk: draft,
      attrs: { 'data-preview-token': TOKEN },
    })
  );
  await openChat(page);
  await expect(chat(page).locator('.nm span').first()).toHaveText('Черновик');
});

test('язык документа чата = язык интерфейса (шаблон iframe — uk): ru и en', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await expect(chat(page).locator('html')).toHaveAttribute('lang', 'ru');
  await page.goto(stand('example.localhost', { pk, lang: 'en' }));
  await openChat(page);
  await expect(chat(page).locator('html')).toHaveAttribute('lang', 'en');
});
