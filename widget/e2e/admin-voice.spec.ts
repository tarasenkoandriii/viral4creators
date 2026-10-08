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
  // Карточка «Так» бывает не всегда и может появиться позже: разовый
  // `isVisible()` без ожидания на холодном старте её пропускал, и поле
  // оставалось пустым. Ждём, пока поле не заполнится, нажимая «Так»,
  // если карточка показалась.
  await expect
    .poll(
      async () => {
        if ((await page.locator('#ak-comment').inputValue()) === '1042')
          return true;
        if (await again.isVisible().catch(() => false))
          await again.click().catch(() => null);
        return false;
      },
      // Под нагрузкой полного прогона (первый тест набора, холодные
      // стенды) путь «сказал → план → карточка → поле» занимал > 15 с.
      { timeout: 30_000 }
    )
    .toBe(true);
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

test('Р-З9-22: мастер на РАБОЧЕМ хосте — автосохранение fetch/XHR/sendBeacon в `change` поля заглушено (GET проходит); вне окна шага запись страницы не трогается', async ({
  page,
}) => {
  const token = `tok_${Date.now().toString(36)}_net_abcdefgh`;
  await vcSet({
    mode: null,
    model: {
      'введи Терміново в Нотатка': [
        { kind: 'fill', text: 'Нотатка', value: 'Терміново' },
      ],
      'введи Інше в Нотатка': [
        { kind: 'fill', text: 'Нотатка', value: 'Інше' },
      ],
    },
  });
  await vcSet({ testToken: token, testHost: false });
  const sent: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/admin/net-'))
      sent.push(`${r.method()} ${u.pathname}`);
  });
  await page.goto(`${adminPage(newPk(), 'emp-net')}&v4c_voicetest=${token}`);
  await expect.poll(() => page.url()).not.toContain('v4c_voicetest');
  const f = await frameOf(page, false);
  await expect(f.locator('.wa-vt')).toContainText('Робочий хост');
  // «Старая админка»: автосохранение поля по `change` — fetch, XHR, beacon.
  await page.evaluate(() => {
    const w = window as unknown as { __net: string[] };
    w.__net = [];
    document.getElementById('ak-note')!.addEventListener('change', () => {
      const note = (x: string) => w.__net.push(x);
      fetch('/admin/net-fetch', { method: 'POST', body: 'a' }).then(
        () => note('fetch:ok'),
        () => note('fetch:blocked')
      );
      fetch(
        new Request('/admin/net-request', { method: 'PUT', body: 'a' })
      ).then(
        () => note('request:ok'),
        () => note('request:blocked')
      );
      note(`beacon:${navigator.sendBeacon('/admin/net-beacon', 'a')}`);
      fetch('/admin/net-get').then(
        () => note('get:ok'),
        () => note('get:blocked')
      );
      try {
        const x = new XMLHttpRequest();
        x.open('POST', '/admin/net-xhr');
        x.send('a');
        note('xhr:sent');
      } catch {
        note('xhr:blocked');
      }
    });
  });
  await say(f, 'введи Терміново в Нотатка');
  await allow(f);
  const card = f.locator('.wa-vc-p .wa-card .wa-yes');
  if (await card.isVisible().catch(() => false)) await card.click();
  await expect(page.locator('#ak-note')).toHaveValue('Терміново');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __net: string[] }).__net.length
      )
    )
    .toBe(5);
  const net = await page.evaluate(
    () => (window as unknown as { __net: string[] }).__net
  );
  expect(net.sort()).toEqual([
    'beacon:false',
    'fetch:blocked',
    'get:ok',
    'request:blocked',
    'xhr:blocked',
  ]);
  // Запись по сети не ушла ни одна; чтение (GET) — ушло.
  expect(sent).toEqual(['GET /admin/net-get']);
  await expect.poll(async () => (await vcLog()).tests[0].submits).toBe(4);
  // Через 1 с после шага окно закрыто: запись самой страницы — как обычно.
  await page.waitForTimeout(1300);
  await page.evaluate(() =>
    fetch('/admin/net-after', { method: 'POST', body: 'b' }).catch(() => null)
  );
  await expect.poll(() => sent).toContain('POST /admin/net-after');
  expect((await vcLog()).tests[0].submits).toBe(4);

  // Аудит пакета F (P2-1): после отчёта мастера страница не глушит запись —
  // обычный план сотрудника на той же странице сохраняет как обычно.
  await f.locator('.wa-vt .wa-yes', { hasText: 'Сформувати звіт' }).click();
  await expect.poll(async () => (await vcLog()).tests[0].report).not.toBeNull();
  await vcSet({ mode: 'on' });
  sent.length = 0;
  await say(f, 'введи Інше в Нотатка');
  const again = f.locator('.wa-vc-p .wa-card .wa-yes');
  await expect
    .poll(
      async () => {
        if ((await page.locator('#ak-note').inputValue()) === 'Інше')
          return true;
        if (await again.isVisible().catch(() => false))
          await again.click().catch(() => null);
        return false;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  await expect
    .poll(() => [...sent].sort())
    .toEqual([
      'GET /admin/net-get',
      'POST /admin/net-beacon',
      'POST /admin/net-fetch',
      'POST /admin/net-xhr',
      'PUT /admin/net-request',
    ]);
});

