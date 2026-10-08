/**
 * Заход 9 — хвосты Э6-тер в Chromium (пикер на «сайте заказчика», панель —
 * iframe `127.0.0.2` = `we.`, API — editor-mock.ts; правила сервера —
 * acceptance/e6t/editor-tools.spec.ts):
 *  - №21: вкладка «Мемо» без записи — список всех мемо, клик — открыть;
 *  - №22/№23: «Чекати це» — клик по сайту становится ожиданием шага (не шаг
 *    и не нажатие); у шага «В кошик» — «Як скасувати» ↶remove-from-cart;
 *  - №116: Shift+клик и рамка — массовый выбор → «Додати в карту» одним
 *    пакетом; `/` — поиск цели; перетаскивание панели за заголовок
 *    (положение переживает переход); новый шаблон в карточке — сначала
 *    шаблон, затем цель на id сервера;
 *  - №114: микрофон «Сказать сейчас» (фейковый микрофон Chromium) — запись
 *    уходит `audio/*` на `/editor/v1/voice`, текст — в поле и проверку.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { mock, newPk, origin, site, stand, WIDGET } from './fixtures';

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
});

const SHOP = origin('shop.example.localhost');
const PANEL = 'http://127.0.0.2:5181';

async function editorLog(): Promise<{
  log: Array<{ path: string; body: unknown }>;
  revision: number;
  targets: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  voiceBytes: number;
}> {
  const r = await fetch(`${WIDGET}/__mock/editor-log`);
  return r.json();
}

test.beforeEach(async () => {
  await mock('reset');
  await fetch(`${WIDGET}/__mock/editor-reset`, { method: 'POST' });
});

const panelOf = (page: Page) =>
  page.frames().find((f) => f.url().startsWith(`${PANEL}/we/v1/frame`));

async function open(page: Page): Promise<Frame> {
  const pk = newPk();
  await site(pk);
  const token = `ed${'C'.repeat(24)}${Date.now().toString(36)}`;
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: SHOP }),
  });
  await page.goto(
    `${stand('shop.example.localhost', { pk, editorKit: true, lang: 'uk' })}&v4c_edit=${token}`
  );
  await expect.poll(() => !!panelOf(page)).toBe(true);
  const frame = panelOf(page)!;
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  return frame;
}

test('№21/№22/№23: список мемо; «Чекати це» — ожидание, не шаг; «Як скасувати» у шага', async ({
  page,
}) => {
  const frame = await open(page);
  await frame.locator('.tabs button', { hasText: 'Мемо' }).click();
  await expect(frame.locator('.memo .list li')).toContainText(
    'М-3 Кошик · опубліковано · /page'
  );
  await frame.locator('button.pri', { hasText: 'Записати' }).click();
  await page.click('#ed-cart');
  await expect(frame.locator('.steps li')).toHaveCount(1);
  await expect(frame.locator('.steps li').first()).toContainText(
    '↶remove-from-cart'
  );
  // «Чекати це»: клик по сайту — ожидание шага, не новый шаг и не нажатие.
  await frame.locator('button', { hasText: 'Чекати це' }).click();
  await page.click('#ed-div');
  await expect(frame.locator('.steps li').first()).toContainText(
    '→ «Іконка кошика»'
  );
  await expect(frame.locator('.steps li')).toHaveCount(1);
  await expect(page.locator('#ed-clicks')).toHaveText('1');
  const waits = (await editorLog()).log.filter(
    (l) => l.path === '/editor/v1/memo/record/wait'
  );
  expect(waits).toHaveLength(1);
  expect(JSON.stringify(waits)).not.toContain('owner.secret');
  // Сохранение несёт ожидание в шаге.
  await frame.locator('input[name="memo-name"]').fill('Кошик');
  await frame.locator('input[name="memo-name"]').blur();
  await frame.locator('button.pri', { hasText: 'Зберегти чернетку' }).click();
  await expect(frame.locator('p.note').first()).toContainText('М-1');
  const stop = (await editorLog()).log.find(
    (l) => l.path === '/editor/v1/memo/record/stop'
  )!;
  const steps = (stop.body as { steps: Array<{ expect: unknown }> }).steps;
  expect(steps[0].expect).toMatchObject({ appear: 'Іконка кошика' });
});

test('№116: Shift+клик и рамка — массовый выбор, «Додати в карту» одним пакетом; `/` — поиск цели', async ({
  page,
}) => {
  const frame = await open(page);
  await page.keyboard.down('Shift');
  await page.click('#ed-cart');
  await page.click('#ed-pay');
  await page.keyboard.up('Shift');
  await expect(frame.locator('.card')).toContainText('Вибрано: 2');
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  await frame.locator('.card button', { hasText: 'Додати в карту' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  const ops = (await editorLog()).log.filter(
    (l) => l.path === '/editor/v1/ops'
  );
  expect(ops).toHaveLength(1);
  expect(
    (ops[0].body as { ops: Array<{ op: string }> }).ops.map((o) => o.op)
  ).toEqual(['upsert-target', 'upsert-target']);
  // Рамка: Shift + протянуть по секции — все элементы внутри.
  const box = (await page.locator('#ed-kit').boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x - 4, box.y - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 4, box.y + box.height + 4, {
    steps: 5,
  });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(frame.locator('.card')).toContainText(/Вибрано: [3-9]/);
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  await frame.locator('.card button', { hasText: '✕' }).click();
  await expect(frame.locator('.card')).toHaveCount(0);
  // `/` на странице — поиск цели во вкладке «Сторінка».
  await page.keyboard.press('/');
  await expect(frame.locator('input[name="q"]')).toBeFocused();
  await frame.locator('input[name="q"]').pressSequentially('кош');
  await expect(frame.locator('.list li')).toHaveCount(1);
  await expect(frame.locator('.list li')).toContainText('В кошик');
});

test('№116: панель перетаскивается за заголовок и остаётся там после перехода', async ({
  page,
}) => {
  await open(page);
  const iframe = page.locator('iframe[title]').first();
  const before = (await page.evaluate(() => {
    const h = document.querySelector('[data-v4c="editor"]');
    return h ? 1 : 0;
  })) as number;
  expect(before).toBe(1);
  const fb = (await panelOf(page)!
    .frameElement()
    .then((e) => e.boundingBox()))!;
  // Заголовок — над iframe (полоса 44 px).
  await page.mouse.move(fb.x + 20, fb.y - 20);
  await page.mouse.down();
  await page.mouse.move(60, fb.y + 200, { steps: 6 });
  await page.mouse.up();
  const after = (await panelOf(page)!
    .frameElement()
    .then((e) => e.boundingBox()))!;
  expect(after.x).toBeLessThan(fb.x - 100);
  expect(after.y).toBeGreaterThan(fb.y + 100);
  expect(iframe).toBeTruthy();
  // Переход по ссылке (N — навигация): положение то же.
  await page.keyboard.press('n');
  await Promise.all([page.waitForURL(/s=/), page.click('#ed-delivery')]);
  await expect.poll(() => !!panelOf(page)).toBe(true);
  await expect(panelOf(page)!.locator('.tabs')).toBeVisible();
  const moved = (await panelOf(page)!
    .frameElement()
    .then((e) => e.boundingBox()))!;
  expect(Math.abs(moved.x - after.x)).toBeLessThan(3);
});

test('карточка: новый шаблон — сначала шаблон (id сервера), затем цель на него', async ({
  page,
}) => {
  const frame = await open(page);
  await page.click('#ed-cart');
  await expect(frame.locator('.pick')).toContainText('В кошик');
  await frame.locator('select[name="scope"]').selectOption('template');
  await frame.locator('input[name="mask"]').fill('/page*');
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).targets.length).toBe(1);
  const log = await editorLog();
  const ops = log.log
    .filter((l) => l.path === '/editor/v1/ops')
    .map((l) => (l.body as { ops: Array<Record<string, unknown>> }).ops);
  expect(ops.map((o) => o.map((x) => x.op))).toEqual([
    ['upsert-template'],
    ['upsert-target'],
  ]);
  expect(log.targets[0]).toMatchObject({
    scope: 'template',
    templateId: log.templates[0].id,
  });
});

test('№114: микрофон «Сказать сейчас» — запись `audio/*` на сервер, текст в поле и проверка без нажатий', async ({
  page,
}) => {
  const frame = await open(page);
  await frame.locator('.tabs button', { hasText: 'Перевірка' }).click();
  await frame.locator('button', { hasText: '🎤' }).click();
  await expect(frame.locator('button', { hasText: '■' })).toBeVisible();
  await page.waitForTimeout(1200);
  await frame.locator('button', { hasText: '■' }).click();
  await expect(frame.locator('input[name="say"]')).toHaveValue(
    'натисни в кошик'
  );
  await expect(frame.locator('ol li').first()).toContainText('В кошик');
  const log = await editorLog();
  const v = log.log.find((l) => l.path === '/editor/v1/voice')!;
  expect((v.body as { type: string }).type).toMatch(/^audio\//);
  expect(log.voiceBytes).toBeGreaterThan(200);
  expect(log.log.filter((l) => l.path === '/editor/v1/try')).toHaveLength(1);
  await expect(page.locator('#ed-clicks')).toHaveText('0');
});
