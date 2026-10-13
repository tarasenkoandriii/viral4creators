#!/usr/bin/env node
/**
 * axe-core на собранном и запущенном сайте (проектный документ §13.6,
 * AT-CORE-02): WCAG 2.0/2.1/2.2 A и AA — 0 нарушений (в т. ч. контраст
 * ≥ 4,5:1) на всех страницах в светлой и тёмной теме и в состояниях,
 * которые есть только после действия: раскрытый FAQ, ошибки полей формы,
 * 429, ошибка сервера, форма закрыта, успех. Плюс 320 и 360 CSS px: нет
 * горизонтальной прокрутки, навигация видна.
 *
 * Запуск: `BASE_URL=http://localhost:3020 STAND_URL=http://localhost:3021
 * npm run axe` при запущенных `next start` и стенде. Браузер —
 * playwright-core (Chromium из PLAYWRIGHT_BROWSERS_PATH; в CI —
 * `npx playwright-core install chromium`).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = (process.env.BASE_URL ?? 'http://localhost:3020').replace(/\/$/, '');
const STAND = (process.env.STAND_URL ?? 'http://localhost:3021').replace(/\/$/, '');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const URLS = [
  '/',
  '/materials',
  '/materials/pershyi-material',
  '/materials/druhyi-material',
  '/contact',
  '/privacy',
  '/no-such-page-404',
  '/materials/znyatyi-material',
];
const stand = (p, body) => fetch(STAND + p, { method: 'POST', body: JSON.stringify(body ?? {}) }).then((r) => r.json());

const browser = await chromium.launch();
const violations = [];
let runs = 0;

async function audit(page, label) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  }, TAGS);
  runs++;
  for (const v of result) violations.push(`${label}: ${v.id} (${v.impact}) — ${v.nodes.join(' | ')}`);
}

async function fillValid(page) {
  await page.fill('#lf-name', 'Олена');
  await page.check('#lf-method-email');
  await page.fill('#lf-contact', 'olena@example.com');
  await page.fill('#lf-business', 'shop.example');
  await page.fill('#lf-task', 'Потрібні матеріали для блогу');
}

async function formState(page, label, scheme, setup) {
  await stand('/__stand/reset');
  await page.goto(`${BASE}/contact`, { waitUntil: 'load' });
  await page.waitForSelector('form[data-ready="1"]');
  await setup();
  await audit(page, `/contact (${label}) [${scheme}]`);
}

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const u of URLS) {
    await page.goto(BASE + u, { waitUntil: 'load' });
    await audit(page, `${u} [${scheme}]`);
  }
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.click('.faq summary >> nth=1');
  await audit(page, `/ (FAQ раскрыт) [${scheme}]`);

  await formState(page, 'ошибки полей', scheme, async () => {
    await page.fill('#lf-contact', 'не-контакт');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.field-error');
  });
  await formState(page, '429', scheme, async () => {
    await stand('/__stand/config', { formLimit: { count: 0, windowSec: 600 } });
    await fillValid(page);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-status="rate_limited"]');
  });
  await formState(page, 'ошибка сервера', scheme, async () => {
    await stand('/__stand/fail', { mode: '500', times: 1 });
    await fillValid(page);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-status="server"]');
  });
  await formState(page, 'форма закрыта', scheme, async () => {
    await stand('/__stand/fail', { mode: 'closed', times: 1 });
    await fillValid(page);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-status="closed"]');
  });
  await formState(page, 'успех', scheme, async () => {
    await fillValid(page);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-status="success"]');
  });
  await ctx.close();
}
await stand('/__stand/reset');

// 320 и 360 px: без горизонтальной прокрутки, навигация видна (ТЗ §20).
const overflow = [];
for (const width of [320, 360]) {
  const narrow = await browser.newContext({ viewport: { width, height: 740 } });
  const np = await narrow.newPage();
  const check = async (label) => {
    const [sw, cw] = await np.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    if (sw > cw) overflow.push(`${label} @${width}: ${sw} > ${cw}`);
  };
  for (const u of URLS) {
    await np.goto(BASE + u, { waitUntil: 'load' });
    await check(u);
    if (!u.includes('znyatyi') && !(await np.isVisible('nav'))) overflow.push(`${u} @${width}: навигация не видна`);
  }
  await np.goto(`${BASE}/contact`, { waitUntil: 'load' });
  await np.waitForSelector('form[data-ready="1"]');
  await np.click('button[type="submit"]');
  await np.waitForSelector('.field-error');
  await check('/contact (ошибки полей)');
  await narrow.close();
}
await browser.close();

if (violations.length || overflow.length) {
  console.error(['FAIL axe/320–360 px:', ...violations, ...overflow].join('\n'));
  process.exit(1);
}
console.log(
  `ok   axe (WCAG 2.2 A/AA, контраст ≥ 4,5:1): ${runs} прогонов — ${URLS.length} адресов × 2 темы + FAQ и 5 состояний формы (ошибки полей, 429, 5xx, закрыта, успех) — 0 нарушений; 320 и 360 px: без горизонтальной прокрутки, навигация видна`,
);
