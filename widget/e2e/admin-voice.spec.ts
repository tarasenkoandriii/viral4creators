/**
 * Э6-бис (б) «Голосовое управление „Админкой“» в браузере (Chromium + мок
 * `stand/admin-vc-mock.ts` с НАСТОЯЩИМИ проверками плана sites-backend):
 * строгий CSP и Trusted Types страницы админки; строки таблиц с ПД — не в
 * снимке (кроме названного номера); карточка «Да» с перечнем полей;
 * «Видалити» кликом не нажимается никогда (и при «дефекте сервера» —
 * вторая линия на странице); стоп; мастер на рабочем хосте — отправка
 * заглушена, попытка по запрещённой цели зарегистрирована, отчёт «fail».
 * Права, тариф, журнал, монитор — acceptance/e6b-admin (сервер).
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { WIDGET, mock, newPk, stand } from './fixtures';
import { testJwt } from './stand/admin-mock';

const ADMIN = 'http://127.0.0.1:5181';
const HOST = 'admin.example.localhost';
const STRICT = `default-src 'self'; script-src 'self' ${ADMIN}; frame-src ${ADMIN}; connect-src 'self'; style-src 'self'; img-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'`;

function adminPage(pk: string, sub: string): string {
  return stand(HOST, {
    pk,
    loaderOrigin: ADMIN,
    adminKit: true,
    csp: STRICT,
    lang: 'uk',
    attrs: {
      'data-mode': 'admin',
      'data-identity': testJwt(sub),
      'data-lang': 'uk',
    },
  });
}

async function vcSet(body: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${WIDGET}/__mock/admin-vc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

interface VcLog {
  plans: Array<{
    status: string;
    steps: Array<{
      kind: string;
      text: string | null;
      risk: string;
      state: string;
    }>;
  }>;
  snapshots: Array<{ elements: Array<{ text: string }> }>;
  tests: Array<{ attempts: number; submits: number; report: unknown }>;
}

async function vcLog(): Promise<VcLog> {
  const r = await fetch(`${WIDGET}/__mock/admin-log`, { method: 'POST' });
  return ((await r.json()) as { vc: VcLog }).vc;
}

async function frameOf(page: Page, open = true): Promise<Frame> {
  if (open) {
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { V4CAssist?: unknown }).V4CAssist ===
        'function'
    );
    await page.evaluate(() =>
      (window as unknown as { V4CAssist: (c: string) => void }).V4CAssist(
        'open'
      )
    );
  }
  await expect
    .poll(
      () => page.frames().find((f) => f.url().includes('/wa/v1/frame')) ?? null
    )
    .not.toBeNull();
  const f = page.frames().find((x) => x.url().includes('/wa/v1/frame'))!;
  await expect(f.locator('.wa-n')).toBeHidden();
  return f;
}

async function say(f: Frame, text: string) {
  await f.locator('.wa-i').fill(text);
  await f.locator('.wa-s').click();
}

/** Согласие на сессию (первая команда) и карточка «Так», если спросили. */
async function allow(f: Frame) {
  const yes = f.locator('.wa-vc-p .wa-yes').first();
  await expect(yes).toBeVisible();
  await yes.click();
}

const cspLog = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
    );
  });

test.beforeEach(async () => {
  await mock('reset');
  await mock('admin-reset');
});

test('строгий CSP + TT: команда набором заполняет поле; строки таблиц с ПД не в снимке, названный номер — в снимке', async ({
  page,
}) => {
  await cspLog(page);
  await vcSet({
    mode: 'on',
    model: {
      'введи Терміново в Нотатка': [
        { kind: 'fill', text: 'Нотатка', value: 'Терміново' },
      ],
      'введи 1042 в Коментар': [
        { kind: 'fill', text: 'Коментар', value: '1042' },
      ],
    },
  });
  const pk = newPk();
  await page.goto(adminPage(pk, 'emp-vc'));
  const f = await frameOf(page);
  await say(f, 'введи Терміново в Нотатка');
  await allow(f); // согласие на сессию
  const card = f.locator('.wa-vc-p .wa-card .wa-yes');
  if (await card.isVisible().catch(() => false)) await card.click();
  await expect(page.locator('#ak-note')).toHaveValue('Терміново');

  let log = await vcLog();
  const first = log.snapshots[0].elements.map((e) => e.text).join('|');
  expect(first).toContain('Нотатка');
  expect(first).not.toContain('Іван Петренко');
  expect(first).not.toContain('Олена Коваль');
  expect(first).not.toContain('Деталі 1042');

  // Номер, названный сотрудником, — его строка в снимке; чужая — нет.
  await say(f, 'введи 1042 в Коментар');
  const again = f.locator('.wa-vc-p .wa-card .wa-yes');
  if (await again.isVisible().catch(() => false)) await again.click();
  await expect(page.locator('#ak-comment')).toHaveValue('1042');
  log = await vcLog();
  const second = log.snapshots
    .at(-1)!
    .elements.map((e) => e.text)
    .join('|');
  expect(second).toContain('Іван Петренко');
  expect(second).not.toContain('Олена Коваль');

  // Ни одного нарушения CSP/Trusted Types на странице админки.
  expect(
    await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
  ).toEqual([]);
  // Хранилище страницы админки: только флаг плана, без данных.
  const store = await page.evaluate(() =>
    JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } })
  );
  expect(store).not.toContain('Терміново');
  expect(store).not.toContain('emp-vc');
});

