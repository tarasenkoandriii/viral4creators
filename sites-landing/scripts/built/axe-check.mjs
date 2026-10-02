#!/usr/bin/env node
/**
 * axe-core на собранном и запущенном сайте (ТЗ §12, §14: «axe — 0
 * нарушений уровня A/AA») + сквозной критерий 5 §14: нет горизонтальной
 * прокрутки на 360 px.
 *
 * Каждая страница × локаль (+ юр-черновик, страница результата формы,
 * 404) — в светлой и тёмной теме: контраст у них разный. Теги правил —
 * WCAG 2.0/2.1/2.2 A и AA. Плюс FAQ в раскрытом виде и форма пилота с
 * показанными ошибками полей — их состояния есть только после клика.
 *
 * Запуск: `BASE_URL=http://localhost:3010 npm run axe` при запущенном
 * `next start`. Браузер — playwright-core (версия = браузеры в
 * PLAYWRIGHT_BROWSERS_PATH; в CI — `npx playwright install chromium`).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = (process.env.BASE_URL ?? 'http://localhost:3010').replace(/\/$/, '');
const LOCALES = ['uk', 'en', 'ru'];
const PLATFORMS = ['html', 'gtm', 'wordpress', 'woocommerce', 'react', 'shopify', 'horoshop', 'tilda'];
const PATHS = [
  '',
  '/assistant',
  '/assistant/how-it-works',
  '/assistant/widget',
  '/assistant/try',
  '/assistant/integrations',
  ...PLATFORMS.map((p) => `/assistant/integrations/${p}`),
  '/assistant/bot',
  '/assistant/security',
  '/assistant/pricing',
  '/assistant/faq',
  '/assistant/pilot',
];
/** Документация — uk/en (§11). */
const DOCS = ['/docs/assistant', '/docs/assistant/js-api', '/docs/assistant/goals', '/docs/assistant/csp'];
const urls = [
  ...LOCALES.flatMap((l) => PATHS.map((p) => `/${l}${p}`)),
  ...['uk', 'en'].flatMap((l) => DOCS.map((p) => `/${l}${p}`)),
  '/legal/privacy',
  '/uk/assistant/pilot/status/unavailable',
  '/uk/assistant/bot/status/unavailable',
  '/no-such-page-404',
];
const STAND = (process.env.STAND_URL ?? 'http://localhost:3011').replace(/\/$/, '');
const stand = (p, body) => fetch(STAND + p, { method: 'POST', body: JSON.stringify(body ?? {}) }).then((r) => r.json()).catch(() => null);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const browser = await chromium.launch();
const violations = [];
let runs = 0;

