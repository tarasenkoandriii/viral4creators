/**
 * Э3-бис (ТЗ §5-тер.9, §5-тер.16 п.12, п.14, п.15): связанный режим по
 * согласию посетителя — чанки ana.js / bf.js на стенде с моком API.
 *  - без согласия: на устройство ничего не пишется, на сервер ничего не
 *    уходит, group/ref → null; без поля `analytics` чанк ana.js не грузится;
 *  - consent(true): ключ визита в localStorage, итог просмотра с ключом,
 *    цель — с ключом; consent(false) — ключ удалён;
 *  - GPC: «без согласия» несмотря на consent(true);
 *  - holdout (группа b): кнопки нет, group → 'h', включение маяком /exp;
 *  - Google Consent Mode (если владелец включил): granted в dataLayer;
 *  - К-11: введённые в форму значения (пароль, телефон, карта) не уходят ни
 *    в одном запросе загрузчика и чанков.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  ask,
  chat,
  humanBrowser,
  launcher,
  log,
  mock,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';

type G = { V4CAssist: (...a: unknown[]) => unknown; dataLayer?: unknown[] };
const call = (page: Page, ...args: unknown[]) =>
  page.evaluate((a) => (window as unknown as G).V4CAssist(...a), args);
const viaCb = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      new Promise((res) =>
        (window as unknown as G).V4CAssist(c, (v: unknown) => res(v))
      ),
    cmd
  );
const visitKeyOf = (page: Page, pk: string) =>
  page.evaluate((k) => localStorage.getItem(k), `v4c_w:${pk}:v`);
const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

/** URL ленивых чанков, запрошенных страницей (статика стенда не в журнале мока). */
function chunkUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}
const anaLoaded = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith('/v1/ana.js'));

const ANA = { consent: { gcm: false }, behavior: true, experiment: null };
const GOALS = [
  {
    key: 'purchase',
    detectors: [{ kind: 'js', config: {} }],
    valueMode: 'none',
  },
];

test.beforeEach(async () => {
  await mock('reset');
});

test('без согласия: ни ключа, ни запросов связанного режима; group/ref — null', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, { analytics: ANA, goals: GOALS });
  const urls = chunkUrls(page);
  const loaded = anaLoaded(page);
  await page.goto(stand('example.localhost', { pk, long: true }));
  await expect(launcher(page)).toBeVisible();
  await loaded;
  expect(await viaCb(page, 'group')).toBeNull();
  expect(await viaCb(page, 'ref')).toBeNull();
  await call(page, 'goal', 'purchase', {});
  await hide(page);
  await page.waitForTimeout(500);
  expect(await visitKeyOf(page, pk)).toBeNull();
  const l = await log();
  expect(l.ana).toEqual([]);
  expect(urls.some((u) => u.endsWith('/v1/bf.js'))).toBe(false);
  expect(l.goals.every((g) => g.visit === undefined)).toBe(true);
});

test('без поля analytics чанк ana.js не грузится вовсе', async ({ page }) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, { goals: GOALS });
  const urls = chunkUrls(page);
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await call(page, 'consent', { analytics: true });
  await page.waitForTimeout(2500);
  expect(await visitKeyOf(page, pk)).toBeNull();
  expect(urls.some((u) => u.endsWith('/v1/engage.js'))).toBe(true);
  expect(urls.some((u) => u.endsWith('/v1/ana.js'))).toBe(false);
});

test('consent(true): ключ визита, итог просмотра и цель с ключом; К-11 — значений полей нет; consent(false) — ключ удалён', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, { analytics: ANA, goals: GOALS });
  const bf = page.waitForResponse((r) => r.url().endsWith('/v1/bf.js'));
  await page.goto(stand('example.localhost', { pk, long: true }));
  await expect(launcher(page)).toBeVisible();
  await call(page, 'consent', { analytics: true });
  await expect
    .poll(() => visitKeyOf(page, pk))
    .toMatch(/^v[A-Za-z0-9_-]{16,}\.\d+$/);
  const key = (await visitKeyOf(page, pk))!.split('.')[0];
  await bf;
  // Форма с паролем/телефоном/картой: значения не должны уйти никуда.
  await page.evaluate(() => {
    const f = document.createElement('form');
    for (const [n, t] of [
      ['password', 'password'],
      ['phone', 'tel'],
      ['card', 'text'],
    ]) {
      const i = document.createElement('input');
      i.name = n;
      i.type = t;
      f.appendChild(i);
    }
    f.addEventListener('submit', (e) => e.preventDefault());
    document.body.appendChild(f);
  });
  await page.locator('input[name=password]').fill('S3cr3t-pass!');
  await page.locator('input[name=phone]').fill('+380671234567');
  await page.locator('input[name=card]').fill('4111111111111111');
  await call(page, 'goal', 'purchase', {});
  await page.waitForTimeout(300);
  await hide(page);
  await expect
    .poll(
      async () =>
        (await log()).ana.filter((a) => a.path === '/widget/v1/pv').length
    )
    .toBeGreaterThan(0);
  const l = await log();
  const pv = l.ana.find((a) => a.path === '/widget/v1/pv')!;
  expect(pv.body.v).toBe(key);
  expect(pv.body.fs).toBe(1);
  expect(pv.body.fa).toBe('card');
  expect(Object.keys(pv.body)).not.toContain('value');
  const all = JSON.stringify([l.ana, l.goals, l.events]);
  for (const secret of [
    'S3cr3t-pass!',
    '+380671234567',
    '4111111111111111',
    '0671234567',
  ]) {
    expect(all).not.toContain(secret);
  }
  expect(l.goals.some((g) => g.goalKey === 'purchase' && g.visit === key)).toBe(
    true
  );
  await call(page, 'consent', { analytics: false });
  await expect.poll(() => visitKeyOf(page, pk)).toBeNull();
});

