#!/usr/bin/env node
/**
 * Сквозные проверки сайта в браузере (проектный документ §13.6, §16.8):
 * собранный сайт (`next start`, :3020) + стенд API (`scripts/built/stand.ts`,
 * :3021) с инъекцией отказов. Мобильный вьюпорт.
 *
 *  1. AT-F11-01 + клавиатура: внешняя метка → внутренняя страница → CTA →
 *     форма, пройденная ТОЛЬКО клавиатурой (порядок фокуса), → заявка с
 *     `sessionRef`, метками и `contentSlug`; события `content_view`/`cta_click`
 *     — `text/plain`, без cookie, с `path`, одна сессия; 0 ошибок консоли.
 *  2. AT-F11-02: тот же путь без хранения (`analyticsStorage='none'`, через
 *     `POST /api/revalidate`) → ни `sessionRef`, ни меток в заявке.
 *  3. AT-CORE-02: пустые обязательные поля → ошибки текстом у полей,
 *     `aria-invalid`, фокус на первом; исправление → успех.
 *  4. AT-CORE-03: 500 и обрыв ДО записи → «не відправлено», кнопка повтора,
 *     альтернативный контакт, данные на месте, ни заявки, ни события
 *     успеха; повтор → успех. Обрыв ПОСЛЕ записи → тоже не успех; повтор
 *     тем же ключом → та же заявка (тот же номер), даже при исчерпанном
 *     лимите.
 *  5. AT-CORE-04: двойной клик → одна отправка и одна заявка; 5 параллельных
 *     разных (одна с отказом сервера) → каждый показанный успех = заявка на
 *     стенде, отказ — честный, ложных успехов нет.
 *  6. AT-CORE-02: 6-я новая отправка за окно → 429 с временем ожидания и
 *     альтернативным контактом, данные на месте.
 *  7. Без JS: текст материала читается, на /contact — альтернативный
 *     контакт вместо формы. Снятый → 410, неизвестный → 404.
 *  8. Раунд исправлений аудита: форма до гидратации инертна (S2-1);
 *     таймаут клиента → «статус невідомий», повтор тем же ключом (S3-1/5);
 *     409 → новый ключ (S3-1); поля заблокированы при отправке, номер
 *     остаётся (S3-6/8); метки/путь с ПД не уходят (S3-3); referrerHost —
 *     только у первого просмотра (S3-4); CSP (S3-2); `/api/revalidate` 401,
 *     `verify.txt` (S3-1); снятый при сбое API — 503 без текста / 410 (S2-2).
 * Счётчик стенда сбрасывается между сценариями.
 *
 * Запуск: `BASE_URL=http://localhost:3020 STAND_URL=http://localhost:3021
 * PUBLISHER_REVALIDATE_SECRET=… node scripts/built/e2e.mjs`; `--base-url`
 * — то же, что BASE_URL (повтор на публичном адресе со своим стендом).
 */
import { chromium } from 'playwright-core';

const argBase = process.argv.includes('--base-url') ? process.argv[process.argv.indexOf('--base-url') + 1] : null;
const BASE = (argBase ?? process.env.BASE_URL ?? 'http://localhost:3020').replace(/\/$/, '');
const STAND = (process.env.STAND_URL ?? 'http://localhost:3021').replace(/\/$/, '');
const SECRET = process.env.PUBLISHER_REVALIDATE_SECRET ?? '';
const MOBILE = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true };
const fails = [];
let checks = 0;
const check = (ok, msg) => {
  checks++;
  if (!ok) fails.push(msg);
};
const stand = (p, body) =>
  fetch(STAND + p, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());
const log = () => stand('/__stand/log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) {
      fails.push(`не дождались: ${what}`);
      return null;
    }
    await sleep(150);
  }
}

// Чистое состояние ISR (прошлый прогон мог оставить в кэше 404 снятого материала).
if (SECRET)
  await fetch(`${BASE}/api/revalidate`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }).catch(
    () => undefined,
  );
const browser = await chromium.launch();