async function audit(page, label) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, TAGS);
  runs++;
  for (const v of result) violations.push(`${label}: ${v.id} (${v.impact}) — ${v.nodes.join(' | ')}`);
}

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const u of urls) {
    await page.goto(BASE + u, { waitUntil: 'load' });
    await audit(page, `${u} [${scheme}]`);
  }
  // Состояния после взаимодействия: раскрытый FAQ и ошибки формы.
  await page.goto(`${BASE}/uk/assistant/faq`, { waitUntil: 'networkidle' });
  const buttons = await page.$$('.faq-q button');
  if (buttons[1]) await buttons[1].click();
  await audit(page, `/uk/assistant/faq (раскрыт 2-й) [${scheme}]`);
  await page.goto(`${BASE}/uk/assistant/pilot`, { waitUntil: 'networkidle' });
  await page.fill('#pilot-name', 'Тест');
  await page.fill('#pilot-contact', 'не-контакт');
  await page.fill('#pilot-site', 'shop.example');
  await page.selectOption('#pilot-segment', 'saas');
  await page.check('#pilot-consent');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.field-error', { timeout: 5000 });
  await audit(page, `/uk/assistant/pilot (ошибки полей) [${scheme}]`);
  if (scheme === 'light') await formKeepsDataUnlessSent(page);
  // Л3: конфигуратор в «трудных» состояниях — поправка контраста, ошибка
  // логотипа, показанный код, телефон с тёмным макетом, своя кнопка.
  await page.goto(`${BASE}/uk/assistant/widget`, { waitUntil: 'networkidle' });
  await page.fill('label:has-text("Свій колір") input', '#FFEE00');
  await page.setInputFiles('input[type="file"]', { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await page.click('button:has-text("Отримати код")');
  await page.check('input[name="cfg-device"][value="phone"]');
  await page.check('input[name="cfg-surface"][value="dark"]');
  await page.waitForSelector('.cfg-adjusted');
  await audit(page, `/uk/assistant/widget (поправка контраста, ошибка логотипа, код, телефон/тёмный) [${scheme}]`);
  await page.check('input[name="cfg-launcher"][value="none"]');
  await page.check('input[name="cfg-device"][value="desktop"]');
  await audit(page, `/uk/assistant/widget (своя кнопка) [${scheme}]`);
  // Л4: песочница — предпроверка с ошибкой, ожидание, результат с ответом, отказ (стенд-мок).
  await page.goto(`${BASE}/uk/assistant/try`, { waitUntil: 'networkidle' });
  await page.fill('#sb-url', 'http://shop.example.com');
  await page.click('form.sb-form button[type="submit"]');
  await page.waitForSelector('#sb-url-error');
  await audit(page, `/uk/assistant/try (ошибка адреса) [${scheme}]`);
  if (await stand('/__stand/reset')) {
    await page.fill('#sb-url', 'shop.example.com');
    await page.click('form.sb-form button[type="submit"]');
    await page.waitForSelector('[data-testid="sb-waiting"]');
    await audit(page, `/uk/assistant/try (ожидание) [${scheme}]`);
    await page.waitForSelector('[data-testid="sb-result"]', { timeout: 30000 });
    await page.click('.sb-suggested button');
    await page.waitForSelector('.sb-msg-assistant .sb-sources');
    await audit(page, `/uk/assistant/try (результат и ответ) [${scheme}]`);
    await page.click('.sb-next button');
    await stand('/__stand/config', { sandboxError: { status: 503, code: 'SANDBOX_BUDGET' } });
    await page.fill('#sb-url', 'shop.example.com');
    await page.click('form.sb-form button[type="submit"]');
    await page.waitForSelector('[data-testid="sb-problem"]');
    await audit(page, `/uk/assistant/try (недоступно — заявка) [${scheme}]`);
    await stand('/__stand/reset');
  } else {
    violations.push('стенд недоступен — состояния песочницы не проверены');
  }
  // Л2: панель «покрутите виджет» после взаимодействия (если виджет есть в сборке).
  await page.goto(`${BASE}/uk/assistant`, { waitUntil: 'networkidle' });
  if (await page.$('[data-testid="playground"]')) {
    await page.check('input[name="pg-corner"][value="bottom-left"]');
    await audit(page, `/uk/assistant (панель «покрутите виджет») [${scheme}]`);
  }
  await ctx.close();
}

/**
 * Обещание формы (§14 Л1, `PilotForm.tsx`): при любом исходе, кроме
 * `sent`, поля НЕ очищаются и текст говорит, что заявка не отправлена;
 * при `sent` — форма очищается. Ответ `/api/pilot` подменяется в браузере
 * — ни сети до Telegram, ни заявок в настоящий канал.
 */
async function formKeepsDataUnlessSent(page) {
  const fill = async () => {
    await page.goto(`${BASE}/uk/assistant/pilot`, { waitUntil: 'networkidle' });
    await page.fill('#pilot-name', 'Тест');
    await page.fill('#pilot-contact', 'test@shop.example');
    await page.fill('#pilot-site', 'shop.example');
    await page.selectOption('#pilot-segment', 'saas');
    await page.check('#pilot-consent');
  };
  for (const [code, status] of [['unavailable', 503], ['error', 502], ['limited', 429], ['sent', 200]]) {
    await page.route('**/api/pilot', (route) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: code === 'sent', code }) }),
    );
    await fill();
    await page.click('button[type="submit"]');
    await page.waitForSelector(`.form-status-${code}`, { timeout: 5000 });
    const kept = await page.inputValue('#pilot-contact');
    if (code === 'sent' && kept !== '') violations.push(`форма пилота: после «sent» поля не очищены`);
    if (code !== 'sent' && kept !== 'test@shop.example') violations.push(`форма пилота: после «${code}» данные пропали из формы`);
    await page.unroute('**/api/pilot');
  }
}

// 360 px: нет горизонтальной прокрутки на самой длинной локали (и на всех).
const narrow = await browser.newContext({ viewport: { width: 360, height: 740 } });
const np = await narrow.newPage();
const overflow = [];
for (const u of urls) {
  await np.goto(BASE + u, { waitUntil: 'load' });
  const [sw, cw] = await np.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  if (sw > cw) overflow.push(`${u}: ${sw} > ${cw}`);
  // Переключатель языка виден (урок Ф-2).
  const visible = await np.isVisible('.locale-switcher');
  if (!visible) overflow.push(`${u}: переключатель языка не виден на 360 px`);
}
await browser.close();

if (violations.length || overflow.length) {
  console.error(['FAIL axe/360 px:', ...violations, ...overflow].join('\n'));
  process.exit(1);
}
console.log(`ok   axe (WCAG 2.2 A/AA): ${runs} прогонов (${urls.length} адресов × 2 темы + состояния FAQ, формы, конфигуратора, песочницы, панели виджета) — 0 нарушений; форма пилота хранит данные при любом исходе, кроме «sent»; 360 px: без горизонтальной прокрутки, переключатель языка виден на ${urls.length} адресах`);
