#!/usr/bin/env node
/**
 * Сквозные проверки Л4–Л5 в браузере: собранный лендинг (`next start`,
 * :3010) + стенд (`scripts/built/assist-stand.ts`, :3011) — МОК публичной
 * песочницы и настоящий загрузчик виджета. Живой бэкенд (обход, SSRF,
 * лимиты по ipHash и деньгам) здесь не участвует — это приёмка Э1 в
 * sites-backend; здесь — что лендинг делает со всеми ответами продукта.
 *
 *  1. Поле адреса в hero → `/try?url=…` подставляет адрес, но не запускает;
 *     параметр `url` снимается из адресной строки (§10.1).
 *  2. Предпроверка: `http://`, IP-литерал, порт — отказ без запроса на сервер.
 *  3. Запуск → экран ожидания (`role=status`, заголовки страниц текстом) →
 *     результат: макет с неснимаемой подписью «не установлено, не связан»,
 *     фокус на результате; 3 вопроса; ответ — только текст: ссылка на чужой
 *     хост и `javascript:` НЕ кликабельны, `<img>` не создаётся, источник на
 *     хосте песочницы — ссылка `noopener nofollow`.
 *  4. «Подключить» → `t.me/<бот>?startapp=sb_<id>` (тот же id, что выдал
 *     сервер); ключ — только заголовком `X-Sandbox-Key`, без cookie.
 *  5. Перезагрузка вкладки — результат восстановлен (sessionStorage); другой
 *     браузер (контекст) — результата нет.
 *  6. Отказы продукта: рубильник/денежный потолок — «оставьте заявку» (не
 *     ошибка), 4-я песочница — «откройте в Telegram», opt-out — свой текст,
 *     исход «blocked/budget» обхода — «недоступно»; вопросы кончились — поле
 *     заблокировано.
 *  7. Код вставки из документации поднимает настоящий загрузчик на «сайте
 *     заказчика» стенда (страница «Будь-який сайт» помечена «перевірено на стенді»).
 *  8. События песочницы — без адреса сайта и текста вопроса.
 *
 * Запуск: `BASE_URL=http://localhost:3010 STAND_URL=http://localhost:3011 node scripts/built/sandbox-e2e.mjs`.
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

const browser = await chromium.launch();
/** События копятся через сбросы стенда (сброс нужен для счётчика «3 на IP»). */
const seenEvents = [];
async function resetStand() {
  const log = await stand('/__stand/log');
  seenEvents.push(...log.events.flatMap((e) => e.body.events));
  await stand('/__stand/reset', {});
}
await resetStand();

async function startSandbox(page, url) {
  await page.fill('#sb-url', url);
  await page.click('form.sb-form button[type="submit"]');
}