/** Страница с журналом ошибок консоли. `expectedFailures` — ожидаемые «Failed to load resource» при инъекции отказов. */
async function open(ctx, consoleErrors) {
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && consoleErrors) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors?.push(`pageerror: ${e.message}`));
  return page;
}
async function gotoForm(page, query = '') {
  await page.goto(`${BASE}/contact${query}`, { waitUntil: 'load' });
  await page.waitForSelector('form[data-ready="1"]');
}
async function fill(page, task = 'Потрібні матеріали для блогу') {
  await page.fill('#lf-name', 'Олена');
  await page.check('#lf-method-email');
  await page.fill('#lf-contact', 'olena@example.com');
  await page.fill('#lf-business', 'shop.example');
  await page.fill('#lf-task', task);
}
const statusOf = (page) => page.getAttribute('[data-testid="form-status"]', 'data-status');
/** Ждёт ИСХОД очередной попытки (`data-done` вырос) — номер прошлого успеха остаётся на экране. */
const seenDone = new WeakMap();
async function settled(page) {
  const prev = seenDone.get(page) ?? 0;
  await page.waitForFunction((p) => {
    const el = document.querySelector('[data-testid="form-status"]');
    return Number(el?.getAttribute('data-done') ?? 0) > p && el?.getAttribute('data-status') !== 'submitting';
  }, prev);
  seenDone.set(page, Number(await page.getAttribute('[data-testid="form-status"]', 'data-done')));
  return statusOf(page);
}
const statusText = (page) => page.textContent('[data-testid="form-status"]');
const leadRefOnPage = async (page) => /L-[A-Z0-9]+/.exec((await statusText(page)) ?? '')?.[0] ?? null;

async function setStorage(mode) {
  await stand('/__stand/config', { analyticsStorage: mode });
  const r = await fetch(`${BASE}/api/revalidate`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } });
  check(r.status === 200, `POST /api/revalidate → ${r.status} (нужен PUBLISHER_REVALIDATE_SECRET как у сборки)`);
  // ISR: новая версия страницы — после фоновой регенерации.
  await waitFor(
    async () => {
      const html = await fetch(`${BASE}/`).then((x) => x.text());
      return html.includes(`analyticsStorage\\":\\"${mode}`);
    },
    `страницы с analyticsStorage=${mode}`,
    20000,
  );
}

