/**
 * Заход 10 — панель редактора в Chromium (пикер на «сайте заказчика»,
 * панель — iframe `127.0.0.2` = `we.`, API — editor-mock.ts; правила сервера
 * — sites-backend editor/editor-assist.spec.ts):
 *  - разгрузка бюджета: словарь ru — ленивый `/v1/editor-panel-ru.js` по языку
 *    страницы (uk — без лишних запросов), строгий CSP + Trusted Types iframe;
 *  - №113: «✨ Синоніми від ШІ» (ленивый `/v1/editor-assist.js`) →
 *    «Запропонувати» → ✓ принять (origin owner) / ✕ відхилити (+ «не
 *    пропонувати»); «Промахи» — Т-4 цели и «просили, не знайшли» →
 *    «Прив’язати до елемента» (клик по сайту — синоним, сайт клика не видит);
 *    «Пропозиції» — карточки очереди, «Відхилити».
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { mock, newPk, origin, site, stand, WIDGET } from './fixtures';

const SHOP = origin('shop.example.localhost');
const PANEL = 'http://127.0.0.2:5181';

interface Log {
  log: Array<{ path: string; body: unknown }>;
  revision: number;
  targets: Array<{
    key: string;
    synonyms?: Record<string, Array<{ text: string; origin: string }>>;
  }>;
}
async function editorLog(): Promise<Log> {
  const r = await fetch(`${WIDGET}/__mock/editor-log`);
  return r.json();
}

test.beforeEach(async () => {
  await mock('reset');
  await fetch(`${WIDGET}/__mock/editor-reset`, { method: 'POST' });
});

const panelOf = (page: Page) =>
  page.frames().find((f) => f.url().startsWith(`${PANEL}/we/v1/frame`));

async function open(page: Page, lang = 'uk'): Promise<Frame> {
  const pk = newPk();
  await site(pk);
  const token = `ed${'D'.repeat(24)}${Date.now().toString(36)}`;
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: SHOP }),
  });
  await page.goto(
    `${stand('shop.example.localhost', { pk, editorKit: true, lang })}&v4c_edit=${token}`
  );
  await expect.poll(() => !!panelOf(page)).toBe(true);
  const frame = panelOf(page)!;
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  return frame;
}

function chunks(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const m = /\/v1\/(editor-panel-\w+|editor-assist)\.js/.exec(r.url());
    if (m) seen.push(m[1]);
  });
  page.on('console', (m) => {
    if (/Content Security Policy|Trusted Type/i.test(m.text()))
      seen.push(`csp:${m.text()}`);
  });
  return seen;
}

test('заход 10: словарь ru — ленивый чанк по языку страницы, uk — без лишних запросов; CSP iframe не нарушен', async ({
  page,
}) => {
  const seen = chunks(page);
  const ru = await open(page, 'ru');
  await expect(ru.locator('.tabs')).toContainText('Цель');
  await expect(ru.locator('.tabs')).toContainText('Предложения');
  await expect(ru.locator('.hint')).toContainText('Наведите');
  expect(seen).toEqual(['editor-panel-ru']);
  seen.length = 0;
  const uk = await open(page, 'uk');
  await expect(uk.locator('.tabs')).toContainText('Ціль');
  await expect(uk.locator('.tabs')).toContainText('Пропозиції');
  expect(seen).toEqual([]);
});

test('№113: ИИ-синонимы в карточке (✓ принять, ✕ відхилити), «Промахи» → прив’язати фразу, «Пропозиції» → відхилити; сайт кликов не видит', async ({
  page,
}) => {
  const seen = chunks(page);
  const frame = await open(page);
  // Цель карты из клика по сайту (режим «Вибір» — сайт клика не видит).
  await page.click('#ed-cart');
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  expect(seen).toEqual([]);
  // «✨ Синоніми від ШІ» — ленивый чанк, затем «Запропонувати».
  await frame.locator('button', { hasText: '✨ Синоніми від ШІ' }).click();
  await expect(frame.locator('fieldset.ai')).toBeVisible();
  expect(seen).toEqual(['editor-assist']);
  await frame.locator('button', { hasText: '✨ Запропонувати' }).click();
  await expect(frame.locator('p.note')).toContainText('Запропоновано: 2');
  const rows = frame.locator('fieldset.ai .row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('«подарунок» · uk');
  // Предложения ИИ в поле синонимов (то, что уйдёт в публикацию) — нет.
  await expect(frame.locator('input[name="syn-uk"]')).toHaveValue('');
  await rows.first().locator('button', { hasText: '✓' }).click();
  await expect
    .poll(async () => (await editorLog()).targets[0].synonyms?.uk)
    .toEqual([
      { text: 'подарунок', origin: 'owner' },
      { text: 'упаковка', origin: 'suggested' },
    ]);
  await expect(frame.locator('input[name="syn-uk"]')).toHaveValue('подарунок');
  await frame
    .locator('fieldset.ai .row', { hasText: 'упаковка' })
    .locator('button', { hasText: '✕' })
    .click();
  await expect
    .poll(async () => (await editorLog()).targets[0].synonyms?.uk)
    .toEqual([{ text: 'подарунок', origin: 'owner' }]);
  await expect
    .poll(async () =>
      (await editorLog()).log
        .filter((l) => l.path === '/editor/v1/suggestions/mute')
        .map((l) => l.body)
    )
    .toEqual([{ key: 'add-to-cart', lang: 'uk', text: 'упаковка' }]);

  // «Промахи»: Т-4 цели и «просили, не знайшли» → прив’язати к элементу.
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  await expect(frame.locator('.list li').first()).toContainText(
    'натисніть самі ×3'
  );
  await expect(frame.locator('.list li').first()).toContainText('не туди ×1');
  const asked = frame.locator('.list li', { hasText: 'таблиця розмірів' });
  await expect(asked).toContainText('відвідувачів: 3 (4)');
  await asked.locator('button', { hasText: 'Прив’язати до елемента' }).click();
  await page.click('#ed-pay');
  // Аудит Ж (P3-5): фраза посетителя — синоним на ЕГО языке (ru), не панели.
  await expect(frame.locator('input[name="syn-ru"]')).toHaveValue(
    'таблиця розмірів'
  );
  await expect(frame.locator('input[name="syn-uk"]')).toHaveValue('');

  // «Пропозиції»: карточки очереди; «Відхилити» — не пропонувати 30 днів.
  await frame.locator('.tabs button', { hasText: 'Пропозиції' }).click();
  const cards = frame.locator('.card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText(
    'Відвідувачі (3) казали «таблиця розмірів»'
  );
  await expect(cards.nth(1)).toContainText(
    'синтетичний клік тут не спрацьовує'
  );
  await cards.first().locator('button', { hasText: 'Відхилити' }).click();
  await expect(frame.locator('.card')).toHaveCount(1);
  await expect(frame.locator('p.note')).toContainText(
    'Не пропонуватиму 30 днів'
  );
  // Ни одного клика сайту и одна загрузка чанка подсказок.
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  expect(seen).toEqual(['editor-assist']);
});

/** Перерисовок панели за `ms` (MutationObserver на корне панели). */
async function renders(frame: Frame, ms: number): Promise<number> {
  return frame.evaluate(
    (wait) =>
      new Promise<number>((resolve) => {
        let n = 0;
        const mo = new MutationObserver((list) => {
          for (const m of list) if (m.type === 'childList') n++;
        });
        mo.observe(document.getElementById('app')!, { childList: true });
        setTimeout(() => {
          mo.disconnect();
          resolve(n);
        }, wait);
      }),
    ms
  );
}

