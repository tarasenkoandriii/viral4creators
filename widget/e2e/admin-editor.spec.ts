/**
 * Заход 11 (№117) в Chromium — редактор голосовой карты «Админки»: вход по
 * ссылке владельца `?v4c_edit=` на странице админки (тег загрузчика с origin
 * «Админки» `127.0.0.1` = `wa.`, `data-mode="admin"`): чанк `admin.js` снимает
 * ссылку и лениво берёт пикер `editor.js`; панель — iframe того же origin
 * (`/wa/v1/editor-frame`, метка контура `admin`), её API —
 * `/assist-admin/v1/editor/*` (editor-mock.ts через admin-mock.ts) с ДВУМЯ
 * сессиями: сотрудника `wa.` (JWT от `admin.js` через пикер) и редактора.
 *  - кнопка/чат сотрудника на вкладке редактора не поднимаются;
 *  - выбор элемента — админка не реагирует; сохранение цели — кликом в
 *    панели, черновик меняется ровно одним пакетом операций;
 *  - мемо, «Промахи»/«Пропозиції», ИИ-синонимы и микрофон скрыты;
 *  - «Сказать сейчас» — без нажатий; запрос публикации — без публикации;
 *  - переход по админке (MPA) — панель продолжает по своим сессиям из
 *    `sessionStorage` `wa.` без нового входа сотрудника; выход — DOM как был;
 *  - без входа сотрудника (нет JWT) — понятная ошибка, клики — админке.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { WIDGET, mock, newPk, origin, stand } from './fixtures';
import { testJwt } from './stand/admin-mock';

const ADMIN = 'http://127.0.0.1:5181';
const HOST = 'admin.example.localhost';
const FRAME = `${ADMIN}/wa/v1/editor-frame`;

interface EdLog {
  log: Array<{ path: string; body: unknown }>;
  revision: number;
  targets: Array<Record<string, unknown>>;
  publishAttempts: number;
}

async function editorLog(): Promise<EdLog> {
  return (await fetch(`${WIDGET}/__mock/editor-log`)).json();
}

async function adminLog(): Promise<{
  log: Array<{ path: string; sub: string | null }>;
}> {
  return (await fetch(`${WIDGET}/__mock/admin-log`)).json();
}

const tok = () => `adm${'C'.repeat(22)}${Date.now().toString(36)}`;

function adminPage(pk: string, n = 1, identity = true): string {
  return stand(HOST, {
    pk,
    n,
    lang: 'uk',
    adminKit: true,
    loaderOrigin: ADMIN,
    attrs: {
      'data-mode': 'admin',
      'data-lang': 'uk',
      ...(identity ? { 'data-identity': testJwt('owner-1') } : {}),
    },
  });
}

async function panel(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(FRAME)))
    .toBe(true);
  return page.frames().find((f) => f.url().startsWith(FRAME))!;
}

async function openEditor(
  page: Page,
  o: { iat?: number } = {}
): Promise<{ pk: string; frame: Frame }> {
  const pk = newPk();
  const token = tok();
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: origin(HOST) }),
  });
  const url = stand(HOST, {
    pk,
    lang: 'uk',
    adminKit: true,
    loaderOrigin: ADMIN,
    attrs: {
      'data-mode': 'admin',
      'data-lang': 'uk',
      'data-identity': testJwt('owner-1', o.iat),
    },
  });
  await page.goto(`${url}&v4c_edit=${token}`);
  const frame = await panel(page);
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  return { pk, frame };
}

const count = async (path: string) =>
  (await editorLog()).log.filter((l) => l.path === path).length;
const adminSessions = async () =>
  (await adminLog()).log.filter((x) => x.path === '/assist-admin/v1/session')
    .length;

test.beforeEach(async () => {
  await mock('reset');
  await mock('admin-reset');
  await fetch(`${WIDGET}/__mock/editor-reset`, { method: 'POST' });
});

test('«Админка»: вход по ссылке в admin.js, сохранение цели, «Сказать сейчас», запрос публикации, переход и выход', async ({
  page,
}) => {
  const pk = newPk();
  const token = tok();
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: origin(HOST) }),
  });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${adminPage(pk)}&v4c_edit=${token}`);
  const frame = await panel(page);

  // Ссылка снята с адреса; токен — во фрагменте iframe и снят панелью.
  expect(page.url()).not.toContain('v4c_edit');
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  expect(frame.url()).not.toContain('#t=');
  expect(new URL(frame.url()).origin).toBe(ADMIN);
  expect(requests.some((u) => u === `${ADMIN}/v1/editor.js`)).toBe(true);
  // Кнопка и чат сотрудника на вкладке редактора не поднимаются.
  expect(requests.some((u) => u.includes('/wa/v1/frame'))).toBe(false);
  await expect(page.locator('[data-v4c=""]')).toHaveCount(0);
  // Режим `admin`: только Ціль / Сторінка / Перевірка / Публікація.
  await expect(frame.locator('.tabs button')).toHaveText([
    'Ціль',
    'Сторінка',
    'Перевірка',
    'Публікація',
  ]);
  // Вход сотрудника — один обмен JWT самой панелью; редактор — с обеими сессиями.
  const sessions = () =>
    adminLog().then(
      (l) => l.log.filter((x) => x.path === '/assist-admin/v1/session').length
    );
  expect(await sessions()).toBe(1);
  const ed = await editorLog();
  expect(ed.log.map((l) => l.path)).toEqual(
    expect.arrayContaining([
      '/assist-admin/v1/editor/session',
      '/assist-admin/v1/editor/map',
    ])
  );
  expect(ed.log.some((l) => l.path.startsWith('/editor/v1/'))).toBe(false);

  // Выбор «Зберегти» формы админки — админка не реагирует (0 сохранений).
  await page.click('#ak-save');
  await expect(frame.locator('.pick')).toContainText('Зберегти');
  await expect(page.locator('#ak-saves')).toHaveText('0');
  // ИИ-синонимов у «Админки» нет (следующий шаг).
  await expect(frame.locator('button', { hasText: 'ШІ' })).toHaveCount(0);
  expect(
    (await editorLog()).log.filter(
      (l) => l.path === '/assist-admin/v1/editor/ops'
    )
  ).toHaveLength(0);
  await frame.locator('input[name="syn-uk"]').fill('зберегти нотатку');
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  const opsCalls = (await editorLog()).log.filter(
    (l) => l.path === '/assist-admin/v1/editor/ops'
  );
  expect(opsCalls).toHaveLength(1);
  const up = (
    opsCalls[0].body as {
      ops: Array<{
        op: string;
        target: {
          names: Record<string, string>;
          synonyms: Record<string, Array<{ text: string }>>;
          descriptor: Record<string, unknown>;
          pagePath: string | null;
        };
      }>;
    }
  ).ops.find((o) => o.op === 'upsert-target')!;
  expect(up.target.names.uk).toBe('Зберегти');
  expect(up.target.synonyms.uk.map((s) => s.text)).toEqual([
    'зберегти нотатку',
  ]);
  expect(up.target.descriptor.text).toBe('Зберегти');
  expect(up.target.pagePath).toBe('/page');
  await expect(page.locator('#ak-saves')).toHaveText('0');

  // «Сказать сейчас»: показ без нажатий; микрофона у «Админки» нет.
  await frame.locator('.tabs button', { hasText: 'Перевірка' }).click();
  await expect(frame.locator('button', { hasText: '🎤' })).toHaveCount(0);
  await frame.locator('input[name="say"]').fill('Відкрий деталі 1042');
  await frame.locator('button.pri', { hasText: 'Перевірити' }).click();
  await expect(frame.locator('ol li').first()).toContainText('Деталі 1042');
  const tries = (await editorLog()).log.filter(
    (l) => l.path === '/assist-admin/v1/editor/try'
  );
  expect(tries).toHaveLength(1);
  // Р-Э6б-6: строки таблиц и карточки клиентов (ПД) в снимок не попадают,
  // кроме строки, которую сотрудник назвал номером (1042).
  const snap = JSON.stringify(
    (tries[0].body as { snapshot: unknown }).snapshot
  );
  expect(snap).toContain('Деталі 1042');
  expect(snap).toContain('Зберегти');
  for (const pd of ['Олена Коваль', 'Деталі 1043', 'Петро Сидоренко'])
    expect(snap).not.toContain(pd);
  await expect(page.locator('#ak-saves')).toHaveText('0');

  // Публикация из панели — только запрос (публикует владелец в Telegram).
  await frame.locator('.tabs button', { hasText: 'Публікація' }).click();
  await frame.locator('button.pri', { hasText: 'публікацію' }).click();
  await expect(frame.locator('.note')).toContainText('Telegram');
  const afterReq = await editorLog();
  expect(
    afterReq.log.some(
      (l) => l.path === '/assist-admin/v1/editor/publish-request'
    )
  ).toBe(true);
  expect(afterReq.publishAttempts).toBe(0);

  // Переход по админке (MPA, та же вкладка): редактор продолжается без
  // ссылки и без нового входа сотрудника (сессии — в sessionStorage `wa.`).
  const maps = (l: EdLog) =>
    l.log.filter((x) => x.path === '/assist-admin/v1/editor/map').length;
  const mapsBefore = maps(await editorLog());
  await page.goto(adminPage(pk, 2));
  const frame2 = await panel(page);
  await expect(frame2.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await expect(frame2.locator('.fatal')).toHaveCount(0);
  await expect.poll(async () => maps(await editorLog())).toBe(mapsBefore + 1);
  expect(await sessions()).toBe(1);
  await expect(page.locator('[data-v4c=""]')).toHaveCount(0);

  // Выход: сессия гаснет на сервере, пикер снят, клики снова доходят до админки.
  await frame2.locator('button.exit').click();
  await expect(page.locator('[data-v4c="editor"]')).toHaveCount(0);
  expect(
    (await editorLog()).log.some(
      (l) => l.path === '/assist-admin/v1/editor/exit'
    )
  ).toBe(true);
  await page.click('#ak-save');
  await expect(page.locator('#ak-saves')).toHaveText('1');
  expect(
    await page.evaluate(
      (k) => [sessionStorage.getItem(k), sessionStorage.getItem('v4c_edit')],
      `v4c_edit:admin:${pk}`
    )
  ).toEqual([null, null]);
});

test('«Админка»: без входа сотрудника — ошибка в панели, клики уходят админке, сессии редактора нет', async ({
  page,
}) => {
  const pk = newPk();
  const token = tok();
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: origin(HOST) }),
  });
  await page.goto(`${adminPage(pk, 1, false)}&v4c_edit=${token}`);
  const frame = await panel(page);
  await expect(frame.locator('.fatal')).toContainText(
    'Немає входу співробітника'
  );
  // Пикер в режиме «Навігація»: админка работает как обычно.
  await page.click('#ak-save');
  await expect(page.locator('#ak-saves')).toHaveText('1');
  const l = await editorLog();
  expect(l.log.some((x) => x.path.endsWith('/editor/session'))).toBe(false);
  expect(l.revision).toBe(0);
});

test('«Админка» (раунд исправлений, P1-1): сессия сотрудника истекла (`exp` JWT) — панель берёт свежий JWT, `rebind` и повторяет сохранение', async ({
  page,
}) => {
  const { frame } = await openEditor(page);
  expect(await adminSessions()).toBe(1);
  await page.click('#ak-save');
  await expect(frame.locator('.pick')).toContainText('Зберегти');
  // JWT сотрудника истёк (≤ 15 мин у заказчика) — сессия `wa.` погасла.
  await fetch(`${WIDGET}/__mock/admin-expire`, { method: 'POST' });
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  expect(await adminSessions()).toBe(2);
  expect(await count('/assist-admin/v1/editor/rebind')).toBe(1);
  // Первый ops — 401, повтор после перепривязки — 200.
  expect(await count('/assist-admin/v1/editor/ops')).toBe(2);
  await expect(frame.locator('.fatal')).toHaveCount(0);
});

test('«Админка» (раунд исправлений, P1-1): за 90 с до `exp` сессии сотрудника панель обновляет её сама (rebind без ошибки)', async ({
  page,
}) => {
  // JWT истекает через 95 с — обновление через ~5 с.
  await openEditor(page, { iat: Math.floor(Date.now() / 1000) - 600 + 95 });
  await expect
    .poll(() => count('/assist-admin/v1/editor/rebind'), { timeout: 15_000 })
    .toBe(1);
  expect(await adminSessions()).toBe(2);
  // Тот же (не более свежий) JWT — не крутимся: второго обновления нет.
  await page.waitForTimeout(6_000);
  expect(await count('/assist-admin/v1/editor/rebind')).toBe(1);
});

test('«Админка» (раунд исправлений, P2-2/P2-3): «Сказать сейчас» — без зон владельца; элемент строки таблицы — без имени и номера, с предупреждением', async ({
  page,
}) => {
  await fetch(`${WIDGET}/__mock/editor-zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deny: ['#ak-form'], allow: [] }),
  });
  const { frame } = await openEditor(page);
  // Имя клиента в строке таблицы заказов.
  await page.click('#ak-table a[href="#c2"]');
  await expect(frame.locator('.row-pd')).toBeVisible();
  await expect(frame.locator('.pick')).not.toContainText('Олена');
  await frame.locator('input[name="key"]').fill('client-link');
  await frame.locator('button.pri', { hasText: 'чернетк' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  const ops = JSON.stringify(
    (await editorLog()).log.filter(
      (l) => l.path === '/assist-admin/v1/editor/ops'
    )
  );
  expect(ops).not.toContain('Олена');
  expect(ops).not.toContain('1043');
  // Элемент вне таблицы — подпись остаётся, предупреждения нет.
  await page.click('#ak-cancel');
  await expect(frame.locator('.pick')).toContainText('Скасувати');
  await expect(frame.locator('.row-pd')).toHaveCount(0);
  // «Сказать сейчас»: форма в запретной зоне владельца в снимок не попадает.
  await frame.locator('.tabs button', { hasText: 'Перевірка' }).click();
  await frame.locator('input[name="say"]').fill('Скасувати');
  await frame.locator('button.pri', { hasText: 'Перевірити' }).click();
  await expect(frame.locator('ol li').first()).toContainText('Скасувати');
  const tries = (await editorLog()).log.filter(
    (l) => l.path === '/assist-admin/v1/editor/try'
  );
  const snap = JSON.stringify(
    (tries[0].body as { snapshot: unknown }).snapshot
  );
  expect(snap).toContain('Скасувати');
  for (const zone of ['Зберегти', 'Нотатка', 'Коментар'])
    expect(snap).not.toContain(zone);
});

test('«Админка» (раунд исправлений, P3-5): выход сотрудника из админки (`logout`) завершает редактор', async ({
  page,
}) => {
  const { pk } = await openEditor(page);
  await page.evaluate(() =>
    (window as unknown as { V4CAssist: (c: string) => void }).V4CAssist(
      'logout'
    )
  );
  await expect(page.locator('[data-v4c="editor"]')).toHaveCount(0);
  await expect.poll(() => count('/assist-admin/v1/editor/exit')).toBe(1);
  expect(
    await page.evaluate(
      (k) => sessionStorage.getItem(k),
      `v4c_edit:admin:${pk}`
    )
  ).toBeNull();
  // Флаг «Сайта» не тронут и не нужен (раздельные флаги, P3-4).
  await page.click('#ak-save');
  await expect(page.locator('#ak-saves')).toHaveText('1');
});