// ── 1. AT-F11-01 + клавиатура + консоль ───────────────────────────────
{
  await stand('/__stand/reset');
  const errors = [];
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, errors);
  await page.goto(
    `${BASE}/materials/pershyi-material?utm_source=tg&utm_medium=community&utm_campaign=pilot&placement=pl-1`,
    { waitUntil: 'load', referer: 'https://t.me/some_channel/42' },
  );
  const first = await waitFor(
    async () =>
      (await log()).events.find((e) => e.body.name === 'content_view' && e.body.path === '/materials/pershyi-material'),
    'content_view материала',
  );
  check(first?.contentType.startsWith('text/plain'), `событие не text/plain: ${first?.contentType}`);
  check(first?.body.referrerHost === 't.me', `referrerHost первого просмотра: ${first?.body.referrerHost}`);
  check(first?.cookie === null, 'cookie в событии');
  check(
    first?.body.contentSlug === 'pershyi-material' &&
      first?.body.utm?.source === 'tg' &&
      first?.body.placementCode === 'pl-1',
    `событие первой страницы без меток: ${JSON.stringify(first?.body)}`,
  );
  const sref = first?.body.sessionRef;
  check(typeof sref === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(sref), 'session: sessionRef в событии');
  check(
    await page
      .textContent('[data-testid="material-body"]')
      .then((t) => t?.includes('основний текст першого матеріалу')),
    'текст материала',
  );
  check(!(await page.evaluate(() => window.__xss)), 'враждебная разметка исполнилась');
  // Внутренний переход.
  await page.click('.crumbs a');
  await page.waitForURL(`${BASE}/materials`);
  const second = await waitFor(
    async () => (await log()).events.find((e) => e.body.name === 'content_view' && e.body.path === '/materials'),
    'content_view списка',
  );
  check(
    second?.body.sessionRef === sref && !second?.body.utm && !second?.body.placementCode,
    `внутренний переход: ${JSON.stringify(second?.body)}`,
  );
  check(!/utm_/.test(page.url()), 'внутренняя ссылка с UTM');
  check(
    second && second.body.referrerHost === undefined,
    `клиентский переход унаследовал referrerHost: ${second?.body.referrerHost}`,
  );
  await page.click('a[href="/materials/pershyi-material"]');
  await page.waitForURL(`${BASE}/materials/pershyi-material`);
  await page.click('[data-cta="material-next"]');
  await page.waitForURL(/\/contact\?material=pershyi-material$/);
  const cta = await waitFor(async () => (await log()).events.find((e) => e.body.name === 'cta_click'), 'cta_click');
  check(
    cta?.body.sessionRef === sref &&
      cta?.contentType.startsWith('text/plain') &&
      cta?.body.contentSlug === 'pershyi-material',
    `cta_click: ${JSON.stringify(cta)}`,
  );
  await page.waitForSelector('form[data-ready="1"]');
  // Только клавиатура: порядок фокуса и заполнение.
  await page.focus('h1');
  const order = [];
  const want = [
    'lf-name',
    'lf-method-email',
    'lf-contact',
    'lf-business',
    'lf-task',
    'lf-budgetRange',
    'lf-selfReported',
    'privacy',
    'submit',
  ];
  const idOf = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return null;
      if (a.tagName === 'A' && a.getAttribute('href') === '/privacy') return 'privacy';
      if (a.getAttribute('type') === 'submit') return 'submit';
      return a.id || a.tagName;
    });
  const typeIn = {
    'lf-name': 'Олена',
    'lf-contact': 'olena@example.com',
    'lf-business': 'shop.example',
    'lf-task': 'Задача з клавіатури',
  };
  for (let i = 0; i < 30 && order.length < want.length; i++) {
    await page.keyboard.press('Tab');
    const id = await idOf();
    if (!want.includes(id) || order.includes(id)) continue;
    order.push(id);
    if (typeIn[id]) await page.keyboard.type(typeIn[id]);
    if (id === 'lf-method-email') await page.keyboard.press('Space');
    if (id === 'lf-budgetRange') await page.keyboard.press('ArrowDown');
  }
  check(JSON.stringify(order) === JSON.stringify(want), `порядок фокуса формы: ${order.join(' → ')}`);
  check(await page.evaluate(() => document.activeElement?.closest('.hp') === null), 'ловушка получила фокус');
  await page.keyboard.press('Enter');
  check((await settled(page)) === 'success', `клавиатурная отправка: ${await statusText(page)}`);
  const ref = await leadRefOnPage(page);
  const l = await log();
  check(
    l.leads.length === 1 && l.leads[0].leadRef === ref,
    `заявка ≠ показанному номеру: ${ref} / ${JSON.stringify(l.leads.map((x) => x.leadRef))}`,
  );
  const body = l.leads[0]?.body ?? {};
  check(body.sessionRef === sref, `заявка без sessionRef сессии: ${body.sessionRef}`);
  check(
    body.utm?.source === 'tg' && body.placementCode === 'pl-1' && body.contentSlug === 'pershyi-material',
    `атрибуция заявки: ${JSON.stringify({ utm: body.utm, p: body.placementCode, c: body.contentSlug })}`,
  );
  check(
    body.budgetRange === 'under_10k' && body.consentState === 'not_required' && body.dataNoticeVersion === 'stand-1',
    `поля заявки: ${JSON.stringify(body)}`,
  );
  check(
    l.serverEvents.length === 1 && !l.events.some((e) => e.body.name === 'lead_submit_success'),
    'событие успеха — только сервер, одно',
  );
  check((await page.inputValue('#lf-task')) === '', 'после успеха форма очищена');
  check(await page.evaluate(() => Boolean(sessionStorage.getItem('pub_sref'))), 'session: pub_sref в sessionStorage');
  check(errors.length === 0, `ошибки консоли в контрольном пути: ${errors.join(' | ')}`);
  await ctx.close();
}

// ── 2. AT-F11-02: без хранения ────────────────────────────────────────
{
  await stand('/__stand/reset');
  await setStorage('none');
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await page.goto(`${BASE}/materials/pershyi-material?utm_source=tg&utm_medium=community`, { waitUntil: 'load' });
  const ev = await waitFor(
    async () => (await log()).events.find((e) => e.body.path === '/materials/pershyi-material'),
    'content_view (none)',
  );
  check(
    ev && !ev.body.sessionRef && ev.body.utm?.source === 'tg',
    `none: событие страницы — метки без sessionRef: ${JSON.stringify(ev?.body)}`,
  );
  await page.click('[data-cta="material-next"]');
  await page.waitForSelector('form[data-ready="1"]');
  await fill(page);
  await page.click('button[type="submit"]');
  check((await settled(page)) === 'success', 'none: отправка');
  const l = await log();
  const b = l.leads[0]?.body ?? {};
  check(
    !b.sessionRef && !b.utm && !b.placementCode,
    `none: заявка без источника (сервер → unknown): ${JSON.stringify(b)}`,
  );
  check(
    l.events.every((e) => !e.body.sessionRef),
    'none: ни одного sessionRef в событиях',
  );
  check(await page.evaluate(() => sessionStorage.getItem('pub_sref') === null), 'none: sessionStorage пуст');
  await ctx.close();
  await setStorage('session');
}

