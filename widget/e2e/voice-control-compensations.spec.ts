/**
 * Э6-тер (и) «Компенсации» в Chromium (ТЗ §5-бис.15 п.6, п.8, п.13 п.2–4, 7
 * — браузерная часть) на стенде магазина в духе WooCommerce (`/vc/shop/*`:
 * «В кошик»/«Видалити» AJAX, кошик на сервере стенда):
 *  - п.2: сбой на 3-м шаге → «Повернути» → товар прибран из мини-кошика
 *    (стандартная разметка `remove-from-cart` в строке ТОГО ЖЕ товара), поле
 *    вернулось; сервер получил `dispatched` до клика, затем итоги;
 *  - п.3: обратная цель на другой странице (`nav-cart` → кошик) — переход и
 *    прибрана нужная строка (чужая осталась); две строки с одинаковым
 *    описанием — «приберіть самі», 0 кликов;
 *  - п.4: «Видалити» без разметки — компенсации нет (стоп-лист), 0 кликов;
 *  - разметка плагина WooCommerce (`data-assist-undo="remove-from-cart"` и
 *    `data-assist-undo-at` у «В кошик», «Кошик» шапки без `nav-cart`) —
 *    компенсация с переходом в кошик без голосовой карты (снимок act.js
 *    несёт пару, сервер — `src: markup`).
 * План проверяет настоящий код (`assist-ui-core`, `compensations: true`),
 * исполняют настоящие act.js/undo.js/comp.js; «модель» — фикстура стенда.
 */
import { expect, test, type Page } from '@playwright/test';
import { chat, log, mock, newPk, openChat, origin, site } from './fixtures';
import type { ModelStep } from './stand/ui-plan-mock';

const A = origin('example.localhost');
const VOICE = {
  input: true,
  output: false,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1_000,
};
const CMD = 'Додай у кошик розмір M';
const MODEL: Record<string, ModelStep[]> = {
  'додай у кошик розмір m': [
    { kind: 'select', find: { assistId: 'size' }, value: 'M' },
    { kind: 'click', find: { assistId: 'add-to-cart' } },
    { kind: 'wait', expect: { appear: 'Такого тексту на стенді немає' } },
  ],
};

test.beforeEach(async () => {
  await mock('reset');
});

const composer = (page: Page) => chat(page).locator('.cmp textarea');

async function openIfClosed(page: Page) {
  await page.waitForTimeout(300);
  if (
    await composer(page)
      .isVisible()
      .catch(() => false)
  )
    return;
  await openChat(page);
}