test('аудит Э6-бис (б) (1): сухой прогон мастера — «вірно / не те» на КАЖДОМ шаге; в отчёт — число верных исполнимых шагов', async ({
  page,
}) => {
  const token = `tok_${Date.now().toString(36)}_dry_abcdefgh`;
  await vcSet({
    mode: null,
    model: {
      'введи Терміново в Нотатка': [
        { kind: 'fill', text: 'Нотатка', value: 'Терміново' },
        { kind: 'click', text: 'Зберегти' },
      ],
      'натисни Клієнти': [{ kind: 'click', text: 'Клієнти' }],
    },
  });
  await vcSet({ testToken: token, testHost: false });
  await page.goto(`${adminPage(newPk(), 'emp-dry')}&v4c_voicetest=${token}`);
  await expect.poll(() => page.url()).not.toContain('v4c_voicetest');
  const f = await frameOf(page, false);
  const box = f.locator('.wa-vt');
  await box.locator('.wa-edit', { hasText: 'Перевірити сторінку' }).click();
  await expect(box).toContainText('введи Терміново в Нотатка');
  await box.locator('.wa-edit', { hasText: 'Сухий прогін' }).first().click();
  // Два шага — две строки со своими «Вірно / Не те».
  const step1 = box.locator('.wa-card-a', { hasText: '1. Нотатка' });
  const step2 = box.locator('.wa-card-a', { hasText: '2. Зберегти' });
  await expect(step1.locator('.wa-yes')).toBeVisible();
  await expect(step2.locator('.wa-no')).toBeVisible();
  // Ничего не нажато: сухой прогон.
  await expect(page.locator('#ak-note')).toHaveValue('');
  await step1.locator('.wa-yes').click();
  await expect(box).toContainText('1. Нотатка — ✓');
  await expect(box).not.toContainText('Вірно 1 з');
  // «Зберегти» на рабочем хосте — «натисніть самі» (не исполнимый): его
  // «вірно» в счёт не идёт — сервер считает исполнимые шаги.
  await step2.locator('.wa-yes').click();
  // «з N» — из исполнимых шагов (как в отчёте TMA).
  await expect(box).toContainText('Вірно 1 з 1 кроків');
  await expect(
    box.locator('.wa-card-a', { hasText: '1. Нотатка' })
  ).toHaveCount(0);
  // Вторая команда: шаг «не те».
  await box.locator('.wa-edit', { hasText: 'Сухий прогін' }).first().click();
  await box
    .locator('.wa-card-a', { hasText: '1. Клієнти' })
    .locator('.wa-no')
    .click();
  await expect(box).toContainText('Вірно 0 з 1 кроків');
  await box.locator('.wa-yes', { hasText: 'Сформувати звіт' }).click();
  await expect
    .poll(async () => (await vcLog()).tests[0].report !== null)
    .toBe(true);
  const rep = (await vcLog()).tests[0].report as {
    dry: Array<{ planId: string; ok: number }>;
  };
  expect(rep.dry.map((d) => d.ok)).toEqual([1, 0]);
});