// ── 3. Ошибки полей → исправление ─────────────────────────────────────
{
  await stand('/__stand/reset');
  const ctx = await browser.newContext({ ...MOBILE, viewport: { width: 320, height: 640 } });
  const page = await open(ctx, null);
  await gotoForm(page);
  await page.click('button[type="submit"]');
  check((await settled(page)) === 'validation', 'пустая форма — статус ошибки');
  check((await page.evaluate(() => document.activeElement?.id)) === 'lf-name', 'фокус — на первом ошибочном поле');
  for (const id of ['lf-name', 'lf-contact', 'lf-business', 'lf-task']) {
    check((await page.getAttribute(`#${id}`, 'aria-invalid')) === 'true', `${id}: aria-invalid`);
    const desc = (await page.getAttribute(`#${id}`, 'aria-describedby')) ?? '';
    const errId = desc.split(' ').find((x) => x.endsWith('-error'));
    check(
      Boolean(errId) && ((await page.textContent(`#${errId}`)) ?? '').trim().length > 3,
      `${id}: ошибка текстом рядом с полем`,
    );
  }
  check(
    ((await page.textContent('#lf-contactMethod-error')) ?? '').includes('спосіб'),
    'способ связи — ошибка текстом',
  );
  await page.check('#lf-method-phone');
  await page.fill('#lf-contact', '12');
  await page.fill('#lf-name', 'Олена');
  await page.fill('#lf-business', 'shop');
  await page.fill('#lf-task', 'Задача');
  await page.click('button[type="submit"]');
  check((await settled(page)) === 'validation', 'неверный телефон — статус ошибки');
  check(((await page.textContent('#lf-contact-error')) ?? '').includes('номер'), 'правило по способу связи (телефон)');
  check((await log()).leads.length === 0 && (await log()).responses.length === 0, 'ошибочная форма не ушла на сервер');
  await page.fill('#lf-contact', '+380 44 123 45 67');
  await page.click('button[type="submit"]');
  check((await settled(page)) === 'success', 'после исправления — успех');
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  check(sw <= cw, `320 px: горизонтальная прокрутка ${sw} > ${cw}`);
  await ctx.close();
}

// ── 4. Отказы сервера и сети ─────────────────────────────────────────
for (const mode of ['500', 'busy', 'drop']) {
  await stand('/__stand/reset');
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  await fill(page, `Задача при відмові ${mode}`);
  await stand('/__stand/fail', { mode, times: 1 });
  await page.click('button[type="submit"]');
  const st = await settled(page);
  check(st === (mode === 'drop' ? 'network' : 'server'), `${mode}: статус ${st}`);
  const text = (await statusText(page)) ?? '';
  check(
    (mode === 'drop' ? /невідом/i.test(text) && /дубль/.test(text) : /не відправлено/i.test(text)) &&
      !/отримано/i.test(text),
    `${mode}: нет ложного успеха, честный текст: ${text}`,
  );
  check(
    await page.isVisible(
      '[data-testid="form-status"] [data-testid="alt-contact"] a[href="mailto:stand-alt@example.com"]',
    ),
    `${mode}: альтернативный контакт`,
  );
  check(
    (await page.inputValue('#lf-task')) === `Задача при відмові ${mode}` &&
      (await page.inputValue('#lf-contact')) === 'olena@example.com',
    `${mode}: данные исчезли`,
  );
  let l = await log();
  check(l.leads.length === 0 && l.serverEvents.length === 0, `${mode}: заявка/событие успеха при отказе`);
  await page.click('[data-testid="form-status"] button');
  check((await settled(page)) === 'success', `${mode}: повтор → успех`);
  l = await log();
  check(l.leads.length === 1 && l.serverEvents.length === 1, `${mode}: после повтора ровно одна заявка`);
  await ctx.close();
}
for (const [mode, shownAs] of [
  ['drop-after-commit', 'network'],
  ['truncated-after-commit', 'server'],
]) {
  // Обрыв ПОСЛЕ записи, лимит исчерпан: повтор тем же ключом → та же заявка (200).
  await stand('/__stand/reset');
  await stand('/__stand/config', { formLimit: { count: 1, windowSec: 600 } });
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  await fill(page, `Обрив після запису ${mode}`);
  await stand('/__stand/fail', { mode, times: 1 });
  await page.click('button[type="submit"]');
  check((await settled(page)) === shownAs, `${mode}: не успех (${await statusOf(page)})`);
  const stored = (await log()).leads;
  check(stored.length === 1, `${mode}: заявка записана до обрыва`);
  await page.click('[data-testid="form-status"] button');
  check((await settled(page)) === 'success', `${mode}: повтор → успех (лимит исчерпан, но повтор не считается)`);
  check((await leadRefOnPage(page)) === stored[0]?.leadRef, `${mode}: повтор тем же ключом → тот же номер`);
  const l = await log();
  check(
    l.leads.length === 1 && l.responses.some((r) => r.path.endsWith('/leads') && r.status === 200),
    `${mode}: повтор — 200, без второй заявки`,
  );
  await ctx.close();
}

