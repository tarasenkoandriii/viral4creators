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
 *    «Пропозиції» — карточки очереди, «Відхилити»;
 *  - заход 11 (остаток №113): тепловые значки «Промахов» на странице
 *    (закрытый Shadow DOM пикера — корни ловит init-скрипт теста), «не
 *    туди → Перепривязати» (новая цель получает фразу, со старой она
 *    снимается — одним пакетом), карточка термина распознавания →
 *    `POST /editor/v1/suggestions/term`.
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
  // Заход 11: + «вела не туди» и «термін розпізнавання».
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toContainText(
    'Відвідувачі (3) казали «таблиця розмірів»'
  );
  await expect(cards.nth(3)).toContainText(
    'синтетичний клік тут не спрацьовує'
  );
  await cards.first().locator('button', { hasText: 'Відхилити' }).click();
  await expect(frame.locator('.card')).toHaveCount(3);
  await expect(frame.locator('p.note')).toContainText(
    'Не пропонуватиму 30 днів'
  );
  // Ни одного клика сайту и одна загрузка чанка подсказок.
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  expect(seen).toEqual(['editor-assist']);
});

/** Значки пикера (закрытый Shadow DOM): корни ловит init-скрипт. */
async function badges(page: Page): Promise<Array<[string, string, string]>> {
  return page.evaluate(() =>
    ((window as unknown as { __roots?: ShadowRoot[] }).__roots ?? []).flatMap(
      (r) =>
        [...r.querySelectorAll('.ht')].map(
          (b) =>
            [
              b.getAttribute('data-key') || '',
              b.textContent || '',
              b.className,
            ] as [string, string, string]
        )
    )
  );
}

