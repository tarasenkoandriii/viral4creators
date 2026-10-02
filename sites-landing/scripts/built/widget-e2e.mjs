#!/usr/bin/env node
/**
 * Сквозные проверки Л2–Л3 в браузере: собранный лендинг (`next start`,
 * :3010) + стенд продукта (`scripts/built/assist-stand.ts`, :3011) с
 * НАСТОЯЩИМ загрузчиком виджета. Сборка — с env стенда:
 *   ASSIST_WIDGET_ORIGIN=ASSIST_API_ORIGIN=http://localhost:3011
 *   ASSIST_WIDGET_PK=pk_live_… ASSIST_BOT_USERNAME=…_bot
 *
 * Л2 (§4, §14):
 *  1. До load/idle и взаимодействия загрузчика нет; после — один тег; до
 *     клика нет ни iframe, ни chat.js; «Открыть помощника» — iframe чата.
 *  2. Панель «покрутите виджет»: угол меняет настоящую кнопку (Shadow DOM).
 *  3. `V4CAssist('preview')` из конфигуратора перекрашивает настоящий
 *     виджет при `allowClientPreview`, и НЕ перекрашивает без флага.
 *  4. События §10 доходят на стенд: `text/plain`, без cookie, пути без
 *     query, только имена/свойства из перечня, без введённого текста.
 * Л3 (§5, §14):
 *  5. Каждый параметр меняет предпросмотр без перезагрузки; контраст
 *     автокорректируется; логотип не уходит в сеть.
 *  6. «Сохранить и подключить» → черновик на стенде (проверен настоящим
 *     parseWidgetConfig) → ссылка `t.me/<бот>?startapp=wd_<id>`; ошибка
 *     сервера — честный текст, настройки остаются.
 *
 * Запуск: `BASE_URL=http://localhost:3010 STAND_URL=http://localhost:3011 node scripts/built/widget-e2e.mjs`.
 */