// ── 5. Двойной клик и 5 параллельных ─────────────────────────────────
{
  await stand('/__stand/reset');
  await stand('/__stand/config', { leadDelayMs: 700 });
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  await fill(page, 'Подвійний клік');
  let posts = 0;
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/leads') && posts++);
  await page.dblclick('button[type="submit"]');
  await page.click('button[type="submit"]', { force: true }).catch(() => undefined);
  check(await page.isDisabled('button[type="submit"]'), 'кнопка заблокирована во время отправки');
  check((await settled(page)) === 'success', 'двойной клик: успех');
  check(posts === 1, `двойной клик: запросов ${posts}`);
  check((await log()).leads.length === 1, 'двойной клик: одна заявка');
  await ctx.close();
}
{
  await stand('/__stand/reset');
  await stand('/__stand/config', { leadDelayMs: 300 });
  await stand('/__stand/fail', { mode: '500', times: 1 });
  const pages = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext(MOBILE);
    const page = await open(ctx, null);
    await gotoForm(page);
    await fill(page, `Паралельна задача ${i + 1}`);
    pages.push({ ctx, page });
  }
  await Promise.all(pages.map(({ page }) => page.click('button[type="submit"]')));
  const states = await Promise.all(pages.map(({ page }) => settled(page)));
  const refs = await Promise.all(pages.map(({ page }) => leadRefOnPage(page)));
  const l = await log();
  const shown = refs.filter((r, i) => states[i] === 'success');
  check(
    states.filter((s) => s === 'success').length === 4 && states.filter((s) => s === 'server').length === 1,
    `5 параллельных: ${states.join(',')}`,
  );
  check(
    shown.every((r) => l.leads.some((x) => x.leadRef === r)) && l.leads.length === shown.length,
    'каждый показанный успех — заявка на стенде, лишних нет',
  );
  check(new Set(l.leads.map((x) => x.submissionKey)).size === l.leads.length, 'разные ключи у разных отправок');
  const failed = pages[states.indexOf('server')];
  if (failed) {
    await failed.page.click('[data-testid="form-status"] button');
    check((await settled(failed.page)) === 'success', 'честная ошибка → повтор → успех');
  }
  check((await log()).leads.length === 5, '5 заявок');
  for (const { ctx } of pages) await ctx.close();
}

// ── 6. 6-я новая отправка → 429 ──────────────────────────────────────
{
  await stand('/__stand/reset');
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  for (let i = 1; i <= 5; i++) {
    await fill(page, `Звернення ${i}`);
    await page.click('button[type="submit"]');
    check((await settled(page)) === 'success', `отправка ${i}`);
  }
  await fill(page, 'Звернення 6');
  await page.click('button[type="submit"]');
  check((await settled(page)) === 'rate_limited', '6-я → 429');
  const text = (await statusText(page)) ?? '';
  check(
    /не відправлено/i.test(text) && /5 звернень за 10 хв/.test(text) && /через 10 хв/.test(text),
    `текст 429 (лимит и ожидание): ${text}`,
  );
  check(
    await page.isVisible('[data-testid="form-status"] [data-testid="alt-contact"] a'),
    '429: альтернативный контакт',
  );
  check((await page.inputValue('#lf-task')) === 'Звернення 6', '429: данные на месте');
  check((await log()).leads.length === 5, '429: шестой заявки нет');
  await ctx.close();
  await stand('/__stand/reset-limit');
}