test('аудит Ж (P2-1): «Промахи» отвечают 500 — панель не засыпает сервер (≤ 2 запросов за 2 с), «Повторити» — ещё один', async ({
  page,
}) => {
  let hits = 0;
  await page.route('**/editor/v1/misses**', (r) => {
    hits++;
    return r.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"success":false,"error":{"code":"X","message":"boom"}}',
    });
  });
  const frame = await open(page);
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  await expect(frame.locator('button', { hasText: 'Повторити' })).toBeVisible();
  await page.waitForTimeout(2000);
  expect(hits).toBeLessThanOrEqual(2);
  expect(await renders(frame, 1000)).toBeLessThan(5);
  const before = hits;
  await frame.locator('button', { hasText: 'Повторити' }).click();
  await expect.poll(() => hits).toBe(before + 1);
  await page.waitForTimeout(1000);
  expect(hits).toBe(before + 1);
});

test('аудит Ж (P2-2): editor-assist.js не загрузился — «Не завантажилось · Повторити», без бесконечной перерисовки; повтор с другим адресом', async ({
  page,
}) => {
  const urls: string[] = [];
  await page.route('**/v1/editor-assist.js**', (r) => {
    urls.push(r.request().url());
    return r.abort();
  });
  const frame = await open(page);
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  await expect(frame.locator('p.warn')).toContainText('Не завантажилось');
  expect(await renders(frame, 1000)).toBeLessThan(5);
  expect(urls).toHaveLength(1);
  await page.unroute('**/v1/editor-assist.js**');
  await frame.locator('p.warn button', { hasText: 'Повторити' }).click();
  await expect(frame.locator('.cnt').first()).toContainText('За 7 днів');
  await expect(frame.locator('p.warn')).toHaveCount(0);
});