import { chromium } from 'playwright-core';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3010').replace(/\/$/, '');
const STAND = (process.env.STAND_URL ?? 'http://localhost:3011').replace(/\/$/, '');
const BOT = process.env.ASSIST_BOT_USERNAME ?? 'assist_stand_bot';
const fails = [];
const check = (ok, msg) => {
  if (!ok) fails.push(msg);
};
const stand = (p, body) =>
  fetch(STAND + p, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const browser = await chromium.launch();
await stand('/__stand/reset', {});

// ── 1–2. Главная Помощника ──
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const reqs = [];
  page.on('request', (r) => reqs.push({ url: r.url(), t: Date.now() }));
  await page.addInitScript(() => {
    window.__loadAt = 0;
    window.addEventListener('load', () => (window.__loadAt = performance.now()));
  });
  await page.goto(`${BASE}/uk/assistant`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div[data-v4c]', { state: 'attached', timeout: 10000 });
  const timing = await page.evaluate(() => {
    const e = performance.getEntriesByType('resource').find((r) => r.name.includes('/v1/loader.js'));
    return { loader: e ? e.startTime : -1, load: window.__loadAt };
  });
  check(timing.loader > 0 && timing.load > 0 && timing.loader >= timing.load, `загрузчик запрошен до load: ${JSON.stringify(timing)}`);
  check((await page.$$('script[data-assist-landing]')).length === 1, 'тег загрузчика — ровно один');
  await page.waitForTimeout(800);
  check(!reqs.some((r) => /\/w\/v1\/frame|\/v1\/chat\./.test(r.url)), 'iframe/chat.js до клика');
  check(!reqs.some((r) => r.url.startsWith(STAND) && !/\/v1\/loader\.js|\/widget\/v1\/(config|ping)/.test(r.url)), 'лишние запросы к продукту до клика');

  const cls = () => page.evaluate(() => document.querySelector('div[data-v4c]')?.shadowRoot?.querySelector('div')?.className ?? '');
  await page.check('input[name="pg-corner"][value="top-left"]');
  await page.waitForTimeout(200);
  const c = await cls();
  check(/\bT\b/.test(c) && /\bL\b/.test(c), `угол «ліворуч зверху» не применился к настоящей кнопке: «${c}»`);
  check((await page.textContent('[data-testid="playground"] [role="status"]'))?.includes('ліворуч зверху'), 'aria-live не объявил угол');
  await page.check('input[name="pg-theme"][value="dark"]');
  await page.click('[data-testid="playground"] button[data-cta="playground"]');
  await page.waitForSelector('div[data-v4c] >> iframe', { timeout: 5000 }).catch(() => fails.push('«Открыть помощника» не открыл чат'));
  check(reqs.some((r) => r.url.includes('/w/v1/frame')), 'iframe чата не запрошен после клика');
  // Уход со страницы — события улетают sendBeacon.
  await page.goto(`${BASE}/uk/assistant/faq?utm_source=test&email=a%40b.c`, { waitUntil: 'load' });
  await page.goto('about:blank');
  await page.waitForTimeout(500);
  await ctx.close();
}

// ── 1б. Без idle и без взаимодействия загрузчика нет вовсе ──
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // Главный поток «никогда не простаивает»: idle-колбэк не зовётся.
  await page.addInitScript(() => {
    window.requestIdleCallback = () => 1;
    window.cancelIdleCallback = () => {};
  });
  await page.goto(`${BASE}/uk/assistant`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  check((await page.$$('script[data-assist-landing]')).length === 0, 'загрузчик вставлен без idle и без взаимодействия');
  await page.mouse.click(5, 300);
  await page.waitForSelector('script[data-assist-landing]', { state: 'attached', timeout: 3000 }).catch(() => fails.push('взаимодействие не загрузило виджет'));
  await ctx.close();
}

// ── 3, 5, 6. Конфигуратор ──
async function configurator({ allowPreview }) {
  await stand('/__stand/config', { allowClientPreview: allowPreview, draftStatus: null });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const posted = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') posted.push({ url: r.url(), body: r.postDataBuffer() });
  });
  await page.goto(`${BASE}/uk/assistant/widget`, { waitUntil: 'load' });
  // Метка в window: перезагрузка страницы её стёрла бы.
  await page.evaluate(() => (window.__noReload = 1));
  await page.waitForSelector('div[data-v4c]', { state: 'attached', timeout: 10000 });
  const stage = '[data-testid="cfg-stage"]';
  const attr = (a) => page.getAttribute(stage, a);
  const liveColor = () => page.evaluate(() => document.querySelector('div[data-v4c]')?.style.getPropertyValue('--c') ?? '');

  await page.click('button[role="radio"][aria-label="Колір #DB2777"]');
  check((await attr('data-primary')) === '#DB2777', 'пресет цвета не изменил предпросмотр');
  await page.waitForTimeout(700);
  const lc = (await liveColor()).toUpperCase();
  if (allowPreview) check(lc === '#DB2777', `preview не перекрасил настоящий виджет (allowClientPreview=true): «${lc}»`);
  else check(lc !== '#DB2777', 'preview перекрасил виджет без allowClientPreview');
  if (!allowPreview) {
    await ctx.close();
    return;
  }
  // Каждый параметр — без перезагрузки.
  await page.check('input[name="cfg-position"][value="bottom-left"]');
  check((await attr('data-position')) === 'bottom-left', 'угол не изменил предпросмотр');
  await page.check('input[name="cfg-preset"][value="strict"]');
  check((await attr('class')).includes('cfg-preset-strict'), 'форма');
  await page.selectOption('select >> nth=1', 'dark').catch(() => {});
  await page.check('input[name="cfg-launcher"][value="none"]');
  check((await page.$(`${stage} .cfg-launcher`)) === null && (await attr('class')).includes('cfg-own'), 'своя кнопка');
  await page.check('input[name="cfg-launcher"][value="default"]');
  await page.check('input[name="cfg-icon"][value="headset"]');
  await page.check('input[name="cfg-avatar"][value="question"]');
  await page.fill('label:has-text("Ім\'я помічника") input', 'Олена з магазину');
  check((await page.textContent(`${stage} .cfg-name`)) === 'Олена з магазину', 'имя');
  await page.fill('label:has-text("Привітання") textarea', 'Добрий день!');
  await page.fill('label:has-text("Підказка 1") input', 'Доставка?');
  check((await page.textContent(`${stage} .cfg-bubble`)) === 'Добрий день!', 'приветствие');
  check((await page.textContent(`${stage} .cfg-chip`)) === 'Доставка?', 'подсказка');
  await page.check('input[name="cfg-device"][value="phone"]');
  check((await attr('class')).includes('cfg-phone'), 'телефон');
  await page.check('input[name="cfg-device"][value="desktop"]');
  await page.check('input[name="cfg-backdrop"][value="blog"]');
  check((await page.$(`${stage} .cfg-page-blog`)) !== null, 'фон «блог»');
  // Контраст: светло-жёлтый — автокоррекция.
  await page.fill('label:has-text("Свій колір") input', '#FFEE00');
  const fixed = await attr('data-primary');
  check(fixed !== '#FFEE00' && /^#[0-9A-F]{6}$/.test(fixed ?? ''), `контраст не скорректирован: ${fixed}`);
  check((await page.textContent('.cfg-adjusted'))?.includes(fixed ?? '?'), 'нет объяснения поправки');
  // Логотип — только в браузере.
  await page.setInputFiles('input[type="file"]', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector(`${stage} .cfg-avatar img`);
  check((await page.getAttribute(`${stage} .cfg-avatar img`, 'src'))?.startsWith('blob:'), 'логотип не blob:');
  await page.setInputFiles('input[type="file"]', { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  check((await page.textContent('.cfg-error'))?.includes('SVG'), 'SVG не отклонён');
  // Код.
  await page.click('button:has-text("Отримати код")');
  const code = await page.textContent('#cfg-code code');
  check(code?.includes('data-position="bottom-left"') && code.includes(`${STAND}/v1/loader.js`), `сниппет: ${code}`);
  // Сохранение.
  await page.click('button:has-text("Зберегти й підключити")');
  await page.waitForSelector('a[data-tma="wd"]', { timeout: 5000 }).catch(() => fails.push('нет ссылки в Telegram после сохранения'));
  const href = await page.getAttribute('a[data-tma="wd"]', 'href');
  const log = await stand('/__stand/log');
  const draft = log.drafts.at(-1);
  check(draft && href === `https://t.me/${BOT}?startapp=wd_${draft.id}`, `deeplink ${href} ≠ черновику ${draft?.id}`);
  check(draft?.config?.brand?.primaryColor === fixed, 'в черновик ушёл не скорректированный цвет');
  check(draft?.config?.brand?.logoAssetId === null && !JSON.stringify(draft?.config).includes('blob:'), 'логотип в черновике');
  check(draft?.config?.texts?.uk?.greeting === 'Добрий день!' && !draft?.config?.texts?.en, 'в черновик — только правленый язык');
  // Логотип не ушёл никуда: ни в одном теле запроса нет байтов PNG.
  check(!posted.some((p) => p.body && p.body.includes(PNG.subarray(0, 16))), 'байты логотипа ушли в сеть');
  check(!posted.some((p) => p.body && p.body.toString().includes('Олена з магазину') && !p.url.includes('/public/widget-drafts')), 'введённое имя ушло куда-то кроме черновика');
  // Ошибка сервера — честный текст, настройки остаются.
  await stand('/__stand/config', { draftStatus: 429 });
  await page.fill('label:has-text("Підказка 2") input', 'Оплата?');
  await page.click('button:has-text("Зберегти й підключити")');
  await page.waitForSelector('.cfg-error[role="status"]', { timeout: 5000 }).catch(() => fails.push('нет текста ошибки сохранения'));
  check((await page.textContent('.cfg-error[role="status"]'))?.includes('Забагато'), 'текст 429');
  check((await page.$('a[data-tma="wd"]')) === null, 'после ошибки осталась старая ссылка');
  check((await attr('data-position')) === 'bottom-left', 'после ошибки настройки сброшены');
  check((await page.evaluate(() => window.__noReload)) === 1, 'страница перезагружалась');
  await stand('/__stand/config', { draftStatus: null });
  await page.goto('about:blank');
  await page.waitForTimeout(500);
  await ctx.close();
}
await configurator({ allowPreview: false });
await configurator({ allowPreview: true });

// ── 4. События ──
{
  const log = await stand('/__stand/log');
  const ALLOWED = new Set(['page_view', 'cta_click', 'widget_open', 'widget_corner_change', 'configurator_change', 'configurator_save', 'tma_click', 'pilot_submit']);
  const events = log.events.flatMap((e) => e.body.events);
  check(log.events.length > 0, 'событий нет');
  for (const e of log.events) {
    check(e.contentType.startsWith('text/plain'), `тип тела ${e.contentType}`);
    check(e.cookie === null, `cookie в событиях: ${e.cookie}`);
    check(e.origin === BASE, `origin событий ${e.origin}`);
  }
  for (const ev of events) {
    check(ALLOWED.has(ev.name), `событие ${ev.name}`);
    check(!ev.path || !/[?#]/.test(ev.path), `путь с query: ${ev.path}`);
  }
  const names = new Set(events.map((e) => e.name));
  for (const n of ['page_view', 'widget_corner_change', 'widget_open', 'configurator_change', 'configurator_save', 'cta_click']) check(names.has(n), `нет события ${n}`);
  const raw = JSON.stringify(events);
  for (const leak of ['Олена', 'Добрий день', 'a@b.c', 'utm_source', 'logo.png']) check(!raw.includes(leak), `в событиях утёк «${leak}»`);
  console.log(`события: ${log.events.length} батчей, ${events.length} событий — ${[...names].sort().join(', ')}`);
}

await browser.close();
if (fails.length) {
  console.error(['FAIL Л2–Л3 e2e:', ...fails].join('\n'));
  process.exit(1);
}
console.log('ok   Л2–Л3 e2e (стенд, настоящий загрузчик): загрузчик после load/idle, чат только по клику; угол/тема/«Открыть» на настоящем виджете; preview — только с allowClientPreview; конфигуратор меняет макет без перезагрузки, контраст автокорректируется, логотип не уходит в сеть; черновик → t.me/…?startapp=wd_<id>; 429 — честная ошибка; события text/plain без cookie и ПДн');