// ── 7. Без JS; 410/404 ───────────────────────────────────────────────
{
  const ctx = await browser.newContext({ ...MOBILE, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/materials/pershyi-material`, { waitUntil: 'load' });
  check(
    ((await page.textContent('[data-testid="material-body"]')) ?? '').includes('основний текст першого матеріалу'),
    'без JS: основной текст материала',
  );
  await page.goto(`${BASE}/contact`, { waitUntil: 'load' });
  check(await page.isVisible('[data-testid="noscript"]'), 'без JS: сообщение вместо формы');
  check(!(await page.isVisible('form.lead-form')), 'без JS: форма скрыта');
  check(await page.isVisible('[data-testid="alt-contact"] a'), 'без JS: альтернативный контакт');
  await ctx.close();
  const gone = await fetch(`${BASE}/materials/znyatyi-material`);
  check(gone.status === 410 && (gone.headers.get('x-robots-tag') ?? '').includes('noindex'), `снятый → ${gone.status}`);
  const nf = await fetch(`${BASE}/materials/takoho-nemae`);
  check(nf.status === 404, `неизвестный → ${nf.status}`);
}

// ── 8. Раунд исправлений аудита P-F ─────────────────────────────────
// S2-1: до гидратации форма инертна — ни ввода, который потом сотрётся, ни нативного POST.
{
  await stand('/__stand/reset');
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  const held = [];
  await page.route('**/_next/static/chunks/**', (route) => held.push(route));
  const nativePosts = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().startsWith(BASE) && nativePosts.push(r.url()));
  await page.goto(`${BASE}/contact`, { waitUntil: 'domcontentloaded' });
  check(
    await page.evaluate(() => document.querySelector('fieldset.lf-fields')?.disabled === true),
    'до гидратации поля выключены',
  );
  check(await page.isDisabled('button[type="submit"]'), 'до гидратации кнопка выключена');
  await page.focus('#lf-name').catch(() => undefined);
  await page.keyboard.type('Олена');
  await page.keyboard.press('Enter');
  await sleep(500);
  check((await page.inputValue('#lf-name')) === '', 'до гидратации ввод не принимается (и потому не теряется)');
  check(nativePosts.length === 0, `до гидратации ушёл нативный POST: ${nativePosts.join(',')}`);
  await page.unroute('**/_next/static/chunks/**');
  for (const r of held) await r.continue().catch(() => undefined);
  await page.waitForSelector('form[data-ready="1"]');
  check(await page.isEnabled('#lf-name'), 'после гидратации поля включены');
  await fill(page, 'Після гідратації');
  check((await page.inputValue('#lf-task')) === 'Після гідратації', 'после гидратации ввод работает');
  check(page.url() === `${BASE}/contact`, `страница перезагрузилась: ${page.url()}`);
  await ctx.close();
}
// S3-1 + S3-5: клиентский таймаут 20 с → «статус невідомий»; повтор тем же ключом → та же заявка.
{
  await stand('/__stand/reset');
  await stand('/__stand/config', { leadDelayMs: 23000 });
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  await fill(page, 'Таймаут клієнта');
  const keys = [];
  page.on(
    'request',
    (r) =>
      r.method() === 'POST' && r.url().endsWith('/leads') && keys.push(JSON.parse(r.postData() ?? '{}').submissionKey),
  );
  const t0 = Date.now();
  await page.click('button[type="submit"]');
  const st = await settled(page);
  const took = Date.now() - t0;
  check(st === 'network' && took >= 19000 && took < 23000, `таймаут: статус ${st} через ${took} мс`);
  check(/невідом/i.test((await statusText(page)) ?? ''), 'таймаут: «статус невідомий»');
  check((await page.inputValue('#lf-task')) === 'Таймаут клієнта', 'таймаут: данные на месте');
  await stand('/__stand/config', { leadDelayMs: 0 });
  await page.click('[data-testid="form-status"] button');
  check((await settled(page)) === 'success', 'таймаут: повтор → успех');
  await sleep(3500); // первый запрос дописывается на стенде
  const l = await log();
  check(keys.length === 2 && keys[0] === keys[1], `таймаут: повтор тем же submissionKey (${keys.join(' / ')})`);
  check(
    l.leads.length === 1 && (await leadRefOnPage(page)) === l.leads[0]?.leadRef,
    'таймаут: одна заявка, показан её номер',
  );
  await ctx.close();
}
// S3-1: 409 PUB_IDEMPOTENCY_REUSED → «не відправлено», следующая попытка — новый ключ.
{
  await stand('/__stand/reset');
  await stand('/__stand/fail', { mode: 'reused', times: 1 });
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  await fill(page, 'Конфлікт ключа');
  const keys = [];
  page.on(
    'request',
    (r) =>
      r.method() === 'POST' && r.url().endsWith('/leads') && keys.push(JSON.parse(r.postData() ?? '{}').submissionKey),
  );
  await page.click('button[type="submit"]');
  check(
    (await settled(page)) === 'server' && /не відправлено/i.test((await statusText(page)) ?? ''),
    '409: «не відправлено»',
  );
  await page.click('[data-testid="form-status"] button');
  check((await settled(page)) === 'success', '409: следующая попытка → успех');
  check(keys.length === 2 && keys[0] !== keys[1], `409: новая попытка — новый ключ (${keys.join(' / ')})`);
  check((await log()).leads.length === 1, '409: одна заявка');
  await ctx.close();
}
// S3-6 + S3-8: поля заблокированы во время отправки; номер остаётся видимым при новом вводе.
{
  await stand('/__stand/reset');
  await stand('/__stand/config', { leadDelayMs: 800 });
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await gotoForm(page);
  await fill(page, 'Блокування полів');
  await page.click('button[type="submit"]');
  check(await page.isDisabled('#lf-task'), 'во время отправки поле задачи заблокировано');
  check((await settled(page)) === 'success', 'отправка с задержкой: успех');
  const ref = await leadRefOnPage(page);
  await page.fill('#lf-name', 'Нове звернення');
  check(Boolean(ref) && (await leadRefOnPage(page)) === ref, 'номер обращения остаётся на экране при новом вводе');
  await ctx.close();
}
// S3-3: метки и путь, похожие на контакт, не уходят с клиента.
{
  await stand('/__stand/reset');
  const ctx = await browser.newContext(MOBILE);
  const page = await open(ctx, null);
  await page.goto(`${BASE}/?utm_source=ivan.petrenko%40gmail.com&utm_campaign=%2B380501234567&utm_medium=tg`, {
    waitUntil: 'load',
  });
  const ev = await waitFor(async () => (await log()).events.find((e) => e.body.path === '/'), 'content_view /');
  check(
    JSON.stringify(ev?.body.utm) === JSON.stringify({ medium: 'tg' }),
    `ПД в метках события: ${JSON.stringify(ev?.body.utm)}`,
  );
  await page.goto(`${BASE}/olena%40example.com`, { waitUntil: 'load' });
  const ev404 = await waitFor(
    async () => (await log()).events.find((e) => e.body.path === '/404'),
    'content_view /404',
  );
  check(
    Boolean(ev404) && !(await log()).events.some((e) => /olena|%40|@/.test(e.body.path ?? '')),
    'ПД в path события',
  );
  const stored = await page.evaluate(() => sessionStorage.getItem('pub_sref') ?? '');
  check(!/ivan|380501234567|olena/.test(stored), `ПД в sessionStorage: ${stored}`);
  await ctx.close();
}
// S3-2: CSP на ответах (нарушения CSP — ошибки консоли; их ноль в сценарии 1).
{
  const r = await fetch(`${BASE}/`);
  const csp = r.headers.get('content-security-policy') ?? '';
  check(/connect-src 'self' \S+/.test(csp) && csp.includes("frame-ancestors 'none'"), `CSP: ${csp}`);
}
// S3-1: /api/revalidate без верного секрета — 401; verify.txt — токен первой строкой.
{
  for (const auth of [undefined, 'Bearer wrong-secret-value-000', `bearer ${SECRET}`]) {
    const r = await fetch(`${BASE}/api/revalidate`, { method: 'POST', headers: auth ? { authorization: auth } : {} });
    check(r.status === 401, `/api/revalidate с «${auth}» → ${r.status}`);
  }
  const tok = process.env.PUBLISHER_OWNERSHIP_TOKEN;
  const v = await fetch(`${BASE}/.well-known/v4c-verify.txt`);
  if (tok) check(v.status === 200 && (await v.text()) === `${tok}\n`, `verify.txt → ${v.status}`);
  else check(v.status === 404, `verify.txt без токена → ${v.status}`);
}
const revalidateAsBackend = () =>
  fetch(`${BASE}/api/revalidate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: '{}', // как задание sites-backend `site-revalidate` (Z-2b)
  });
// Z-2b: снятие + ревалидация от бэкенда → СРАЗУ 410 (не 404 и не текст).
{
  await stand('/__stand/reset');
  await revalidateAsBackend();
  await sleep(1100);
  check((await fetch(`${BASE}/materials/druhyi-material`)).status === 200, 'до снятия → 200');
  check((await fetch(`${BASE}/materials/druhyi-material`)).status === 200, 'до снятия (ISR) → 200');
  await stand('/__stand/config', { withdrawnExtra: ['druhyi-material'] });
  const rv = await revalidateAsBackend();
  check(rv.status === 200, `ревалидация от бэкенда → ${rv.status}`);
  const wl = await fetch(`${BASE}/api/withdrawn`).then((x) => x.json());
  check(
    wl?.data?.some((x) => x.slug === 'druhyi-material'),
    `/api/withdrawn сразу после ревалидации видит снятие: ${JSON.stringify(wl)}`,
  );
  await sleep(1100); // память middleware — ≤ 1 с (TTL_MS)
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(`${BASE}/materials/druhyi-material`)).status);
  check(
    statuses.every((st) => st === 410),
    `после снятия и ревалидации — 410 сразу: ${statuses.join(',')}`,
  );
  await stand('/__stand/reset');
  await revalidateAsBackend();
  await sleep(1100);
  check((await fetch(`${BASE}/materials/druhyi-material`)).status === 200, 'снова опубликован + ревалидация → 200');
}
// S2-2: снятый материал при сбое списка — fail-closed (503 без текста), при ответе материала 410.
{
  await stand('/__stand/reset');
  await stand('/__stand/config', {
    withdrawnExtra: ['druhyi-material'],
    contentsListStatus: 500,
    contentsSlugStatus: 503,
  });
  await revalidateAsBackend(); // снятие сопровождается ревалидацией (Z-2b) — data cache сброшен, список падает по-настоящему
  const r = await waitFor(
    async () => {
      const x = await fetch(`${BASE}/materials/druhyi-material`);
      return x.status === 503 ? { status: x.status, body: await x.text() } : null;
    },
    'снятый материал при неизвестном статусе → 503',
    10000,
  );
  check(
    r?.status === 503 && !r.body.includes('другого матеріалу') && /тимчасово недоступний/.test(r.body),
    `сбой списка и материала → ${r?.status} без текста`,
  );
  await stand('/__stand/config', { contentsSlugStatus: null });
  const g = await fetch(`${BASE}/materials/druhyi-material`);
  check(g.status === 410, `сбой списка, материал отвечает 410 → ${g.status}`);
  await stand('/__stand/reset');
  await revalidateAsBackend();
  await sleep(5500); // повтор списка после сбоя — через 5 с
  const back = await waitFor(
    async () => (await fetch(`${BASE}/materials/druhyi-material`)).status === 200,
    'материал снова опубликован → 200',
    20000,
  );
  check(Boolean(back), 'список восстановлен → 200');
}

await browser.close();
await stand('/__stand/reset');
if (fails.length) {
  console.error(['FAIL e2e:', ...fails].join('\n'));
  process.exit(1);
}
console.log(
  `ok   e2e: ${checks} проверок — внешняя метка → внутренняя страница → форма (клавиатура, sessionRef, метки, contentSlug, text/plain, 0 ошибок консоли); без хранения → без источника; ошибки полей с фокусом; 500/503/обрыв — нет ложного успеха, повтор; обрыв после записи → тот же номер; двойной клик → 1 заявка; 5 параллельных (1 отказ) — без ложных успехов; 6-я → 429; без JS; 410/404; до гидратации инертна; таймаут → «статус невідомий» и тот же ключ; 409 → новый ключ; поля заблокированы при отправке, номер виден; без ПД в метках/пути; CSP; revalidate 401; снятие + ревалидация бэкенда → сразу 410; снятый при сбое API → 503/410`,
);
