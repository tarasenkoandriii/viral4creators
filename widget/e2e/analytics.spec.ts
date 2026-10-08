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
 *    в одном запросе загрузчика и чанков;
 *  - заход 9: готовые связки CMP (Cookiebot, OneTrust, CookieYes, Complianz)
 *    на макетах их API — согласие/отказ и решение до загрузки виджета.
 */
import { expect, test, type Page } from '@playwright/test';
import { cmpSnippet, type CmpId } from '../../assist/src/lib/cmp-snippets';
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

// ── Заход 9 (хвост Э3-бис (8)): готовые связки баннеров согласия (CMP) ──
// Фрагменты — те же, что показывает TMA (assist/src/lib/cmp-snippets.ts);
// на странице стенда — макет API каждой CMP (события и глобалы, как у неё).
const CMP_CASES: Array<{
  id: Exclude<CmpId, 'custom' | 'gcm'>;
  before?: string;
  grant: string;
  deny: string;
}> = [
  {
    id: 'cookiebot',
    grant:
      "window.Cookiebot={consent:{statistics:true}};window.dispatchEvent(new Event('CookiebotOnConsentReady'))",
    deny: "window.Cookiebot={consent:{statistics:false,marketing:true}};window.dispatchEvent(new Event('CookiebotOnConsentReady'))",
  },
  {
    id: 'onetrust',
    before: 'window.OptanonWrapper=function(){}',
    grant:
      "window.OnetrustActiveGroups=',C0001,C0002,';window.OptanonWrapper()",
    deny: "window.OnetrustActiveGroups=',C0001,C0004,';window.OptanonWrapper()",
  },
  {
    id: 'cookieyes',
    grant:
      "document.dispatchEvent(new CustomEvent('cookieyes_consent_update',{detail:{accepted:['necessary','analytics'],rejected:[]}}))",
    deny: "document.dispatchEvent(new CustomEvent('cookieyes_consent_update',{detail:{accepted:['necessary'],rejected:['analytics']}}))",
  },
  {
    id: 'complianz',
    grant:
      "window.cmplz_has_consent=function(c){return c==='statistics'};document.dispatchEvent(new CustomEvent('cmplz_status_change',{detail:{category:'statistics',value:'allow'}}))",
    deny: "window.cmplz_has_consent=function(){return false};document.dispatchEvent(new CustomEvent('cmplz_status_change',{detail:{category:'statistics',value:'deny'}}))",
  },
];

for (const c of CMP_CASES) {
  test(`CMP ${c.id}: согласие в баннере → ключ визита; отказ → ключ удалён`, async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { analytics: ANA, goals: GOALS });
    const loaded = anaLoaded(page);
    await page.goto(stand('example.localhost', { pk }));
    await expect(launcher(page)).toBeVisible();
    await loaded;
    const code = cmpSnippet(c.id, 'V4CAssist') as string;
    await page.addScriptTag({ content: `${c.before ?? ''};\n${code}` });
    expect(await visitKeyOf(page, pk)).toBeNull();
    await page.evaluate(c.grant);
    await expect
      .poll(() => visitKeyOf(page, pk))
      .toMatch(/^v[A-Za-z0-9_-]{16,}\.\d+$/);
    await page.evaluate(c.deny);
    await expect.poll(() => visitKeyOf(page, pk)).toBeNull();
  });
}

test('CMP: решение баннера ДО загрузки виджета — в очередь, связанный режим включается', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, { analytics: ANA, goals: GOALS });
  // Cookiebot с прежним решением шлёт событие сразу — раньше загрузчика.
  await page.addInitScript(
    `${cmpSnippet('cookiebot', 'V4CAssist')};\n` +
      "window.Cookiebot={consent:{statistics:true}};window.dispatchEvent(new Event('CookiebotOnConsentReady'));"
  );
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await expect
    .poll(() => visitKeyOf(page, pk))
    .toMatch(/^v[A-Za-z0-9_-]{16,}\.\d+$/);
});

// Аудит P2-5: решение, данное РАНЬШЕ (CMP уже ответила до фрагмента или
// сообщает его при загрузке баннера), — связанный режим без нового клика.
const CMP_PRIOR: Array<{
  name: string;
  id: Exclude<CmpId, 'custom' | 'gcm'>;
  before: string;
  after?: string;
}> = [
  {
    name: 'Cookiebot: hasResponse до вставки фрагмента',
    id: 'cookiebot',
    before: 'window.Cookiebot={hasResponse:true,consent:{statistics:true}}',
  },
  {
    name: 'CookieYes: getCkyConsent() до вставки фрагмента',
    id: 'cookieyes',
    before:
      'window.getCkyConsent=function(){return {categories:{necessary:true,analytics:true},isUserActionCompleted:true}}',
  },
  {
    name: 'CookieYes: cookieyes_banner_load с прежним решением',
    id: 'cookieyes',
    before: '',
    after:
      "document.dispatchEvent(new CustomEvent('cookieyes_banner_load',{detail:{activeLaw:'gdpr',categories:{necessary:true,analytics:true},isUserActionCompleted:true}}))",
  },
];

for (const c of CMP_PRIOR) {
  test(`CMP прежнее решение — ${c.name}`, async ({ page }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { analytics: ANA, goals: GOALS });
    const loaded = anaLoaded(page);
    await page.goto(stand('example.localhost', { pk }));
    await expect(launcher(page)).toBeVisible();
    await loaded;
    await page.addScriptTag({
      content: `${c.before};\n${cmpSnippet(c.id, 'V4CAssist')}`,
    });
    if (c.after) await page.evaluate(c.after);
    await expect
      .poll(() => visitKeyOf(page, pk))
      .toMatch(/^v[A-Za-z0-9_-]{16,}\.\d+$/);
  });
}