async function command(
  page: Page,
  pk: string,
  query: string,
  before?: (p: Page) => Promise<unknown>
) {
  await site(pk, {
    voice: VOICE,
    voiceControl: { mode: 'on' },
    vcModel: MODEL,
  });
  await page.goto(
    `${A}/vc/shop/product?pk=${encodeURIComponent(pk)}&m=1${query}`
  );
  if (before) await before(page);
  await openIfClosed(page);
  await composer(page).fill(CMD);
  await composer(page).press('Enter');
  const allow = chat(page).locator('.vconsent button', {
    hasText: 'Дозволити',
  });
  await allow.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await expect(chat(page).locator('.poffer')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#s-size')).toHaveValue('M');
}

async function shop(pk: string): Promise<Array<{ t: string; v: string }>> {
  const r = await fetch(
    `http://localhost:5182/vc/state?pk=${encodeURIComponent(pk)}`
  );
  return ((await r.json()) as { shop: Array<{ t: string; v: string }> }).shop;
}

const removes = (page: Page) =>
  page
    .evaluate(
      () => (window as unknown as { __stand: { removes?: number } }).__stand
    )
    .then((s) => s.removes ?? 0);

const reports = async () =>
  (await log()).vc.undos.map((u) => [u.kind, JSON.parse(u.raw)]);

test('п.2: мини-кошик на этой странице — «Повернути»: товар прибран (своя строка), поле вернулось; dispatched до клика', async ({
  page,
}) => {
  const pk = newPk();
  await command(page, pk, '&mini=1&seed=Шапка зимова:L');
  expect((await shop(pk)).map((x) => x.t)).toEqual([
    'Шапка зимова',
    'Футболка синя',
  ]);
  await chat(page).locator('.poffer button.pyes').click();
  const fr = chat(page);
  await expect(fr.locator('body')).toContainText('Прибрав «Футболка синя»', {
    timeout: 15_000,
  });
  await expect(fr.locator('body')).toContainText(
    'Повернув попереднє значення поля «Розмір»'
  );
  await expect(page.locator('#s-size')).toHaveValue('');
  expect(await shop(pk)).toEqual([{ t: 'Шапка зимова', v: 'L' }]);
  expect(await removes(page)).toBe(1);
  expect(await reports()).toEqual([
    ['undo', { by: 'offer' }],
    ['report', { dispatch: 1 }],
    ['report', { results: [{ i: 1, result: 'done' }] }],
    ['report', { results: [{ i: 0, result: 'done' }] }],
  ]);
});

test('п.3: обратная цель на странице кошика — переход, прибрана нужная строка (чужая осталась), поля прежней страницы — «не можу»', async ({
  page,
}) => {
  const pk = newPk();
  await command(page, pk, '&seed=Шапка зимова:L');
  await chat(page).locator('.poffer button.pyes').click();
  await expect(page).toHaveURL(/\/vc\/shop\/cart$/, { timeout: 15_000 });
  const fr = chat(page);
  await expect(fr.locator('body')).toContainText('Прибрав «Футболка синя»', {
    timeout: 20_000,
  });
  await expect(fr.locator('body')).toContainText(
    'Поля на попередній сторінці повернути не можу'
  );
  expect(await shop(pk)).toEqual([{ t: 'Шапка зимова', v: 'L' }]);
  await expect(page.locator('#s-table tr')).toHaveCount(1);
  expect(await reports()).toEqual([
    ['undo', { by: 'offer' }],
    ['report', { next: true }],
    ['report', { dispatch: 1 }],
    ['report', { results: [{ i: 1, result: 'done' }] }],
    ['report', { results: [{ i: 0, result: 'gone' }] }],
  ]);
});

test('п.3: две строки с одинаковым описанием — «приберіть самі», 0 кликов; п.4: «Видалити» без разметки — 0 кликов', async ({
  page,
}) => {
  const pk = newPk();
  await command(page, pk, '&mini=1&seed=Футболка синя:M');
  await chat(page).locator('.poffer button.pyes').click();
  await expect(chat(page).locator('body')).toContainText(
    'Не зміг прибрати «Футболка синя» — приберіть самі',
    { timeout: 15_000 }
  );
  expect(await removes(page)).toBe(0);
  expect((await shop(pk)).length).toBe(2);
  // Сбой компенсации — стоп: поле не возвращается.
  await expect(page.locator('#s-size')).toHaveValue('M');

  await mock('reset');
  const pk2 = newPk();
  const p2 = await page.context().newPage();
  await command(p2, pk2, '&mini=1&rx=0');
  await chat(p2).locator('.poffer button.pyes').click();
  await expect(chat(p2).locator('body')).toContainText(
    'Не зміг прибрати «Футболка синя»',
    { timeout: 15_000 }
  );
  expect(await removes(p2)).toBe(0);
  expect((await shop(pk2)).length).toBe(1);
  expect((await reports()).slice(-1)).toEqual([
    ['report', { results: [{ i: 1, result: 'gone' }] }],
  ]);
});

test('разметка плагина WooCommerce (`data-assist-undo`/`-at`): компенсация без голосовой карты — переход в кошик, прибрана своя строка', async ({
  page,
}) => {
  const pk = newPk();
  await command(page, pk, '&wc=1&seed=Шапка зимова:L');
  // Страница отмены — только из разметки кнопки: ссылки `nav-cart` нет.
  await expect(page.locator('[data-assist-id="nav-cart"]')).toHaveCount(0);
  await expect(page.locator('#s-add')).toHaveAttribute(
    'data-assist-undo',
    'remove-from-cart'
  );
  await chat(page).locator('.poffer button.pyes').click();
  await expect(page).toHaveURL(/\/vc\/shop\/cart$/, { timeout: 15_000 });
  await expect(chat(page).locator('body')).toContainText(
    'Прибрав «Футболка синя»',
    { timeout: 20_000 }
  );
  await expect(chat(page).locator('body')).toContainText(
    'Поля на попередній сторінці повернути не можу'
  );
  expect(await shop(pk)).toEqual([{ t: 'Шапка зимова', v: 'L' }]);
  await expect(page.locator('#s-table tr')).toHaveCount(1);
  expect(await reports()).toEqual([
    ['undo', { by: 'offer' }],
    ['report', { next: true }],
    ['report', { dispatch: 1 }],
    ['report', { results: [{ i: 1, result: 'done' }] }],
    ['report', { results: [{ i: 0, result: 'gone' }] }],
  ]);
});

test('битая страница отмены в разметке (`//evil…`) — пары разметки нет: перехода нет, на этой странице обратной цели нет — «не зміг», 0 кліків', async ({
  page,
}) => {
  const pk = newPk();
  await command(page, pk, '&wc=1&seed=Шапка зимова:L', (p) =>
    p.evaluate(() =>
      document
        .getElementById('s-add')!
        .setAttribute('data-assist-undo-at', '//evil.example/cart')
    )
  );
  await chat(page).locator('.poffer button.pyes').click();
  await expect(chat(page).locator('body')).toContainText(
    'Не зміг прибрати «Футболка синя»',
    { timeout: 15_000 }
  );
  expect(page.url()).toMatch(/\/vc\/shop\/product/);
  expect(await removes(page)).toBe(0);
  expect((await shop(pk)).length).toBe(2);
});