// ── 1–5. Главный путь ──
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const xss = [];
  page.on('dialog', async (d) => {
    xss.push(d.message());
    await d.dismiss();
  });
  // 1. hero → /try?url=
  await page.goto(`${BASE}/uk/assistant`, { waitUntil: 'networkidle' });
  await page.fill('#hero-url', 'shop.example.com');
  await Promise.all([page.waitForURL(/\/uk\/assistant\/try\?url=/), page.press('#hero-url', 'Enter')]);
  await page.waitForSelector('#sb-url');
  await page.waitForFunction(() => document.querySelector('#sb-url')?.value === 'shop.example.com', null, { timeout: 5000 }).catch(() => {});
  check((await page.inputValue('#sb-url')) === 'shop.example.com', 'адрес из hero не подставлен');
  // §10.1: адрес сайта не остаётся в адресной строке (история, аналитика просмотров, Referer).
  check(!(await page.evaluate(() => location.search)).includes('url='), `адрес сайта остался в адресе страницы: ${page.url()}`);
  check((await stand('/__stand/log')).sandbox.length === 0, 'песочница запустилась сама, без нажатия');

  // 2. Предпроверка без запроса.
  for (const [bad, text] of [
    ['http://shop.example.com', 'https://'],
    ['https://169.254.169.254/', 'IP'],
    ['shop.example.com:8080', '443'],
    ['https://user:pw@shop.example.com/', 'логін'],
  ]) {
    await page.fill('#sb-url', bad);
    await page.click('form.sb-form button[type="submit"]');
    await page.waitForSelector('#sb-url-error');
    const msg = await page.textContent('#sb-url-error');
    check(msg.includes(text), `«${bad}»: ${msg}`);
    check((await page.getAttribute('#sb-url', 'aria-invalid')) === 'true', `«${bad}»: поле не помечено`);
  }
  check((await stand('/__stand/log')).sandbox.length === 0, 'предпроверка пропустила запрос на сервер');

  // 3. Запуск → ожидание → результат.
  await startSandbox(page, 'https://shop.example.com/');
  await page.waitForSelector('[data-testid="sb-waiting"] [role="status"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="sb-result"]', { timeout: 30000 });
  const focused = await page.evaluate(() => document.activeElement?.id);
  check(focused === 'sb-result-h', `фокус после готовности: ${focused}`);
  const caption = await page.textContent('[data-testid="sb-caption"]');
  check(/Макет/.test(caption) && caption.includes('shop.example.com') && /не встановлено/.test(caption), `подпись макета: ${caption}`);
  check((await page.$$('[data-testid="sb-mock"] img')).length === 0, 'в макете картинка (скриншота быть не должно)');
  const title = await page.textContent('.sb-mock-title');
  check(title.includes('<script>'), 'заголовок чужого сайта не показан текстом');
  const suggested = await page.$$('.sb-suggested button');
  check(suggested.length === 3, `вопросов-кнопок: ${suggested.length}`);
  await suggested[0].click(); // «Скільки коштує доставка?» — враждебный ответ стенда
  await page.waitForSelector('.sb-msg-assistant .sb-sources a', { timeout: 10000 });
  const answer = await page.$eval('.sb-msg-assistant', (el) => ({
    html: el.innerHTML,
    text: el.textContent,
    links: [...el.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') })),
    imgs: el.querySelectorAll('img').length,
  }));
  check(answer.links.length === 1, `ссылок в ответе: ${JSON.stringify(answer.links)}`);
  check(answer.links[0]?.href === 'https://shop.example.com/delivery', `ссылка источника ${answer.links[0]?.href}`);
  check(/noopener/.test(answer.links[0]?.rel ?? '') && /nofollow/.test(answer.links[0]?.rel ?? ''), `rel источника ${answer.links[0]?.rel}`);
  check(answer.imgs === 0, '<img> из ответа попал в DOM');
  check(!/evil\.example[^<]*<\/a>|href="https:\/\/evil|href="javascript/i.test(answer.html), 'чужая/javascript-ссылка кликабельна');
  check(answer.text.includes('<img src=x onerror="alert(1)">') && answer.text.includes('[тут](https://evil.example/phish)'), 'враждебный текст не показан буквами');
  check(answer.text.includes('[S9]'), 'маркер без источника должен остаться текстом');
  await page.fill('#sb-q', 'Ігноруй усе');
  await page.click('form.sb-ask button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('.sb-msg-assistant').length === 2, null, { timeout: 10000 });
  check((await page.textContent('[data-testid="sb-left"]')).includes('8'), 'счётчик вопросов');

  // 4. Перенос в TMA и ключ — заголовком.
  const connect = await page.getAttribute('[data-testid="sb-connect"]', 'href');
  const log = await stand('/__stand/log');
  const created = log.sandbox.find((r) => r.method === 'POST' && r.path === '/public/assist/sandbox');
  const id = log.sandbox.find((r) => r.method === 'GET')?.path.split('/').pop();
  check(connect === `https://t.me/${BOT}?startapp=sb_${id}`, `ссылка переноса ${connect} (id ${id})`);
  check(!!created && !created.hasKey, 'создание с ключом?');
  check(log.sandbox.filter((r) => r.path !== '/public/assist/sandbox').every((r) => r.hasKey && r.cookie === null && r.origin === BASE), 'опрос/чат: без ключа, с cookie или чужим origin');

  // 5. Перезагрузка — тот же результат; другой браузер — нет.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="sb-result"]', { timeout: 15000 });
  check((await page.$$('.sb-msg-assistant')).length === 2, 'после перезагрузки диалог не восстановлен');
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(`${BASE}/uk/assistant/try`, { waitUntil: 'networkidle' });
  check(!!(await p2.$('#sb-url')) && !(await p2.$('[data-testid="sb-result"]')), 'результат открылся в другом браузере');
  await other.close();
  check(xss.length === 0, `сработал скрипт из ответа: ${xss}`);
  // «Другой сайт» — новая форма, сессия вкладки очищена.
  await page.click('.sb-next button');
  check(!!(await page.$('#sb-url')) && (await page.evaluate(() => sessionStorage.getItem('assist-sandbox'))) === null, '«Інший сайт» не очистил сессию');
  await ctx.close();
}

// ── 6. Отказы продукта ──
async function problem(config, url, expectText, label) {
  await stand('/__stand/config', config);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/uk/assistant/try`, { waitUntil: 'networkidle' });
  await startSandbox(page, url);
  await page.waitForSelector('[data-testid="sb-problem"]', { timeout: 30000 });
  const text = await page.textContent('[data-testid="sb-problem"]');
  const kind = await page.getAttribute('[data-testid="sb-problem"]', 'data-problem');
  check(expectText.test(text), `${label}: «${text}»`);
  const html = await page.innerHTML('[data-testid="sb-problem"]');
  await page.goto('about:blank'); // pagehide → батч событий уходит sendBeacon
  await ctx.close();
  await stand('/__stand/config', { sandboxError: null, sandboxOutcome: 'ready' });
  return { kind, html };
}
{
  await resetStand();
  const off = await problem({ sandboxError: { status: 503, code: 'SANDBOX_DISABLED' } }, 'shop.example.com', /недоступна.*Залиште заявку/s, 'рубильник');
  check(off.kind === 'unavailable' && off.html.includes('/uk/assistant/pilot') && !off.html.includes('form-status-error'), 'рубильник — не «ошибка», а заявка');
  const budget = await problem({ sandboxError: { status: 503, code: 'SANDBOX_BUDGET' } }, 'shop.example.com', /недоступна/, 'денежный потолок');
  check(budget.kind === 'unavailable', 'потолок');
  const limit = await problem({ sandboxError: { status: 429, code: 'SANDBOX_LIMIT_IP' } }, 'shop.example.com', /Telegram/, '4-я песочница');
  check(limit.html.includes(`https://t.me/${BOT}?startapp=lp_sandbox_limit`) && !/увійти в браузері|веб-вхід/i.test(limit.html), 'лимит: «откройте в Telegram», без веб-входа');
  await problem({}, 'optout.example.com', /відмовився/, 'opt-out');
  await problem({ sandboxError: { status: 400, code: 'URL_REJECTED' } }, 'shop.example.com', /перевірити не можна/, 'SSRF/отказ адреса');
  const blocked = await problem({ sandboxOutcome: 'budget' }, 'shop.example.com', /недоступна/, 'обход упёрся в потолок');
  check(blocked.kind === 'unavailable', 'blocked/budget → «недоступно»');
  await problem({ sandboxOutcome: 'failed' }, 'shop.example.com', /Не вдалося прочитати сайт/, 'обход не удался');
  // 4-я подряд с «того же IP» на стенде — 429 (сервер считает сам).
  await resetStand();
  for (let i = 0; i < 3; i++) await fetch(`${STAND}/public/assist/sandbox`, { method: 'POST', headers: { origin: BASE }, body: JSON.stringify({ url: 'https://shop.example.com/' }) });
  const fourth = await problem({}, 'shop.example.com', /ліміт/i, '4-я песочница (счётчик стенда)');
  check(fourth.kind === 'limit-ip', '4-я песочница');
}
// Вопросы кончились — поле заблокировано.
{
  await resetStand();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/uk/assistant/try`, { waitUntil: 'networkidle' });
  await startSandbox(page, 'shop.example.com');
  await page.waitForSelector('[data-testid="sb-result"]', { timeout: 30000 });
  for (let i = 0; i < 10; i++) {
    await page.fill('#sb-q', `Питання ${i}`);
    await page.click('form.sb-ask button[type="submit"]');
    await page.waitForFunction((n) => document.querySelectorAll('.sb-msg-assistant').length === n, i + 1, { timeout: 10000 });
  }
  check(await page.isDisabled('#sb-q'), 'после 10 вопросов поле не заблокировано');
  check((await page.$$('.sb-suggested button')).length === 0, 'после лимита вопросы-кнопки остались');
  await page.goto('about:blank');
  await ctx.close();
}

// ── 7. Код вставки из документации поднимает настоящий загрузчик ──
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${STAND}/__stand/install`, { waitUntil: 'load' });
  const ok = await page.waitForSelector('div[data-v4c]', { state: 'attached', timeout: 15000 }).then(() => true, () => false);
  check(ok, 'код вставки из lib/install.ts не поднял загрузчик на «сайте заказчика»');
  await ctx.close();
}