test('карточка «Так» с перечнем полей: поле и «Зберегти» — после «Так», одно сохранение', async ({
  page,
}) => {
  await vcSet({
    mode: 'on',
    model: {
      'заповни Нотатка Терміново і збережи': [
        { kind: 'fill', text: 'Нотатка', value: 'Терміново' },
        { kind: 'click', text: 'Зберегти' },
      ],
    },
  });
  await page.goto(adminPage(newPk(), 'emp-card'));
  const f = await frameOf(page);
  await say(f, 'заповни Нотатка Терміново і збережи');
  await allow(f); // согласие
  const card = f.locator('.wa-vc-p .wa-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Нотатка: Терміново');
  await expect(card).toContainText('Зберегти');
  // До «Так» — ничего не нажато.
  await expect(page.locator('#ak-note')).toHaveValue('');
  await expect(page.locator('#ak-saves')).toHaveText('0');
  await card.locator('.wa-yes').click();
  await expect(page.locator('#ak-saves')).toHaveText('1');
  await expect(page.locator('#ak-note')).toHaveValue('Терміново');
});

test('«Видалити» кликом — никогда: стоп-лист кода, предпочтение API (карточка Э8), вторая линия на странице', async ({
  page,
}) => {
  await vcSet({
    mode: 'on',
    model: {
      'натисни третю кнопку': [
        { kind: 'click', text: 'Видалити вибрані', risk: 'auto' },
      ],
    },
  });
  await page.goto(adminPage(newPk(), 'emp-del'));
  const f = await frameOf(page);
  // (1) «Модель» предложила нажать «Видалити» — код делает шаг «никогда».
  await say(f, 'натисни третю кнопку');
  await allow(f);
  await expect(f.locator('.wa-ai').last()).toContainText('Видалити вибрані');
  await expect(page.locator('#ak-deletes')).toHaveText('0');
  let log = await vcLog();
  expect(log.plans[0].steps[0].risk).toBe('never');

  // (2) «Видали замовлення 1042» — изменение с операцией API: карточка Э8
  // «Да» в чате, на странице ничего не нажимается.
  await say(f, 'видали замовлення 1042');
  await expect(f.locator('.wa-card.wa-danger')).toBeVisible();
  await expect(page.locator('#ak-deletes')).toHaveText('0');

  // (3) «Дефект сервера» пропустил клик — исполнитель на странице отказал.
  await vcSet({ leak: true });
  await say(f, 'натисни третю кнопку');
  await expect
    .poll(async () => (await vcLog()).plans.at(-1)?.status)
    .toBe('failed');
  await expect(page.locator('#ak-deletes')).toHaveText('0');
  log = await vcLog();
  expect(log.plans.at(-1)!.steps[0].state).toBe('failed');
});

test('аудит: голый «Скасувати», иконка «Видалити» внутри кнопки, ссылка /delete — никогда (код и вторая линия); список клиентов `li` — не в снимке', async ({
  page,
}) => {
  await vcSet({
    mode: 'on',
    model: {
      'натисни перший пункт': [
        { kind: 'click', text: 'Скасувати', risk: 'auto' },
      ],
      'натисни другий пункт': [{ kind: 'click', text: '⋯', risk: 'auto' }],
      'натисни третій пункт': [
        { kind: 'click', text: 'Деталі замовлення', risk: 'auto' },
      ],
    },
  });
  await page.goto(adminPage(newPk(), 'emp-audit'));
  const f = await frameOf(page);
  // (1) Код сервера: все три — «никогда».
  for (const cmd of [
    'натисни перший пункт',
    'натисни другий пункт',
    'натисни третій пункт',
  ]) {
    const n = (await vcLog()).plans.length;
    await say(f, cmd);
    if (n === 0) await allow(f);
    await expect.poll(async () => (await vcLog()).plans.length).toBe(n + 1);
    const log = await vcLog();
    expect(log.plans.at(-1)!.steps[0]?.risk ?? 'none').toMatch(/never|none/);
  }
  await expect(page.locator('#ak-deletes')).toHaveText('0');
  const snap = (await vcLog()).snapshots[0].elements.map((e) => e.text);
  expect(snap.join('|')).not.toContain('Петро Сидоренко');
  // (2) «Дефект сервера» пропустил клики — исполнитель на странице отказал.
  await vcSet({ leak: true });
  for (const cmd of [
    'натисни перший пункт',
    'натисни другий пункт',
    'натисни третій пункт',
  ]) {
    const n = (await vcLog()).plans.length;
    await say(f, cmd);
    await expect.poll(async () => (await vcLog()).plans.length).toBe(n + 1);
    await expect
      .poll(async () => (await vcLog()).plans.at(-1)?.status)
      .toBe('failed');
  }
  await expect(page.locator('#ak-deletes')).toHaveText('0');
  expect(page.url()).not.toContain('/delete');
});