test('заход 11 (№113): тепловые значки «Промахов» на странице, «не туди → Перепривязати» (фраза — новой цели, со старой снята), термин распознавания → черновик', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const r = orig.call(this, init);
      const w = window as unknown as { __roots?: ShadowRoot[] };
      (w.__roots ||= []).push(r);
      return r;
    };
  });
  const frame = await open(page);
  // Цель A («В кошик») с синонимом «доставка» — на неё фраза «вела не туди».
  await page.click('#ed-cart');
  await frame.locator('input[name="syn-uk"]').fill('доставка');
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  expect(await badges(page)).toEqual([]);

  // «Промахи»: легенда, значок над целью (🗣 = виконано + натисніть самі).
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  await expect(frame.locator('p.hint').first()).toContainText(
    '🗣 просили · ✋ натисніть самі'
  );
  await expect
    .poll(() => badges(page))
    .toEqual([['add-to-cart', '🗣5 ✋3 ↩1', 'ht bad']]);

  // «Не туди» под целью → «Перепривязати» → клик по правильному элементу.
  const wrong = frame.locator('ul.wrong li', { hasText: '«доставка»' });
  await expect(wrong).toContainText('відвідувачів: 2 (2)');
  await wrong.locator('button', { hasText: 'Перепривязати' }).click();
  await expect(frame.locator('p.note')).toContainText(
    '«доставка» стане його синонімом'
  );
  await page.click('#ed-delivery');
  await expect(frame.locator('input[name="syn-uk"]')).toHaveValue('доставка');
  // Вкладка ушла с «Промахів» — значки сняты.
  await expect.poll(() => badges(page)).toEqual([]);
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(2);
  const ops = (await editorLog()).log
    .filter((l) => l.path === '/editor/v1/ops')
    .pop()!.body as {
    ops: Array<{ op: string; target: Record<string, unknown> }>;
  };
  expect(ops.ops.map((o) => [o.op, o.target.key])).toEqual([
    ['upsert-target', 'dostavka'],
    ['upsert-target', 'add-to-cart'],
  ]);
  expect(ops.ops[0].target.synonyms).toEqual({
    uk: [{ text: 'доставка', origin: 'owner' }],
  });
  expect(ops.ops[1].target.synonyms).toEqual({});

  // Аудит P3-6: «Скасувати» — одним шагом: новая цель ушла, синоним A вернулся.
  const undo = frame.locator('button.undo');
  await undo.click();
  await expect.poll(async () => (await editorLog()).revision).toBe(3);
  const byKey = async (k: string) =>
    (await editorLog()).targets.find((t) => t.key === k);
  expect(await byKey('dostavka')).toBeUndefined();
  expect((await byKey('add-to-cart'))!.synonyms).toEqual({
    uk: [{ text: 'доставка', origin: 'owner' }],
  });

  // «Пропозиції»: «вела не туди» и термин; «Додати термін» — сервер по id.
  await frame.locator('.tabs button', { hasText: 'Пропозиції' }).click();
  await expect(
    frame.locator('.card', { hasText: '«доставка» вела на' })
  ).toBeVisible();
  const term = frame.locator('.card', { hasText: 'Розпізнавання не впевнене' });
  await expect(term).toContainText('«Ксіомі» (відвідувачів: 2)');
  await term.locator('button', { hasText: 'Додати термін' }).click();
  await expect(frame.locator('p.note')).toContainText(
    '«Ксіомі» — у термінах чернетки'
  );
  await expect(term).toHaveCount(0);
  const log = await editorLog();
  expect(
    log.log
      .filter((l) => l.path === '/editor/v1/suggestions/term')
      .map((l) => l.body)
  ).toEqual([{ expectedRevision: 3, id: 'e'.repeat(24) }]);
  expect((log as unknown as { terms: string[] }).terms).toEqual(['Ксіомі']);

  // Существующая цель B: «Перепривязати» → клик по B — синоним на B и
  // снятие с A одним пакетом; «Скасувати» — обе цели как были.
  await page.click('#ed-div');
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(5);
  const b = (await editorLog()).targets.find(
    (t) => t.key !== 'add-to-cart'
  )!.key;
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  await frame
    .locator('ul.wrong li', { hasText: '«доставка»' })
    .locator('button', { hasText: 'Перепривязати' })
    .click();
  await page.click('#ed-div');
  const plus = frame.locator('button.pri', {
    hasText: `+ «доставка» → ${b}`,
  });
  await expect(plus).toContainText('(add-to-cart ↛)');
  await plus.click();
  await expect.poll(async () => (await editorLog()).revision).toBe(6);
  const last = (await editorLog()).log
    .filter((l) => l.path === '/editor/v1/ops')
    .pop()!.body as {
    ops: Array<Record<string, unknown>>;
  };
  expect(last.ops).toEqual([
    { op: 'add-synonym', key: b, lang: 'uk', text: 'доставка' },
    { op: 'upsert-target', target: { key: 'add-to-cart', synonyms: {} } },
  ]);
  expect((await byKey(b))!.synonyms).toEqual({
    uk: [{ text: 'доставка', origin: 'owner' }],
  });
  expect((await byKey('add-to-cart'))!.synonyms).toEqual({});
  await undo.click();
  await expect.poll(async () => (await editorLog()).revision).toBe(7);
  expect((await byKey('add-to-cart'))!.synonyms).toEqual({
    uk: [{ text: 'доставка', origin: 'owner' }],
  });
  expect((await byKey(b))!.synonyms ?? {}).toEqual({});
  // Сайт кликов не видел.
  await expect(page.locator('#ed-clicks')).toHaveText('0');
});

test('заход 11 (аудит P2-3): фраза «не туди» = ИМЯ старой цели — предупреждение о конфликте фраз до «Перепривязати» и «Перейменувати» (карточка старой цели)', async ({
  page,
}) => {
  const frame = await open(page);
  // Цель A — ссылка «Доставка» (имя uk «Доставка»); команда «доставка» вела на неё.
  await page.click('#ed-delivery');
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  const row = frame.locator('ul.wrong li', { hasText: '«доставка»' });
  await expect(row.locator('p.warn')).toContainText(
    '«доставка» — це назва цілі «Доставка»'
  );
  await expect(row.locator('p.warn')).toContainText('конфлікт фраз');
  await row.locator('button', { hasText: 'Перейменувати «Доставка»' }).click();
  await expect(frame.locator('input[name="name-uk"]')).toHaveValue('Доставка');
  await expect(frame.locator('input[name="key"]')).toHaveValue('dostavka');
  // То же предупреждение — в карточке «вела не туди».
  await frame.locator('.tabs button', { hasText: 'Пропозиції' }).click();
  await expect(
    frame.locator('.card', { hasText: 'вела на' }).locator('p.warn')
  ).toContainText('це назва цілі');
  await expect(page.locator('#ed-clicks')).toHaveText('0');
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
