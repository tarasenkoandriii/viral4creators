/**
 * Заход 13 (хвост Р-З11-А11) в Chromium — инструменты панели редактора карты
 * «Админки» (iframe `wa.` = origin «Админки» `127.0.0.1`, метка `admin`) до
 * паритета с панелью «Сайта»: API — `/assist-admin/v1/editor/*` (editor-mock.ts
 * через admin-mock.ts, ОБЕ сессии — сотрудника и редактора; правила сервера —
 * sites-backend acceptance/z13a):
 *  - «✨ Синоніми від ШІ» → `suggest-synonyms`, ✓ принять / ✕ відхилити;
 *  - «Промахи»: тепловые значки над целями на странице админки, «не туди →
 *    Перепривязати» (клик по другому элементу — синоним ему, со старой цели
 *    снят); «Пропозиції» — без карточки термина (у «Админки» их нет);
 *  - мемо АМ-N записью кликами: ссылка — шаг (переход по-настоящему, запись
 *    продолжается на новой странице), поле — слот, «Зберегти» — стоп
 *    «Серверна дія — лише кроком API», без «Чекати це»; «Зберегти чернетку» —
 *    «АМ-1»; «Прогнати» — снимок с зонами владельца;
 *  - микрофон 🎤 → `/assist-admin/v1/editor/voice` (`audio/*`) → «Сказать сейчас»;
 *  - ни одного сохранения/удаления в самой админке.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { WIDGET, mock, newPk, origin, stand } from './fixtures';
import { testJwt } from './stand/admin-mock';

// Микрофон «Сказать сейчас»: поддельное устройство и разрешение (как editor-tools).
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
});

const ADMIN = 'http://127.0.0.1:5181';
const HOST = 'admin.example.localhost';
const FRAME = `${ADMIN}/wa/v1/editor-frame`;

interface EdLog {
  log: Array<{ path: string; body: unknown }>;
  revision: number;
  targets: Array<{
    key: string;
    synonyms?: Record<string, Array<{ text: string; origin: string }>>;
  }>;
  voiceBytes: number;
}

async function editorLog(): Promise<EdLog> {
  return (await fetch(`${WIDGET}/__mock/editor-log`)).json();
}

const paths = async (prefix: string) =>
  (await editorLog()).log.filter((l) => l.path.startsWith(prefix));

function adminPage(pk: string, n = 1): string {
  return stand(HOST, {
    pk,
    n,
    lang: 'uk',
    adminKit: true,
    loaderOrigin: ADMIN,
    attrs: {
      'data-mode': 'admin',
      'data-lang': 'uk',
      'data-identity': testJwt('owner-1'),
    },
  });
}

const panelOf = (page: Page) =>
  page.frames().find((f) => f.url().startsWith(FRAME));

async function openEditor(page: Page): Promise<{ pk: string; frame: Frame }> {
  const pk = newPk();
  const token = `adm${'T'.repeat(22)}${Date.now().toString(36)}`;
  await fetch(`${WIDGET}/__mock/editor-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, origin: origin(HOST) }),
  });
  await page.goto(`${adminPage(pk)}&v4c_edit=${token}`);
  await expect.poll(() => !!panelOf(page)).toBe(true);
  const frame = panelOf(page)!;
  await expect(frame.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  return { pk, frame };
}

/** Значки пикера (закрытый Shadow DOM): корни ловит init-скрипт. */
async function badges(page: Page): Promise<Array<[string, string]>> {
  return page.evaluate(() =>
    ((window as unknown as { __roots?: ShadowRoot[] }).__roots ?? []).flatMap(
      (r) =>
        [...r.querySelectorAll('.ht')].map(
          (b) =>
            [b.getAttribute('data-key') || '', b.textContent || ''] as [
              string,
              string,
            ]
        )
    )
  );
}

async function untouched(page: Page): Promise<void> {
  await expect(page.locator('#ak-saves')).toHaveText('0');
  await expect(page.locator('#ak-deletes')).toHaveText('0');
}

test.beforeEach(async () => {
  await mock('reset');
  await mock('admin-reset');
  await fetch(`${WIDGET}/__mock/editor-reset`, { method: 'POST' });
});