test('стоп: Esc посреди плана — остальные поля не трогаются, «Зберегти» не нажат', async ({
  page,
}) => {
  await vcSet({
    mode: 'on',
    model: {
      'заповни Нотатка А, Коментар Б, Місто В і збережи': [
        { kind: 'fill', text: 'Нотатка', value: 'А' },
        { kind: 'fill', text: 'Коментар', value: 'Б' },
        { kind: 'fill', text: 'Місто', value: 'В' },
        { kind: 'click', text: 'Зберегти' },
      ],
    },
  });
  await page.goto(adminPage(newPk(), 'emp-stop'));
  const f = await frameOf(page);
  await say(f, 'заповни Нотатка А, Коментар Б, Місто В і збережи');
  await allow(f);
  await f.locator('.wa-vc-p .wa-card .wa-yes').click();
  await expect(page.locator('#ak-note')).toHaveValue('А');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await expect(page.locator('#ak-city')).toHaveValue('');
  await expect(page.locator('#ak-saves')).toHaveText('0');
  await expect
    .poll(async () => (await vcLog()).plans.at(-1)?.status)
    .toBe('stopped');
});

test('мастер на РАБОЧЕМ хосте: «Зберегти» только подсвечен, отправка заглушена, попытка по «Видалити» — в регистраторе, отчёт fail', async ({
  page,
}) => {
  const token = `tok_${Date.now().toString(36)}_abcdefghijkl`;
  await vcSet({
    mode: null,
    model: {
      'заповни Нотатка Терміново і збережи': [
        { kind: 'fill', text: 'Нотатка', value: 'Терміново' },
        { kind: 'click', text: 'Зберегти' },
      ],
      'натисни третю кнопку': [
        { kind: 'click', text: 'Видалити вибрані', risk: 'auto' },
      ],
      'натисни Зберегти': [{ kind: 'click', text: 'Зберегти', risk: 'auto' }],
      'вибери Високий в Пріоритет': [
        { kind: 'select', text: 'Пріоритет', value: 'Високий' },
      ],
    },
  });
  await vcSet({ testToken: token, testHost: false });
  await page.goto(`${adminPage(newPk(), 'emp-owner')}&v4c_voicetest=${token}`);
  // Ссылка мастера снята с адреса сразу; окно поднялось само.
  await expect.poll(() => page.url()).not.toContain('v4c_voicetest');
  const f = await frameOf(page, false);
  await expect(f.locator('.wa-vt')).toContainText('Робочий хост');

  // Код: на рабочем хосте «Зберегти» — «натисніть самі».
  await say(f, 'заповни Нотатка Терміново і збережи');
  await allow(f);
  const card = f.locator('.wa-vc-p .wa-card .wa-yes');
  if (await card.isVisible().catch(() => false)) await card.click();
  await expect(page.locator('#ak-note')).toHaveValue('Терміново');
  await page.waitForTimeout(1200);
  await expect(page.locator('#ak-saves')).toHaveText('0');
  let log = await vcLog();
  const save = log.plans.at(-1)!.steps.find((s) => s.text === 'Зберегти');
  expect(save?.risk).toBe('manual');

  // «Дефект сервера»: клик по «Видалити» и «Зберегти» дошли до страницы.
  await vcSet({ leak: true });
  await say(f, 'натисни третю кнопку');
  await expect.poll(async () => (await vcLog()).tests[0].attempts).toBe(1);
  await expect(page.locator('#ak-deletes')).toHaveText('0');
  await say(f, 'натисни Зберегти');
  await expect.poll(async () => (await vcLog()).tests[0].submits).toBe(1);
  await expect(page.locator('#ak-saves')).toHaveText('0');

  // Аудит: автосохранение `form.submit()` в `onchange` поля — тоже заглушено.
  await vcSet({ leak: false });
  await say(f, 'вибери Високий в Пріоритет');
  const prio = f.locator('.wa-vc-p .wa-card .wa-yes');
  if (await prio.isVisible().catch(() => false)) await prio.click();
  await expect(page.locator('#ak-prio')).toHaveValue('Високий');
  await expect.poll(async () => (await vcLog()).tests[0].submits).toBe(2);
  expect(page.url()).not.toContain('/admin/autosave');

  await f.locator('.wa-vt .wa-yes', { hasText: 'Сформувати звіт' }).click();
  await expect(f.locator('.wa-vt')).toContainText('Не пройдено');
  log = await vcLog();
  expect(log.tests[0].report).toMatchObject({
    result: 'fail',
    attempts: 1,
    submitsBlocked: 2,
  });
});