test('Р-З9-23: «заповни Місто Київ і збережи» — поле и «Зберегти» с операцией API по параметру: на странице ничего, вопрос в чат с номером объекта страницы', async ({
  page,
}) => {
  await vcSet({
    mode: 'on',
    model: {
      'заповни Місто Київ і збережи': [
        { kind: 'fill', text: 'Місто', value: 'Київ' },
        { kind: 'click', text: 'Зберегти' },
      ],
    },
  });
  await page.goto(adminPage(newPk(), 'emp-api'));
  const f = await frameOf(page);
  // Страница заказа 1042 (адрес SPA): номер — из адреса, не из команды.
  await page.evaluate(() => history.pushState({}, '', '/admin/orders/1042'));
  await say(f, 'заповни Місто Київ і збережи');
  await allow(f); // согласие на сессию
  await expect(f.locator('.wa-me').last()).toContainText(
    'заповни Місто Київ і збережи (№ 1042)'
  );
  await page.waitForTimeout(800);
  await expect(page.locator('#ak-city')).toHaveValue('');
  await expect(page.locator('#ak-saves')).toHaveText('0');
  expect((await vcLog()).plans).toHaveLength(0);
  const r = await fetch(`${WIDGET}/__mock/admin-log`, { method: 'POST' });
  const dialogs = (
    (await r.json()) as {
      dialogs: Record<string, Array<{ role: string; text: string }>>;
    }
  ).dialogs;
  expect(dialogs['emp-api']?.[0]).toMatchObject({
    role: 'employee',
    text: 'заповни Місто Київ і збережи (№ 1042)',
  });
});

test('аудит 06.10: прогон мемо «Админки» — карточка мемо, «Перевірити сторінку» (итог кодом), «Завершити прогін»; ничего не нажато, планов нет', async ({
  page,
}) => {
  const token = `tok_${Date.now().toString(36)}_memo_abcdef`;
  await vcSet({
    testToken: token,
    testHost: false,
    memo: {
      schema: 1,
      names: { uk: 'Клієнти і відвантаження' },
      triggers: {},
      goal: { text: { uk: 'Відкрито клієнтів' } },
      slots: [],
      steps: [
        {
          action: 'ui',
          kind: 'navigate',
          target: { assistId: null, text: 'Клієнти', role: 'link' },
          value: null,
        },
        { action: 'api', op: 'r2', opKey: 'shop.updateOrderStatus', args: {} },
      ],
    },
  });
  await page.goto(`${adminPage(newPk(), 'emp-owner')}&v4c_voicetest=${token}`);
  await expect.poll(() => page.url()).not.toContain('v4c_voicetest');
  const f = await frameOf(page, false);
  const box = f.locator('.wa-vt');
  await expect(box).toContainText('Прогін мемо АМ-7 «Клієнти і відвантаження»');
  await expect(box).toContainText('API · shop.updateOrderStatus');
  await box.locator('.wa-edit', { hasText: 'Перевірити сторінку' }).click();
  await expect(box).toContainText('кроків 1, проблем 0');
  await box.locator('.wa-yes', { hasText: 'Завершити прогін' }).click();
  await expect(box).toContainText('Прогін пройдено');
  const log = await vcLog();
  expect(log.plans).toHaveLength(0);
  expect(
    (log.tests[0] as unknown as { memo: { result: string } }).memo.result
  ).toBe('pass');
  await expect(page.locator('#ak-saves')).toHaveText('0');
  await expect(page.locator('#ak-deletes')).toHaveText('0');
});