test('GPC: «без согласия» несмотря на consent(true)', async ({ page }) => {
  await humanBrowser(page);
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
      get: () => true,
    })
  );
  const pk = newPk();
  await site(pk, { analytics: ANA });
  const loaded = anaLoaded(page);
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await loaded;
  await call(page, 'consent', { analytics: true });
  await page.waitForTimeout(800);
  expect(await visitKeyOf(page, pk)).toBeNull();
  expect(await viaCb(page, 'ref')).toBeNull();
  expect((await log()).ana).toEqual([]);
});

test('holdout, группа b: кнопки нет, group → h, включение маяком /exp; ref — с ключом', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, {
    analytics: {
      ...ANA,
      behavior: false,
      experiment: {
        id: 'exp1',
        kind: 'holdout',
        share: 0.999,
        salt: 'salt1',
        variant: null,
      },
    },
  });
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await call(page, 'consent', { analytics: true });
  await expect(launcher(page)).toBeHidden();
  expect(await viaCb(page, 'group')).toBe('h');
  expect(await viaCb(page, 'ref')).toBe('r1.test');
  await expect
    .poll(
      async () =>
        (await log()).ana.filter((a) => a.path === '/widget/v1/exp').length
    )
    .toBe(1);
  const exp = (await log()).ana.find((a) => a.path === '/widget/v1/exp')!;
  expect(exp.body).toMatchObject({ pk, x: 'exp1' });
  expect(Object.keys(exp.body).sort()).toEqual(['pk', 'v', 'x']);
});

test('аудит: отзыв и новое согласие — новый ключ визита включается в эксперимент заново', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, {
    analytics: {
      ...ANA,
      behavior: false,
      experiment: {
        id: 'exp1',
        kind: 'holdout',
        share: 0.999,
        salt: 'salt1',
        variant: null,
      },
    },
  });
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  const exps = async () =>
    (await log()).ana.filter((a) => a.path === '/widget/v1/exp');
  await call(page, 'consent', { analytics: true });
  await expect.poll(async () => (await exps()).length).toBe(1);
  await call(page, 'consent', { analytics: false });
  await expect(launcher(page)).toBeVisible();
  await call(page, 'consent', { analytics: true });
  await expect.poll(async () => (await exps()).length).toBe(2);
  const [a, b] = await exps();
  expect(a.body.v).not.toBe(b.body.v);
});

test('Google Consent Mode (включено владельцем): granted в dataLayer → связанный режим', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, {
    analytics: { ...ANA, behavior: false, consent: { gcm: true } },
  });
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as G;
    w.dataLayer = w.dataLayer || [];
    // gtag кладёт в dataLayer объект arguments.
    (function (...a: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
      return a;
    })('consent', 'update', { analytics_storage: 'granted' });
  });
  await expect
    .poll(() => visitKeyOf(page, pk), { timeout: 5000 })
    .not.toBeNull();
});

test('вариант приветствия (группа b): текст B в чате, включение при открытии; диалог привязан к визиту', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, {
    analytics: {
      ...ANA,
      behavior: false,
      experiment: {
        id: 'exp2',
        kind: 'greeting',
        share: 0.999,
        salt: 'salt2',
        variant: {
          uk: 'Вітаю! Підкажу з розміром',
          ru: 'Здравствуйте! Подскажу с размером',
        },
      },
    },
  });
  const loaded = anaLoaded(page);
  await page.goto(stand('example.localhost', { pk, lang: 'uk' }));
  await expect(launcher(page)).toBeVisible();
  await loaded;
  await call(page, 'consent', { analytics: true });
  await expect.poll(() => visitKeyOf(page, pk)).not.toBeNull();
  const key = (await visitKeyOf(page, pk))!.split('.')[0];
  expect((await log()).ana.filter((a) => a.path === '/widget/v1/exp')).toEqual(
    []
  );
  await openChat(page);
  await expect(chat(page).getByText('Вітаю! Підкажу з розміром')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await log()).ana.filter((a) => a.path === '/widget/v1/exp').length
    )
    .toBe(1);
  await ask(page, 'Є 44 розмір?');
  await waitAnswer(page);
  await expect
    .poll(
      async () =>
        (await log()).ana.filter((a) => a.path === '/widget/v1/visit').length
    )
    .toBe(1);
  const visit = (await log()).ana.find((a) => a.path === '/widget/v1/visit')!;
  expect(visit.body.v).toBe(key);
  expect(typeof visit.body.conversationId).toBe('string');
});