test('«Админка» (заход 13): ИИ-синонимы, «Промахи» — значки на странице и «не туди → Перепривязати», «Пропозиції» без термина; всё — `/assist-admin/v1/editor/*`, админка не реагирует', async ({
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
  const { frame } = await openEditor(page);
  // Цель — вкладка-ссылка «Клієнти» админки (режим «Вибір» — переход не идёт).
  await page.click('#ak-nav a:nth-of-type(2)');
  await expect(frame.locator('.pick')).toContainText('Клієнти');
  await frame.locator('input[name="syn-uk"]').fill('доставка');
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(1);
  const key = (await editorLog()).targets[0].key;

  // ИИ-синонимы: ленивый чанк того же origin `wa.`, запрос — префикс «Админки».
  await frame.locator('button', { hasText: '✨ Синоніми від ШІ' }).click();
  await frame.locator('button', { hasText: '✨ Запропонувати' }).click();
  await expect(frame.locator('p.note')).toContainText('Запропоновано: 2');
  expect(await paths('/assist-admin/v1/editor/suggest-synonyms')).toHaveLength(
    1
  );
  const rows = frame.locator('fieldset.ai .row');
  await rows.first().locator('button', { hasText: '✓' }).click();
  await expect
    .poll(async () => (await editorLog()).targets[0].synonyms?.uk)
    .toEqual([
      { text: 'доставка', origin: 'owner' },
      { text: 'подарунок', origin: 'owner' },
      { text: 'упаковка', origin: 'suggested' },
    ]);
  await frame
    .locator('fieldset.ai .row', { hasText: 'упаковка' })
    .locator('button', { hasText: '✕' })
    .click();
  await expect
    .poll(async () =>
      (await paths('/assist-admin/v1/editor/suggestions/mute')).map(
        (l) => l.body
      )
    )
    .toEqual([{ key, lang: 'uk', text: 'упаковка' }]);

  // «Промахи»: значок над целью на странице админки; «не туди» под целью.
  await frame.locator('.tabs button', { hasText: 'Промахи' }).click();
  await expect.poll(() => badges(page)).toEqual([[key, '🗣5 ✋3 ↩1']]);
  expect(await paths('/assist-admin/v1/editor/misses')).not.toHaveLength(0);
  const wrong = frame.locator('ul.wrong li', { hasText: '«доставка»' });
  await expect(wrong).toContainText('відвідувачів: 2 (2)');
  await wrong.locator('button', { hasText: 'Перепривязати' }).click();
  // Другой элемент — поле «Місто» (у ссылок навигации тот же адрес).
  await page.click('#ak-city');
  await expect(frame.locator('input[name="syn-uk"]')).toHaveValue('доставка');
  await expect.poll(() => badges(page)).toEqual([]);
  const r0 = (await editorLog()).revision;
  await frame.locator('button.pri', { hasText: 'Зберегти в чернетку' }).click();
  await expect.poll(async () => (await editorLog()).revision).toBe(r0 + 1);
  const ops = (await paths('/assist-admin/v1/editor/ops')).pop()!.body as {
    ops: Array<{ op: string; target: { key: string; synonyms?: unknown } }>;
  };
  // Новая цель получила фразу, со старой она снята — одним пакетом.
  expect(ops.ops.map((o) => o.target.key)).toEqual([
    expect.not.stringMatching(new RegExp(`^${key}$`)),
    key,
  ]);

  // «Пропозиції»: «просили», «вела не туди», «натисніть самі» — без термина.
  await frame.locator('.tabs button', { hasText: 'Пропозиції' }).click();
  const cards = frame.locator('.card');
  await expect(cards).toHaveCount(3);
  await expect(
    frame.locator('.card', { hasText: 'Розпізнавання не впевнене' })
  ).toHaveCount(0);
  // Старых путей «Сайта» панель «Админки» не вызывает; админка не реагирует.
  expect(await paths('/editor/v1/')).toHaveLength(0);
  await untouched(page);
});

test('«Админка» (заход 13): мемо АМ-N кликами — переход исполняется и запись идёт дальше, поле — слот, «Зберегти» — стоп (лише кроком API), без «Чекати це»; «Зберегти чернетку» — АМ-1; микрофон → `/assist-admin/v1/editor/voice`', async ({
  page,
}) => {
  const { pk, frame } = await openEditor(page);
  await frame.locator('.tabs button', { hasText: 'Мемо' }).click();
  // Список мемо сайта — номера «АМ-».
  await expect(frame.locator('.memo .list li').first()).toContainText(
    'АМ-3 Кошик'
  );
  await frame.locator('button.pri', { hasText: 'Записати' }).click();
  await expect(frame.locator('.memo p.warn')).toContainText('Запис');
  // «Чекати це» — у мемо «Админки» нет.
  await expect(frame.locator('button', { hasText: 'Чекати це' })).toHaveCount(
    0
  );
  // Ссылка «Клієнти» — шаг, переход по-настоящему (MPA): запись продолжается.
  const before = page.url();
  await Promise.all([
    page.waitForURL((u) => u.href !== before),
    page.click('#ak-nav a:nth-of-type(2)'),
  ]);
  await expect.poll(() => !!panelOf(page)).toBe(true);
  const f2 = panelOf(page)!;
  await expect(f2.locator('.tabs')).toBeVisible({ timeout: 15_000 });
  await expect(f2.locator('.tabs button.on')).toHaveText('Мемо');
  await expect(f2.locator('ol.steps li')).toHaveCount(1);
  await expect(f2.locator('ol.steps li').first()).toContainText('Клієнти');
  // Поле — слот без значения.
  await page.click('#ak-note');
  await expect(f2.locator('ol.steps li')).toHaveCount(2);
  await expect(f2.locator('ol.steps li').nth(1)).toContainText('{note}');
  // Ссылка в строке таблицы (имя клиента) — не шаг: панель передаёт
  // признак строки, сервер без `data-assist-id` её не пишет (аудит P3-3).
  await page.click('#ak-table a[href="#c2"]');
  await expect
    .poll(async () =>
      (await paths('/assist-admin/v1/editor/memo/record/step')).some(
        (l) => (l.body as { row?: boolean }).row === true
      )
    )
    .toBe(true);
  await expect(f2.locator('ol.steps li')).toHaveCount(2);
  // «Зберегти» формы — стоп: серверное действие только шагом API.
  await page.click('#ak-save');
  await expect(f2.locator('p.note')).toContainText(
    'Серверна дія — лише кроком API'
  );
  await expect(f2.locator('ol.steps li')).toHaveCount(2);
  await untouched(page);
  // Сохранить черновик — «АМ-1».
  await f2.locator('input[name="memo-name"]').fill('Нотатка до замовлення');
  await f2.locator('input[name="memo-name"]').dispatchEvent('change');
  await f2.locator('button.pri', { hasText: 'Зберегти чернетку' }).click();
  await expect(f2.locator('p.note')).toContainText('Чернетку АМ-1 збережено');
  const stop = (await paths('/assist-admin/v1/editor/memo/record/stop')).pop()!
    .body as { steps: Array<{ action: string }>; name: string };
  expect(stop.steps.map((s) => s.action)).toEqual(['click', 'fill']);
  expect(stop.name).toBe('Нотатка до замовлення');
  // «Прогнати» — снимок этой страницы (строки таблиц клиентов — вон, Р-Э6б-6).
  await f2.locator('button', { hasText: 'Прогнати' }).click();
  await expect(f2.locator('.memo p.note')).toContainText('Збій на кроці 1');
  const run = (await paths('/assist-admin/v1/editor/memo/m1/try')).pop()!;
  const snap = JSON.stringify((run.body as { snapshot: unknown }).snapshot);
  expect(snap).toContain('Нотатка');
  expect(snap).not.toContain('Олена Коваль');
  const steps = await paths('/assist-admin/v1/editor/memo/record/step');
  expect(steps).toHaveLength(4);
  expect(await paths('/editor/v1/')).toHaveLength(0);

  // Микрофон «Сказать сейчас» — запись на сервер «Админки», затем проверка.
  await f2.locator('.tabs button', { hasText: 'Перевірка' }).click();
  await f2.locator('button', { hasText: '🎤' }).click();
  await expect(f2.locator('button', { hasText: '■' })).toBeVisible();
  await page.waitForTimeout(1200);
  await f2.locator('button', { hasText: '■' }).click();
  await expect(f2.locator('input[name="say"]')).toHaveValue('натисни в кошик');
  const log = await editorLog();
  const v = log.log.find((l) => l.path === '/assist-admin/v1/editor/voice')!;
  expect((v.body as { type: string }).type).toMatch(/^audio\//);
  expect(log.voiceBytes).toBeGreaterThan(200);
  expect(await paths('/assist-admin/v1/editor/try')).toHaveLength(1);
  await untouched(page);
  // Флаг продолжения — свой у «Админки».
  expect(
    await page.evaluate(
      (k) => !!sessionStorage.getItem(k),
      `v4c_edit:admin:${pk}`
    )
  ).toBe(true);
});
