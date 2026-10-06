/**
 * Э6-тер в Chromium — визуальный редактор голосовой карты на «сайте
 * заказчика» (пикер `editor.js` в origin страницы, панель — iframe на
 * отдельном origin `127.0.0.2` = `we.`; API панели — editor-mock.ts),
 * приёмка ТЗ §5-кватер.14:
 *  - п.1/п.2: ссылка `?v4c_edit=` снята с адреса, публичный чат на вкладке
 *    редактора не поднимается; ссылка одноразовая; у посетителя — ни
 *    запроса к editor.js, ни узлов редактора;
 *  - п.2: выбор элемента — сайт не реагирует (0 своих кликов), выход —
 *    DOM страницы как был, обработчики сняты (клик снова доходит до сайта);
 *  - п.4: «злой скрипт» шлёт поддельные pick/ops/publish/exit — 0 операций
 *    черновика без клика человека в панели, пикер не снимается;
 *  - п.5: строгий CSP + Trusted Types с `frame-src we.` — 0 нарушений; без
 *    `frame-src` — нарушение `frame-src`, панели нет (сообщение в пикере);
 *  - п.6: в запросах панели нет значения поля (e-mail в поле страницы);
 *  - п.11: «Сказать сейчас» — подсветка без нажатий (0 событий сайта);
 *  - Э6-тер (д): запись мемо кликами — шаг «в кошик» исполняется по
 *    слову сервера (1 событие сайта), поле — слот без значения, «Оплатити» —
 *    стоп без нажатия; «Зберегти чернетку», «Прогнати» — подсветка; переход
 *    по ссылке при записи — запись продолжается на новой странице.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  chat,
  mock,
  newPk,
  openChat,
  origin,
  site,
  stand,
  WIDGET,
} from './fixtures';

const SHOP = origin('shop.example.localhost');
const PANEL = 'http://127.0.0.2:5181';

async function editorLog(): Promise<{
  log: Array<{ path: string; body: unknown }>;
  revision: number;
  targets: Array<Record<string, unknown>>;
  publishAttempts: number;
}> {
  const r = await fetch(`${WIDGET}/__mock/editor-log`);
  return r.json();
}

async function link(token: string, o = SHOP): Promise<void> {
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: o }),
  });
}

test.beforeEach(async ({ page }) => {
  await mock('reset');
  await fetch(`${WIDGET}/__mock/editor-reset`, { method: 'POST' });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
    );
  });
});

const tok = () => `ed${'B'.repeat(24)}${Date.now().toString(36)}`;

async function open(
  page: Page,
  spec: Record<string, unknown> = {},
  token = tok()
): Promise<{ frame: Frame; token: string; requests: string[] }> {
  const pk = newPk();
  await site(pk);
  await link(token);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const url = `${stand('shop.example.localhost', { pk, editorKit: true, lang: 'uk', ...spec })}&v4c_edit=${token}`;
  await page.goto(url);
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().startsWith(`${PANEL}/we/v1/frame`))
    )
    .toBe(true);
  const frame = page
    .frames()
    .find((f) => f.url().startsWith(`${PANEL}/we/v1/frame`))!;
  return { frame, token, requests };
}

test('ссылка снята, чат не поднят, выбор без события сайта, сохранение кликом, выход — DOM как был', async ({
  page,
}) => {
  const { frame, requests } = await open(page);
  expect(page.url()).not.toContain('v4c_edit');
  // Токен — во фрагменте адреса iframe и снят панелью; в адресе панели его нет.
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  expect(frame.url()).not.toContain('#t=');
  expect(requests.some((u) => u.includes('/w/v1/frame'))).toBe(false);
  expect(requests.some((u) => u.includes('/v1/editor.js'))).toBe(true);
  const before = await page.evaluate(() => document.body.innerHTML);

  // Выбор: сайт на клик не реагирует.
  await page.click('#ed-cart');
  await expect(frame.locator('.pick')).toContainText('В кошик');
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  // Значение поля страницы не уходит никуда (только структура): поле можно
  // выбрать и даже сохранить целью — в дескрипторе нет его значения.
  await page.click('#ed-email');
  await expect(frame.locator('.pick')).toContainText('textbox');
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  await page.click('#ed-cart');
  await expect(frame.locator('.pick')).toContainText('В кошик');
  // Сохранение — только кликом человека в панели.
  expect(
    (await editorLog()).log.filter((l) => l.path === '/editor/v1/ops')
  ).toHaveLength(1);
  await frame.locator('input[name="syn-uk"]').fill('кошик, до кошика');
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(2);
  const log = await editorLog();
  const ops = log.log.filter((l) => l.path === '/editor/v1/ops')[1].body as {
    ops: Array<{
      op: string;
      target: {
        descriptor: Record<string, unknown>;
        names: Record<string, string>;
      };
    }>;
  };
  const up = ops.ops.find((o) => o.op === 'upsert-target')!;
  expect(up.target.descriptor.assistId).toBe('add-to-cart');
  expect(up.target.names.uk).toBe('В кошик');
  expect(JSON.stringify(log.log)).not.toContain('owner.secret');

  // Выход: корень редактора снят, DOM страницы как был, клики — снова сайту.
  await frame.locator('button.exit').click();
  await expect
    .poll(() =>
      page.evaluate(() => !!document.querySelector('[data-v4c="editor"]'))
    )
    .toBe(false);
  expect(await page.evaluate(() => document.body.innerHTML)).toBe(before);
  await page.click('#ed-cart');
  await expect(page.locator('#ed-clicks')).toHaveText('1');
  expect(
    (await editorLog()).log.some((l) => l.path === '/editor/v1/exit')
  ).toBe(true);
});

test('аудит Э6-тер (3): путь ссылки с ПД уходит в панель маской (e-mail, номер)', async ({
  page,
}) => {
  const { frame } = await open(page, { editorPdLink: true });
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  // Без id и разметки: «единственный?» — по пути ссылки (маской).
  await page.click('a.ed-profile');
  await expect(frame.locator('.pick')).toContainText('Мій кабінет');
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  const log = await editorLog();
  const ops = log.log.filter((l) => l.path === '/editor/v1/ops')[0].body as {
    ops: Array<{ op: string; target: { descriptor: Record<string, unknown> } }>;
  };
  const up = ops.ops.find((o) => o.op === 'upsert-target')!;
  expect(up.target.descriptor.hrefPath).toBe('/u/:email/orders/:n');
  expect(JSON.stringify(log.log)).not.toContain('ivan.petrenko');
  expect(JSON.stringify(log.log)).not.toContain('123456789012');
  // Цель находится на странице по своей (маскированной) ссылке: единственная.
  expect(up.target.descriptor.unique).toBe(true);
});

test('ссылка одноразовая; посетитель без ссылки — ни чанка, ни узлов редактора', async ({
  page,
  context,
}) => {
  const { token } = await open(page);
  const second = await context.newPage();
  const pk = newPk();
  await site(pk);
  await second.goto(
    `${stand('shop.example.localhost', { pk, editorKit: true })}&v4c_edit=${token}`
  );
  await expect
    .poll(() =>
      second.frames().some((f) => f.url().startsWith(`${PANEL}/we/v1/frame`))
    )
    .toBe(true);
  const f = second
    .frames()
    .find((x) => x.url().startsWith(`${PANEL}/we/v1/frame`))!;
  await expect(f.locator('.fatal')).toBeVisible();
  // Аудит: недействительная ссылка не перехватывает клики страницы.
  await second.click('#ed-cart');
  await expect(second.locator('#ed-clicks')).toHaveText('1');

  const visitor = await context.newPage();
  const urls: string[] = [];
  visitor.on('request', (r) => urls.push(r.url()));
  await visitor.goto(stand('shop.example.localhost', { pk, editorKit: true }));
  await visitor.waitForLoadState('load');
  await visitor.waitForTimeout(500);
  expect(urls.some((u) => u.includes('/v1/editor'))).toBe(false);
  expect(
    await visitor.evaluate(
      () => !!document.querySelector('[data-v4c="editor"]')
    )
  ).toBe(false);
});

test('злой скрипт: поддельные pick/ops/publish/exit — 0 изменений черновика без клика в панели', async ({
  page,
}) => {
  const { frame } = await open(page, { editorEvil: true });
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const log = await editorLog();
  expect(
    log.log.filter(
      (l) => l.path !== '/editor/v1/session' && l.path !== '/editor/v1/map'
    )
  ).toHaveLength(0);
  expect(log.publishAttempts).toBe(0);
  // Пикер не снят поддельным `exit`, карточка не открылась поддельным `pick`.
  expect(
    await page.evaluate(() => !!document.querySelector('[data-v4c="editor"]'))
  ).toBe(true);
  await expect(frame.locator('.pick')).toHaveCount(0);
});

test('строгий CSP + Trusted Types с frame-src we.: редактор работает, 0 нарушений', async ({
  page,
}) => {
  const csp =
    "default-src 'self'; script-src 'self' {W}; style-src 'self'; img-src 'self' data:; connect-src 'self' {W}; frame-src {W} " +
    PANEL +
    "; require-trusted-types-for 'script'; trusted-types 'none'";
  const { frame } = await open(page, { csp });
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await page.click('#ed-cart');
  await expect(frame.locator('.pick')).toContainText('В кошик');
  expect(
    await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
  ).toEqual([]);
});

test('CSP без frame-src we.: нарушение frame-src, панели нет', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  const token = tok();
  await link(token);
  const csp =
    "default-src 'self'; script-src 'self' {W}; style-src 'self'; connect-src 'self' {W}; frame-src {W}";
  await page.goto(
    `${stand('shop.example.localhost', { pk, editorKit: true, csp })}&v4c_edit=${token}`
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __csp: string[] }).__csp.join(' ')
      )
    )
    .toContain('frame-src');
  expect(page.frames().some((f) => f.url().startsWith(PANEL))).toBe(false);
});

test('«Сказать сейчас»: подсветка шагов без нажатий — 0 событий сайта', async ({
  page,
}) => {
  const { frame } = await open(page);
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await frame.locator('.tabs button', { hasText: 'Перевірка' }).click();
  await frame.locator('input[name="say"]').fill('натисни в кошик');
  await frame.locator('button.pri', { hasText: 'Перевірити' }).click();
  await expect(frame.locator('ol li').first()).toContainText('В кошик');
  await page.waitForTimeout(300);
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  const tries = (await editorLog()).log.filter(
    (l) => l.path === '/editor/v1/try'
  );
  expect(tries).toHaveLength(1);
  // Снимок — структура без значений полей.
  expect(JSON.stringify(tries[0].body)).not.toContain('owner.secret');
});

test('«Навигация» (N): переход по ссылке сайта — редактор продолжается по сессии панели', async ({
  page,
}) => {
  const { frame } = await open(page);
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('n');
  await Promise.all([page.waitForURL(/s=/), page.click('#ed-delivery')]);
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().startsWith(`${PANEL}/we/v1/frame`))
    )
    .toBe(true);
  const f = page
    .frames()
    .find((x) => x.url().startsWith(`${PANEL}/we/v1/frame`))!;
  await expect(f.locator('.tabs')).toBeVisible();
  await expect(f.locator('.fatal')).toHaveCount(0);
  // Новая страница: панель читает карту без нового обмена ссылки.
  const log = await editorLog();
  expect(log.log.filter((l) => l.path === '/editor/v1/session')).toHaveLength(
    1
  );
  expect(
    log.log.filter((l) => l.path === '/editor/v1/map').length
  ).toBeGreaterThanOrEqual(2);
});

test('«Я вмію» под микрофоном (Р-72): имена мемо, пока лента пуста; без мемо — ничего', async ({
  page,
}) => {
  const voice = {
    input: true,
    output: false,
    maxRecordMs: 30_000,
    minSpeechMs: 400,
    endSilenceMs: 1_000,
  };
  const pk = newPk();
  await site(pk, {
    voice,
    voiceControl: {
      mode: 'on',
      memos: true,
      skills: ['Покласти в кошик', 'Запис на консультацію'],
    },
  });
  await page.goto(stand('example.localhost', { pk, lang: 'uk' }));
  await openChat(page);
  await expect(chat(page).locator('.skl')).toContainText(
    '«Покласти в кошик», «Запис на консультацію»'
  );
  const pk2 = newPk();
  await site(pk2, { voice, voiceControl: { mode: 'on' } });
  await page.goto(stand('example.localhost', { pk: pk2, lang: 'uk' }));
  await openChat(page);
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  await expect(chat(page).locator('.skl')).toHaveCount(0);
});

test('Э6-тер (д): запись мемо кликами — шаги, слот без значения, стоп на «Оплатити», черновик и «Прогнати»', async ({
  page,
}) => {
  const { frame } = await open(page);
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await frame.locator('.tabs button', { hasText: 'Мемо' }).click();
  await frame.locator('button.pri', { hasText: 'Записати' }).click();
  await expect(frame.locator('.memo .warn')).toContainText('Запис');
  // «В кошик» — сервер разрешил «сразу»: нажатие исполнено по-настоящему.
  await page.click('#ed-cart');
  await expect(frame.locator('.steps li')).toHaveCount(1);
  await expect(page.locator('#ed-clicks')).toHaveText('1');
  // Поле — шаг fill со слотом; значение поля страницы не уходит.
  await page.click('#ed-email');
  await expect(frame.locator('.steps li').nth(1)).toContainText('{email}');
  // «Оплатити» — стоп записи, подсветка последним шагом, 0 нажатий.
  await page.click('#ed-pay');
  await expect(frame.locator('p.note').first()).toContainText('payment');
  await expect(frame.locator('.steps li')).toHaveCount(3);
  // Запись стоит: клик — снова карточка цели, не шаг.
  await page.click('#ed-cart');
  await expect(frame.locator('.pick')).toContainText('В кошик');
  await frame.locator('.tabs button', { hasText: 'Мемо' }).click();
  await expect(frame.locator('.steps li')).toHaveCount(3);
  await expect(page.locator('#ed-clicks')).toHaveText('1');
  // Удалить подсветку, назвать, сохранить, прогнать.
  await frame
    .locator('.steps li')
    .nth(2)
    .locator('button', { hasText: '✕' })
    .click();
  await frame.locator('input[name="memo-name"]').fill('Покласти в кошик');
  await frame.locator('input[name="memo-goal"]').fill('Товар у кошику');
  await frame.locator('input[name="memo-goal"]').blur();
  await frame.locator('button.pri', { hasText: 'Зберегти чернетку' }).click();
  await expect(frame.locator('p.note').first()).toContainText('М-1');
  await frame.locator('button', { hasText: 'Прогнати' }).click();
  await expect(frame.locator('.memo .note')).toContainText('Усі кроки');
  const log = (await editorLog()).log.filter((l) =>
    l.path.startsWith('/editor/v1/memo/')
  );
  const stop = log.find((l) => l.path === '/editor/v1/memo/record/stop')!;
  expect((stop.body as { steps: unknown[] }).steps).toHaveLength(2);
  expect((stop.body as { name: string }).name).toBe('Покласти в кошик');
  expect(JSON.stringify(log)).not.toContain('owner.secret');
  const steps = log.filter((l) => l.path === '/editor/v1/memo/record/step');
  expect((steps[1].body as { fieldName: string }).fieldName).toBe('email');
});

test('Э6-тер (д): переход по ссылке во время записи — исполняется, запись продолжается на новой странице', async ({
  page,
}) => {
  const { frame } = await open(page);
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await frame.locator('.tabs button', { hasText: 'Мемо' }).click();
  await frame.locator('button.pri', { hasText: 'Записати' }).click();
  const before = page.url();
  await page.click('#ed-delivery');
  await page.waitForURL((u) => u.href !== before);
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().startsWith(`${PANEL}/we/v1/frame`))
    )
    .toBe(true);
  const f = page
    .frames()
    .find((x) => x.url().startsWith(`${PANEL}/we/v1/frame`))!;
  await expect(f.locator('.steps li')).toHaveCount(1, { timeout: 15_000 });
  await expect(f.locator('.memo .warn')).toContainText('Запис');
  await page.click('#ed-cart');
  await expect(f.locator('.steps li')).toHaveCount(2);
});

test('Э6-тер (д): злой скрипт во время записи — поддельные pick без метки клика, 0 нажатий на странице', async ({
  page,
}) => {
  const { frame } = await open(page, { editorEvil: true });
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await frame.locator('.tabs button', { hasText: 'Мемо' }).click();
  await frame.locator('button.pri', { hasText: 'Записати' }).click();
  await page.waitForTimeout(1500);
  await expect(page.locator('#ed-clicks')).toHaveText('0');
  // Черновик мемо — только кликом человека в панели.
  expect(
    (await editorLog()).log.filter(
      (l) => l.path === '/editor/v1/memo/record/stop'
    )
  ).toHaveLength(0);
});