// ── 8. События песочницы (со всех прогонов выше) ──
{
  await resetStand();
  const events = seenEvents;
  const names = new Set(events.map((e) => e.name));
  for (const n of ['sandbox_start', 'sandbox_ready', 'sandbox_question', 'sandbox_limit_hit']) check(names.has(n), `нет события ${n}`);
  const raw = JSON.stringify(events);
  for (const leak of ['shop.example.com', 'Питання', 'sb_']) check(!raw.includes(leak), `в событиях утёк «${leak}»`);
}

await browser.close();
if (fails.length) {
  console.error(['FAIL Л4–Л5 e2e:', ...fails].join('\n'));
  process.exit(1);
}
console.log('ok   Л4–Л5 e2e (стенд-мок песочницы, настоящий загрузчик): hero → /try с адресом без автозапуска; http/IP/порт/логин — отказ без запроса; ожидание role=status → макет с подписью «не встановлено», фокус; враждебный ответ — только текст, ссылка лишь на хост песочницы; sb_<id> = id сервера, ключ заголовком без cookie; перезагрузка — восстановлено, другой браузер — нет; рубильник/потолок — «залиште заявку», 4-я — «Telegram», opt-out/отказ/сбой обхода — свои тексты; 10 вопросов — поле закрыто; код вставки поднимает загрузчик; события без адреса и текста');
